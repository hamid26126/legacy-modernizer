"""
Legacy Modernization Agent API.

LOCAL DEV (with --reload, use this for any real testing/demo):

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

PRODUCTION / DOCKER: the container CMD in the repo-root Dockerfile runs
uvicorn WITHOUT --reload and with a single worker (see the Dockerfile
comment) — job state is in-memory, so multiple workers would each keep
their own _jobs table and users would lose sessions.
"""
from __future__ import annotations

import asyncio
import io
import json
import math
import os
import queue
import shutil
import threading
import time
import uuid
import zipfile
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Load env files before reading any configuration below. Precedence:
# real process environment > backend/.env > repo-root .env (override=False,
# so an explicitly-exported value is never clobbered by a file).
_BACKEND_DIR = Path(__file__).resolve().parent
load_dotenv(_BACKEND_DIR / ".env")
load_dotenv(_BACKEND_DIR.parent / ".env")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from planner import get_migration_plan_stream
from executor import execute_plan_stream
from repo_fetch import clone_repo, cleanup_repo, RepoFetchError
from sandbox_verify import BASE_PACKAGE_JSON, BASE_VITE_CONFIG, BASE_MAIN_JSX
from utils import get_generation_state_path

# ── Environment configuration ──────────────────────────────────────────────


def _env_int(name: str, default: int) -> int:
    """Read an int env var; unset/blank/unparseable values fall back to the
    default so a typo in .env can never crash the server at import."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def parse_allowed_origins(value: str | None) -> list[str]:
    """Parse the comma-separated ALLOWED_ORIGINS env var into a clean list.

    None (unset) means "use the dev-server default". Whitespace around each
    entry and empty entries (trailing/double commas) are dropped.
    """
    if value is None:
        value = "http://localhost:5173,http://127.0.0.1:5173"
    return [origin.strip() for origin in value.split(",") if origin.strip()]


def build_cors_kwargs(origins: list[str], origin_regex: str | None) -> dict:
    """CORSMiddleware kwargs. allow_origin_regex is only passed when the
    ALLOWED_ORIGIN_REGEX env var is set (default: unset)."""
    kwargs: dict = {
        "allow_origins": origins,
        "allow_methods": ["*"],
        "allow_headers": ["*"],
    }
    if origin_regex:
        kwargs["allow_origin_regex"] = origin_regex
    return kwargs


ALLOWED_ORIGINS = parse_allowed_origins(os.environ.get("ALLOWED_ORIGINS"))
ALLOWED_ORIGIN_REGEX = (os.environ.get("ALLOWED_ORIGIN_REGEX") or "").strip() or None

JOB_TTL_MINUTES = _env_int("JOB_TTL_MINUTES", 90)
JOB_TTL_SECONDS = JOB_TTL_MINUTES * 60
MAX_CONCURRENT_MIGRATIONS = _env_int("MAX_CONCURRENT_MIGRATIONS", 3)
MAX_PLANS_PER_HOUR_PER_IP = _env_int("MAX_PLANS_PER_HOUR_PER_IP", 10)
MAX_MIGRATIONS_PER_HOUR_PER_IP = _env_int("MAX_MIGRATIONS_PER_HOUR_PER_IP", 6)
DAILY_MIGRATION_CAP = _env_int("DAILY_MIGRATION_CAP", 80)

# Seconds of generator silence before an SSE comment (": keepalive") is sent.
# Module constant on purpose — tests shrink it so they don't wait 15s.
KEEPALIVE_INTERVAL = 15.0

# How often the background TTL sweep runs (seconds).
JOB_CLEANUP_INTERVAL = 10 * 60

# Headers required on every SSE response: stop any proxy from buffering the
# stream and keep intermediaries from mangling it.
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}

EXPIRED_SESSION_MESSAGE = "This session has expired. Please start again from the beginning."
BUSY_MESSAGE = "The demo server is busy with other migrations. Please try again in a few minutes."
DAILY_CAP_MESSAGE = "The demo has reached its daily usage limit. Please try again tomorrow."


# ── Rate limiting / cost protection ────────────────────────────────────────


class SlidingWindowLimiter:
    """In-memory sliding-window counter keyed by client IP.

    limit <= 0 disables the limit entirely. now_fn is injectable so tests can
    drive a fake clock. Thread-safe: hit/retry_after may be called from
    concurrent request threads.
    """

    def __init__(self, limit: int, window_seconds: float = 3600.0, now_fn=None):
        self.limit = limit
        self.window_seconds = window_seconds
        self._now = now_fn or time.time
        self._events: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _live(self, key: str, now: float) -> list[float]:
        events = [t for t in self._events.get(key, ()) if now - t < self.window_seconds]
        if events:
            self._events[key] = events
        else:
            self._events.pop(key, None)
        return events

    def retry_after(self, key: str) -> float | None:
        """Seconds the caller must wait before another attempt is allowed,
        or None when an attempt is allowed right now (or the limit is off)."""
        if self.limit <= 0:
            return None
        now = self._now()
        with self._lock:
            events = self._live(key, now)
            if len(events) < self.limit:
                return None
            return max(0.0, self.window_seconds - (now - events[0]))

    def hit(self, key: str) -> None:
        """Record one attempt for the current window."""
        if self.limit <= 0:
            return
        now = self._now()
        with self._lock:
            events = self._live(key, now)
            events.append(now)
            self._events[key] = events

    def used(self, key: str) -> int:
        if self.limit <= 0:
            return 0
        now = self._now()
        with self._lock:
            return len(self._live(key, now))


class DailyCounter:
    """Global per-day budget that resets at UTC midnight. cap <= 0 disables."""

    def __init__(self, cap: int, now_fn=None):
        self.cap = cap
        self._now = now_fn or time.time
        self._count = 0
        self._day = self._utc_day()
        self._lock = threading.Lock()

    def _utc_day(self):
        return datetime.fromtimestamp(self._now(), tz=timezone.utc).date()

    def _rollover(self) -> None:
        today = self._utc_day()
        if today != self._day:
            self._day = today
            self._count = 0

    def exceeded(self) -> bool:
        if self.cap <= 0:
            return False
        with self._lock:
            self._rollover()
            return self._count >= self.cap

    def record(self) -> None:
        if self.cap <= 0:
            return
        with self._lock:
            self._rollover()
            self._count += 1


class _UnlimitedSemaphore:
    """Stand-in used when MAX_CONCURRENT_MIGRATIONS <= 0 (0 disables)."""

    def acquire(self, blocking: bool = False) -> bool:  # noqa: ARG002
        return True

    def release(self) -> None:
        pass


def _build_semaphore(limit: int):
    """0 (or a negative value) disables the concurrency cap entirely."""
    return threading.Semaphore(limit) if limit > 0 else _UnlimitedSemaphore()


_plan_limiter = SlidingWindowLimiter(MAX_PLANS_PER_HOUR_PER_IP)
_migration_limiter = SlidingWindowLimiter(MAX_MIGRATIONS_PER_HOUR_PER_IP)
_daily_cap = DailyCounter(DAILY_MIGRATION_CAP)
_migrate_semaphore = _build_semaphore(MAX_CONCURRENT_MIGRATIONS)


def _rate_limit_message(kind: str, limit: int, wait_seconds: float) -> str:
    minutes = max(1, math.ceil(wait_seconds / 60))
    plural = "s" if minutes != 1 else ""
    return (
        f"You've reached the demo's limit of {limit} {kind} per hour. "
        f"Please try again in {minutes} minute{plural}."
    )


def client_ip(request: Request | None) -> str:
    """Client identity for rate limiting. Behind a proxy, trust the first
    X-Forwarded-For address; otherwise fall back to the socket peer."""
    if request is None:
        return "unknown"
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    client = request.client
    return client.host if client else "unknown"


# ── Per-job state (simultaneous users never interfere) ─────────────────────

# Every successful plan creates one job keyed by a uuid4 hex id. A job owns
# its cloned repo, its own output/ subdirectory and (by virtue of the unique
# repo_path) its own generation-state file. All access goes through
# _jobs_lock; jobs are dropped by cleanup_expired_jobs() once JOB_TTL_SECONDS
# old — never by the next plan request.
BASE_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _create_job(repo_path: Path, repo_url: str) -> dict:
    job_id = uuid.uuid4().hex
    output_dir = BASE_OUTPUT_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "job_id": job_id,
        "repo_path": repo_path,
        "repo_url": repo_url,
        "output_dir": output_dir,
        "created_at": time.time(),
    }
    with _jobs_lock:
        _jobs[job_id] = job
    return job


def _get_job(job_id: str | None) -> dict | None:
    if not job_id:
        return None
    with _jobs_lock:
        return _jobs.get(job_id)


def _delete_job_files(job: dict) -> None:
    """Remove one job's cloned repo, output dir and generation-state file.
    Every step is best-effort: cleanup must never raise into a request."""
    repo_path = job.get("repo_path")
    if repo_path is not None:
        try:
            if Path(repo_path).exists():
                cleanup_repo(Path(repo_path))
        except Exception:
            shutil.rmtree(repo_path, ignore_errors=True)
        try:
            get_generation_state_path(repo_path).unlink(missing_ok=True)
        except Exception:
            pass
    output_dir = job.get("output_dir")
    if output_dir is not None:
        shutil.rmtree(output_dir, ignore_errors=True)


def cleanup_expired_jobs(now: float | None = None) -> int:
    """Delete jobs older than JOB_TTL_SECONDS. Returns how many were removed.

    Runs opportunistically at the start of every plan request and from the
    background sweeper; tolerant of errors on every individual path.
    """
    now = time.time() if now is None else now
    expired: list[dict] = []
    try:
        with _jobs_lock:
            for job_id, job in list(_jobs.items()):
                if now - job.get("created_at", now) > JOB_TTL_SECONDS:
                    expired.append(_jobs.pop(job_id, job))
    except Exception:
        return 0
    for job in expired:
        try:
            _delete_job_files(job)
        except Exception:
            continue
    return len(expired)


async def _job_cleanup_loop() -> None:
    while True:
        await asyncio.sleep(JOB_CLEANUP_INTERVAL)
        try:
            await asyncio.to_thread(cleanup_expired_jobs)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(_job_cleanup_loop())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="Legacy Modernization Agent API", lifespan=lifespan)

app.add_middleware(CORSMiddleware, **build_cors_kwargs(ALLOWED_ORIGINS, ALLOWED_ORIGIN_REGEX))


# ── SSE plumbing ───────────────────────────────────────────────────────────


def _redact_secrets(text: str) -> str:
    """Replace any configured secret value that leaks into an outgoing message.
    Model/sandbox exceptions occasionally embed the offending credential
    (e.g. an API error echoing the key back) — that must never reach a client."""
    for var in ("NEBIUS_API_KEY", "TAVILY_API_KEY", "NEBIUS_PROJECT_ID", "CONTREE_TOKEN"):
        value = os.environ.get(var)
        if value and len(value) >= 8 and value in text:
            text = text.replace(value, "***")
    return text


def sse_format(event: dict) -> str:
    """Format a dict as a single SSE event, with secrets redacted."""
    if isinstance(event, dict):
        message = event.get("message")
        if isinstance(message, str):
            event = {**event, "message": _redact_secrets(message)}
    return f"data: {json.dumps(event)}\n\n"


def sse_error_response(message: str) -> StreamingResponse:
    """A finished-instantly SSE stream carrying one error event, so limit and
    session errors travel the exact same path as every other backend error
    (the frontend shows them in its normal notice with no special-casing)."""
    async def gen():
        yield sse_format({"type": "error", "message": message})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)


def stream_generator_in_thread(gen_func):
    """
    Runs a blocking generator (gen_func) in a background thread, pushing each
    yielded event into a queue. The async endpoint below reads from that queue
    without blocking the event loop — this is what keeps the server responsive
    to other requests while a slow Nemotron call is in flight.

    A queue.get timeout of KEEPALIVE_INTERVAL seconds sends an SSE comment
    (": keepalive") so proxies/clients can tell a quiet stream from a dead one.
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
        loop = asyncio.get_running_loop()
        while True:
            # q.get blocks, so it runs off the event loop thread; on timeout
            # (no event for KEEPALIVE_INTERVAL) emit an SSE comment instead.
            try:
                item = await loop.run_in_executor(None, q.get, True, KEEPALIVE_INTERVAL)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            if item is SENTINEL:
                break
            yield sse_format(item)

    return event_stream()


