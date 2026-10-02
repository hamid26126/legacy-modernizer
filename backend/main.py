import json
import queue
import threading
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from planner import get_migration_plan_stream
from executor import execute_plan_stream
from repo_fetch import clone_repo, cleanup_repo, RepoFetchError

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
        try:
            repo_path = clone_repo(repo_url)
        except RepoFetchError as e:
            yield {"type": "error", "message": str(e)}
            return
        _last_repo_path = repo_path
        _last_repo_url = repo_url
        yield from get_migration_plan_stream(repo_path, force_refresh, cache_key=repo_url)

    gen = stream_generator_in_thread(planning_generator)
    return StreamingResponse(gen, media_type="text/event-stream")


@app.get("/api/migrate/stream")
async def stream_migrate():
    if _last_repo_path is None:
        async def error_gen():
            yield sse_format({"type": "error", "message": "No repo has been planned yet. Call /api/plan/stream first."})
        return StreamingResponse(error_gen(), media_type="text/event-stream")
    gen = stream_generator_in_thread(lambda: execute_plan_stream(_last_repo_path, cache_key=_last_repo_url))
    return StreamingResponse(gen, media_type="text/event-stream")


@app.get("/api/health")
async def health():
    return {"status": "ok"}