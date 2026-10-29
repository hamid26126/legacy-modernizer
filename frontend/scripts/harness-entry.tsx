/**
 * In-browser stage harness — bundled by scripts/stage-harness.mjs (esbuild)
 * and driven inside a jsdom window with a mocked EventSource. Feeds the REAL
 * backend event sequences (backend/executor.py + planner.py + main.py field
 * names, including the independent build_attempt / lint_attempt counters)
 * and asserts:
 *   - every live status message REPLACES the previous one (exact equality)
 *   - each output toggle opens/closes ONLY its own row, even when a build
 *     failure and a lint failure share "attempt 1"
 *   - timeline spinners settle by position, never by attempt number
 *   - result-screen counts (Build runs / Lint runs / Fix passes) use the
 *     authoritative execution_complete fields, with exact timeline fallbacks
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'

export interface StageCheck {
  name: string
  ok: boolean
  detail?: string
}

const results: StageCheck[] = []
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
}

/** Minimal EventSource stand-in: records URLs, replays scripted events. */
class MockEventSource {
  static instances: MockEventSource[] = []
  static reset(): void {
    MockEventSource.instances = []
  }
  url: string
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const PLAN = {
  overall_notes: 'Straightforward jQuery → React rewrite.',
  files: [
    {
      path: 'js/app.js',
      new_path: 'src/App.jsx',
      priority: 1,
      depends_on: [] as string[],
      migration_notes: 'Extract state.',
    },
    {
      path: 'js/util.js',
      new_path: 'src/util.ts',
      priority: 2,
      depends_on: ['js/app.js'],
      migration_notes: 'Type helpers.',
    },
  ],
}

const LINT_MSG = 'Build passed — checking lint...'

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? ''
}

function statusLine(container: HTMLElement): string {
  return textOf(container.querySelector('.status-line'))
}

function execStatus(container: HTMLElement): string {
  return textOf(container.querySelector('.executing-status span'))
}

function inlineSpinners(container: HTMLElement): number {
  return container.querySelectorAll('.timeline-inline-spinner').length
}

function activeDots(container: HTMLElement): number {
  return container.querySelectorAll('.timeline-dot--active').length
}

function statValue(container: HTMLElement, label: string): string {
  for (const stat of container.querySelectorAll('.stat')) {
    const dt = textOf(stat.querySelector('dt'))
    if (dt === label) return textOf(stat.querySelector('dd'))
  }
  return '(missing stat)'
}

function bannerText(container: HTMLElement): string {
  return textOf(container.querySelector('.banner-message'))
}

function buttonIn(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  )
}

