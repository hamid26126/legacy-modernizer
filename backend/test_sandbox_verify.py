from dotenv import load_dotenv
load_dotenv()
import json
import base64
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


print("Starting base image...")
image = sdk.images.use("node:20-slim")

print("Writing scaffold files...")
cp = write_file(image, "/app/package.json", BASE_PACKAGE_JSON)
cp = write_file(cp, "/app/vite.config.js", BASE_VITE_CONFIG)
cp = write_file(cp, "/app/src/main.jsx", BASE_MAIN_JSX)

print("Running npm install (this will take a bit)...")
cp = cp.run(shell="cd /app && npm install", disposable=False).wait()
print("npm install exit info:", cp)  # print the whole object so we can see real field names
print("stdout:", cp.stdout[-500:] if cp.stdout else None)

print(f"\nBase checkpoint UUID: {cp.uuid}")
print("If npm install succeeded, this checkpoint is your reusable base for every migration attempt.")