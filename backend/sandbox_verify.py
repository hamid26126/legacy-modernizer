import os
import re
import json
import base64
from dotenv import load_dotenv
load_dotenv()

from contree_sdk import ContreeSync
from utils import call_with_retry

sdk = ContreeSync()

BASE_PACKAGE_JSON = json.dumps({
    "name": "migrated-app",
    "private": True,
    "version": "0.0.0",
    "type": "module",
    "scripts": {
        "dev": "vite",
        "build": "vite build",
        "lint": "eslint src --ext js,jsx || true"
    },
    "dependencies": {"react": "^18.2.0", "react-dom": "^18.2.0"},
    "devDependencies": {
        "@vitejs/plugin-react": "^4.2.0",
        "vite": "^5.0.0",
        "eslint": "^8.57.0",
        "eslint-plugin-react": "^7.34.0",
        "eslint-plugin-react-hooks": "^4.6.0"
    },
}, indent=2)

BASE_VITE_CONFIG = """import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()] })
"""

BASE_MAIN_JSX = """import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
"""

BASE_ESLINTRC = """module.exports = {
  root: true,
  env: { browser: true, es2021: true },
  extends: ['eslint:recommended', 'plugin:react/recommended', 'plugin:react-hooks/recommended'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    'no-unused-vars': 'warn'
  }
}
"""


def write_file(checkpoint, remote_path: str, content: str):
    """Write a file into the sandbox via base64 — safe regardless of content/quoting."""
    encoded = base64.b64encode(content.encode()).decode()
    cmd = f"mkdir -p $(dirname {remote_path}) && echo {encoded} | base64 -d > {remote_path}"
    return call_with_retry(lambda: checkpoint.run(shell=cmd, disposable=False).wait())


def build_base_checkpoint():
    """One-time scaffold + npm install. Every verification attempt branches from this."""
    image = sdk.images.use("node:20-slim")
    cp = write_file(image, "/app/package.json", BASE_PACKAGE_JSON)
    cp = write_file(cp, "/app/vite.config.js", BASE_VITE_CONFIG)
    cp = write_file(cp, "/app/src/main.jsx", BASE_MAIN_JSX)
    cp = write_file(cp, "/app/.eslintrc.cjs", BASE_ESLINTRC)
    cp = call_with_retry(lambda: cp.run(shell="cd /app && npm install", disposable=False).wait())
    return cp


def write_all_files(base_checkpoint, files: dict):
    """files: {path relative to /app -> content}. Returns the checkpoint with all files written."""
    cp = base_checkpoint
    for remote_path, content in files.items():
        cp = write_file(cp, f"/app/{remote_path}", content)
    return cp


def run_build(checkpoint):
    """Run the real build inside the sandbox. Returns (passed: bool, combined_output: str)."""
    result_cp = call_with_retry(lambda: checkpoint.run(shell="cd /app && npm run build", disposable=False).wait())
    passed = result_cp.result.exit_code == 0
    output = (result_cp.result.stdout or "") + "\n" + (result_cp.result.stderr or "")
    return passed, output


def run_lint(checkpoint):
    """Run ESLint on the migrated JS/JSX files inside the sandbox. Returns
    (passed: bool, combined_output: str). Only 'error' severity findings fail
    verification — warnings are logged but don't block."""
    result_cp = call_with_retry(lambda: checkpoint.run(shell="cd /app && npm run lint", disposable=False).wait())
    output = (result_cp.result.stdout or "") + "\n" + (result_cp.result.stderr or "")
    match = re.search(r"✖\s+.*?\((\d+)\s+errors?", output) or re.search(r"(\d+)\s+errors?\s*\(", output)
    error_count = int(match.group(1)) if match else 0
    passed = error_count == 0
    return passed, output


def run_full_verification(checkpoint):
    """
    Runs build, then (only if build passed) lint. Returns a dict:
    {"passed": bool, "stage": "build" | "lint" | None, "output": str}
    stage is None only when passed is True.
    """
    build_passed, build_output = run_build(checkpoint)
    if not build_passed:
        return {"passed": False, "stage": "build", "output": build_output}

    lint_passed, lint_output = run_lint(checkpoint)
    if not lint_passed:
        return {"passed": False, "stage": "lint", "output": lint_output}

    return {"passed": True, "stage": None, "output": build_output + "\n\n--- Lint ---\n" + lint_output}


def guess_broken_file(build_output: str, file_paths: list) -> str | None:
    """
    Identify which migrated file actually caused a build failure. Prefers
    structured error patterns (which name the file explicitly) over blind
    substring search, since blind search false-matches on unrelated success
    lines and code-frame context that also happen to mention a filename.
    """
    patterns = [
        r"file:\s*/app/([^\s:]+)",
        r'is not exported by ["\']([^"\']+)["\']',
        r'from ["\']([^"\']+)["\']',
        r"^(/app/[^\s:]+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, build_output, re.MULTILINE)
        if m:
            candidate = m.group(1)
            candidate_name = candidate.split("/")[-1]
            for path in file_paths:
                if path.endswith(candidate_name):
                    return path

    # Fallback: blind substring match (previous behavior)
    for path in file_paths:
        filename = path.split("/")[-1]
        if filename in build_output:
            return path

    js_files = [p for p in file_paths if p.endswith((".jsx", ".js", ".tsx", ".ts"))]
    return js_files[0] if js_files else (file_paths[0] if file_paths else None)


def guess_broken_files(failure_output: str, file_paths: list) -> list:
    """
    EVERY migrated file the failure output names, ordered by where it appears
    (guess_broken_file only ever returns the first one). Lets a single fix
    pass repair every file the build/linter flagged instead of one per attempt.

    A file is only included when its block of the output contains an `error`
    finding — eslint prints warning-only files too, and warnings don't fail
    verification, so rewriting those files is wasted risk.
    """
    matches = []
    for path in file_paths:
        idx = failure_output.find(path.split("/")[-1])
        if idx != -1:
            matches.append((idx, path))
    matches.sort()

    flagged = []
    for i, (idx, path) in enumerate(matches):
        end = matches[i + 1][0] if i + 1 < len(matches) else len(failure_output)
        if re.search(r"\berror\b", failure_output[idx:end], re.IGNORECASE):
            flagged.append(path)
    return flagged


def classify_build_error(build_output: str) -> str:
    lowered = build_output.lower()
    if "failed to resolve import" in lowered or "could not resolve" in lowered or "cannot find module" in lowered:
        if "/src/main" in lowered or "index.html" in lowered:
            return "index_html"
        m = re.search(r'resolve import ["\']([^"\']+)["\']', build_output, re.IGNORECASE) or \
            re.search(r'could not resolve ["\']([^"\']+)["\']', build_output, re.IGNORECASE)
        if m:
            specifier = m.group(1) or ""
            if specifier.startswith((".", "/")):
                return "general"  # relative path issue, not a missing npm package
        return "missing_dependency"
    return "general"