@app.get("/api/plan/stream")
async def stream_plan(request: Request, repo_url: str, force_refresh: bool = False):
    requester = client_ip(request)

    def planning_generator():
        # Opportunistic TTL sweep: cheap when nothing expired, and it means
        # clones/output dirs don't linger when the app is used sporadically.
        cleanup_expired_jobs()

        wait = _plan_limiter.retry_after(requester)
        if wait is not None:
            yield {
                "type": "error",
                "message": _rate_limit_message("plan requests", MAX_PLANS_PER_HOUR_PER_IP, wait),
            }
            return
        _plan_limiter.hit(requester)

        # Sent before the (blocking) clone so the UI can show a real status
        # line instead of sitting on a generic "connecting" message.
        yield {"type": "progress", "step": "cloning", "message": "Cloning repository — this may take a minute..."}
        try:
            repo_path = clone_repo(repo_url)
        except RepoFetchError as e:
            yield {"type": "error", "message": str(e)}
            return

        # Job is created (and announced) right after a successful clone and
        # BEFORE any planning events, so the frontend always has the job_id
        # by the time the plan is reviewable. The previous repo clone is
        # deliberately NOT deleted here — it may belong to another user's
        # in-flight session; TTL cleanup owns deletion.
        job = _create_job(repo_path, repo_url)
        yield {"type": "job", "job_id": job["job_id"]}
        yield {"type": "progress", "step": "cloned", "message": "Clone complete — analyzing codebase..."}
        yield from get_migration_plan_stream(repo_path, force_refresh, cache_key=repo_url)

    gen = stream_generator_in_thread(planning_generator)
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)


