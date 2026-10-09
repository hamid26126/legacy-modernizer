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
      attempts?: number
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
  attempts: number
}

/** Known-working example repo, pre-filled so a demo is always one click away. */
const DEFAULT_REPO_URL = 'https://github.com/coryjquirk/weather-dashboard'

/** Backend accepts only github.com hosts (repo_fetch.validate_github_url). */
const REPO_URL_PREFIX = 'https://github.com/'

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
  const [expandedAttempts, setExpandedAttempts] = useState<Record<number, boolean>>({})
  const [finalSummary, setFinalSummary] = useState<FinalSummary | null>(null)
  const [currentAttempt, setCurrentAttempt] = useState(0)
  // Live status line for Stage 4 — updated per phase (build, lint, fix) so the
  // header text never goes stale while a different phase is actually running.
  const [executingStatus, setExecutingStatus] = useState('')

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
    setExpandedAttempts({})
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

    // Verification timeline state — always fresh, so a retry gets its own
    // clean Build Verification section.
    setTimeline([])
    setVerificationStarted(false)
    setExpandedAttempts({})
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
      const attempts = lastAttemptRef.current
      setFinalSummary((prev) => prev ?? { verified: false, attempts })
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
            const attempts = lastAttemptRef.current
            setFinalSummary((prev) => prev ?? { verified: false, attempts })
            break
          }

          case 'execution_complete': {
            const verified = data.verified ?? false
            const attempts = data.attempts ?? lastAttemptRef.current
            setFinalSummary({ verified, attempts })

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
    setExpandedAttempts({})
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

  const toggleOutput = useCallback((attempt: number) => {
    setExpandedAttempts((prev) => ({ ...prev, [attempt]: !prev[attempt] }))
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

  const toggleCard = useCallback((idx: number) => {
    setExpandedCards((prev) => ({ ...prev, [idx]: !prev[idx] }))
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────

  const trimmedRepoUrl = repoUrl.trim()
  const repoUrlValid = trimmedRepoUrl.startsWith(REPO_URL_PREFIX)
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

  // ── Final result summary ──────────────────────────────────────────────
  // Rides in the same notice slot as every other banner, but never
  // auto-dismisses: it stays until the user closes it or the stage changes.
  useEffect(() => {
    if (stage !== 'complete' || !finalSummary) return
    if (finalSummary.verified) {
      showNotice(
        `All files verified after ${finalSummary.attempts} attempt${finalSummary.attempts === 1 ? '' : 's'}`,
        { kind: 'success', autoDismiss: false, icon: '✓' },
      )
    } else {
      showNotice(
        `Verification failed after ${finalSummary.attempts} attempt${finalSummary.attempts === 1 ? '' : 's'} — manual review needed`,
        { kind: 'error', autoDismiss: false, icon: '⚠' },
      )
    }
  }, [stage, finalSummary, showNotice])

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
                aria-label="Toggle migration notes"
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
                {file.depends_on.map((dep) => (
                  <span className="dep-chip" key={dep}>
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

  /**
   * The timeline is append-only, so a `verify_start` / `fixing` row can never
   * learn that it finished on its own. Derive which attempts and fixes have
   * already been settled by a later event instead, so a row shows its spinner
   * only while it is genuinely still in flight.
   */
  const settledAttempts = new Set<number>()
  const settledFixes = new Set<string>()
  // The build phase of an attempt is over once lint has started (or the
  // result landed) — retires the "Verifying full build..." spinner so it
  // can't keep spinning through the lint phase it no longer describes.
  const buildSettled = new Set<number>()
  for (const row of timeline) {
    if (row.kind === 'verify_result') settledAttempts.add(row.attempt)
    if (row.kind === 'lint_check' || row.kind === 'verify_result') buildSettled.add(row.attempt)
    if (row.kind === 'fixed') settledFixes.add(row.newPath)
  }

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
              outputOpen={row.kind === 'verify_result' ? !!expandedAttempts[row.attempt] : false}
              onToggleOutput={toggleOutput}
              isLast={i === timeline.length - 1}
              streamFinished={streamFinished}
              settledAttempts={settledAttempts}
              buildSettled={buildSettled}
              settledFixes={settledFixes}
            />
          ))}
        </ol>
      </section>
    )

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <header className="header">
        <h1 className="title">Legacy Modernization Agent</h1>
        <p className="subtitle">
          AI-powered jQuery → React migration, powered by NVIDIA Nemotron on Nebius Token Factory
        </p>
      </header>

      <main className="main">
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
            <div className="idle-icon">
              <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
                <rect width="64" height="64" rx="16" fill="#EEF2FF" />
                <path
                  d="M20 44V20h8l8 12 8-12h0v24"
                  stroke="#6366F1"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>

            <form
              className="repo-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (repoUrlValid) handleStartPlanning()
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

              <p className="repo-note">
                Works best on small-to-medium vanilla jQuery apps without heavy external
                dependencies or build tooling.
              </p>

              <button className="btn btn--primary" type="submit" disabled={!repoUrlValid}>
                Start Planning
              </button>
            </form>
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
            <p className="status-line">{statusMessage || 'Connecting to backend...'}</p>
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

            {/* Once the stream is over the spinner is retired, so the UI can't
                keep "Generating..." spinning behind the error notice. */}
            {!streamFinished && (
              <div className="executing-status">
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
                      Generating migrated files... {generatedCount}/{totalFiles}
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

            {renderVerificationPanel()}
            {renderFileList()}

            <div className="action-bar">
              {finalSummary?.verified && (
                <button className="btn btn--primary" onClick={handleDownload}>
                  Download Migrated App (.zip)
                </button>
              )}
              <button className="btn btn--secondary" onClick={handleStartOver}>
                Start Over
              </button>
            </div>
          </div>
        )}
      </main>
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
  streamFinished,
  settledAttempts,
  buildSettled,
  settledFixes,
}: {
  row: TimelineEntry
  outputOpen: boolean
  onToggleOutput: (attempt: number) => void
  isLast: boolean
  streamFinished: boolean
  settledAttempts: ReadonlySet<number>
  buildSettled: ReadonlySet<number>
  settledFixes: ReadonlySet<string>
}) {
  let dotClass = 'timeline-dot'
  let body: ReactNode

  switch (row.kind) {
    case 'verify_start': {
      // Spinner runs through the build only — it stops when lint starts or
      // this attempt's verify_result lands, whichever comes first.
      const inFlight = !streamFinished && !buildSettled.has(row.attempt)
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
      // Settles as soon as this attempt's verify_result (which follows lint)
      // lands, so the row never spins after the stream has moved on.
      const inFlight = !streamFinished && !settledAttempts.has(row.attempt)
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
                onClick={() => onToggleOutput(row.attempt)}
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
      const inFlight = !streamFinished && !settledFixes.has(row.newPath)
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