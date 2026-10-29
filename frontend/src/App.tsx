import { useState, useRef, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useNotice } from './useNotice'
import { Notice } from './Notice'
import { API_BASE } from './config'
import './App.css'

// ── Types ──────────────────────────────────────────────────────────────────

interface PlanFile {
  path: string
  new_path: string
  priority: number
  depends_on: string[]
  migration_notes: string
}

interface Plan {
  files: PlanFile[]
  overall_notes: string
}

/**
 * Per-file status in `execution_complete.results`.
 *
 * - pass / fail — a full verification run finished
 * - unverified — sandbox setup failed before verification could start
 * - generated / generation_failed — the run stopped after generation errors,
 *   with the successes and failures reported individually
 */
type ResultStatus = 'pass' | 'fail' | 'unverified' | 'generated' | 'generation_failed'

interface MigrationResult {
  file: string
  new_path: string
  status: ResultStatus
}

/**
 * Events emitted by GET /api/migrate/stream.
 *
 * `execution_complete.verified` / `.attempts` are optional because the backend
 * omits them when sandbox setup fails before verification ever starts.
 * `file_generated.reused` marks a file that a resumed run read back from disk
 * instead of regenerating.
 */
type MigrateEvent =
  | { type: 'file_start'; file: string; new_path: string }
  | { type: 'file_generated'; file: string; new_path: string; reused?: boolean }
  | { type: 'file_error'; file: string; message: string }
  | { type: 'verify_start'; attempt: number }
  | { type: 'verify_stage_progress'; attempt: number; stage: string; message: string }
  | {
      type: 'verify_result'
      attempt: number
      passed: boolean
      stage?: 'build' | 'lint' | null
      output: string
    }
  | { type: 'file_fixing'; new_path: string; attempt: number }
  | { type: 'file_fixed'; new_path: string; attempt: number }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'file_complete'; file: string; new_path: string; status: 'pass' | 'fail' }
  | {
      type: 'execution_complete'
      results: MigrationResult[]
      verified?: boolean
      /** Authoritative run counters — the backend numbers build and lint on
       *  INDEPENDENT budgets (build_attempt / lint_attempt in executor.py).
       *  Omitted entirely on the sandbox-setup-failure path. */
      build_attempts?: number
      lint_attempts?: number
    }

type Stage = 'idle' | 'planning' | 'review' | 'executing' | 'complete'

/** Per-file badge state across the generate → verify → finalize lifecycle. */
type FileStatus =
  | 'pending' // not started yet
  | 'generating' // Super is writing the migrated file
  | 'generated' // written, not yet verified
  | 'gen_failed' // generation threw
  | 'verified' // final: whole build passed
  | 'unverified' // final: whole build failed

interface FileStatusEntry {
  status: FileStatus
  error?: string
}

/** One row of the build-verification timeline. */
type TimelineEntry =
  | { kind: 'verify_start'; attempt: number }
  | { kind: 'lint_check'; attempt: number; message: string }
  | {
      kind: 'verify_result'
      attempt: number
      passed: boolean
      stage?: 'build' | 'lint' | null
      output: string
    }
  | { kind: 'fixing'; newPath: string; attempt: number }
  | { kind: 'fixed'; newPath: string; attempt: number }
  | { kind: 'note'; message: string }
  | { kind: 'error'; message: string }

interface FinalSummary {
  verified: boolean
  /** Authoritative counts from execution_complete; null when the event
   *  omitted them (sandbox-setup failure), so the timeline is used instead. */
  buildAttempts: number | null
  lintAttempts: number | null
  /** Last attempt number seen in any event — notice-text fallback. */
  lastAttempt: number
}

/**
 * Which timeline rows have already settled, decided by POSITION in the
 * append-only list (a later event ends an earlier row's phase).
 *
 * Attempt numbers are deliberately NOT consulted: the backend runs build and
 * lint on independent counters, so "attempt 1 — build failed" and
 * "attempt 1 — lint failed" are different rows that must never settle (or
 * share an output toggle with) each other.
 */
function computeRowSettled(timeline: TimelineEntry[]): boolean[] {
  const settled = new Array<boolean>(timeline.length).fill(true)
  let seenResult = false // a verify_result appears later in the list
  let seenPhaseMove = false // a verify_result OR lint_check appears later
  const fixedPaths = new Set<string>()
  for (let i = timeline.length - 1; i >= 0; i--) {
    const row = timeline[i]
    switch (row.kind) {
      case 'verify_result':
        settled[i] = true
        seenResult = true
        seenPhaseMove = true
        break
      case 'lint_check':
        // The lint run this row announced is over once any result lands.
        settled[i] = seenResult
        seenPhaseMove = true
        break
      case 'verify_start':
        // Covers sandbox setup + the first build; ends when the build phase
        // moves on (lint starts, or a result lands).
        settled[i] = seenPhaseMove
        break
      case 'fixed':
        fixedPaths.add(row.newPath)
        settled[i] = true
        break
      case 'fixing':
        // One file's fix is done once its "fixed" row lands, or once the
        // verification phase has moved on without it.
        settled[i] = seenPhaseMove || fixedPaths.has(row.newPath)
        break
      default:
        settled[i] = true
    }
  }
  return settled
}

/** Known-working example, offered as a one-click chip. It is also the default
 *  input value, so the demo is always one click away. */
const EXAMPLE_REPO = {
  label: 'Weather dashboard',
  url: 'https://github.com/coryjquirk/weather-dashboard',
} as const

const DEFAULT_REPO_URL: string = EXAMPLE_REPO.url

/** Backend accepts only github.com hosts (repo_fetch.validate_github_url). */
const REPO_URL_PREFIX = 'https://github.com/'

/** Step-indicator labels; the active step is derived from `stage`. */
const STEPS = ['Repo', 'Plan', 'Migrate and verify', 'Download'] as const

/** Which step each stage sits on — display mapping only, drives no logic. */
const STAGE_STEP: Record<Stage, number> = {
  idle: 0,
  planning: 1,
  review: 1,
  executing: 2,
  complete: 3,
}

/** The one command shown (and copied) on the result screen. */
const LOCAL_RUN_CMD = 'npm install && npm run dev'

/** "3m 07s" — the elapsed readout used by the run and result cards. */
function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/**
 * Live elapsed-time readout. The 1s interval lives HERE, so only this tiny
 * node re-renders each tick — the rest of the page keeps its last render.
 * `running` turns the interval on/off: while a run is on screen it counts;
 * when the stream ends the prop flips and the last tick stays on screen. The
 * result card mounts already frozen (running=false) and stamps mount time,
 * which is when the run finished.
 */