def migrate_generator(job: dict, resume: bool, requester: str):
    """Events for one migration run of one job. Runs in a worker thread.

    Order: session-independent cost limits first (never counted for resume),
    then a non-blocking semaphore slot, then the run itself. The semaphore is
    released in finally — on normal completion, on an exception from the
    executor, and when the generator is closed early.
    """
    if not resume:
        wait = _migration_limiter.retry_after(requester)
        if wait is not None:
            yield {
                "type": "error",
                "message": _rate_limit_message(
                    "migrations", MAX_MIGRATIONS_PER_HOUR_PER_IP, wait
                ),
            }
            return
        if _daily_cap.exceeded():
            yield {"type": "error", "message": DAILY_CAP_MESSAGE}
            return

    if not _migrate_semaphore.acquire(blocking=False):
        yield {"type": "error", "message": BUSY_MESSAGE}
        return

    try:
        if not resume:
            # Counted only once the run actually starts: rate/daily budget is
            # not spent on attempts the busy server rejected. Resume retries
            # never count — they continue one migration the user already paid.
            _migration_limiter.hit(requester)
            _daily_cap.record()
        yield from execute_plan_stream(
            job["repo_path"],
            cache_key=job["repo_url"],
            resume=resume,
            output_path=job["output_dir"],
        )
    finally:
        _migrate_semaphore.release()


