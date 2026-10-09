"""Stubbed unit tests for the public-deployment work.

Covers: per-job isolation (migrate/download scoping, expired sessions),
TTL cleanup, the concurrency semaphore, per-IP/daily rate limits, SSE
keepalives, CORS env parsing, the executor's per-job output_path, and
secret redaction / no-stack-trace hygiene.

No network, no live migrations, no servers: clone, planning, the model and
the sandbox are all stubbed. Run from backend/:

    python -m unittest test_public_deployment -v
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

# Dummy credentials BEFORE importing main/planner/executor: those modules
# build API clients from env at import time. load_dotenv() never overrides
# already-set values, so this is safe whether or not a real .env exists.
os.environ.setdefault("NEBIUS_API_KEY", "test-nebius-key-0123456789abcdef")
os.environ.setdefault("NEBIUS_PROJECT_ID", "test-project-000")
os.environ.setdefault("TAVILY_API_KEY", "test-tavily-key-0123456789")

from fastapi import Request  # noqa: E402

import main  # noqa: E402
import utils  # noqa: E402
import executor  # noqa: E402


# ── Helpers ────────────────────────────────────────────────────────────────


def make_request(ip: str = "198.51.100.7", forwarded: str | None = None) -> Request:
    headers = []
    if forwarded is not None:
        headers.append((b"x-forwarded-for", forwarded.encode("latin-1")))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": headers,
            "client": (ip, 12345),
            "server": ("testserver", 80),
        }
    )


async def collect_body(response) -> str:
    parts = []
    async for chunk in response.body_iterator:
        parts.append(chunk if isinstance(chunk, str) else chunk.decode("utf-8"))
    return "".join(parts)


def collect_bytes(response) -> bytes:
    async def _collect():
        parts = []
        async for chunk in response.body_iterator:
            parts.append(chunk.encode("utf-8") if isinstance(chunk, str) else chunk)
        return b"".join(parts)

    return asyncio.run(_collect())


def parse_sse(text: str) -> list[dict]:
    events = []
    for line in text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[len("data: "):]))
    return events


class JobsTableMixin:
    """Snapshot/restore main._jobs and point job output dirs at a temp base."""

    def setUp(self):
        super().setUp()
        self.tmp = Path(tempfile.mkdtemp(prefix="legacy-modernizer-deploy-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

        self._saved_jobs = dict(main._jobs)
        main._jobs.clear()
        self._saved_output_base = main.BASE_OUTPUT_DIR
        main.BASE_OUTPUT_DIR = self.tmp / "output"
        self.addCleanup(self._restore_jobs)

    def _restore_jobs(self):
        main.BASE_OUTPUT_DIR = self._saved_output_base
        main._jobs.clear()
        main._jobs.update(self._saved_jobs)

    def add_job(self, name: str, output_files: dict[str, str] | None = None,
                created_at: float | None = None, with_repo_dir: bool = True) -> dict:
        repo_path = self.tmp / f"{name}-repo"
        if with_repo_dir:
            (repo_path / "src").mkdir(parents=True, exist_ok=True)
            (repo_path / "src" / "app.js").write_text("// original\n", encoding="utf-8")
        job = main._create_job(repo_path=repo_path, repo_url=f"https://github.com/example/{name}")
        if created_at is not None:
            job["created_at"] = created_at
        for rel, content in (output_files or {}).items():
            target = job["output_dir"] / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        return job


# ── 1. Job isolation ───────────────────────────────────────────────────────

class JobIsolationTest(JobsTableMixin, unittest.TestCase):
    def test_download_returns_only_that_jobs_files(self):
        job_a = self.add_job(
            "alpha",
            {"src/App.jsx": "ALPHA APP", "src/index.css": "alpha css"},
        )
        job_b = self.add_job(
            "beta",
            {"src/App.jsx": "BETA APP", "src/OnlyB.jsx": "only in beta"},
        )

        response = asyncio.run(main.download_zip(job_id=job_a["job_id"]))
        self.assertEqual(response.media_type, "application/zip")
        self.assertIn("attachment", response.headers.get("content-disposition", ""))

        body = collect_bytes(response)
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            names = set(zf.namelist())
            self.assertIn("src/App.jsx", names)
            self.assertIn("src/index.css", names)
            self.assertIn("package.json", names)  # shared scaffold
            self.assertNotIn("src/OnlyB.jsx", names)  # job B's file
            self.assertEqual(zf.read("src/App.jsx"), b"ALPHA APP")

        # And the reverse direction.
        response_b = asyncio.run(main.download_zip(job_id=job_b["job_id"]))
        body_b = collect_bytes(response_b)
        with zipfile.ZipFile(io.BytesIO(body_b)) as zf:
            names = set(zf.namelist())
            self.assertIn("src/OnlyB.jsx", names)
            self.assertEqual(zf.read("src/App.jsx"), b"BETA APP")

    def test_unknown_or_missing_job_id_download_is_http_404_json(self):
        for job_id in ("does-not-exist", None):
            response = asyncio.run(main.download_zip(job_id=job_id))
            self.assertEqual(response.status_code, 404, job_id)
            payload = json.loads(response.body)
            self.assertIn("error", payload)
            self.assertEqual(payload["error"], main.EXPIRED_SESSION_MESSAGE)

    def test_unknown_job_migrate_emits_expired_session_error(self):
        for resume in (False, True):
            response = asyncio.run(
                main.stream_migrate(request=make_request(), job_id="does-not-exist", resume=resume)
            )
            events = parse_sse(asyncio.run(collect_body(response)))
            self.assertEqual(len(events), 1, resume)
            self.assertEqual(events[0]["type"], "error")
            self.assertEqual(events[0]["message"], main.EXPIRED_SESSION_MESSAGE)

    def test_missing_job_id_migrate_emits_expired_session_error(self):
        response = asyncio.run(main.stream_migrate(request=make_request()))
        events = parse_sse(asyncio.run(collect_body(response)))
        self.assertEqual(events, [{"type": "error", "message": main.EXPIRED_SESSION_MESSAGE}])

    def test_generation_state_cannot_collide_between_jobs_on_same_url(self):
        repo_a = self.tmp / "clone-a"
        repo_b = self.tmp / "clone-b"
        repo_a.mkdir()
        repo_b.mkdir()
        url = "https://github.com/example/shared"
        state_a = utils.get_generation_state_path(repo_a, url)
        state_b = utils.get_generation_state_path(repo_b, url)
        # Plan cache IS shared by URL (by design); generation state is not.
        self.assertEqual(
            utils.get_plan_cache_path(repo_a, url), utils.get_plan_cache_path(repo_b, url)
        )
        self.assertNotEqual(state_a, state_b)


# ── 2. TTL cleanup ─────────────────────────────────────────────────────────

class TtlCleanupTest(JobsTableMixin, unittest.TestCase):
    def test_expired_job_dirs_removed_and_fresh_job_left_alone(self):
        fresh = self.add_job(
            "fresh",
            output_files={"src/App.jsx": "fresh"},
            created_at=time.time(),
        )
        expired = self.add_job(
            "expired",
            output_files={"src/App.jsx": "stale"},
            created_at=time.time() - main.JOB_TTL_SECONDS - 10,
        )
        # A job whose repo dir vanished already must not break cleanup.
        ghost = self.add_job("ghost", created_at=time.time() - main.JOB_TTL_SECONDS - 10)
        shutil.rmtree(ghost["repo_path"], ignore_errors=True)

        # Generation-state files for both jobs exist under backend/.cache/.
        fresh_state = utils.get_generation_state_path(fresh["repo_path"])
        expired_state = utils.get_generation_state_path(expired["repo_path"])
        for path in (fresh_state, expired_state):
            path.write_text(json.dumps({"plan_fingerprint": "x", "generated": []}), encoding="utf-8")
            self.addCleanup(lambda p=path: p.unlink(missing_ok=True))

        removed = main.cleanup_expired_jobs()

        self.assertGreaterEqual(removed, 2)
        for job_id in (expired["job_id"], ghost["job_id"]):
            self.assertNotIn(job_id, main._jobs)
        self.assertFalse(expired["repo_path"].exists())
        self.assertFalse(expired["output_dir"].exists())
        self.assertFalse(expired_state.exists())

        # Fresh job untouched: registered, clone dir and output intact.
        self.assertIn(fresh["job_id"], main._jobs)
        self.assertTrue(fresh["repo_path"].exists())
        self.assertTrue((fresh["output_dir"] / "src" / "App.jsx").is_file())
        self.assertTrue(fresh_state.exists())


# ── 3. Concurrency semaphore ───────────────────────────────────────────────

class ConcurrencyLimitTest(JobsTableMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self._saved_limits = (
            main._migrate_semaphore,
            main._migration_limiter,
            main._daily_cap,
        )
        # MAX_CONCURRENT_MIGRATIONS=1 semantics under test; limits off so the
        # busy verdict can only come from the semaphore.
        main._migrate_semaphore = main._build_semaphore(1)
        main._migration_limiter = main.SlidingWindowLimiter(0)
        main._daily_cap = main.DailyCounter(0)
        self.addCleanup(self._restore_limits)

    def _restore_limits(self):
        (main._migrate_semaphore, main._migration_limiter, main._daily_cap) = self._saved_limits

    def test_second_concurrent_migrate_gets_busy_and_slot_is_released(self):
        job_a = self.add_job("a")
        job_b = self.add_job("b")
        release = threading.Event()

        def blocking_stream(*args, **kwargs):
            yield {"type": "info", "message": "started"}
            if not release.wait(timeout=10):
                raise AssertionError("test never released the first migration")
            yield {"type": "execution_complete", "results": []}

        with mock.patch.object(main, "execute_plan_stream", side_effect=blocking_stream):
            first = main.migrate_generator(job_a, resume=False, requester="1.1.1.1")
            self.assertEqual(next(first)["message"], "started")

            # Slot is held: a second, different client is turned away with the
            # busy error event on the normal error path.
            busy = list(main.migrate_generator(job_b, resume=False, requester="2.2.2.2"))
            self.assertEqual(len(busy), 1)
            self.assertEqual(busy[0]["type"], "error")
            self.assertEqual(busy[0]["message"], main.BUSY_MESSAGE)

            release.set()
            tail = list(first)
            self.assertTrue(any(e["type"] == "execution_complete" for e in tail))

            # First run finished -> the slot is free again.
            third = list(main.migrate_generator(job_b, resume=False, requester="3.3.3.3"))
            self.assertFalse(any(e.get("message") == main.BUSY_MESSAGE for e in third))

        self.assertTrue(main._migrate_semaphore.acquire(blocking=False))
        main._migrate_semaphore.release()

    def test_slot_released_when_run_raises(self):
        job = self.add_job("boom")

        def raising_stream(*args, **kwargs):
            yield {"type": "info", "message": "started"}
            raise RuntimeError("model exploded")

        with mock.patch.object(main, "execute_plan_stream", side_effect=raising_stream):
            with self.assertRaises(RuntimeError):
                list(main.migrate_generator(job, resume=False, requester="1.1.1.1"))

        self.assertTrue(main._migrate_semaphore.acquire(blocking=False))
        main._migrate_semaphore.release()

    def test_slot_released_when_generator_closed_early(self):
        """Client disconnect closes the generator mid-run — finally must fire."""
        job = self.add_job("gone")

        def blocking_stream(*args, **kwargs):
            yield {"type": "info", "message": "started"}
            yield {"type": "file_start", "file": "a.js", "new_path": "src/A.jsx"}

        with mock.patch.object(main, "execute_plan_stream", side_effect=blocking_stream):
            gen = main.migrate_generator(job, resume=False, requester="1.1.1.1")
            self.assertEqual(next(gen)["message"], "started")
            gen.close()

        self.assertTrue(main._migrate_semaphore.acquire(blocking=False))
        main._migrate_semaphore.release()

    def test_zero_concurrency_limit_disables_the_cap(self):
        unlimited = main._build_semaphore(0)
        self.assertTrue(unlimited.acquire(blocking=False))
        self.assertTrue(unlimited.acquire(blocking=False))
        unlimited.release()


# ── 4. Per-IP limiter and daily cap ────────────────────────────────────────

class SlidingWindowLimiterTest(unittest.TestCase):
    def test_allow_deny_boundaries_and_window_expiry_with_fake_clock(self):
        clock = [1_000_000.0]
        limiter = main.SlidingWindowLimiter(3, window_seconds=3600.0, now_fn=lambda: clock[0])

        # Under the limit -> allowed, and every attempt is counted.
        for _ in range(3):
            self.assertIsNone(limiter.retry_after("ip"))
            limiter.hit("ip")
        self.assertEqual(limiter.used("ip"), 3)

        # At the boundary -> denied, with a positive wait that shrinks as the
        # window ages.
        wait = limiter.retry_after("ip")
        self.assertIsNotNone(wait)
        self.assertGreater(wait, 0)
        clock[0] += 3590.0
        wait = limiter.retry_after("ip")
        self.assertGreaterEqual(wait, 0)
        self.assertLess(wait, 10.1)

        # Once the oldest event falls out of the window -> allowed again.
        clock[0] += 20.0
        self.assertIsNone(limiter.retry_after("ip"))
        for _ in range(3):  # refill to the limit
            limiter.hit("ip")
        self.assertIsNotNone(limiter.retry_after("ip"))

    def test_zero_limit_disables(self):
        limiter = main.SlidingWindowLimiter(0)
        for _ in range(50):
            limiter.hit("ip")
            self.assertIsNone(limiter.retry_after("ip"))
        self.assertEqual(limiter.used("ip"), 0)

    def test_keys_are_independent(self):
        clock = [1_000_000.0]
        limiter = main.SlidingWindowLimiter(1, now_fn=lambda: clock[0])
        limiter.hit("ip-a")
        self.assertIsNotNone(limiter.retry_after("ip-a"))
        self.assertIsNone(limiter.retry_after("ip-b"))


class DailyCounterTest(unittest.TestCase):
    def test_boundary_and_utc_midnight_reset(self):
        clock = [datetime(2026, 1, 1, 23, 59, 0, tzinfo=timezone.utc).timestamp()]
        daily = main.DailyCounter(2, now_fn=lambda: clock[0])

        self.assertFalse(daily.exceeded())
        daily.record()
        self.assertFalse(daily.exceeded())
        daily.record()  # at the cap
        self.assertTrue(daily.exceeded())
        daily.record()  # still over
        self.assertTrue(daily.exceeded())

        # UTC midnight rolls the budget over.
        clock[0] = datetime(2026, 1, 2, 0, 0, 1, tzinfo=timezone.utc).timestamp()
        self.assertFalse(daily.exceeded())

    def test_zero_cap_disables(self):
        daily = main.DailyCounter(0)
        for _ in range(50):
            daily.record()
            self.assertFalse(daily.exceeded())


class MigrateRateLimitIntegrationTest(JobsTableMixin, unittest.TestCase):
    """The limits ride the normal SSE error path, and resume never counts."""

    def setUp(self):
        super().setUp()
        self._saved_limits = (main._migrate_semaphore, main._migration_limiter, main._daily_cap)
        main._migrate_semaphore = main._build_semaphore(0)  # unlimited under test
        main._migration_limiter = main.SlidingWindowLimiter(0)
        main._daily_cap = main.DailyCounter(0)
        self.addCleanup(self._restore_limits)

    def _restore_limits(self):
        (main._migrate_semaphore, main._migration_limiter, main._daily_cap) = self._saved_limits

    @staticmethod
    def _done_stream(*args, **kwargs):
        yield {"type": "execution_complete", "results": []}

    def test_per_ip_migration_limit_denies_after_boundary_resume_not_counted(self):
        main._migration_limiter = main.SlidingWindowLimiter(1)
        job = self.add_job("lim")
        ip = "203.0.113.44"

        with mock.patch.object(main, "execute_plan_stream", side_effect=self._done_stream):
            # First migration allowed; resume of it also allowed (not counted).
            self.assertFalse(any(e["type"] == "error" for e in main.migrate_generator(job, False, ip)))
            self.assertFalse(any(e["type"] == "error" for e in main.migrate_generator(job, True, ip)))
            self.assertEqual(main._migration_limiter.used(ip), 1)

            # Second NEW migration for the same IP is denied with a message
            # saying how many minutes to wait.
            denied = list(main.migrate_generator(job, False, ip))
            self.assertEqual(len(denied), 1)
            self.assertEqual(denied[0]["type"], "error")
            self.assertIn("minute", denied[0]["message"])
            self.assertIn(str(main.MAX_MIGRATIONS_PER_HOUR_PER_IP), denied[0]["message"])

            # The denied attempt was not counted, and resume still works.
            self.assertEqual(main._migration_limiter.used(ip), 1)
            self.assertFalse(any(e["type"] == "error" for e in main.migrate_generator(job, True, ip)))

    def test_daily_cap_denies_and_resume_does_not_consume(self):
        main._daily_cap = main.DailyCounter(1)
        job = self.add_job("daily")

        with mock.patch.object(main, "execute_plan_stream", side_effect=self._done_stream):
            # A resume runs first and must not spend the day's budget.
            self.assertFalse(any(e["type"] == "error" for e in main.migrate_generator(job, True, "9.9.9.9")))
            self.assertFalse(any(e["type"] == "error" for e in main.migrate_generator(job, False, "9.9.9.9")))

            denied = list(main.migrate_generator(job, False, "9.9.9.9"))
            self.assertEqual(denied, [{"type": "error", "message": main.DAILY_CAP_MESSAGE}])

    def test_disabled_limits_allow_everything(self):
        main._migration_limiter = main.SlidingWindowLimiter(0)
        main._daily_cap = main.DailyCounter(0)
        job = self.add_job("off")
        with mock.patch.object(main, "execute_plan_stream", side_effect=self._done_stream):
            for _ in range(20):
                events = main.migrate_generator(job, False, "8.8.8.8")
                self.assertFalse(any(e["type"] == "error" for e in events))

    def test_plan_limit_denies_before_clone(self):
        main._plan_limiter = main.SlidingWindowLimiter(1)
        self.addCleanup(lambda: setattr(main, "_plan_limiter", main.SlidingWindowLimiter(main.MAX_PLANS_PER_HOUR_PER_IP)))
        ip = "198.51.100.55"
        main._plan_limiter.hit(ip)  # quota already spent

        with mock.patch.object(main, "clone_repo") as clone_mock:
            response = asyncio.run(main.stream_plan(request=make_request(ip=ip), repo_url="https://github.com/x/y"))
            events = parse_sse(asyncio.run(collect_body(response)))

        clone_mock.assert_not_called()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "error")
        self.assertIn("minute", events[0]["message"])
        self.assertIn("plan requests", events[0]["message"])

    def test_client_ip_prefers_first_x_forwarded_for_address(self):
        self.assertEqual(main.client_ip(make_request(ip="10.0.0.1", forwarded="1.2.3.4, 5.6.7.8")), "1.2.3.4")
        self.assertEqual(main.client_ip(make_request(ip="10.0.0.1")), "10.0.0.1")


# ── Plan stream: job event ordering, no cross-session deletion ────────────

class PlanJobEventTest(JobsTableMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self._saved_plan_limiter = main._plan_limiter
        main._plan_limiter = main.SlidingWindowLimiter(0)
        self.addCleanup(setattr, main, "_plan_limiter", self._saved_plan_limiter)

    def test_job_event_emitted_after_clone_before_planning_and_old_repo_kept(self):
        previous = self.add_job("previous")  # another user's in-flight session

        clone_dir = self.tmp / "fresh-clone"
        clone_dir.mkdir()

        def fake_plan_stream(repo_path, force_refresh=False, cache_key=None):
            yield {"type": "info", "message": "analyzing"}
            yield {"type": "plan_complete", "plan": {"files": [], "overall_notes": ""}}

        with mock.patch.object(main, "clone_repo", side_effect=lambda url: clone_dir), \
                mock.patch.object(main, "get_migration_plan_stream", side_effect=fake_plan_stream):
            response = asyncio.run(
                main.stream_plan(request=make_request(ip="198.51.100.99"), repo_url="https://github.com/x/y")
            )
            events = parse_sse(asyncio.run(collect_body(response)))

        types = [e["type"] for e in events]
        self.assertEqual(types[0], "progress")
        self.assertIn("job", types)
        self.assertIn("plan_complete", types)
        job_event = next(e for e in events if e["type"] == "job")
        # Job is announced before any planning events...
        self.assertLess(types.index("job"), types.index("plan_complete"))
        # ...and it is registered with an output dir under the output base.
        job = main._jobs.get(job_event["job_id"])
        self.assertIsNotNone(job)
        self.assertEqual(job["repo_path"], clone_dir)
        self.assertTrue(str(job["output_dir"]).startswith(str(main.BASE_OUTPUT_DIR)))

        # The previous session's clone was NOT deleted by this plan request.
        self.assertIn(previous["job_id"], main._jobs)
        self.assertTrue(previous["repo_path"].exists())


# ── 5. SSE keepalive ───────────────────────────────────────────────────────

class KeepaliveTest(unittest.TestCase):
    def test_slow_generator_yields_keepalive_comments_between_events(self):
        def slow_generator():
            yield {"type": "info", "message": "first"}
            time.sleep(0.3)
            yield {"type": "info", "message": "second"}

        saved = main.KEEPALIVE_INTERVAL
        main.KEEPALIVE_INTERVAL = 0.05
        try:
            stream = main.stream_generator_in_thread(slow_generator)

            async def run():
                chunks = []
                async for chunk in stream:
                    chunks.append(chunk)
                return chunks

            chunks = asyncio.run(asyncio.wait_for(run(), timeout=10))
        finally:
            main.KEEPALIVE_INTERVAL = saved

        text = "".join(chunks)
        self.assertIn('"first"', text)
        self.assertIn('"second"', text)
        self.assertIn(": keepalive\n\n", text)
        # At least one keepalive landed in the silent gap between the events.
        between = text[text.index('"first"'):text.index('"second"')]
        self.assertIn(": keepalive", between)


# ── 6. CORS env parsing ────────────────────────────────────────────────────

class CorsConfigTest(unittest.TestCase):
    def test_default_when_unset(self):
        self.assertEqual(
            main.parse_allowed_origins(None),
            ["http://localhost:5173", "http://127.0.0.1:5173"],
        )

    def test_whitespace_trailing_commas_and_empty_entries(self):
        self.assertEqual(
            main.parse_allowed_origins("  https://a.example , , https://b.example ,, "),
            ["https://a.example", "https://b.example"],
        )
        self.assertEqual(main.parse_allowed_origins("http://one"), ["http://one"])

    def test_allow_origin_regex_only_passed_when_set(self):
        kwargs = main.build_cors_kwargs(["https://a.example"], None)
        self.assertNotIn("allow_origin_regex", kwargs)
        self.assertEqual(kwargs["allow_origins"], ["https://a.example"])
        self.assertEqual(kwargs["allow_methods"], ["*"])

        kwargs = main.build_cors_kwargs(["https://a.example"], r"https://.*\.example\.com")
        self.assertEqual(kwargs["allow_origin_regex"], r"https://.*\.example\.com")

    def test_app_has_cors_middleware(self):
        from fastapi.middleware.cors import CORSMiddleware
        self.assertTrue(
            any(getattr(middleware, "cls", None) is CORSMiddleware for middleware in main.app.user_middleware)
        )

    def test_env_int_parsing(self):
        with mock.patch.dict(os.environ, {"_TEST_INT": "17"}):
            self.assertEqual(main._env_int("_TEST_INT", 3), 17)
        with mock.patch.dict(os.environ, {"_TEST_INT": "not-a-number"}):
            self.assertEqual(main._env_int("_TEST_INT", 3), 3)
        with mock.patch.dict(os.environ, {"_TEST_INT": "  "}):
            self.assertEqual(main._env_int("_TEST_INT", 3), 3)
        self.assertEqual(main._env_int("_TEST_INT_NEVER_SET", 3), 3)


# ── Executor per-job output_path ───────────────────────────────────────────

class ExecutorOutputPathTest(unittest.TestCase):
    """output_path routes files to a per-job dir; default (None) keeps the
    old OUTPUT_PATH behaviour for the CLI and older callers."""

    PLAN = {
        "files": [
            {
                "path": "src/app.jsx",
                "new_path": "src/App.jsx",
                "priority": 1,
                "depends_on": [],
                "migration_notes": "Convert it.",
            },
            {
                "path": "src/extra.jsx",
                "new_path": "src/_unused_extra.jsx.txt",
                "priority": 2,
                "depends_on": [],
                "migration_notes": "Placeholder.",
            },
        ],
        "overall_notes": "test plan",
    }

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="legacy-modernizer-outpath-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.url = "https://github.com/example/outpath"
        self.state_paths: list[Path] = []

        patchers = [
            mock.patch.object(executor, "migrate_file", side_effect=lambda o, n, notes, content, html_reference=None: f"// migrated {n}"),
            mock.patch.object(executor, "fix_file_with_build_error", side_effect=RuntimeError("no fix expected")),
            mock.patch.object(executor, "build_base_checkpoint", return_value="cp"),
            mock.patch.object(executor, "write_all_files", side_effect=lambda cp, migrated: cp),
            mock.patch.object(executor, "run_build", return_value=(True, "ok")),
            mock.patch.object(executor, "run_lint", return_value=(True, "ok")),
            mock.patch("time.sleep"),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def _make_job(self, name: str):
        repo = self.tmp / f"{name}-repo"
        (repo / "src").mkdir(parents=True)
        (repo / "src" / "app.jsx").write_text("var x = 1;", encoding="utf-8")
        (repo / "src" / "extra.jsx").write_text("var y = 2;", encoding="utf-8")
        out = self.tmp / f"{name}-output"

        plan_cache = utils.get_plan_cache_path(repo, self.url)
        plan_cache.write_text(json.dumps(self.PLAN), encoding="utf-8")
        self.addCleanup(lambda p=plan_cache: p.unlink(missing_ok=True))
        state_path = utils.get_generation_state_path(repo, self.url)
        self.state_paths.append(state_path)
        self.addCleanup(lambda p=state_path: p.unlink(missing_ok=True))
        return repo, out, state_path

    def test_output_path_routes_files_to_the_jobs_own_dir(self):
        repo_a, out_a, state_a = self._make_job("a")
        repo_b, out_b, state_b = self._make_job("b")

        events = list(executor.execute_plan_stream(repo_a, cache_key=self.url, output_path=out_a))
        self.assertFalse(any(e["type"] == "error" for e in events))
        self.assertTrue((out_a / "src" / "App.jsx").is_file())
        self.assertFalse(out_b.exists())

        events = list(executor.execute_plan_stream(repo_b, cache_key=self.url, output_path=out_b))
        self.assertFalse(any(e["type"] == "error" for e in events))
        self.assertTrue((out_b / "src" / "App.jsx").is_file())

        # Separate progress state per job, even though the URL (plan cache)
        # is shared: repo_path is unique per clone, so the state files differ.
        self.assertNotEqual(state_a, state_b)
        self.assertTrue(state_a.is_file())
        self.assertTrue(state_b.is_file())

        # Job A's output was never touched by job B's fresh-run wipe.
        self.assertTrue((out_a / "src" / "App.jsx").is_file())

    def test_output_path_none_falls_back_to_module_output_path(self):
        repo, _, _ = self._make_job("default")
        fallback = self.tmp / "module-output"
        with mock.patch.object(executor, "OUTPUT_PATH", fallback):
            list(executor.execute_plan_stream(repo, cache_key=self.url))
        self.assertTrue((fallback / "src" / "App.jsx").is_file())


# ── ASGI wiring (in-process TestClient: no sockets, no servers) ────────────

class AsgiWiringTest(JobsTableMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self._saved_plan_limiter = main._plan_limiter
        main._plan_limiter = main.SlidingWindowLimiter(0)
        self.addCleanup(setattr, main, "_plan_limiter", self._saved_plan_limiter)

    def _fake_clone(self, url):
        clone_dir = Path(tempfile.mkdtemp(prefix="legacy-modernizer-wire-"))
        self.addCleanup(shutil.rmtree, clone_dir, True)
        (clone_dir / "app.js").write_text("$(document).ready(function(){});", encoding="utf-8")
        return clone_dir

    @staticmethod
    def _fake_plan(repo_path, force_refresh=False, cache_key=None):
        yield {"type": "plan_complete", "plan": {"files": [], "overall_notes": ""}}

    def test_plan_stream_sse_headers_cors_and_job_event(self):
        from fastapi.testclient import TestClient

        client = TestClient(main.app)
        allowed_origin = main.ALLOWED_ORIGINS[0] if main.ALLOWED_ORIGINS else None
        with mock.patch.object(main, "clone_repo", side_effect=self._fake_clone), \
                mock.patch.object(main, "get_migration_plan_stream", side_effect=self._fake_plan):
            response = client.get(
                "/api/plan/stream",
                params={"repo_url": "https://github.com/x/y"},
                headers={"Origin": allowed_origin} if allowed_origin else {},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("cache-control"), "no-cache")
        self.assertEqual(response.headers.get("x-accel-buffering"), "no")
        self.assertEqual(response.headers.get("connection"), "keep-alive")
        if allowed_origin:
            self.assertEqual(response.headers.get("access-control-allow-origin"), allowed_origin)

        events = parse_sse(response.text)
        types = [e["type"] for e in events]
        self.assertIn("job", types)
        self.assertIn("plan_complete", types)
        self.assertLess(types.index("job"), types.index("plan_complete"))

    def test_download_unknown_job_is_http_404_through_asgi(self):
        from fastapi.testclient import TestClient

        client = TestClient(main.app)
        missing = client.get("/api/download/zip")  # no job_id at all
        self.assertEqual(missing.status_code, 404)
        self.assertIn("error", missing.json())

        unknown = client.get("/api/download/zip", params={"job_id": "nope"})
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.json()["error"], main.EXPIRED_SESSION_MESSAGE)

    def test_migrate_without_job_emits_expired_error_through_asgi(self):
        from fastapi.testclient import TestClient

        client = TestClient(main.app)
        response = client.get("/api/migrate/stream")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers.get("cache-control"), "no-cache")
        events = parse_sse(response.text)
        self.assertEqual(events, [{"type": "error", "message": main.EXPIRED_SESSION_MESSAGE}])


# ── 6b. Secrets / stack-trace hygiene ──────────────────────────────────────

class SecretsHygieneTest(unittest.TestCase):
    def test_sse_messages_redact_configured_secrets(self):
        for var in ("NEBIUS_API_KEY", "TAVILY_API_KEY"):
            secret = os.environ.get(var)
            self.assertTrue(secret and len(secret) >= 8, f"{var} not set for test")
            rendered = main.sse_format({"type": "error", "message": f"boom: {secret} rejected"})
            self.assertNotIn(secret, rendered)
            self.assertIn("***", rendered)

    def test_no_endpoint_builds_a_raw_traceback(self):
        backend = Path(__file__).resolve().parent
        for name in ("main.py", "planner.py", "executor.py", "repo_fetch.py", "utils.py"):
            source = (backend / name).read_text(encoding="utf-8")
            self.assertNotIn("format_exc", source, name)
            self.assertNotIn("traceback.", source, name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
