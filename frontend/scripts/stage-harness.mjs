/**
 * jsdom + mocked-EventSource stage harness.
 *
 * Bundles scripts/harness-entry.tsx with esbuild (no live server, no
 * backend), runs it inside a jsdom window, and prints one PASS/FAIL line per
 * check. Exit code 1 if anything failed.
 *
 *   node scripts/stage-harness.mjs
 */
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const frontendDir = fileURLToPath(new URL('..', import.meta.url))
const outfile = join(mkdtempSync(join(tmpdir(), 'lm-stage-harness-')), 'bundle.mjs')

await build({
  entryPoints: [join(frontendDir, 'scripts', 'harness-entry.tsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  logLevel: 'silent',
  loader: { '.css': 'empty' },
  define: {
    'import.meta.env': '{ "VITE_API_BASE_URL": "" }',
    'process.env.NODE_ENV': '"development"',
  },
})

// ── jsdom window as the browser environment ───────────────────────────────
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const g = globalThis
g.window = dom.window
g.document = dom.window.document
// Node ≥ 21 defines its own navigator getter — override it explicitly.
Object.defineProperty(g, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})
for (const key of [
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  const value = dom.window[key]
  if (typeof value === 'function') {
    g[key] = value.bind ? value.bind(dom.window) : value
  } else if (value !== undefined) {
    g[key] = value
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true
// Health probe must never hit the network: answer "warm" immediately.
g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })

const { runStageHarness } = await import(pathToFileURL(outfile).href)
const results = await runStageHarness()

let failed = 0
for (const result of results) {
  if (!result.ok) failed++
  const detail = result.ok || !result.detail ? '' : ` — ${result.detail}`
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${detail}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed > 0 ? 1 : 0)
