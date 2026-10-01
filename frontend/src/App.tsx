import { useState, useRef, useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'
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

interface MigrationResult {
  file: string
  new_path: string
  status: string
}

/**
 * Events emitted by GET /api/migrate/stream.
 *
 * `execution_complete.verified` / `.attempts` are optional because the backend
 * omits them when sandbox setup fails before verification ever starts.
 */
type MigrateEvent =
  | { type: 'file_start'; file: string; new_path: string }
  | { type: 'file_generated'; file: string; new_path: string }
  | { type: 'file_error'; file: string; message: string }
  | { type: 'verify_start'; attempt: number }
  | { type: 'verify_result'; attempt: number; passed: boolean; output: string }
  | { type: 'file_fixing'; new_path: string; attempt: number }
  | { type: 'file_fixed'; new_path: string; attempt: number }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'file_complete'; file: string; new_path: string; status: string }
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
  | { kind: 'verify_result'; attempt: number; passed: boolean; output: string }
  | { kind: 'fixing'; newPath: string; attempt: number }
  | { kind: 'fixed'; newPath: string; attempt: number }
  | { kind: 'note'; message: string }
  | { kind: 'error'; message: string }

interface FinalSummary {
  verified: boolean
  attempts: number
}

const CARD_STATUS_CLASS: Record<FileStatus, string> = {
  pending: 'pending',
  generating: 'generating',
  generated: 'generated',
  gen_failed: 'gen-failed',
  verified: 'verified',
  unverified: 'unverified',
}

// ── Component ──────────────────────────────────────────────────────────────

