import os
import json
import base64
from dotenv import load_dotenv
load_dotenv()

from contree_sdk import ContreeSync

sdk = ContreeSync()

BASE_PACKAGE_JSON = json.dumps({
    "name": "migrated-app",
    "private": True,
    "version": "0.0.0",
    "type": "module",
    "scripts": {"build": "vite build"},
    "dependencies": {"react": "^18.2.0", "react-dom": "^18.2.0"},
    "devDependencies": {"@vitejs/plugin-react": "^4.2.0", "vite": "^5.0.0"},
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


def write_file(checkpoint, remote_path: str, content: str):
    """Write a file into the sandbox via base64 — safe regardless of content/quoting."""
    encoded = base64.b64encode(content.encode()).decode()
    cmd = f"mkdir -p $(dirname {remote_path}) && echo {encoded} | base64 -d > {remote_path}"
    return checkpoint.run(shell=cmd, disposable=False).wait()


def build_base_checkpoint():
    """One-time scaffold + npm install. Every verification attempt branches from this."""
    image = sdk.images.use("node:20-slim")
    cp = write_file(image, "/app/package.json", BASE_PACKAGE_JSON)
    cp = write_file(cp, "/app/vite.config.js", BASE_VITE_CONFIG)
    cp = write_file(cp, "/app/src/main.jsx", BASE_MAIN_JSX)
    cp = cp.run(shell="cd /app && npm install", disposable=False).wait()
    return cp


def write_all_files(base_checkpoint, files: dict):
    """files: {path relative to /app -> content}. Returns the checkpoint with all files written."""
    cp = base_checkpoint
    for remote_path, content in files.items():
        cp = write_file(cp, f"/app/{remote_path}", content)
    return cp


def run_build(checkpoint):
    """Run the real build inside the sandbox. Returns (passed: bool, combined_output: str)."""
    result_cp = checkpoint.run(shell="cd /app && npm run build", disposable=False).wait()
    passed = result_cp.result.exit_code == 0
    output = (result_cp.result.stdout or "") + "\n" + (result_cp.result.stderr or "")
    return passed, output


def guess_broken_file(build_output: str, file_paths: list) -> str | None:
    for path in file_paths:
        filename = path.split("/")[-1]
        if filename in build_output:
            return path
    # No exact filename matched the error text — default to the first JS/JSX
    # file rather than giving up, since most real build errors live there.
    js_files = [p for p in file_paths if p.endswith((".jsx", ".js", ".tsx", ".ts"))]
    return js_files[0] if js_files else (file_paths[0] if file_paths else None)


def classify_build_error(build_output: str) -> str:
    """Returns 'missing_dependency' if the build failed due to an unresolvable
    npm package import, 'index_html' if it's an entry-point resolution issue,
    or 'general' otherwise. Used to give the fixer model more targeted context."""
    lowered = build_output.lower()
    if "failed to resolve import" in lowered or "could not resolve" in lowered or "cannot find module" in lowered:
        if "/src/main" in lowered or "index.html" in lowered:
            return "index_html"
        return "missing_dependency"
    return "general"