function ElapsedTimer({
  startedAt,
  running = true,
  className,
}: {
  startedAt: number | null
  running?: boolean
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  if (startedAt === null) {
    return <span className={className}>0m 00s</span>
  }
  // A resumed run re-stamps startedAt; a stale `now` from the previous run
  // then clamps to 0 until the next tick lands.
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return <span className={className}>{formatElapsed(seconds)}</span>
}

/**
 * Cold-start probe for a sleeping host (Render sleeps after ~15 min idle and
 * needs ~1 min to boot). On mount we poll /api/health every 3s, capping each
 * try at 8s so one hung request can't eat the whole budget, until it answers
 * or 120s have passed.
 */
const HEALTH_POLL_INTERVAL_MS = 3000
const HEALTH_TRY_TIMEOUT_MS = 8000
/** The wake-up line waits 2s first — a warm server answers before that. */
const HEALTH_WAKE_DELAY_MS = 2000
const HEALTH_GIVE_UP_MS = 120000

const WAKE_MESSAGE = 'Waking up the server. The first visit can take up to a minute.'
const WAKE_FAILED_MESSAGE = 'Could not reach the server. Please refresh and try again.'

/** Lifecycle of the on-mount health probe. */
type HealthState = 'pending' | 'waking' | 'ready' | 'failed'

const CARD_STATUS_CLASS: Record<FileStatus, string> = {
  pending: 'pending',
  generating: 'generating',
  generated: 'generated',
  gen_failed: 'gen-failed',
  verified: 'verified',
  unverified: 'unverified',
}

/**
 * Cards kept as-is when a run is resumed: every one of these states means the
 * file was successfully written to output/, so it must not flash back to
 * pending while the retry reuses it. Failed/pending/generating cards reset.
 */
const KEEP_ON_RESUME: ReadonlySet<FileStatus> = new Set([
  'generated',
  'verified',
  'unverified',
])

/** Map execution_complete result statuses onto per-card badge states. */
const RESULT_STATUS_MAP: Record<ResultStatus, FileStatus> = {
  pass: 'verified',
  fail: 'unverified',
  unverified: 'unverified',
  generated: 'generated',
  generation_failed: 'gen_failed',
}

// ── Component ──────────────────────────────────────────────────────────────

function App() {
  const [stage, setStage] = useState<Stage>('idle')
  // Persistent progress line for the planning stage — updates in place with
  // each progress/info event, cleared only on plan_complete or error.
  const [statusMessage, setStatusMessage] = useState('')
  // The single dismissible-notice slot used by every banner in the app.
  const { notice, showNotice, dismissNotice } = useNotice()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatusEntry>>({})
  const [expandedCards, setExpandedCards] = useState<Record<number, boolean>>({})
  const [repoUrl, setRepoUrl] = useState(DEFAULT_REPO_URL)
  // Job id issued by the backend right after a successful clone. Required by
  // /api/migrate/stream and /api/download/zip so simultaneous users never
  // touch each other's clone/output. Dropped on Start Over.
  const [jobId, setJobId] = useState<string | null>(null)

  // Verification timeline state
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [verificationStarted, setVerificationStarted] = useState(false)
  // Output-block expansion for failed verify_result rows, keyed by TIMELINE
  // ROW INDEX. Never by attempt number: build and lint failures can share an
  // attempt number (independent backend counters) and must stay independent.
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
  const [finalSummary, setFinalSummary] = useState<FinalSummary | null>(null)
  const [currentAttempt, setCurrentAttempt] = useState(0)
  // Live status line for Stage 4 — updated per phase (build, lint, fix) so the
  // header text never goes stale while a different phase is actually running.
  const [executingStatus, setExecutingStatus] = useState('')

  // On-mount health probe: 'pending' → ('waking' →) 'ready', or 'failed'.
  const [healthState, setHealthState] = useState<HealthState>('pending')

  // Presentation-only start stamp behind the elapsed-time readouts: set when
  // a run begins, never consulted by any decision-making code. The live tick
  // lives inside ElapsedTimer so only that node re-renders each second.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  // Copy-button feedback for the "Run it locally" command.
  const [commandCopied, setCommandCopied] = useState(false)

  const eventSourceRef = useRef<EventSource | null>(null)
  const lastAttemptRef = useRef(0)

  const closeConnection = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => closeConnection()
  }, [closeConnection])

  // ── Backend wake-up check ────────────────────────────────────────────────

  /**
   * Poll /api/health until it answers or HEALTH_GIVE_UP_MS elapse.
   *
   * The "waking" message and the disabled button only kick in after 2s, so a
   * warm server (or a local dev server) never shows them at all. Success
   * lands in 'ready' from any state and drops the message; the 120s deadline
   * lands in 'failed', which re-enables the button and raises a notice.
   * StrictMode's dev double-mount is neutralised by the `cancelled` flag.
   */
  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    const startedAt = Date.now()

    const giveUp = () => {
      if (!cancelled) setHealthState('failed')
    }

    const tryOnce = async (): Promise<void> => {
      if (cancelled) return
      const attemptAt = Date.now()
      if (attemptAt - startedAt >= HEALTH_GIVE_UP_MS) {
        giveUp()
        return
      }

      // Per-try cap: a request stuck on a sleeping host must not hold the
      // probe for longer than HEALTH_TRY_TIMEOUT_MS.
      const controller = new AbortController()
      const abortTimer = window.setTimeout(() => controller.abort(), HEALTH_TRY_TIMEOUT_MS)
      try {
        const response = await fetch(`${API_BASE}/api/health`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        if (response.ok) {
          if (!cancelled) setHealthState('ready')
          return
        }
      } catch {
        // Network failure or the 8s abort — fall through and retry.
      } finally {
        window.clearTimeout(abortTimer)
      }

      if (cancelled) return
      if (Date.now() - startedAt >= HEALTH_GIVE_UP_MS) {
        giveUp()
        return
      }
      // Keep the 3s cadence measured from the attempt's start.
      const wait = Math.max(0, HEALTH_POLL_INTERVAL_MS - (Date.now() - attemptAt))
      retryTimer = window.setTimeout(() => {
        void tryOnce()
      }, wait)
    }

    const wakeTimer = window.setTimeout(() => {
      // Never downgrade an outcome that already landed.
      if (!cancelled) {
        setHealthState((prev) => (prev === 'ready' || prev === 'failed' ? prev : 'waking'))
      }
    }, HEALTH_WAKE_DELAY_MS)

    void tryOnce()

    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      window.clearTimeout(wakeTimer)
    }
  }, [])

  // The only notice this flow raises: the 120s deadline. Everything else is
  // the persistent wake-up line rendered under the header.
  useEffect(() => {
    if (healthState === 'failed') showNotice(WAKE_FAILED_MESSAGE, { kind: 'error' })
  }, [healthState, showNotice])

  // Auto-clear the "Copied" confirmation shortly after a successful copy.
  useEffect(() => {
    if (!commandCopied) return
    const id = window.setTimeout(() => setCommandCopied(false), 2000)
    return () => window.clearTimeout(id)
  }, [commandCopied])

  // ── Stage 1: Idle ──────────────────────────────────────────────────────

  // Always plans the URL currently in the input — there is deliberately no
  // way to call this with a different (e.g. default/example) URL, so an error
  // can never silently resubmit something the user didn't just confirm.
  const handleStartPlanning = useCallback(() => {
    const repo = repoUrl.trim()
    if (!repo.startsWith(REPO_URL_PREFIX)) return
    setRepoUrl(repo)

    closeConnection()
    setStage('planning')
    setStatusMessage('Connecting to backend...')
    dismissNotice()
    setPlan(null)
    // The new plan will mint a fresh job_id; drop any previous one so a
    // migrate/download can never target the old session.
    setJobId(null)
    setFileStatuses({})
    setExpandedCards({})
    setTimeline([])
    setVerificationStarted(false)
    setExpandedRows({})
    setFinalSummary(null)
    setExecutingStatus('')
    lastAttemptRef.current = 0
    setCurrentAttempt(0)

    // repo_url is a required query param on the backend, and must be encoded
    // since it is itself a URL.
    const es = new EventSource(
      `${API_BASE}/api/plan/stream?repo_url=${encodeURIComponent(repo)}`,
    )
    eventSourceRef.current = es

    // True once a backend-sent {"type": "error"} has been shown for THIS
    // attempt, so the native onerror handler never overwrites it.
    let errorShown = false

    es.onerror = () => {
      // Close immediately: without this the browser keeps auto-reconnecting
      // to a stream the backend has already (intentionally) ended, leaving
      // the UI spinning on "Connecting to backend..." forever.
      es.close()
      if (eventSourceRef.current === es) eventSourceRef.current = null
      if (!errorShown) {
        showNotice('Lost connection to the backend. Please try again.')
      }
      setStatusMessage('')
      // Back to the input screen with the typed URL intact — the user edits
      // and resubmits explicitly; nothing is ever retried automatically.
      setStage('idle')
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as
          | { type: 'info'; message: string }
          | { type: 'progress'; step: string; message: string }
          | { type: 'error'; message: string }
          | { type: 'job'; job_id: string }
          | { type: 'plan_complete'; plan: Plan }

        switch (data.type) {
          case 'info':
          case 'progress':
            setStatusMessage(data.message)
            break
          case 'job':
            // Sent by the backend right after a successful clone, before any
            // planning events — store it for migrate + download.
            setJobId(data.job_id)
            break
          case 'error':
            errorShown = true
            showNotice(data.message)
            setStatusMessage('')
            es.close()
            if (eventSourceRef.current === es) eventSourceRef.current = null
            // Clone failure, non-jQuery rejection, planner error — all land
            // here: show the message on the input screen, pre-filled with the
            // URL that produced it, and wait for the user to edit + resubmit.
            setStage('idle')
            break
          case 'plan_complete':
            setStatusMessage('')
            setPlan(data.plan)
            es.close()
            if (eventSourceRef.current === es) eventSourceRef.current = null
            setStage('review')
            break
        }
      } catch {
        // ignore malformed messages
      }
    }
  }, [closeConnection, repoUrl, dismissNotice, showNotice])

  // ── Stage 3 → 4: Run Migration ────────────────────────────────────────

  /**
   * Starts a migration stream. `resume: true` is the retry path: the backend
   * reuses every file already generated for this plan and only (re)generates
   * the missing/failed ones, so cards for files that already exist are kept
   * instead of being reset.
   */
  const startMigration = useCallback((resume: boolean) => {
    if (!plan || !jobId) return

    /**
     * Generation-phase errors arrive keyed by the original path, but errors
     * raised while fixing a file arrive keyed by the *new* path, so resolve
     * either to the plan's original path.
     */
    const resolveKey = (pathOrNewPath: string): string => {
      const match = plan.files.find((f) => f.new_path === pathOrNewPath)
      return match ? match.path : pathOrNewPath
    }

    closeConnection()
    setStage('executing')
    dismissNotice()

    // Display only: the elapsed-time readout counts from this moment, and a
    // resumed run starts a fresh clock. Nothing else reads this stamp.
    setRunStartedAt(Date.now())

    // Verification timeline state — always fresh, so a retry gets its own
    // clean Build Verification section.
    setTimeline([])
    setVerificationStarted(false)
    setExpandedRows({})
    setFinalSummary(null)
    setExecutingStatus('')
    lastAttemptRef.current = 0
    setCurrentAttempt(0)

    setFileStatuses((prev) => {
      const next: Record<string, FileStatusEntry> = {}
      for (const f of plan.files) {
        const existing = prev[f.path]
        if (resume && existing && KEEP_ON_RESUME.has(existing.status)) {
          // Already generated (and possibly verified) — stays visible.
          next[f.path] = existing
        } else {
          next[f.path] = { status: 'pending' }
        }
      }
      return next
    })

    // job_id is required by the backend (it scopes the clone + output dir
    // to this session); resume retries reuse the SAME job.
    const params = new URLSearchParams({ job_id: jobId })
    if (resume) params.set('resume', 'true')
    const es = new EventSource(`${API_BASE}/api/migrate/stream?${params.toString()}`)
    eventSourceRef.current = es

    // True once a backend-sent {"type": "error"} has been shown for THIS
    // attempt, so the native onerror handler never overwrites it.
    let errorShown = false

    es.onerror = () => {
      // Close immediately to stop the browser's automatic reconnect — a
      // reconnect would otherwise re-run the whole migration from scratch.
      es.close()
      if (eventSourceRef.current === es) eventSourceRef.current = null
      if (!errorShown) {
        showNotice('Lost connection to the backend. Please try again.')
      }
      // The stream is over: retire any in-flight verification spinners so
      // the timeline can't spin forever behind the error banner.
      setFinalSummary((prev) => prev ?? {
        verified: false,
        buildAttempts: null,
        lintAttempts: null,
        lastAttempt: lastAttemptRef.current,
      })
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as MigrateEvent

        switch (data.type) {
          // ── Generation phase ──
          case 'file_start':
            setFileStatuses((prev) => ({
              ...prev,
              [data.file]: { status: 'generating' },
            }))
            break

          case 'file_generated':
            setFileStatuses((prev) => ({
              ...prev,
              [data.file]: { status: 'generated' },
            }))
            break

          case 'file_error': {
            const key = resolveKey(data.file)
            setFileStatuses((prev) => ({
              ...prev,
              [key]: { status: 'gen_failed', error: data.message },
            }))
            // Errors raised mid-verification also abort the retry loop, so
            // surface them in the timeline where the attempts are listed.
            setTimeline((prev) =>
              prev.length > 0 ? [...prev, { kind: 'error', message: data.message }] : prev,
            )
            break
          }

          // ── Verification phase ──
          case 'verify_start':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setVerificationStarted(true)
            setExecutingStatus(`Running build verification (attempt ${data.attempt})...`)
            setTimeline((prev) => [...prev, { kind: 'verify_start', attempt: data.attempt }])
            break

          // Build finished; ESLint is now running. Distinct timeline row so
          // the user sees "build ok, lint in progress" instead of one opaque
          // "verifying..." state covering both stages.
          case 'verify_stage_progress':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setExecutingStatus(data.message)
            setTimeline((prev) => [
              ...prev,
              { kind: 'lint_check', attempt: data.attempt, message: data.message },
            ])
            break

          case 'verify_result':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setExecutingStatus(
              data.passed
                ? `Attempt ${data.attempt} — build and lint passed`
                : `Attempt ${data.attempt} — ${data.stage === 'lint' ? 'lint' : 'build'} failed`,
            )
            setTimeline((prev) => [
              ...prev,
              {
                kind: 'verify_result',
                attempt: data.attempt,
                passed: data.passed,
                stage: data.stage,
                output: data.output,
              },
            ])
            break

          case 'file_fixing':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setExecutingStatus(`Fixing ${data.new_path} (attempt ${data.attempt})...`)
            setTimeline((prev) => [
              ...prev,
              { kind: 'fixing', newPath: data.new_path, attempt: data.attempt },
            ])
            break

          case 'file_fixed':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setExecutingStatus(`Fix applied to ${data.new_path} — re-running build...`)
            setTimeline((prev) => [
              ...prev,
              { kind: 'fixed', newPath: data.new_path, attempt: data.attempt },
            ])
            break

          case 'info':
            setTimeline((prev) => [...prev, { kind: 'note', message: data.message }])
            break

          // ── Finalization ──
          case 'file_complete':
            setFileStatuses((prev) => ({
              ...prev,
              [data.file]: {
                ...(prev[data.file] ?? {}),
                status: data.status === 'pass' ? 'verified' : 'unverified',
              },
            }))
            break

          case 'error': {
            errorShown = true
            showNotice(data.message)
            // The backend ends the stream right after an error event — close
            // so the browser does not auto-reconnect and re-run the migration.
            es.close()
            if (eventSourceRef.current === es) eventSourceRef.current = null
            // Stop here: the retry actions belong to the executing view, not
            // the completion screen. Settle any in-flight spinners.
            setFinalSummary((prev) => prev ?? {
              verified: false,
              buildAttempts: null,
              lintAttempts: null,
              lastAttempt: lastAttemptRef.current,
            })
            break
          }

          case 'execution_complete': {
            const verified = data.verified ?? false
            setFinalSummary({
              verified,
              buildAttempts: data.build_attempts ?? null,
              lintAttempts: data.lint_attempts ?? null,
              lastAttempt: lastAttemptRef.current,
            })

            // Apply per-file results: verification outcomes (pass/fail), the
            // sandbox-setup-failure path (unverified) and the generation-phase
            // split (generated vs generation_failed) all arrive here.
            const generationFailed = data.results.some(
              (r) => r.status === 'generation_failed',
            )
            setFileStatuses((prev) => {
              const next = { ...prev }
              for (const r of data.results) {
                next[r.file] = {
                  ...(next[r.file] ?? {}),
                  status: RESULT_STATUS_MAP[r.status] ?? 'unverified',
                }
              }
              return next
            })

            es.close()
            eventSourceRef.current = null
            if (generationFailed) {
              // A generation failure normally ends on the earlier `error`
              // event (which closes the stream first); if this completion is
              // processed anyway, stay on the executing view so the
              // "Retry failed files" actions remain available instead of
              // mislabelling the run as a verification failure.
              break
            }
            setStage('complete')
            break
          }
        }
      } catch {
        // ignore malformed messages
      }
    }
  }, [plan, jobId, closeConnection, dismissNotice, showNotice])

  /** Fresh run: wipe-and-regenerate (the backend's resume=false default). */
  const handleRunMigration = useCallback(() => startMigration(false), [startMigration])

  /**
   * Retry after a run that ended with failed files or failed verification:
   * a brand-new stream with ?resume=true, so only the missing files are
   * generated and everything already on disk is reused.
   */
  const handleRetry = useCallback(() => startMigration(true), [startMigration])

  // ── Start Over ─────────────────────────────────────────────────────────

  const handleStartOver = useCallback(() => {
    closeConnection()
    setStage('idle')
    setStatusMessage('')
    dismissNotice()
    setPlan(null)
    setFileStatuses({})
    setExpandedCards({})
    setTimeline([])
    setVerificationStarted(false)
    setExpandedRows({})
    setFinalSummary(null)
    setExecutingStatus('')
    lastAttemptRef.current = 0
    setCurrentAttempt(0)
    setRepoUrl(DEFAULT_REPO_URL)
    // This session is over: forget the job so nothing can download or resume
    // into the previous run's output.
    setJobId(null)
  }, [closeConnection, dismissNotice])

  /**
   * Recovery from an execution-phase error: go back to the plan review screen
   * (the plan and the original URL are both still intact) so the user can
   * explicitly re-run or start over. Never resubmits anything on its own.
   */
  const handleBackToPlan = useCallback(() => {
    closeConnection()
    dismissNotice()
    setStage(plan ? 'review' : 'idle')
  }, [closeConnection, dismissNotice, plan])

  const toggleRowOutput = useCallback((rowIndex: number) => {
    setExpandedRows((prev) => ({ ...prev, [rowIndex]: !prev[rowIndex] }))
  }, [])

  /**
   * Hand the download off to the browser. The endpoint responds with
   * Content-Disposition: attachment, so this triggers a save dialog even
   * though the backend is on a different origin. job_id scopes the zip to
   * THIS session's output directory.
   */
  const handleDownload = useCallback(() => {
    if (!jobId) return
    const a = document.createElement('a')
    a.href = `${API_BASE}/api/download/zip?job_id=${encodeURIComponent(jobId)}`
    a.download = 'migrated-app.zip'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [jobId])

  /**
   * Copy the local run command from the result screen. Uses the async
   * Clipboard API when it is available, falling back to a hidden textarea +
   * execCommand so the button still works over plain http.
   */
  const handleCopyCommand = useCallback(async () => {
    let copied = false
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(LOCAL_RUN_CMD)
        copied = true
      }
    } catch {
      copied = false
    }
    if (!copied) {
      const helper = document.createElement('textarea')
      helper.value = LOCAL_RUN_CMD
      helper.setAttribute('readonly', '')
      helper.style.position = 'fixed'
      helper.style.opacity = '0'
      document.body.appendChild(helper)
      helper.select()
      try {
        copied = document.execCommand('copy')
      } catch {
        copied = false
      }
      document.body.removeChild(helper)
    }
    if (copied) setCommandCopied(true)
  }, [])

  const toggleCard = useCallback((idx: number) => {
    setExpandedCards((prev) => ({ ...prev, [idx]: !prev[idx] }))
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────

  const trimmedRepoUrl = repoUrl.trim()
  const repoUrlValid = trimmedRepoUrl.startsWith(REPO_URL_PREFIX)
  // Cold-start lock: only while the wake-up line is on screen (so a fast,
  // healthy first response never blocks the form).
  const serverWaking = healthState === 'waking'
  // Only nag once the user has actually typed something invalid.
  const showRepoHint = trimmedRepoUrl.length > 0 && !repoUrlValid

  const sortedFiles = plan ? [...plan.files].sort((a, b) => a.priority - b.priority) : []
  const totalFiles = sortedFiles.length
  const generatedCount = sortedFiles.filter(
    (f) => fileStatuses[f.path]?.status !== 'pending' &&
      fileStatuses[f.path]?.status !== 'generating',
  ).length

  // Files whose generation failed in the last run — exactly what a retry
  // would regenerate (everything else is reused from disk).
  const failedFileCount = sortedFiles.filter(
    (f) => fileStatuses[f.path]?.status === 'gen_failed',
  ).length
  const retryLabel =
    failedFileCount > 0 ? `Retry failed files (${failedFileCount})` : 'Retry verification'

  // ── Presentation summaries (pure reads of state that already exists) ────

  // Files actually written to disk: everything except untouched/failed ones.
  const migratedCount = sortedFiles.filter((f) => {
    const s = fileStatuses[f.path]?.status
    return s === 'verified' || s === 'unverified' || s === 'generated'
  }).length

  // ── Result-screen counts ───────────────────────────────────────────────
  // execution_complete carries the AUTHORITATIVE run counters (the backend
  // numbers build and lint on independent budgets). The timeline fallbacks
  // mirror the same semantics for streams that omit the fields: every
  // completed failed build run leaves a build-stage verify_result, and the
  // single successful build run that reached lint is implied by the first
  // lint_check row; every lint run is preceded by exactly one lint_check
  // row. A "fix pass" is one apply_fix() call the backend made after a
  // failed result — one pass can fix several files, so FILES are not
  // counted, and the label says "Fix passes".
  const buildFailRows = timeline.filter(
    (r) => r.kind === 'verify_result' && !r.passed && r.stage === 'build',
  ).length
  const lintCheckRows = timeline.filter((r) => r.kind === 'lint_check').length
  const timelineBuildRuns = buildFailRows + (lintCheckRows > 0 ? 1 : 0)
  const timelineLintRuns = lintCheckRows
  const timelineFixPasses = timeline.reduce((count, row, i) => {
    if (row.kind !== 'verify_result' || row.passed) return count
    const retried = timeline.slice(i + 1).some((later) => later.kind === 'fixing')
    return retried ? count + 1 : count
  }, 0)

  const buildRunCount = finalSummary?.buildAttempts ?? timelineBuildRuns
  const lintRunCount = finalSummary?.lintAttempts ?? timelineLintRuns
  const fixPassCount = timelineFixPasses
  // Notice wording: "after N attempts" = the deepest phase's run count, so a
  // first-try pass reads "after 1 attempt" and a double lint retry reads
  // "after 3 attempts".
  const noticeAttempts = Math.max(buildRunCount, lintRunCount, finalSummary?.lastAttempt ?? 0)

  const progressPercent =
    totalFiles > 0 ? Math.round((generatedCount / totalFiles) * 100) : 0

  // Active step in the header-to-content stepper.
  const stepIndex = STAGE_STEP[stage]

  // ── Final result summary ──────────────────────────────────────────────
  // Rides in the same notice slot as every other banner, but never
  // auto-dismisses: it stays until the user closes it or the stage changes.
  useEffect(() => {
    if (stage !== 'complete' || !finalSummary) return
    if (finalSummary.verified) {
      showNotice(
        `All files verified after ${noticeAttempts} attempt${noticeAttempts === 1 ? '' : 's'}`,
        { kind: 'success', autoDismiss: false, icon: '✓' },
      )
    } else {
      showNotice(
        `Verification failed after ${noticeAttempts} attempt${noticeAttempts === 1 ? '' : 's'} — manual review needed`,
        { kind: 'error', autoDismiss: false, icon: '⚠' },
      )
    }
  }, [stage, finalSummary, noticeAttempts, showNotice])

  // ── Shared sub-render: the file list (identical in Stage 4 and complete) ──

  const renderFileList = () => (
    <div className="file-list">
      {sortedFiles.map((file, idx) => {
        const entry = fileStatuses[file.path]
        const st: FileStatus = entry?.status ?? 'pending'

        return (
          <div
            className={`file-card file-card--${CARD_STATUS_CLASS[st]}`}
            key={`${file.path}-${idx}`}
          >
            <div className="file-card-header">
              <span className="priority-badge">#{file.priority}</span>
              <div className="file-paths">
                <span className="file-path">{file.path}</span>
                <span className="arrow">→</span>
                <span className="file-path file-path--new">{file.new_path}</span>
              </div>
              <StatusBadge status={st} />
              <button
                className="expand-btn"
                onClick={() => toggleCard(idx)}
                aria-label={`Toggle migration notes for ${file.path}`}
                aria-expanded={!!expandedCards[idx]}
              >
                {expandedCards[idx] ? '▾' : '▸'}
              </button>
            </div>

            {entry?.error && <div className="file-error">{entry.error}</div>}

            {expandedCards[idx] && (
              <div className="file-card-body">
                <div className="migration-notes">
                  <h4>Migration Notes</h4>
                  <pre className="notes-text">{file.migration_notes}</pre>
                </div>
              </div>
            )}

            {file.depends_on.length > 0 && (
              <div className="depends-on">
                <span className="depends-label">Depends on:</span>
                {file.depends_on.map((dep, depIdx) => (
                  <span className="dep-chip" key={`${depIdx}-${dep}`}>
                    {dep}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  // ── Shared sub-render: the build-verification timeline ──

  // Which rows have settled, by position (see computeRowSettled). A row's
  // spinner runs only while it is genuinely still the newest event of its
  // phase — attempt numbers are never consulted.
  const rowSettled = computeRowSettled(timeline)

  // execution_complete retires every spinner, even for an attempt that never
  // reported a result (e.g. sandbox setup failed mid-verification).
  const streamFinished = finalSummary !== null

  const renderVerificationPanel = () =>
    verificationStarted && (
      <section className="verify-panel">
        <div className="verify-panel-header">
          <h2 className="section-title">Build Verification</h2>
          {stage !== 'complete' && !streamFinished && (
            <span className="verify-live">
              <span className="badge-spinner badge-spinner--dark" />
              In progress
            </span>
          )}
        </div>
        <p className="verify-panel-sub">
          Each attempt runs a real build in a sandbox, then ESLint on the result. Failed
          attempts are retried with targeted fixes, up to 3 tries.
        </p>

        <ol className="timeline">
          {timeline.map((row, i) => (
            <TimelineRow
              key={i}
              row={row}
              outputOpen={row.kind === 'verify_result' ? !!expandedRows[i] : false}
              onToggleOutput={() => toggleRowOutput(i)}
              isLast={i === timeline.length - 1}
              inFlight={!streamFinished && !rowSettled[i]}
            />
          ))}
        </ol>
      </section>
    )

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <div className="brand">
            <svg
              className="brand-mark"
              width="32"
              height="32"
              viewBox="0 0 64 64"
              fill="none"
              aria-hidden="true"
            >
              <rect width="64" height="64" rx="16" fill="#4f46e5" />
              <path
                d="M20 44V20h8l8 12 8-12h0v24"
                stroke="#ffffff"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <h1 className="title">Legacy Modernizer</h1>
          </div>
        </div>
      </header>

      {/* ── Cold-start line (persistent, NOT a Notice) ── */}
      {/* Render's backend sleeps after ~15 min idle and takes ~1 min to wake,
          so this line stays on screen until /api/health answers. It is
          deliberately not a Notice: every banner in the notice slot
          auto-dismisses after 5s, and this one must never disappear while the
          server is still down. */}
      {healthState === 'waking' && (
        <div className="wake-status" role="status" aria-live="polite">
          <span className="wake-status-spinner" aria-hidden="true" />
          <span>{WAKE_MESSAGE}</span>
        </div>
      )}

      <main className="main">
        {/* ── Step indicator ── */}
        {/* Purely derived from `stage`: every earlier step renders as done,
            the current one is highlighted with aria-current="step", later
            ones stay neutral. It carries no click handlers on purpose — the
            app moves forward only through the actions below. */}
        <nav className="stepper" aria-label="Migration progress">
          <ol className="stepper-list">
            {STEPS.map((label, i) => {
              const state = i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'
              return (
                <li
                  key={label}
                  className={`stepper-item stepper-item--${state}`}
                  aria-current={state === 'current' ? 'step' : undefined}
                >
                  <span className="stepper-index" aria-hidden="true">
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <span className="stepper-label">{label}</span>
                </li>
              )
            })}
          </ol>
        </nav>

        {/* ── Notice ── */}
        {/* Every banner/note in the app renders here through the shared
            notice mechanism: dismissible, auto-hiding after 5s (the final
            summary excepted), and deliberately EMPTY of actions — "Retry
            failed files", "Back to Plan" and "Start Over" live in the action
            bars below, so closing a message never hides a button or changes
            the stage. A planning error returns the user to Stage 1 with their
            URL still in the (editable) input, so there is intentionally no
            retry button here. */}
        {notice && <Notice key={notice.id} notice={notice} onDismiss={dismissNotice} />}

        {/* ── Stage 1: Idle ── */}
        {stage === 'idle' && (
          <div className="idle">
            {/* ── Hero ── */}
            <section className="hero">
              <h2 className="hero-title">
                Migrate jQuery apps to React, verified in a real sandbox
              </h2>
            </section>

            {/* ── How it works ── */}
            {/* One compact row: the details live in the repo card below, so
                these stay to three short numbered items. */}
            <ol className="how-it-works">
              <li className="how-step">
                <span className="how-step-index" aria-hidden="true">
                  1
                </span>
                <span className="how-step-label">Paste a repo</span>
              </li>
              <li className="how-step">
                <span className="how-step-index" aria-hidden="true">
                  2
                </span>
                <span className="how-step-label">AI plans and rewrites</span>
              </li>
              <li className="how-step">
                <span className="how-step-index" aria-hidden="true">
                  3
                </span>
                <span className="how-step-label">Built and linted in a sandbox</span>
              </li>
            </ol>

            {/* ── Repo input card ── */}
            <div className="repo-card">
              <form
                className="repo-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  // `serverWaking` re-checks the Enter-key path, not just the
                  // disabled button: a plan request against a sleeping backend
                  // would only produce a connection error.
                  if (repoUrlValid && !serverWaking) handleStartPlanning()
                }}
              >
                <label className="repo-label" htmlFor="repo-url">
                  Enter a public GitHub repo URL (small-to-medium vanilla jQuery app)
                </label>

                <input
                  id="repo-url"
                  className={`repo-input${showRepoHint ? ' repo-input--invalid' : ''}`}
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  aria-invalid={showRepoHint}
                  aria-describedby={showRepoHint ? 'repo-url-hint' : undefined}
                />

                {showRepoHint && (
                  <p className="repo-hint" id="repo-url-hint">
                    Must be a public github.com repository URL
                  </p>
                )}

                {/* ── Example chip: one click fills the input ── */}
                <div className="chips">
                  <span className="chips-label" id="examples-label">
                    Try an example
                  </span>
                  <div className="chip-row" role="group" aria-labelledby="examples-label">
                    <button
                      type="button"
                      className={`chip${trimmedRepoUrl === EXAMPLE_REPO.url ? ' chip--active' : ''}`}
                      aria-pressed={trimmedRepoUrl === EXAMPLE_REPO.url}
                      onClick={() => setRepoUrl(EXAMPLE_REPO.url)}
                    >
                      {EXAMPLE_REPO.label}
                    </button>
                  </div>
                </div>

                <button
                  className="btn btn--primary"
                  type="submit"
                  disabled={!repoUrlValid || serverWaking}
                >
                  {serverWaking ? 'Waking up server...' : 'Start Planning'}
                </button>

                {/* One muted line inside the card: timing + what works best. */}
                <p className="repo-note">
                  Small apps usually take 3 to 5 minutes. Works best on small-to-medium
                  vanilla jQuery apps.
                </p>
              </form>
            </div>

            {/* Second muted line: the credits, kept to a single line. */}
            <p className="repo-note repo-note--centered">
              Powered by NVIDIA Nemotron, Nebius Token Factory, Tavily
            </p>
          </div>
        )}

        {/* ── Stage 2: Planning ── */}
        {/* Persistent status line (NOT a notice): it is overwritten by every
            progress/info event the backend sends (cloning → reading repo →
            grounding → planning), so it always reflects the phase actually
            running, and it is cleared only on plan_complete or error. An error
            moves the user back to Stage 1, so no spinner outlives its process. */}
        {stage === 'planning' && (
          <div className="planning">
            <div className="spinner" />
            <p className="status-line" role="status" aria-live="polite">
              {statusMessage || 'Connecting to backend...'}
            </p>
          </div>
        )}

        {/* ── Stage 3: Review ── */}
        {stage === 'review' && plan && (
          <div className="review">
            {plan.overall_notes && (
              <div className="overall-notes">
                <h3>Overall Notes</h3>
                <p>{plan.overall_notes}</p>
              </div>
            )}

            <h2 className="section-title">Migration Plan ({totalFiles} files)</h2>

            {renderFileList()}

            <div className="action-bar">
              <button className="btn btn--primary" onClick={handleRunMigration}>
                Run Migration
              </button>
            </div>
          </div>
        )}

        {/* ── Stage 4: Executing ── */}
        {stage === 'executing' && plan && (
          <div className="executing">
            {/* Recovery actions, shown once the stream has ended. They live
                OUTSIDE the dismissible notice so they stay on screen after
                the message is closed — dismissing a notice may only hide the
                message, never the buttons. */}
            {streamFinished && (
              <div className="action-bar action-bar--top">
                {failedFileCount > 0 && (
                  <button className="btn btn--primary" onClick={handleRetry}>
                    {retryLabel}
                  </button>
                )}
                <button className="btn btn--secondary" onClick={handleBackToPlan}>
                  Back to Plan
                </button>
              </div>
            )}

            {/* ── Progress: files generated + elapsed time ── */}
            {/* A real bar (not just a count) so a glance shows how far the
                generation phase has got; it stays on screen with its final
                values once the stream ends. */}
            <div className="run-progress">
              <div className="run-progress-head">
                <span className="run-progress-label">Files generated</span>
                <span className="run-progress-count">
                  {generatedCount} / {totalFiles}
                </span>
                <span className="run-progress-elapsed">
                  Elapsed <ElapsedTimer startedAt={runStartedAt} />
                </span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Files generated"
                aria-valuemin={0}
                aria-valuemax={Math.max(totalFiles, 1)}
                aria-valuenow={generatedCount}
                aria-valuetext={`${generatedCount} of ${totalFiles} files`}
              >
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            {/* Once the stream is over the spinner is retired, so the UI can't
                keep "Generating..." spinning behind the error notice. */}
            {!streamFinished && (
              <div className="executing-status" role="status" aria-live="polite">
                {verificationStarted ? (
                  <>
                    <div className="spinner" />
                    <span>
                      {executingStatus ||
                        `Running build verification (attempt ${currentAttempt || 1})...`}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="spinner" />
                    <span>
                      Generating migrated files... {generatedCount} / {totalFiles}
                    </span>
                  </>
                )}
              </div>
            )}

            {renderFileList()}
            {renderVerificationPanel()}
          </div>
        )}

        {/* ── Stage 4b: Complete ── */}
        {stage === 'complete' && (
          <div className="complete">
            {/* The verified/verification-failed summary renders up top through
                the shared notice slot (working close button, no auto-hide). */}
            {finalSummary && !finalSummary.verified && (
              <div className="action-bar action-bar--top">
                <button className="btn btn--primary" onClick={handleRetry}>
                  {retryLabel}
                </button>
                <button className="btn btn--secondary" onClick={handleBackToPlan}>
                  Back to Plan
                </button>
              </div>
            )}

            {/* ── Summary card ── */}
            {/* Every number here is read straight from state the run already
                produced — no extra counting logic runs against the backend. */}
            <section
              className={`summary-card${finalSummary?.verified ? '' : ' summary-card--warn'}`}
              aria-label="Run summary"
            >
              <div className="summary-head">
                <span className="summary-icon" aria-hidden="true">
                  {finalSummary?.verified ? '✓' : '⚠'}
                </span>
                <div>
                  <h2 className="summary-title">
                    {finalSummary?.verified ? 'Migration complete' : 'Migration finished'}
                  </h2>
                  <p className="summary-sub">
                    {finalSummary?.verified
                      ? 'Every file built and passed lint in the sandbox.'
                      : 'Some files still need attention — the timeline below has the details.'}
                  </p>
                </div>
              </div>

              <dl className="stats">
                <div className="stat">
                  <dt>Files migrated</dt>
                  <dd>
                    {migratedCount} / {totalFiles}
                  </dd>
                </div>
                <div className="stat">
                  <dt>Build runs</dt>
                  <dd>{buildRunCount}</dd>
                </div>
                <div className="stat">
                  <dt>Lint runs</dt>
                  <dd>{lintRunCount}</dd>
                </div>
                <div className="stat">
                  <dt>Fix passes</dt>
                  <dd>{fixPassCount}</dd>
                </div>
                <div className="stat">
                  <dt>Elapsed time</dt>
                  <dd>
                    <ElapsedTimer startedAt={runStartedAt} running={false} />
                  </dd>
                </div>
              </dl>

              <div className="summary-actions">
                {finalSummary?.verified && (
                  <button className="btn btn--primary btn--lg" onClick={handleDownload}>
                    Download Migrated App (.zip)
                  </button>
                )}
                <button className="btn btn--secondary" onClick={handleStartOver}>
                  Start Over
                </button>
              </div>
            </section>

            {/* ── Run it locally ── */}
            <section className="run-locally">
              <h2 className="run-locally-title">Run it locally</h2>
              <div className="code-row">
                <code className="code-block">{LOCAL_RUN_CMD}</code>
                <button
                  type="button"
                  className={`copy-btn${commandCopied ? ' copy-btn--copied' : ''}`}
                  onClick={handleCopyCommand}
                >
                  {commandCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <span className="copy-feedback" role="status" aria-live="polite">
                {commandCopied ? 'Command copied to clipboard' : ''}
              </span>
              <p className="run-locally-note">
                Unzip the download, open the folder, then run the command above.
              </p>
            </section>

            {renderVerificationPanel()}
            {renderFileList()}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="footer">
        <span>Legacy Modernizer — open source under the MIT License.</span>
        <a
          className="footer-link"
          href="https://github.com/hamid26126/legacy-modernizer"
          target="_blank"
          rel="noreferrer"
        >
          github.com/hamid26126/legacy-modernizer
        </a>
      </footer>
    </div>
  )
}

// ── Status Badge ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: FileStatus }) {
  switch (status) {
    case 'pending':
      return <span className="badge badge--pending">Pending</span>
    case 'generating':
      return (
        <span className="badge badge--generating">
          <span className="badge-spinner" />
          Generating...
        </span>
      )
    case 'generated':
      return <span className="badge badge--generated">Generated</span>
    case 'gen_failed':
      return <span className="badge badge--gen-failed">Generation Failed</span>
    case 'verified':
      return (
        <span className="badge badge--verified">
          <span className="badge-check">✓</span>
          Verified
        </span>
      )
    case 'unverified':
      return <span className="badge badge--unverified">Failed Verification</span>
  }
}

// ── Verification Timeline Row ──────────────────────────────────────────────

function TimelineRow({
  row,
  outputOpen,
  onToggleOutput,
  isLast,
  inFlight,
}: {
  row: TimelineEntry
  outputOpen: boolean
  onToggleOutput: () => void
  isLast: boolean
  /** Still the newest event of its phase — drives the row spinner only. */
  inFlight: boolean
}) {
  let dotClass = 'timeline-dot'
  let body: ReactNode

  switch (row.kind) {
    case 'verify_start': {
      if (inFlight) dotClass += ' timeline-dot--active'
      body = (
        <div className="timeline-body">
          <span className="timeline-text">
            Verifying full build (attempt {row.attempt})
            {inFlight ? '...' : ''}
          </span>
          {inFlight && (
            <span className="badge-spinner badge-spinner--dark timeline-inline-spinner" />
          )}
        </div>
      )
      break
    }

    case 'lint_check': {
      if (inFlight) dotClass += ' timeline-dot--active'
      body = (
        <div className="timeline-body">
          <span className="timeline-text">{row.message}</span>
          {inFlight && (
            <span className="badge-spinner badge-spinner--dark timeline-inline-spinner" />
          )}
        </div>
      )
      break
    }

    case 'verify_result':
      if (row.passed) {
        dotClass += ' timeline-dot--passed'
        body = (
          <div className="timeline-body">
            <span className="timeline-text timeline-text--passed">
              Attempt {row.attempt} — Build &amp; lint passed
            </span>
          </div>
        )
      } else {
        const failedStage = row.stage === 'lint' ? 'Lint' : 'Build'
        dotClass += ' timeline-dot--failed'
        body = (
          <div className="timeline-body">
            <div className="timeline-body-head">
              <span className="timeline-text timeline-text--failed">
                Attempt {row.attempt} — {failedStage} failed
              </span>
              <button
                className="output-toggle"
                onClick={onToggleOutput}
                aria-expanded={outputOpen}
              >
                {outputOpen ? '▾' : '▸'} {outputOpen ? 'Hide' : 'Show'}{' '}
                {failedStage.toLowerCase()} output
                {!outputOpen && row.output && (
                  <span className="output-size">
                    ({row.output.length.toLocaleString()} chars)
                  </span>
                )}
              </button>
            </div>
            {outputOpen && <pre className="verify-output">{row.output || '(no output)'}</pre>}
          </div>
        )
      }
      break

    case 'fixing': {
      if (inFlight) dotClass += ' timeline-dot--active'
      body = (
        <div className="timeline-body">
          <span className="timeline-text">
            Attempting to fix <code className="timeline-path">{row.newPath}</code>
            {inFlight ? '...' : ''}
          </span>
          {inFlight && (
            <span className="badge-spinner badge-spinner--dark timeline-inline-spinner" />
          )}
        </div>
      )
      break
    }

    case 'fixed':
      dotClass += ' timeline-dot--passed'
      body = (
        <div className="timeline-body">
          <span className="timeline-text timeline-text--fixed">
            Fix applied to <code className="timeline-path">{row.newPath}</code>, retrying
            build...
          </span>
        </div>
      )
      break

    case 'note':
      dotClass += ' timeline-dot--note'
      body = (
        <div className="timeline-body">
          <span className="timeline-text timeline-text--note">{row.message}</span>
        </div>
      )
      break

    case 'error':
      dotClass += ' timeline-dot--failed'
      body = (
        <div className="timeline-body">
          <span className="timeline-text timeline-text--failed">{row.message}</span>
        </div>
      )
      break
  }

  return (
    <li className={`timeline-row${isLast ? ' timeline-row--last' : ''}`}>
      <span className={`${dotClass} timeline-dot-slot`} />
      <div className="timeline-content">{body}</div>
    </li>
  )
}

export default App