function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatusEntry>>({})
  const [expandedCards, setExpandedCards] = useState<Record<number, boolean>>({})
  const [connectionError, setConnectionError] = useState(false)

  // Verification timeline state
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [verificationStarted, setVerificationStarted] = useState(false)
  const [expandedAttempts, setExpandedAttempts] = useState<Record<number, boolean>>({})
  const [finalSummary, setFinalSummary] = useState<FinalSummary | null>(null)
  const [currentAttempt, setCurrentAttempt] = useState(0)

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

  const handleStartPlanning = useCallback(() => {
    closeConnection()
    setStage('planning')
    setStatusMessage('Connecting to backend...')
    setErrorMessage('')
    setConnectionError(false)
    setPlan(null)
    setFileStatuses({})
    setExpandedCards({})
    setTimeline([])
    setVerificationStarted(false)
    setExpandedAttempts({})
    setFinalSummary(null)
    lastAttemptRef.current = 0
    setCurrentAttempt(0)

    const es = new EventSource('http://localhost:8000/api/plan/stream')
    eventSourceRef.current = es

    let connected = false

    es.onopen = () => {
      connected = true
      setConnectionError(false)
    }

    es.onerror = () => {
      if (!connected) {
        setConnectionError(true)
        setErrorMessage('Could not connect to the backend. Is it running on localhost:8000?')
        es.close()
        eventSourceRef.current = null
      }
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as
          | { type: 'info'; message: string }
          | { type: 'progress'; step: string; message: string }
          | { type: 'error'; message: string }
          | { type: 'plan_complete'; plan: Plan }

        switch (data.type) {
          case 'info':
          case 'progress':
            setStatusMessage(data.message)
            break
          case 'error':
            setErrorMessage(data.message)
            es.close()
            eventSourceRef.current = null
            break
          case 'plan_complete':
            setPlan(data.plan)
            es.close()
            eventSourceRef.current = null
            setStage('review')
            break
        }
      } catch {
        // ignore malformed messages
      }
    }
  }, [closeConnection])

  // ── Stage 3 → 4: Run Migration ────────────────────────────────────────

  const handleRunMigration = useCallback(() => {
    if (!plan) return

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
    setErrorMessage('')
    setConnectionError(false)

    // Verification timeline state
    setTimeline([])
    setVerificationStarted(false)
    setExpandedAttempts({})
    setFinalSummary(null)
    lastAttemptRef.current = 0
    setCurrentAttempt(0)

    const initial: Record<string, FileStatusEntry> = {}
    for (const f of plan.files) {
      initial[f.path] = { status: 'pending' }
    }
    setFileStatuses(initial)

    const es = new EventSource('http://localhost:8000/api/migrate/stream')
    eventSourceRef.current = es

    let connected = false

    es.onopen = () => {
      connected = true
      setConnectionError(false)
    }

    es.onerror = () => {
      if (!connected) {
        setConnectionError(true)
        setErrorMessage('Could not connect to the backend. Is it running on localhost:8000?')
        es.close()
        eventSourceRef.current = null
      }
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
            setTimeline((prev) => [...prev, { kind: 'verify_start', attempt: data.attempt }])
            break

          case 'verify_result':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setTimeline((prev) => [
              ...prev,
              {
                kind: 'verify_result',
                attempt: data.attempt,
                passed: data.passed,
                output: data.output,
              },
            ])
            break

          case 'file_fixing':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
            setTimeline((prev) => [
              ...prev,
              { kind: 'fixing', newPath: data.new_path, attempt: data.attempt },
            ])
            break

          case 'file_fixed':
            lastAttemptRef.current = data.attempt
            setCurrentAttempt(data.attempt)
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

          case 'error':
            setErrorMessage(data.message)
            break

          case 'execution_complete': {
            const verified = data.verified ?? false
            const attempts = data.attempts ?? lastAttemptRef.current
            setFinalSummary({ verified, attempts })

            // Fallback for the sandbox-setup-failure path, where no
            // file_complete events are emitted.
            setFileStatuses((prev) => {
              const next = { ...prev }
              for (const r of data.results) {
                next[r.file] = {
                  ...(next[r.file] ?? {}),
                  status: r.status === 'pass' ? 'verified' : 'unverified',
                }
              }
              return next
            })

            es.close()
            eventSourceRef.current = null
            setStage('complete')
            break
          }
        }
      } catch {
        // ignore malformed messages
      }
    }
  }, [plan, closeConnection])

  // ── Start Over ─────────────────────────────────────────────────────────

  const handleStartOver = useCallback(() => {
    closeConnection()
    setStage('idle')
    setStatusMessage('')
    setErrorMessage('')
    setConnectionError(false)
    setPlan(null)
    setFileStatuses({})
    setExpandedCards({})
    setTimeline([])
    setVerificationStarted(false)
    setExpandedAttempts({})
    setFinalSummary(null)
    lastAttemptRef.current = 0
    setCurrentAttempt(0)
  }, [closeConnection])

  const toggleOutput = useCallback((attempt: number) => {
    setExpandedAttempts((prev) => ({ ...prev, [attempt]: !prev[attempt] }))
  }, [])

  const toggleCard = useCallback((idx: number) => {
    setExpandedCards((prev) => ({ ...prev, [idx]: !prev[idx] }))
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────

  const sortedFiles = plan ? [...plan.files].sort((a, b) => a.priority - b.priority) : []
  const totalFiles = sortedFiles.length
  const generatedCount = sortedFiles.filter(
    (f) => fileStatuses[f.path]?.status !== 'pending' &&
      fileStatuses[f.path]?.status !== 'generating',
  ).length

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
  for (const row of timeline) {
    if (row.kind === 'verify_result') settledAttempts.add(row.attempt)
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
          {stage !== 'complete' && (
            <span className="verify-live">
              <span className="badge-spinner badge-spinner--dark" />
              In progress
            </span>
          )}
        </div>
        <p className="verify-panel-sub">
          Full build is compiled in a sandbox after every file is generated. Failed
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
        {/* ── Error Banner ── */}
        {errorMessage && (
          <div className="banner banner--error">
            <span className="banner-icon">✕</span>
            <span>{errorMessage}</span>
            {(stage === 'planning' || stage === 'executing' || connectionError) && (
              <button className="banner-btn" onClick={handleStartOver}>
                Try Again
              </button>
            )}
          </div>
        )}

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
            <button className="btn btn--primary" onClick={handleStartPlanning}>
              Start Planning
            </button>
          </div>
        )}

        {/* ── Stage 2: Planning ── */}
        {stage === 'planning' && (
          <div className="planning">
            <div className="spinner" />
            <p className="status-line">{statusMessage || 'Connecting...'}</p>
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
            <div className="executing-status">
              {verificationStarted ? (
                <>
                  <div className="spinner" />
                  <span>
                    Running build verification (attempt {currentAttempt || 1})...
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

            {renderFileList()}
            {renderVerificationPanel()}
          </div>
        )}

        {/* ── Stage 4b: Complete ── */}
        {stage === 'complete' && (
          <div className="complete">
            {finalSummary &&
              (finalSummary.verified ? (
                <div className="banner banner--success">
                  <span className="banner-icon">✓</span>
                  <span>
                    All files verified after {finalSummary.attempts} attempt
                    {finalSummary.attempts === 1 ? '' : 's'}
                  </span>
                </div>
              ) : (
                <div className="banner banner--error">
                  <span className="banner-icon">⚠</span>
                  <span>
                    Verification failed after {finalSummary.attempts} attempt
                    {finalSummary.attempts === 1 ? '' : 's'} — manual review needed
                  </span>
                </div>
              ))}

            {renderVerificationPanel()}
            {renderFileList()}

            <div className="action-bar">
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
  settledFixes,
}: {
  row: TimelineEntry
  outputOpen: boolean
  onToggleOutput: (attempt: number) => void
  isLast: boolean
  streamFinished: boolean
  settledAttempts: ReadonlySet<number>
  settledFixes: ReadonlySet<string>
}) {
  let dotClass = 'timeline-dot'
  let body: ReactNode

  switch (row.kind) {
    case 'verify_start': {
      // Spinner runs only until this attempt's verify_result lands.
      const inFlight = !streamFinished && !settledAttempts.has(row.attempt)
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

    case 'verify_result':
      if (row.passed) {
        dotClass += ' timeline-dot--passed'
        body = (
          <div className="timeline-body">
            <span className="timeline-text timeline-text--passed">
              Attempt {row.attempt} — Build passed
            </span>
          </div>
        )
      } else {
        dotClass += ' timeline-dot--failed'
        body = (
          <div className="timeline-body">
            <div className="timeline-body-head">
              <span className="timeline-text timeline-text--failed">
                Attempt {row.attempt} — Build failed
              </span>
              <button
                className="output-toggle"
                onClick={() => onToggleOutput(row.attempt)}
                aria-expanded={outputOpen}
              >
                {outputOpen ? '▾' : '▸'} {outputOpen ? 'Hide' : 'Show'} build output
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