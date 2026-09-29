import { useState, useRef, useCallback, useEffect } from 'react'
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

type Stage = 'idle' | 'planning' | 'review' | 'executing' | 'complete'

type FileStatus = 'pending' | 'migrating' | 'passed' | 'failed'

interface FileStatusEntry {
  status: FileStatus
  error?: string
}

// ── Component ──────────────────────────────────────────────────────────────

function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatusEntry>>({})
  const [executionResults, setExecutionResults] = useState<MigrationResult[]>([])
  const [expandedCards, setExpandedCards] = useState<Record<number, boolean>>({})
  const [connectionError, setConnectionError] = useState(false)

  const eventSourceRef = useRef<EventSource | null>(null)

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
    setExecutionResults([])
    setExpandedCards({})

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

    closeConnection()
    setStage('executing')
    setErrorMessage('')
    setConnectionError(false)
    setExecutionResults([])

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
        const data = JSON.parse(event.data) as
          | { type: 'file_start'; file: string; new_path: string }
          | { type: 'file_complete'; file: string; new_path: string; status: string }
          | { type: 'file_error'; file: string; message: string }
          | { type: 'error'; message: string }
          | { type: 'execution_complete'; results: MigrationResult[] }

        switch (data.type) {
          case 'file_start':
            setFileStatuses((prev) => ({
              ...prev,
              [data.file]: { status: 'migrating' },
            }))
            break
          case 'file_complete':
            setFileStatuses((prev) => ({
              ...prev,
              [data.file]: {
                status: data.status === 'pass' ? 'passed' : 'failed',
              },
            }))
            break
          case 'file_error':
            setFileStatuses((prev) => ({
              ...prev,
              [data.file]: { status: 'failed', error: data.message },
            }))
            break
          case 'error':
            setErrorMessage(data.message)
            break
          case 'execution_complete':
            setExecutionResults(data.results)
            es.close()
            eventSourceRef.current = null
            setStage('complete')
            break
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
    setExecutionResults([])
    setExpandedCards({})
  }, [closeConnection])

  const toggleCard = useCallback((idx: number) => {
    setExpandedCards((prev) => ({ ...prev, [idx]: !prev[idx] }))
  }, [])

  // ── Derived state ──────────────────────────────────────────────────────

  const sortedFiles = plan
    ? [...plan.files].sort((a, b) => a.priority - b.priority)
    : []

  const totalFiles = sortedFiles.length
  const passedCount = executionResults.filter((r) => r.status === 'pass').length
  const failedCount = totalFiles - passedCount

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
                <path d="M20 44V20h8l8 12 8-12h0v24" stroke="#6366F1" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
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

            <div className="file-list">
              {sortedFiles.map((file, idx) => (
                <div className="file-card" key={`${file.path}-${idx}`}>
                  <div className="file-card-header">
                    <span className="priority-badge">#{file.priority}</span>
                    <div className="file-paths">
                      <span className="file-path">{file.path}</span>
                      <span className="arrow">→</span>
                      <span className="file-path file-path--new">{file.new_path}</span>
                    </div>
                    <button
                      className="expand-btn"
                      onClick={() => toggleCard(idx)}
                      aria-label="Toggle details"
                    >
                      {expandedCards[idx] ? '▾' : '▸'}
                    </button>
                  </div>

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
                        <span className="dep-chip" key={dep}>{dep}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

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
              <div className="spinner" />
              <span>Migrating files...</span>
            </div>

            <div className="file-list">
              {sortedFiles.map((file, idx) => {
                const entry = fileStatuses[file.path]
                const st = entry?.status ?? 'pending'

                return (
                  <div
                    className={`file-card file-card--${st}`}
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
                    </div>

                    {entry?.error && (
                      <div className="file-error">{entry.error}</div>
                    )}

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
                          <span className="dep-chip" key={dep}>{dep}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Stage 4b: Complete ── */}
        {stage === 'complete' && (
          <div className="complete">
            <div
              className={`banner ${
                failedCount === 0 ? 'banner--success' : 'banner--warning'
              }`}
            >
              <span className="banner-icon">
                {failedCount === 0 ? '✓' : '⚠'}
              </span>
              <span>
                {passedCount} of {totalFiles} files migrated successfully
                {failedCount > 0 && ` (${failedCount} failed)`}
              </span>
            </div>

            <div className="file-list">
              {sortedFiles.map((file, idx) => {
                const entry = fileStatuses[file.path]
                const st = entry?.status ?? 'pending'

                return (
                  <div
                    className={`file-card file-card--${st}`}
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
                    </div>

                    {entry?.error && (
                      <div className="file-error">{entry.error}</div>
                    )}

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
                          <span className="dep-chip" key={dep}>{dep}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

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

// ── Status Badge Sub-component ──────────────────────────────────────────────

function StatusBadge({ status }: { status: FileStatus }) {
  switch (status) {
    case 'pending':
      return <span className="badge badge--pending">Pending</span>
    case 'migrating':
      return (
        <span className="badge badge--migrating">
          <span className="badge-spinner" />
          Migrating...
        </span>
      )
    case 'passed':
      return <span className="badge badge--passed">Passed</span>
    case 'failed':
      return <span className="badge badge--failed">Failed</span>
  }
}

export default App
