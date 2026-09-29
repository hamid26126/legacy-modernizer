import json
import queue
import threading
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from planner import get_migration_plan_stream
from executor import execute_plan_stream

app = FastAPI(title="Legacy Modernization Agent API")

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
async def stream_plan(force_refresh: bool = False):
    gen = stream_generator_in_thread(lambda: get_migration_plan_stream(force_refresh))
    return StreamingResponse(gen, media_type="text/event-stream")


@app.get("/api/migrate/stream")
async def stream_migrate():
    gen = stream_generator_in_thread(execute_plan_stream)
    return StreamingResponse(gen, media_type="text/event-stream")


@app.get("/api/health")
async def health():
    return {"status": "ok"}