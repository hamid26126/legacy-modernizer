"""Unit tests for generation timeouts and resume/retry state (executor.py, main.py).

No network, no live migration, no servers: the model call, the retry delay and
the sandbox verification are all stubbed. Run from backend/:

    python -m unittest test_resume_logic -v

Deliberately NOT run via `python -m unittest discover` — the older test_*.py
scripts in this folder execute live builds/models at import time.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import utils  # noqa: E402
import executor  # noqa: E402


# ── Stubs ──────────────────────────────────────────────────────────────────

class ModelStub:
    """Stand-in for executor.migrate_file: records every call and can be told
    to raise a timeout for specific original paths."""

    def __init__(self):
        self.calls: list[str] = []
        self.fail_paths: set[str] = set()

    def __call__(self, original_path, new_path, migration_notes, original_content, html_reference=None):
        self.calls.append(original_path)
        if original_path in self.fail_paths:
            raise TimeoutError("simulated 120s request timeout")
        return f"// migrated {new_path} from {original_path}\n"

    def reset(self):
        self.calls.clear()
        self.fail_paths.clear()


class SandboxStub:
    """Stand-in for the sandbox verification helpers — always controllable,
    never touches a real sandbox."""

    def __init__(self):
        self.build_result = (True, "vite build ok")
        self.lint_result = (True, "eslint ok")
        self.build_calls = 0
        self.migrated_seen: dict = {}

    def checkpoint(self):
        return "checkpoint"

    def write_all(self, cp, migrated):
        self.migrated_seen = dict(migrated)
        return cp

    def build(self, cp):
        self.build_calls += 1
        return self.build_result

    def lint(self, cp):
        return self.lint_result


class FixStub:
    """Stand-in for fix_file_with_build_error — a failing build must never be
    able to reach the real model from a unit test."""

    def __init__(self):
        self.calls: list[tuple] = []

    def __call__(self, original_path, new_path, current_content, notes, build_error):
        self.calls.append((original_path, new_path))
        return f"// fixed {new_path}\n"


class RecordingClient:
    """Stand-in for the OpenAI client that records with_options() overrides."""

    def __init__(self):
        self.with_options_calls: list[dict] = []
        self.create_calls: list[dict] = []

    def with_options(self, **kwargs):
        self.with_options_calls.append(kwargs)
        return self

    @property
    def chat(self):
        return self

    @property
    def completions(self):
        return self

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        message = SimpleNamespace(content="export default function Component() { return null }")
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


# ── Shared fixtures ────────────────────────────────────────────────────────

# .jsx original paths on purpose: normalize_plan only reassigns new_path for
# .js/.html/.css entries, so every one of these stays a model-migrated file.
FIVE_FILES = [
    ("src/alpha.jsx", "src/Alpha.jsx"),
    ("src/beta.jsx", "src/Beta.jsx"),
    ("src/gamma.jsx", "src/Gamma.jsx"),
    ("src/delta.jsx", "src/Delta.jsx"),
    ("src/epsilon.jsx", "src/Epsilon.jsx"),
]

FIXTURE_FILES = [
    ("index.html", "index.html"),
    ("style.css", "src/index.css"),
    ("app.js", "src/App.jsx"),
    ("extra.js", "src/_unused_extra.jsx.txt"),
]


def five_file_plan():
    return {
        "files": [
            {
                "path": p,
                "new_path": n,
                "priority": i + 1,
                "depends_on": [],
                "migration_notes": f"Convert {p} to React.",
            }
            for i, (p, n) in enumerate(FIVE_FILES)
        ],
        "overall_notes": "unit test plan",
    }


def fixture_plan():
    return {
        "files": [
            {
                "path": p,
                "new_path": n,
                "priority": i + 1,
                "depends_on": [],
                "migration_notes": f"Convert {p} to React.",
            }
            for i, (p, n) in enumerate(FIXTURE_FILES)
        ],
        "overall_notes": "fixture plan",
    }


def events_of(events, etype):
    return [e for e in events if e["type"] == etype]


class ExecutorTestCase(unittest.TestCase):
    """Common setup: temp repo + temp output dir, stubbed model/sandbox/sleep."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="legacy-modernizer-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        self.output = self.tmp / "output"
        self.cache_key = f"resume-test-{uuid.uuid4().hex}"
        self.state_path = utils.get_generation_state_path(self.repo, self.cache_key)
        self.plan_cache = utils.get_plan_cache_path(self.repo, self.cache_key)
        self.addCleanup(lambda: self.state_path.unlink(missing_ok=True))
        self.addCleanup(lambda: self.state_path.with_name(self.state_path.name + ".tmp").unlink(missing_ok=True))
        self.addCleanup(lambda: self.plan_cache.unlink(missing_ok=True))

        self.model = ModelStub()
        self.sandbox = SandboxStub()
        self.fixer = FixStub()

        for patcher in (
            mock.patch.object(executor, "OUTPUT_PATH", self.output),
            mock.patch.object(executor, "migrate_file", self.model),
            mock.patch.object(executor, "fix_file_with_build_error", self.fixer),
            mock.patch.object(executor, "build_base_checkpoint", self.sandbox.checkpoint),
            mock.patch.object(executor, "write_all_files", self.sandbox.write_all),
            mock.patch.object(executor, "run_build", self.sandbox.build),
            mock.patch.object(executor, "run_lint", self.sandbox.lint),
            mock.patch("time.sleep"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_plan(self, plan):
        for f in plan["files"]:
            source = self.repo / f["path"]
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(f"// original {f['path']}\n", encoding="utf-8")
        self.plan_cache.write_text(json.dumps(plan), encoding="utf-8")

    def run_stream(self, resume=False):
        return list(executor.execute_plan_stream(self.repo, cache_key=self.cache_key, resume=resume))

    def run_stream_default_resume(self):
        """Call the way the CLI/older callers do: no resume kwarg at all."""
        return list(executor.execute_plan_stream(self.repo, cache_key=self.cache_key))

    def expected_fingerprint(self):
        return utils.plan_fingerprint(executor.load_plan(self.repo, self.cache_key))

    def load_state(self):
        return utils.load_generation_state(self.state_path)


# ── 1. Fresh run with timeouts ────────────────────────────────────────────

class FreshRunTimeoutTest(ExecutorTestCase):
    def test_two_of_five_timeout_no_early_abort(self):
        plan = five_file_plan()
        self.write_plan(plan)
        self.model.fail_paths = {"src/beta.jsx", "src/delta.jsx"}

        events = self.run_stream()

        # Every remaining file was still attempted after the failures.
        self.assertEqual(len(events_of(events, "file_start")), 5)
        self.assertEqual(len(events_of(events, "file_error")), 2)
        self.assertEqual(len(events_of(events, "file_generated")), 3)

        # retries=1 -> exactly 2 attempts for a failing file, 1 for a healthy one.
        self.assertEqual(self.model.calls.count("src/beta.jsx"), 2)
        self.assertEqual(self.model.calls.count("src/delta.jsx"), 2)
        for healthy in ("src/alpha.jsx", "src/gamma.jsx", "src/epsilon.jsx"):
            self.assertEqual(self.model.calls.count(healthy), 1)

        # The 3 healthy files are on disk, the 2 failures are not.
        for new_path in ("src/Alpha.jsx", "src/Gamma.jsx", "src/Epsilon.jsx"):
            written = self.output / new_path
            self.assertTrue(written.is_file(), f"{new_path} missing")
            self.assertTrue(written.read_text(encoding="utf-8"))
        for new_path in ("src/Beta.jsx", "src/Delta.jsx"):
            self.assertFalse((self.output / new_path).exists())

        # State file written, matching fingerprint, only successes recorded.
        state = self.load_state()
        self.assertIsNotNone(state)
        self.assertEqual(state["plan_fingerprint"], self.expected_fingerprint())
        self.assertEqual(
            sorted(state["generated"]),
            ["src/Alpha.jsx", "src/Epsilon.jsx", "src/Gamma.jsx"],
        )

        # Per-file statuses: 3 generated + 2 generation_failed, not all failed.
        errors = events_of(events, "error")
        self.assertEqual(len(errors), 1)
        self.assertIn("One or more files failed to generate", errors[0]["message"])
        complete = events_of(events, "execution_complete")[0]
        statuses = {r["new_path"]: r["status"] for r in complete["results"]}
        self.assertEqual(
            {p: s for p, s in statuses.items() if s == "generated"},
            {"src/Alpha.jsx": "generated", "src/Gamma.jsx": "generated", "src/Epsilon.jsx": "generated"},
        )
        self.assertEqual(
            {p: s for p, s in statuses.items() if s == "generation_failed"},
            {"src/Beta.jsx": "generation_failed", "src/Delta.jsx": "generation_failed"},
        )
        self.assertFalse(complete["verified"])
        self.assertEqual(complete["build_attempts"], 0)

        # Verification is skipped when generation failed.
        self.assertEqual(events_of(events, "verify_start"), [])


# ── 2. Resume of the same plan ────────────────────────────────────────────

class ResumeSamePlanTest(ExecutorTestCase):
    def _run_fresh_with_two_failures(self):
        self.write_plan(five_file_plan())
        self.model.fail_paths = {"src/beta.jsx", "src/delta.jsx"}
        fresh_events = self.run_stream()
        self.model.reset()
        return fresh_events

    def test_resume_only_calls_model_for_failed_files(self):
        self._run_fresh_with_two_failures()

        events = self.run_stream(resume=True)

        # Only the 2 previously-failed files hit the model — once each.
        self.assertEqual(self.model.calls, ["src/beta.jsx", "src/delta.jsx"])

        # The 3 healthy files were reused from disk, with reused:True, and
        # never even got a file_start (their cards must not leave "Generated").
        reused = [e for e in events_of(events, "file_generated") if e.get("reused")]
        self.assertEqual(
            {e["file"] for e in reused},
            {"src/alpha.jsx", "src/gamma.jsx", "src/epsilon.jsx"},
        )
        self.assertTrue(all(e["reused"] is True for e in reused))
        started = {e["file"] for e in events_of(events, "file_start")}
        self.assertEqual(started, {"src/beta.jsx", "src/delta.jsx"})

        # Reused content came back from disk, not from the model.
        for event in reused:
            on_disk = (self.output / event["new_path"]).read_text(encoding="utf-8")
            self.assertIn(f"migrated {event['new_path']} from {event['file']}", on_disk)

        # All 5 now recorded, and the run went on to verification successfully.
        state = self.load_state()
        self.assertEqual(len(state["generated"]), 5)
        self.assertEqual(state["plan_fingerprint"], self.expected_fingerprint())
        self.assertTrue(events_of(events, "verify_start"))
        complete = events_of(events, "execution_complete")[0]
        self.assertTrue(complete["verified"])
        self.assertEqual({r["status"] for r in complete["results"]}, {"pass"})

    def test_resume_regenerates_file_that_is_empty_on_disk(self):
        self.write_plan(five_file_plan())
        self.run_stream()
        (self.output / "src/Gamma.jsx").write_text("", encoding="utf-8")
        self.model.reset()

        events = self.run_stream(resume=True)

        self.assertEqual(self.model.calls, ["src/gamma.jsx"])
        self.assertTrue((self.output / "src/Gamma.jsx").read_text(encoding="utf-8"))
        self.assertTrue(events_of(events, "verify_start"))


# ── 3. Resume with a changed plan ─────────────────────────────────────────

class ResumeChangedPlanTest(ExecutorTestCase):
    def test_changed_fingerprint_falls_back_to_fresh_run(self):
        plan = five_file_plan()
        self.write_plan(plan)
        self.model.fail_paths = {"src/beta.jsx", "src/delta.jsx"}
        self.run_stream()
        self.model.reset()

        # Same repo/URL, different plan content -> different fingerprint.
        plan["files"][0]["migration_notes"] = "Rewritten migration notes."
        self.write_plan(plan)
        # A stale file from the old run must not survive the fresh fallback.
        self.output.mkdir(parents=True, exist_ok=True)
        (self.output / "stale.txt").write_text("stale", encoding="utf-8")

        events = self.run_stream(resume=True)

        self.assertFalse((self.output / "stale.txt").exists())
        self.assertEqual([e for e in events_of(events, "file_generated") if e.get("reused")], [])
        self.assertEqual(sorted(self.model.calls), sorted(p for p, _ in FIVE_FILES))
        state = self.load_state()
        self.assertEqual(state["plan_fingerprint"], self.expected_fingerprint())
        self.assertEqual(len(state["generated"]), 5)

    def test_resume_without_state_file_falls_back_to_fresh_run(self):
        self.write_plan(five_file_plan())
        self.assertFalse(self.state_path.exists())

        events = self.run_stream(resume=True)

        self.assertEqual(sorted(self.model.calls), sorted(p for p, _ in FIVE_FILES))
        self.assertEqual([e for e in events_of(events, "file_generated") if e.get("reused")], [])
        self.assertIsNotNone(self.load_state())


# ── 4. Resume when everything already exists ──────────────────────────────

class ResumeAllPresentTest(ExecutorTestCase):
    def test_zero_model_calls_goes_straight_to_verification(self):
        self.write_plan(five_file_plan())
        self.run_stream()
        self.model.reset()

        events = self.run_stream(resume=True)

        self.assertEqual(self.model.calls, [])
        reused = [e for e in events_of(events, "file_generated") if e.get("reused")]
        self.assertEqual(len(reused), 5)
        self.assertTrue(events_of(events, "verify_start"))
        complete = events_of(events, "execution_complete")[0]
        self.assertTrue(complete["verified"])
        # Fresh verification budgets for this run.
        self.assertEqual(complete["build_attempts"], 1)
        self.assertEqual(complete["lint_attempts"], 1)

    def test_retry_after_verification_failure_reuses_everything(self):
        self.write_plan(five_file_plan())
        self.sandbox.build_result = (False, "build broke")
        failed = self.run_stream()
        complete = events_of(failed, "execution_complete")[0]
        self.assertFalse(complete["verified"])
        self.model.reset()

        # Fix the build, retry: generation must be skipped entirely.
        self.sandbox.build_result = (True, "vite build ok")
        events = self.run_stream(resume=True)

        self.assertEqual(self.model.calls, [])
        self.assertTrue(events_of(events, "verify_start"))
        self.assertTrue(events_of(events, "execution_complete")[0]["verified"])


# ── Fixture flow: resume=False must be unchanged ──────────────────────────

class FixtureFlowUnchangedTest(ExecutorTestCase):
    def test_default_resume_wipes_output_resets_state_and_regenerates(self):
        plan = fixture_plan()
        self.write_plan(plan)

        # Simulate leftovers from an older run: a stale output file and a
        # stale state file pointing at a different plan.
        self.output.mkdir(parents=True, exist_ok=True)
        (self.output / "stale.txt").write_text("stale", encoding="utf-8")
        utils.save_generation_state(self.state_path, {"plan_fingerprint": "bogus", "generated": ["stale.txt"]})

        events = self.run_stream_default_resume()

        # Fresh-run behaviour, byte for byte as before: output wiped, state reset.
        self.assertFalse((self.output / "stale.txt").exists())
        state = self.load_state()
        self.assertEqual(state["plan_fingerprint"], self.expected_fingerprint())
        self.assertEqual(
            state["generated"],
            ["index.html", "src/index.css", "src/App.jsx", "src/_unused_extra.jsx.txt"],
        )

        # index.html is built deterministically, not by the model.
        index_html = (self.output / "index.html").read_text(encoding="utf-8")
        self.assertIn('<div id="root"></div>', index_html)
        # _unused_ placeholder behaves as today.
        placeholder = (self.output / "src/_unused_extra.jsx.txt").read_text(encoding="utf-8")
        self.assertIn("Not migrated separately", placeholder)
        # Only the two real source files hit the model, and nothing was reused.
        self.assertEqual(self.model.calls, ["style.css", "app.js"])
        self.assertEqual([e for e in events_of(events, "file_generated") if e.get("reused")], [])

        # And the run still proceeds to verification as it always did.
        self.assertTrue(events_of(events, "verify_start"))
        self.assertTrue(events_of(events, "execution_complete")[0]["verified"])


# ── Timeout configuration (requirement 1) ─────────────────────────────────

class TimeoutConfigTest(unittest.TestCase):
    def test_migrate_file_uses_120s_timeout(self):
        client = RecordingClient()
        with mock.patch.object(executor, "client", client):
            out = executor.migrate_file("src/a.jsx", "src/A.jsx", "notes", "var x = 1;")
        self.assertEqual(client.with_options_calls, [{"timeout": 120.0}])
        self.assertEqual(len(client.create_calls), 1)
        self.assertTrue(out)

    def test_fix_file_with_build_error_uses_120s_timeout(self):
        client = RecordingClient()
        current = "export default function Component() { return null }"
        with mock.patch.object(executor, "client", client):
            out = executor.fix_file_with_build_error(
                "src/a.jsx", "src/A.jsx", current, "notes", "some build error"
            )
        self.assertEqual(client.with_options_calls, [{"timeout": 120.0}])
        self.assertEqual(len(client.create_calls), 1)
        self.assertTrue(out)

    def test_build_fix_retries_are_capped_at_two_attempts(self):
        """The verification-phase fixer is also wrapped with retries=1."""
        model = ModelStub()
        sandbox = SandboxStub()
        sandbox.build_result = (False, "boom: something broke")
        tmp = Path(tempfile.mkdtemp(prefix="legacy-modernizer-fix-test-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        repo = tmp / "repo"
        repo.mkdir()
        output = tmp / "output"
        cache_key = f"fix-test-{uuid.uuid4().hex}"
        state_path = utils.get_generation_state_path(repo, cache_key)
        plan_cache = utils.get_plan_cache_path(repo, cache_key)
        self.addCleanup(lambda: state_path.unlink(missing_ok=True))
        self.addCleanup(lambda: plan_cache.unlink(missing_ok=True))

        plan = five_file_plan()
        for f in plan["files"]:
            source = repo / f["path"]
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(f"// original {f['path']}\n", encoding="utf-8")
        plan_cache.write_text(json.dumps(plan), encoding="utf-8")

        fix_stub = mock.Mock(side_effect=RuntimeError("fix model timeout"))
        with mock.patch.object(executor, "OUTPUT_PATH", output), \
                mock.patch.object(executor, "migrate_file", model), \
                mock.patch.object(executor, "fix_file_with_build_error", fix_stub), \
                mock.patch.object(executor, "build_base_checkpoint", sandbox.checkpoint), \
                mock.patch.object(executor, "write_all_files", sandbox.write_all), \
                mock.patch.object(executor, "run_build", sandbox.build), \
                mock.patch.object(executor, "run_lint", sandbox.lint), \
                mock.patch.object(executor, "guess_broken_files", lambda out, keys: [keys[0]]), \
                mock.patch("time.sleep"):
            events = list(executor.execute_plan_stream(repo, cache_key=cache_key))

        # One apply_fix pass (nothing fixable -> retry loop stops) x retries=1
        # -> exactly 2 fix attempts, never 3.
        self.assertEqual(fix_stub.call_count, 2)
        self.assertTrue(events_of(events, "verify_start"))
        self.assertFalse(events_of(events, "execution_complete")[0]["verified"])


# ── main.py resume pass-through ───────────────────────────────────────────

class MainResumeParamTest(unittest.TestCase):
    def test_stream_migrate_forwards_resume_and_cache_key(self):
        import main

        captured = {}
        calls = []

        def fake_stream_generator_in_thread(gen_func):
            captured["gen_func"] = gen_func

            async def empty_stream():
                yield ""

            return empty_stream()

        def fake_execute_plan_stream(*args, **kwargs):
            calls.append((args, kwargs))
            return iter([])

        previous_repo = main._last_repo_path
        previous_url = main._last_repo_url
        try:
            main._last_repo_path = Path("C:/tmp/some-repo")
            main._last_repo_url = "https://github.com/example/repo"
            with mock.patch.object(main, "stream_generator_in_thread", side_effect=fake_stream_generator_in_thread), \
                    mock.patch.object(main, "execute_plan_stream", side_effect=fake_execute_plan_stream):
                asyncio.run(main.stream_migrate(resume=True))
                self.assertIn("gen_func", captured)
                captured["gen_func"]()

                captured.clear()
                asyncio.run(main.stream_migrate())
                captured["gen_func"]()
        finally:
            main._last_repo_path = previous_repo
            main._last_repo_url = previous_url

        self.assertEqual(len(calls), 2)
        _, resumed_kwargs = calls[0]
        self.assertIs(resumed_kwargs["resume"], True)
        self.assertEqual(resumed_kwargs["cache_key"], "https://github.com/example/repo")
        _, fresh_kwargs = calls[1]
        self.assertIs(fresh_kwargs["resume"], False)
        self.assertEqual(fresh_kwargs["cache_key"], "https://github.com/example/repo")


if __name__ == "__main__":
    unittest.main(verbosity=2)