@app.get("/api/migrate/stream")
async def stream_migrate(request: Request, job_id: str | None = None, resume: bool = False):
    """Stream a migration run for a specific job.

    job_id (from the plan stream's {"type":"job"} event) is required.
    resume=true reuses the output of a previous run for this same job: files
    already generated are read back from disk instead of being regenerated,
    and only the missing/failed ones are sent to the model. The job's output
    dir is only wiped when the saved progress doesn't match the current plan.
    """
    job = _get_job(job_id)
    if job is None:
        return sse_error_response(EXPIRED_SESSION_MESSAGE)
    gen = stream_generator_in_thread(
        lambda: migrate_generator(job, resume, client_ip(request))
    )
    return StreamingResponse(gen, media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/download/zip")
async def download_zip(job_id: str | None = None):
    """Bundle the migrated app for ONE job: the same scaffold the sandbox
    verified against, plus that job's generated files — and nothing from any
    other session. Unknown/expired job_id is a real 404, not a 200 with an
    error body."""
    job = _get_job(job_id)
    if job is None:
        return JSONResponse(status_code=404, content={"error": EXPIRED_SESSION_MESSAGE})

    output_dir: Path = job["output_dir"]
    if not output_dir.is_dir():
        return JSONResponse(
            status_code=404, content={"error": "No migrated output found. Run a migration first."}
        )

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

        # Actual migrated files for THIS job only, skipping _unused_ placeholders
        for file_path in output_dir.rglob("*"):
            if file_path.is_file() and "_unused_" not in file_path.name:
                arcname = file_path.relative_to(output_dir)
                zf.write(file_path, arcname=str(arcname))

    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": "attachment; filename=migrated-app.zip",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/health")
async def health():
    return {"status": "ok"}
