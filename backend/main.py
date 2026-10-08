"""
Legacy Modernization Agent API.

RUNNING WITH --reload (use this for any real testing/demo):

    uvicorn main:app --reload --port 8000 --reload-include "*.py"

The --reload-include "*.py" flag is NOT optional when --reload is used: it
restricts the watcher to Python sources so that files written during a
request (plan-cache JSON in backend/.cache/, __pycache__, logs) can never
restart the server mid-request and kill an in-flight SSE stream. Plan cache
files are additionally kept out of the watched tree in backend/.cache/ as a
second layer. If you need to change backend code, restart the server rather
than relying on a mid-flight reload.

Caveat: --reload-include only takes effect when the `watchfiles` package is
installed. Without it uvicorn falls back to StatReload, which polls only
*.py files anyway (and logs a warning that the flag had no effect) — so
neither flavour of reload should react to JSON/cache writes.
"""
import io
import json
import queue
import threading
import zipfile
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from planner import get_migration_plan_stream
from executor import execute_plan_stream
from repo_fetch import clone_repo, cleanup_repo, RepoFetchError
from sandbox_verify import BASE_PACKAGE_JSON, BASE_VITE_CONFIG, BASE_MAIN_JSX

app = FastAPI(title="Legacy Modernization Agent API")

# The most recently cloned repo. Kept on disk after planning finishes because
# /api/migrate/stream still needs to read the original files from it. It is
# cleaned up at the start of the NEXT plan request.
# Limitation: this is a single global, so only one migration can be in flight
# at a time across all users. Acceptable for a demo, not for production.
_last_repo_path: Path | None = None
# The repo_url the current plan was generated from. Used as the plan-cache key
# so the same URL reuses its cached plan across separate clones, and so
# /api/migrate/stream can find the same cache file.
_last_repo_url: str | None = None

# Allow the Vite dev server to call this API. Tighten this list before any
# real deployment — "*" or an unrestricted list is fine for hackathon demo only.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def sse_format(event: dict) -> str:
    """Format a dict as a single SSE event."""
    return f"data: {json.dumps(event)}\n\n"


def stream_generator_in_thread(gen_func):
    """
    Runs a blocking generator (gen_func) in a background thread, pushing each
    yielded event into a queue. The async endpoint below reads from that queue
    without blocking the event loop — this is what keeps the server responsive
    to other requests while a slow Nemotron call is in flight.
    """
    q: queue.Queue = queue.Queue()
    SENTINEL = object()

    def worker():
        try:
            for event in gen_func():
                q.put(event)
        except Exception as e:
            q.put({"type": "error", "message": f"{type(e).__name__}: {e}"})
        finally:
            q.put(SENTINEL)

    threading.Thread(target=worker, daemon=True).start()

    async def event_stream():
        loop = __import__("asyncio").get_event_loop()
        while True:
            # q.get is blocking, so run it off the event loop thread
            item = await loop.run_in_executor(None, q.get)
            if item is SENTINEL:
                break
            yield sse_format(item)

    return event_stream()


@app.get("/api/plan/stream")
async def stream_plan(repo_url: str, force_refresh: bool = False):
    global _last_repo_path

    def planning_generator():
        global _last_repo_path, _last_repo_url
        if _last_repo_path is not None:
            cleanup_repo(_last_repo_path)
            _last_repo_path = None
        # Sent before the (blocking) clone so the UI can show a real status
        # line instead of sitting on a generic "connecting" message.
        yield {"type": "progress", "step": "cloning", "message": "Cloning repository — this may take a minute..."}
        try:
            repo_path = clone_repo(repo_url)
        except RepoFetchError as e:
            yield {"type": "error", "message": str(e)}
            return
        yield {"type": "progress", "step": "cloned", "message": "Clone complete — analyzing codebase..."}
        _last_repo_path = repo_path
        _last_repo_url = repo_url
        yield from get_migration_plan_stream(repo_path, force_refresh, cache_key=repo_url)

    gen = stream_generator_in_thread(planning_generator)
    return StreamingResponse(gen, media_type="text/event-stream")


@app.get("/api/migrate/stream")
async def stream_migrate(resume: bool = False):
    """Stream a migration run.

    resume=true reuses the output of a previous run for this same plan: files
    already generated are read back from disk instead of being regenerated,
    and only the missing/failed ones are sent to the model. output/ is only
    wiped when the saved progress doesn't match the current plan."""
    if _last_repo_path is None:
        async def error_gen():
            yield sse_format({"type": "error", "message": "No repo has been planned yet. Call /api/plan/stream first."})
        return StreamingResponse(error_gen(), media_type="text/event-stream")
    gen = stream_generator_in_thread(
        lambda: execute_plan_stream(_last_repo_path, cache_key=_last_repo_url, resume=resume)
    )
    return StreamingResponse(gen, media_type="text/event-stream")


@app.get("/api/download/zip")
async def download_zip():
    """Bundle the migrated app: the same scaffold the sandbox verified against,
    plus every generated file under output/."""
    output_dir = Path(__file__).parent.parent / "output"
    if not output_dir.exists():
        return {"error": "No migrated output found. Run a migration first."}

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        # Scaffold files, identical to what the sandbox already verified against
        zf.writestr("package.json", BASE_PACKAGE_JSON)
        zf.writestr("vite.config.js", BASE_VITE_CONFIG)
        zf.writestr("src/main.jsx", BASE_MAIN_JSX)
        zf.writestr("README.md", (
            "# Migrated App\n\n"
            "This React app was generated by the Legacy Modernization Agent "
            "(jQuery → React, powered by NVIDIA Nemotron on Nebius Token Factory).\n\n"
            "## Run it\n\n```\nnpm install\nnpm run dev\n```\n\n"
            "This build was verified inside a Nebius Token Factory Sandbox "
            "(real `npm run build` + ESLint) before being made available for download.\n"
        ))

        # Actual migrated files, skipping any _unused_ placeholder entries
        for file_path in output_dir.rglob("*"):
            if file_path.is_file() and "_unused_" not in file_path.name:
                arcname = file_path.relative_to(output_dir)
                zf.write(file_path, arcname=str(arcname))

    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=migrated-app.zip"},
    )


@app.get("/api/health")
async def health():
    return {"status": "ok"}