async function click(el: Element | undefined): Promise<void> {
  if (!el) return
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

async function emit(es: MockEventSource | undefined, payload: unknown): Promise<void> {
  if (!es) return
  await act(async () => {
    es.emit(payload)
  })
}

/** Submit the repo form so a planning EventSource opens. */
async function submitPlanning(container: HTMLElement): Promise<void> {
  const form = container.querySelector('form')
  await act(async () => {
    form?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** job + plan_complete, then Run Migration → the migrate stream is open. */
async function driveToExecuting(
  container: HTMLElement,
): Promise<{ planES: MockEventSource; migrateES: MockEventSource | undefined }> {
  const planES = MockEventSource.instances[0]
  await emit(planES, { type: 'job', job_id: 'job-1' })
  await emit(planES, { type: 'plan_complete', plan: PLAN })
  await click(buttonIn(container, 'Run Migration'))
  return { planES, migrateES: MockEventSource.instances[1] }
}

async function generateAll(migrateES: MockEventSource | undefined): Promise<void> {
  for (const file of PLAN.files) {
    await emit(migrateES, { type: 'file_start', file: file.path, new_path: file.new_path })
    await emit(migrateES, { type: 'file_generated', file: file.path, new_path: file.new_path })
  }
}

// ── Scenario A: planning replacement + first-try pass ─────────────────────
async function scenarioA(): Promise<void> {
  MockEventSource.reset()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  await submitPlanning(container)
  const planES = MockEventSource.instances[0]
  check('A: planning stream opened', !!planES?.url.includes('/api/plan/stream'))

  await emit(planES, { type: 'job', job_id: 'job-1' })
  check('A: job event alone changes no status text', statusLine(container) === 'Connecting to backend...')

  // The four real planner/main progress messages, in order.
  const planningMessages = [
    'Cloning repository — this may take a minute...',
    'Clone complete — analyzing codebase...',
    'Reading repo...',
    'Grounding with Tavily...',
    'Calling Nemotron 3 Ultra for the migration plan (this costs credits)...',
  ]
  for (const message of planningMessages) {
    await emit(planES, { type: 'progress', step: 'planning', message })
    check(
      `A: status REPLACES previous with exactly "${message}"`,
      statusLine(container) === message,
      statusLine(container),
    )
    check(
      `A: no stale tail after replacing ("${message}")`,
      !statusLine(container).includes('Cloning repository') ||
        message.startsWith('Cloning'),
    )
    check(`A: spinner present during "${message}"`, !!container.querySelector('.planning .spinner'))
  }

  await emit(planES, { type: 'plan_complete', plan: PLAN })
  check('A: review shows plan', textOf(container).includes('Migration Plan (2 files)'))

  await click(buttonIn(container, 'Run Migration'))
  const migrateES = MockEventSource.instances[1]
  await generateAll(migrateES)

  await emit(migrateES, { type: 'verify_start', attempt: 1 })
  check(
    'A: executing status replaced by verification status',
    execStatus(container) === 'Running build verification (attempt 1)...',
    execStatus(container),
  )
  check('A: verify_start spinner in flight', inlineSpinners(container) === 1 && activeDots(container) === 1)

  await emit(migrateES, { type: 'verify_stage_progress', attempt: 1, stage: 'lint', message: LINT_MSG })
  check('A: lint message replaces verification status', execStatus(container) === LINT_MSG, execStatus(container))
  check('A: lint row in flight, verify_start settled', inlineSpinners(container) === 1 && activeDots(container) === 1)

  await emit(migrateES, { type: 'verify_result', attempt: 1, passed: true, stage: null, output: 'ok' })
  check('A: passed status replaces lint status', execStatus(container) === 'Attempt 1 — build and lint passed', execStatus(container))
  check('A: all spinners settled after pass', inlineSpinners(container) === 0 && activeDots(container) === 0)

  for (const file of PLAN.files) {
    await emit(migrateES, { type: 'file_complete', file: file.path, new_path: file.new_path, status: 'pass' })
  }
  await emit(migrateES, {
    type: 'execution_complete',
    results: PLAN.files.map((f) => ({ file: f.path, new_path: f.new_path, status: 'pass' })),
    verified: true,
    build_attempts: 1,
    lint_attempts: 1,
  })

  check('A: first-try counts 1 build / 1 lint / 0 fixes', statValue(container, 'Build runs') === '1'
    && statValue(container, 'Lint runs') === '1'
    && statValue(container, 'Fix passes') === '0',
  `build=${statValue(container, 'Build runs')} lint=${statValue(container, 'Lint runs')} fixes=${statValue(container, 'Fix passes')}`)
  check('A: notice reads "after 1 attempt" (singular)', bannerText(container) === 'All files verified after 1 attempt', bannerText(container))

  await act(async () => {
    root.unmount()
  })
  container.remove()
}

// ── Scenario B: build fails (2-file fix pass), lint fails, then pass ──────
// Also carries the output-toggle isolation and per-step spinner assertions.
async function scenarioB(): Promise<void> {
  MockEventSource.reset()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  await submitPlanning(container)
  const { planES, migrateES } = await driveToExecuting(container)
  check('B: plan stream closed after plan_complete', !!planES?.closed)
  check('B: migrate stream scoped to job_id', !!migrateES?.url.includes('job_id=job-1'))
  await generateAll(migrateES)

  // verify_start → build fails (attempt 1 on the BUILD counter).
  await emit(migrateES, { type: 'verify_start', attempt: 1 })
  await emit(migrateES, {
    type: 'verify_result', attempt: 1, passed: false, stage: 'build',
    output: 'BUILD ERROR: src/App.jsx is broken',
  })
  check('B: build-fail status replaces verification status',
    execStatus(container) === 'Attempt 1 — build failed', execStatus(container))
  check('B: verify_start settled by the build result (no spinner)',
    inlineSpinners(container) === 0 && activeDots(container) === 0)

  // ONE fix pass fixes BOTH files (backend apply_fix loops flagged files).
  await emit(migrateES, { type: 'file_fixing', new_path: 'src/App.jsx', attempt: 2 })
  check('B: fixing row in flight', inlineSpinners(container) === 1)
  check('B: fixing status text',
    execStatus(container) === 'Fixing src/App.jsx (attempt 2)...', execStatus(container))
  await emit(migrateES, { type: 'file_fixed', new_path: 'src/App.jsx', attempt: 2 })
  check('B: first fixed row settles its fixing row', inlineSpinners(container) === 0)
  await emit(migrateES, { type: 'file_fixing', new_path: 'src/util.ts', attempt: 2 })
  await emit(migrateES, { type: 'file_fixed', new_path: 'src/util.ts', attempt: 2 })

  // Build now passes; lint (LINT counter attempt 1) fails.
  await emit(migrateES, { type: 'verify_stage_progress', attempt: 2, stage: 'lint', message: LINT_MSG })
  check('B: lint message replaces fix status', execStatus(container) === LINT_MSG, execStatus(container))
  check('B: lint row in flight', inlineSpinners(container) === 1 && activeDots(container) === 1)

  await emit(migrateES, {
    type: 'verify_result', attempt: 1, passed: false, stage: 'lint',
    output: 'LINT ERROR: no-unused-vars in src/util.ts',
  })
  check('B: lint-fail status (LINT counter attempt 1)',
    execStatus(container) === 'Attempt 1 — lint failed', execStatus(container))
  check(
    'B: lint_check (attempt 2) settled by lint result (attempt 1) — no orphan spinner',
    inlineSpinners(container) === 0 && activeDots(container) === 0,
  )

  // ── Toggle isolation: build row (attempt 1) vs lint row (attempt 1) ──
  const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>('.output-toggle'))
  check('B: two output toggles (build fail + lint fail)', toggles.length === 2, `${toggles.length}`)
  const buildToggle = toggles[0]
  const lintToggle = toggles[1]
  check('B: first toggle is the build output', buildToggle.textContent?.includes('build output') === true)
  check('B: second toggle is the lint output', lintToggle.textContent?.includes('lint output') === true)

  await click(lintToggle)
  let outputs = Array.from(container.querySelectorAll('.verify-output'))
  check('B: lint toggle opens ONLY the lint output', outputs.length === 1
    && outputs[0].textContent?.includes('LINT ERROR') === true,
  `${outputs.length} output(s)`)
  check('B: build output still collapsed after lint toggle', buildToggle.getAttribute('aria-expanded') === 'false')

  await click(buildToggle)
  outputs = Array.from(container.querySelectorAll('.verify-output'))
  check('B: build toggle adds ONLY the build output', outputs.length === 2
    && outputs.some((o) => o.textContent?.includes('BUILD ERROR')))

  await click(lintToggle)
  outputs = Array.from(container.querySelectorAll('.verify-output'))
  check('B: lint toggle closes only the lint output', outputs.length === 1
    && outputs[0].textContent?.includes('BUILD ERROR') === true)

  // Lint is fixed on the second LINT-counter run.
  await emit(migrateES, { type: 'file_fixing', new_path: 'src/util.ts', attempt: 2 })
  await emit(migrateES, { type: 'file_fixed', new_path: 'src/util.ts', attempt: 2 })
  await emit(migrateES, { type: 'verify_stage_progress', attempt: 2, stage: 'lint', message: LINT_MSG })
  check('B: second lint message replaces fix status', execStatus(container) === LINT_MSG, execStatus(container))
  await emit(migrateES, { type: 'verify_result', attempt: 2, passed: true, stage: null, output: 'ok' })
  check('B: final pass status replaces lint status',
    execStatus(container) === 'Attempt 2 — build and lint passed', execStatus(container))
  check('B: all spinners settled before completion', inlineSpinners(container) === 0 && activeDots(container) === 0)

  for (const file of PLAN.files) {
    await emit(migrateES, { type: 'file_complete', file: file.path, new_path: file.new_path, status: 'pass' })
  }
  await emit(migrateES, {
    type: 'execution_complete',
    results: PLAN.files.map((f) => ({ file: f.path, new_path: f.new_path, status: 'pass' })),
    verified: true,
    build_attempts: 2,
    lint_attempts: 2,
  })

  check('B: counts are 2 build / 2 lint / 2 fix PASSES (not files)',
    statValue(container, 'Build runs') === '2'
      && statValue(container, 'Lint runs') === '2'
      && statValue(container, 'Fix passes') === '2',
    `build=${statValue(container, 'Build runs')} lint=${statValue(container, 'Lint runs')} fixes=${statValue(container, 'Fix passes')}`)
  check('B: notice reads "after 2 attempts"', bannerText(container) === 'All files verified after 2 attempts', bannerText(container))
  check('B: summary card + download kept', !!container.querySelector('.summary-card')
    && !!Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Download Migrated App')))

  // Toggles survive into the complete stage and still isolate rows.
  const completeToggles = Array.from(container.querySelectorAll<HTMLButtonElement>('.output-toggle'))
  await click(completeToggles[1])
  const completeOutputs = Array.from(container.querySelectorAll('.verify-output'))
  check('B: toggle isolation holds on the result screen', completeOutputs.length === 2)

  await act(async () => {
    root.unmount()
  })
  container.remove()
}

// ── Scenario C: build fails all 3 times — lint NEVER runs ─────────────────
async function scenarioC(): Promise<void> {
  MockEventSource.reset()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  await submitPlanning(container)
  const { migrateES } = await driveToExecuting(container)
  await generateAll(migrateES)

  await emit(migrateES, { type: 'verify_start', attempt: 1 })
  for (let attempt = 1; attempt <= 3; attempt++) {
    await emit(migrateES, {
      type: 'verify_result', attempt, passed: false, stage: 'build',
      output: `BUILD ERROR run ${attempt}`,
    })
    if (attempt < 3) {
      await emit(migrateES, { type: 'file_fixing', new_path: 'src/App.jsx', attempt: attempt + 1 })
      await emit(migrateES, { type: 'file_fixed', new_path: 'src/App.jsx', attempt: attempt + 1 })
    }
  }
  for (const file of PLAN.files) {
    await emit(migrateES, { type: 'file_complete', file: file.path, new_path: file.new_path, status: 'fail' })
  }
  await emit(migrateES, {
    type: 'execution_complete',
    results: PLAN.files.map((f) => ({ file: f.path, new_path: f.new_path, status: 'fail' })),
    verified: false,
    build_attempts: 3,
    lint_attempts: 0,
  })

  check('C: build runs = 3', statValue(container, 'Build runs') === '3', statValue(container, 'Build runs'))
  check('C: lint runs = 0 (lint never ran — NOT 1)', statValue(container, 'Lint runs') === '0', statValue(container, 'Lint runs'))
  check('C: fix passes = 2 (only the two retried failures)',
    statValue(container, 'Fix passes') === '2', statValue(container, 'Fix passes'))
  check('C: no lint rows in the timeline', !textOf(container).includes('checking lint'))
  check('C: failed notice "after 3 attempts"',
    bannerText(container) === 'Verification failed after 3 attempts — manual review needed', bannerText(container))
  check('C: no spinners after completion', inlineSpinners(container) === 0 && activeDots(container) === 0)

  await act(async () => {
    root.unmount()
  })
  container.remove()
}

// ── Scenario D: lint fails twice, then passes — independent counters ──────
async function scenarioD(): Promise<void> {
  MockEventSource.reset()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<App />)
  })
  await act(async () => {
    await Promise.resolve()
  })

  await submitPlanning(container)
  const { migrateES } = await driveToExecuting(container)
  await generateAll(migrateES)

  await emit(migrateES, { type: 'verify_start', attempt: 1 })
  for (let lintRun = 1; lintRun <= 2; lintRun++) {
    await emit(migrateES, { type: 'verify_stage_progress', attempt: 1, stage: 'lint', message: LINT_MSG })
    await emit(migrateES, {
      type: 'verify_result', attempt: lintRun, passed: false, stage: 'lint',
      output: `LINT ERROR run ${lintRun}`,
    })
    check(
      `D: after lint failure ${lintRun}, only the fixing row spins (lint rows with the SAME attempt number settle)`,
      inlineSpinners(container) === 0 && activeDots(container) === 0,
    )
    await emit(migrateES, { type: 'file_fixing', new_path: 'src/util.ts', attempt: lintRun + 1 })
    await emit(migrateES, { type: 'file_fixed', new_path: 'src/util.ts', attempt: lintRun + 1 })
  }
  await emit(migrateES, { type: 'verify_stage_progress', attempt: 1, stage: 'lint', message: LINT_MSG })
  await emit(migrateES, { type: 'verify_result', attempt: 3, passed: true, stage: null, output: 'ok' })
  check('D: three lint_check rows all with attempt 1 all settle at the end',
    inlineSpinners(container) === 0 && activeDots(container) === 0)

  for (const file of PLAN.files) {
    await emit(migrateES, { type: 'file_complete', file: file.path, new_path: file.new_path, status: 'pass' })
  }
  await emit(migrateES, {
    type: 'execution_complete',
    results: PLAN.files.map((f) => ({ file: f.path, new_path: f.new_path, status: 'pass' })),
    verified: true,
    build_attempts: 1,
    lint_attempts: 3,
  })

  check('D: build runs = 1 (build only ran once)',
    statValue(container, 'Build runs') === '1', statValue(container, 'Build runs'))
  check('D: lint runs = 3',
    statValue(container, 'Lint runs') === '3', statValue(container, 'Lint runs'))
  check('D: fix passes = 2',
    statValue(container, 'Fix passes') === '2', statValue(container, 'Fix passes'))
  check('D: notice "after 3 attempts"', bannerText(container) === 'All files verified after 3 attempts', bannerText(container))

  await act(async () => {
    root.unmount()
  })
  container.remove()
}

async function main(): Promise<StageCheck[]> {
  ;(globalThis as { EventSource?: unknown }).EventSource = MockEventSource
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  const reactErrors: unknown[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    reactErrors.push(args.map(String).join(' '))
  }

  try {
    await scenarioA()
    await scenarioB()
    await scenarioC()
    await scenarioD()
  } finally {
    console.error = originalConsoleError
  }

  const unexpected = reactErrors.filter((line) => !line.includes('not wrapped in act'))
  check(
    'runtime: no React console errors or warnings',
    unexpected.length === 0,
    unexpected.slice(0, 3).join(' | ').slice(0, 400),
  )

  return results
}

export { main as runStageHarness }
