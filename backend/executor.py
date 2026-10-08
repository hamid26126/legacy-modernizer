import os
import re
import json
import shutil
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI
from sandbox_verify import build_base_checkpoint, write_all_files, run_build, run_lint, guess_broken_file, guess_broken_files, classify_build_error
from utils import (
    call_with_retry,
    normalize_plan,
    get_plan_cache_path,
    get_generation_state_path,
    plan_fingerprint,
    load_generation_state,
    save_generation_state,
)

import sys
sys.stdout.reconfigure(encoding="utf-8")

# Verification runs two phases with independent retry budgets: the build
# phase must pass before lint is ever attempted, and each phase gets its own
# capped number of fixes. A lint-phase fix that breaks the build again is
# charged to the BUILD budget (the build is re-run first on every loop).
MAX_BUILD_RETRIES = 3
MAX_LINT_RETRIES = 3
load_dotenv()

# timeout=45 / max_retries=0: same bounds as planner.py — a stalled model
# call can't sit on the SDK's default 600s timeout, and all retries are left
# to call_with_retry. migrate_file and fix_file_with_build_error override the
# timeout per call (client.with_options(timeout=120.0), which preserves the
# client-level max_retries=0) and are wrapped with retries=1, so a single
# generate/fix call caps at 2 x 120s = 4 minutes — large files normally take
# 32-78s, and the old 45s bound was failing them early.
client = OpenAI(
    api_key=os.environ["NEBIUS_API_KEY"],
    base_url="https://api.tokenfactory.nebius.com/v1/",
    timeout=45.0,
    max_retries=0,
)

SUPER_MODEL = "nvidia/nemotron-3-super-120b-a12b"
OUTPUT_PATH = Path(__file__).parent.parent / "output"


def build_fixed_index_html(original_html: str) -> str:
    """
    index.html is not sent to the LLM. Its entry script must exactly match our
    sandbox scaffold (src/main.jsx). We build it from a fixed template, but we
    DO preserve the original's <title> and any external stylesheet/font <link>
    tags from its <head> — these (Bootstrap, Font Awesome, Google Fonts, etc.)
    are often load-bearing for the migrated app's visual appearance, since the
    migrated CSS file assumes those base styles are still present.
    """
    title_match = re.search(r"<title>(.*?)</title>", original_html, re.IGNORECASE | re.DOTALL)
    title = title_match.group(1).strip() if title_match else "App"

    link_tags = re.findall(r'<link\b[^>]*>', original_html, re.IGNORECASE)
    external_links = []
    for tag in link_tags:
        href_match = re.search(r'href=["\']([^"\']+)["\']', tag, re.IGNORECASE)
        rel_match = re.search(r'rel=["\']([^"\']+)["\']', tag, re.IGNORECASE)
        if not href_match or not rel_match:
            continue
        href = href_match.group(1)
        rel = rel_match.group(1).lower()
        # Only keep genuinely external links (CDNs), and only stylesheet/font-related ones.
        # Skip local/relative hrefs (e.g. href="style.css") since that file is being
        # migrated separately and will conflict with our own index.css.
        if href.startswith(("http://", "https://", "//")) and rel in ("stylesheet", "preconnect", "dns-prefetch"):
            external_links.append(f'    <link rel="{rel}" href="{href}">')

    links_html = "\n" + "\n".join(external_links) if external_links else ""

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>{links_html}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
"""

def load_plan(repo_path: Path, cache_key: str | None = None) -> dict:
    plan_cache = get_plan_cache_path(repo_path, cache_key)
    if not plan_cache.exists():
        raise FileNotFoundError(f"No {plan_cache.name} found. Run planner.py first.")
    return normalize_plan(json.loads(plan_cache.read_text()))


def extract_html_body(html_content: str) -> str:
    """Extract just the <body> content from an HTML file, to use as
    structural reference context without spending tokens on <head>."""
    match = re.search(r"<body[^>]*>(.*?)</body>", html_content, re.IGNORECASE | re.DOTALL)
    return match.group(1).strip() if match else html_content


def migrate_file(original_path: str, new_path: str, migration_notes: str, original_content: str, html_reference=None) -> str:
    """Send one file to Super with its specific migration notes, get back the converted code."""
    system_msg = (
    "You are an expert React developer performing a precise jQuery-to-React "
    "migration for ONE file at a time. You will be given the original file's "
    "content and specific migration notes for that file. "
    "IMPORTANT: Preserve all original `id` and `class`/`className` values EXACTLY "
    "as they appear in the original file, even when restructuring the DOM or JSX. "
    "The CSS file was migrated separately and still targets the original id/class "
    "names — if you rename or drop them, the styling will break even though the "
    "app still functions. Also preserve original visible text (button labels, "
    "headings) exactly unless the migration notes explicitly say to change them. "
    "ARIA ATTRIBUTES: Preserve all ARIA attributes in their original hyphenated "
    "HTML form exactly (e.g. aria-hidden, aria-label, aria-expanded) — do NOT "
    "convert them to camelCase (e.g. never write ariaHidden). React/JSX uses the "
    "standard hyphenated attribute names for all aria-* attributes, unlike other "
    "DOM properties. "
    "IMPORTANT CONSTRAINT: Do not import or rely on any npm package other than "
    "'react' and 'react-dom', which are the only dependencies available in the target "
    "environment. If the original code uses a jQuery plugin or utility library (e.g. a "
    "datepicker, carousel, animation library, lodash, moment.js), reimplement the "
    "equivalent behavior using only plain JavaScript and React — do not import a "
    "replacement package. "
    "This also applies to any library the original code used as a global variable "
    "loaded via a <script> tag (other than jQuery itself, which you are already "
    "removing) — for example html2canvas, moment, lodash, or similar. Do NOT "
    "reference any such global in your migrated code, since no external scripts are "
    "loaded in this environment. If the original code used such a library, either "
    "omit that specific functionality with a clear comment explaining it was removed "
    "(e.g. '// html2canvas functionality removed — library not available in this "
    "migration'), or reimplement the essential behavior using only plain "
    "JavaScript/React, whichever is more appropriate given the surrounding code. "
    "CRITICAL: This file must export its main component as the default export "
    "(`export default ComponentName;`). Do NOT call createRoot, ReactDOM.render, or any "
    "app-mounting code inside this file — the application's entry point (main.jsx) already "
    "handles mounting and expects to import this file's default export. "
    "STRUCTURAL FIDELITY: The original HTML's class names, ids, and overall element "
    "nesting/wrapper structure (e.g. header/container/footer wrapping elements) often have "
    "CSS rules written specifically against them. You MUST preserve every original id and "
    "class name EXACTLY on the JSX element that serves the equivalent role — do not rename, "
    "abbreviate, or invent new class/id names, and do not remove structural wrapper elements "
    "(headers, containers, footers) even if they seem redundant. If you are unsure what an "
    "element's original class or id was, re-use it verbatim rather than guessing a new one. "
    "AVOID DUPLICATE RENDERING: If the original code referenced multiple DOM containers for "
    "what is conceptually the same piece of data (e.g. a history list, a results panel), "
    "check carefully whether those containers were ALL actually visible and populated in the "
    "original, or whether some were dead/unused code (e.g. targeting an element id that "
    "doesn't exist in the original HTML, or hidden via CSS). Render each piece of data in "
    "exactly ONE place in your migrated component, matching wherever the original ACTUALLY "
    "displayed it — never render the same data in two different visible locations unless the "
    "original genuinely did so simultaneously. "
    "Respond with ONLY the final code for the new file — no markdown fences, "
    "no explanation, no commentary. Just the raw file content, ready to write to disk."
)
    user_msg = (
        f"ORIGINAL FILE: {original_path}\n"
        f"NEW FILE PATH: {new_path}\n\n"
        f"MIGRATION NOTES FOR THIS FILE:\n{migration_notes}\n\n"
        f"ORIGINAL CONTENT:\n{original_content}\n\n"
    )
    if html_reference:
        user_msg += (
            f"ORIGINAL HTML STRUCTURE (for reference only — this is the original "
            f"index.html's body, showing the exact ids/classes this script's logic "
            f"was written against; it is NOT being migrated by you, it exists only so "
            f"you preserve the correct ids/classes and understand which DOM elements "
            f"genuinely existed vs. which selectors in the script might target "
            f"nonexistent elements):\n{html_reference}\n\n"
        )
    user_msg += "Produce the migrated file content now."
    # 120s per call: large files legitimately take 32-78s to generate, so the
    # client-level 45s was aborting healthy requests. with_options() copies
    # this client (keeping max_retries=0) with only the timeout overridden.
    response = client.with_options(timeout=120.0).chat.completions.create(
        model=SUPER_MODEL,
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.2,
        max_tokens=12000,
    )
    content = response.choices[0].message.content
    if content is None:
        raise ValueError(f"Model returned empty content for {new_path} — likely hit a token/length limit.")
    raw = content.strip()

    # Strip markdown fences if the model adds them anyway, despite instructions
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
    return raw


def run_checks(file_path: Path) -> bool:
    """
    PLACEHOLDER — this is where Sandboxes plugs in.
    Once Sandbox access lands, replace this function's body with:
      1. Start/reuse a sandbox with a Node/React base image
      2. Write the migrated file(s) into it
      3. Run lint (eslint) and/or build (vite build) inside the sandbox
      4. Return True only if those commands exit 0
      5. On failure, checkpoint/rollback and feed the error back to migrate_file() for a retry
    For now, this always passes so the rest of the pipeline is testable end-to-end.
    """
    return True





def introduces_new_relative_import(original: str, fixed: str) -> bool:
    """True if `fixed` contains a relative import ('./x' / '../x' style) that
    `original` did not already contain — i.e. the fix tried to reference a
    file that isn't part of the project yet."""
    import re
    pattern = re.compile(r'''(?:from|import)\s+['"]\.\/?[^'"]+['"]''')
    original_imports = set(pattern.findall(original))
    fixed_imports = set(pattern.findall(fixed))
    return bool(fixed_imports - original_imports)


def fix_file_with_build_error(original_path, new_path, current_content, notes, build_error):
    """Feed the real sandbox build error back to Super and ask for a corrected version."""
    system_msg = (
        "You are fixing a React file that failed a real build. You will get the "
        "current file content, the original migration notes, and the exact build "
        "error output. Fix ONLY what's needed to make the build pass — do not "
        "rewrite unrelated parts. "
        "CRITICAL CONSTRAINT: You must fix the error WITHOUT creating any new file or "
        "import referencing a file that doesn't already exist in this project. "
        "Specifically: do NOT extract any logic into a new component file and import it "
        "(e.g. do not write `import X from './SomeNewFile'` unless './SomeNewFile' was "
        "already present in the original content you were given). If you're tempted to "
        "split code into a separate file to fix an error, instead keep all the code in "
        "THIS SAME FILE — define any extracted logic as a function, inline component, "
        "or constant within this file, not as a separate module. This file must remain "
        "self-contained. "
        "IMPORTANT CONSTRAINT: Do not introduce any import from an npm package other "
        "than 'react' and 'react-dom' — none are available besides those. If the build "
        "error is about a package that cannot be resolved, rewrite that code to not "
        "depend on any external package at all. "
        "ARIA ATTRIBUTES: Preserve all ARIA attributes in their original hyphenated "
        "HTML form exactly (e.g. aria-hidden, aria-label, aria-expanded) — do NOT "
        "convert them to camelCase (e.g. never write ariaHidden). React/JSX uses the "
        "standard hyphenated attribute names for all aria-* attributes, unlike other "
        "DOM properties. "
        "CRITICAL: If this file contains 'export default', you MUST keep that default "
        "export in your corrected version — never remove it, even while fixing an "
        "unrelated issue. "
        "Respond with ONLY the corrected file content, "
        "no markdown fences, no commentary."
    )
    user_msg = (
        f"FILE: {new_path} (migrated from {original_path})\n\n"
        f"ORIGINAL MIGRATION NOTES:\n{notes}\n\n"
        f"CURRENT CONTENT:\n{current_content}\n\n"
        f"BUILD ERROR:\n{build_error}\n\n"
        "Produce the corrected file content now."
    )

    def _ask(prompt: str) -> str:
        # Same 120s override as migrate_file — a real fix on a large file can
        # take just as long as the original generation did.
        response = client.with_options(timeout=120.0).chat.completions.create(
            model=SUPER_MODEL,
            messages=[{"role": "system", "content": system_msg}, {"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=12000,
        )
        content = response.choices[0].message.content
        if content is None:
            raise ValueError(f"Model returned empty content for {new_path} — likely hit a token/length limit.")
        raw = content.strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
        return raw

    raw = _ask(user_msg)

    # Prompts aren't 100% reliable, so enforce the single-file rule in code:
    # if the fix references a relative import that wasn't in the original, the
    # model tried to split this file out. Retry exactly once, harder.
    if introduces_new_relative_import(current_content, raw):
        retry_msg = (
            user_msg
            + "\n\nREJECTED — YOUR PREVIOUS ATTEMPT INTRODUCED A NEW FILE IMPORT, WHICH IS "
            "NOT ALLOWED. Fix the error by modifying ONLY the content of this single file "
            "— do not reference any file not already present in the original. "
            "Produce the corrected file content now."
        )
        raw = _ask(retry_msg)
        if introduces_new_relative_import(current_content, raw):
            # Second attempt still splits the file — ship it rather than fail the
            # whole migration, but make the violation impossible to miss in logs.
            print(
                f"WARNING: fix for {new_path} still introduces a new relative import "
                f"after retry — returning it anyway.",
                flush=True,
            )
    return raw


def execute_plan_stream(repo_path: Path, cache_key: str | None = None, resume: bool = False):
    try:
        plan = load_plan(repo_path, cache_key)
    except Exception as e:
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
        return

    files = sorted(plan["files"], key=lambda f: f.get("priority", 0))
    fingerprint = plan_fingerprint(plan)
    state_path = get_generation_state_path(repo_path, cache_key)

    # Resume only when the saved progress belongs to THIS plan — reusing
    # output that a different plan generated would ship mismatched files, so a
    # fingerprint mismatch (or no state file at all) falls back to a fresh run.
    resumed = False
    state: dict = {"plan_fingerprint": fingerprint, "generated": []}
    if resume:
        previous = load_generation_state(state_path)
        if previous is not None and previous["plan_fingerprint"] == fingerprint:
            resumed = True
            state = previous

    if resumed:
        # Keep output/: files already generated stay on disk and are reused by
        # the loop below instead of being paid for again.
        OUTPUT_PATH.mkdir(exist_ok=True)
    else:
        # Wipe output/ so a new migration never inherits files (or stale
        # _unused_ placeholders) from a previous run, and reset the progress
        # state file for this fresh run.
        shutil.rmtree(OUTPUT_PATH, ignore_errors=True)
        OUTPUT_PATH.mkdir(exist_ok=True)
        save_generation_state(state_path, state)

    generated_set = set(state["generated"])

    def record_generated(new_path: str) -> None:
        """Persist progress after EVERY successful file, so a crash, timeout or
        disconnect mid-run never loses the work already paid for."""
        if new_path not in state["generated"]:
            state["generated"].append(new_path)
            generated_set.add(new_path)
            save_generation_state(state_path, state)

    migrated = {}
    file_meta = {}
    failed_generation = set()

    html_reference = None
    html_entry = next((f for f in files if f["path"].lower().endswith(".html")), None)
    if html_entry:
        try:
            html_original = (repo_path / html_entry["path"]).read_text(encoding="utf-8")
            html_reference = extract_html_body(html_original)
        except Exception:
            html_reference = None

    for entry in files:
        original_path = entry["path"]
        new_path = entry["new_path"]
        notes = entry["migration_notes"]
        file_meta[new_path] = {"original_path": original_path, "notes": notes}

        is_placeholder = "_unused_" in new_path
        is_index = new_path == "index.html"

        # Resumed run: reuse an already-generated file by reading it back from
        # disk — no model call, and the UI is told via reused:True. Only files
        # recorded as generated AND present non-empty in output/ qualify;
        # index.html is always rebuilt deterministically and _unused_
        # placeholders are always rewritten, exactly as in a fresh run.
        if resumed and not is_placeholder and not is_index and new_path in generated_set:
            output_file = OUTPUT_PATH / new_path
            existing = None
            if output_file.is_file():
                try:
                    existing = output_file.read_text(encoding="utf-8")
                except OSError:
                    existing = None
            if existing:
                migrated[new_path] = existing
                yield {"type": "file_generated", "file": original_path, "new_path": new_path, "reused": True}
                continue
            # Listed in state but missing/empty on disk — fall through and
            # regenerate it rather than verifying against nothing.

        yield {"type": "file_start", "file": original_path, "new_path": new_path}
        if is_placeholder:
            output_file = OUTPUT_PATH / new_path
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(f"// Not migrated separately — see src/App.jsx\n", encoding="utf-8")
            record_generated(new_path)
            yield {"type": "file_generated", "file": original_path, "new_path": new_path}
            continue
        try:
            original_content = (repo_path / original_path).read_text(encoding="utf-8")

            # Only the entry file the planner designated as index.html gets the
            # fixed scaffold. Any OTHER original .html file in a multi-page app
            # (new_path e.g. src/pages/AboutPage.jsx) must be migrated for real
            # like any other source file — treating it as "the" entry point
            # would overwrite it with the root template and corrupt the page.
            if is_index:
                content = build_fixed_index_html(original_content)
            else:
                # retries=1 (2 attempts total): with the 120s per-call timeout
                # above, one file's generation can never exceed ~4 minutes.
                content = call_with_retry(migrate_file, original_path, new_path, notes, original_content, html_reference, retries=1)

            migrated[new_path] = content
            output_file = OUTPUT_PATH / new_path
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(content, encoding="utf-8")
            record_generated(new_path)
            yield {"type": "file_generated", "file": original_path, "new_path": new_path}
        except Exception as e:
            # One file failing must not stop the run — every remaining file is
            # still attempted, and only the failures are reported as such.
            failed_generation.add(new_path)
            yield {"type": "file_error", "file": original_path, "message": f"{type(e).__name__}: {e}"}

    if failed_generation:
        yield {"type": "error", "message": "One or more files failed to generate — skipping build verification. Please try again."}
        results = [
            {
                "file": m["original_path"],
                "new_path": p,
                "status": "generation_failed" if p in failed_generation else "generated",
            }
            for p, m in file_meta.items()
        ]
        yield {"type": "execution_complete", "results": results, "verified": False, "build_attempts": 0, "lint_attempts": 0}
        return

    # Phase 2: verify the WHOLE app in a real sandbox build, with self-correction retries
    yield {"type": "verify_start", "attempt": 1}
    try:
        base_cp = build_base_checkpoint()
    except Exception as e:
        yield {"type": "error", "message": f"Sandbox setup failed: {type(e).__name__}: {e}"}
        results = [{"file": m["original_path"], "new_path": p, "status": "unverified"} for p, m in file_meta.items()]
        yield {"type": "execution_complete", "results": results}
        return

    build_attempt = 1
    lint_attempt = 1
    passed = False
    stage = None
    build_output = ""

    def apply_fix(fail_output: str, next_attempt: int):
        """Feed the failing output (build OR lint) to the fixer for EVERY file
        the output flags — not just the first — so one attempt can clear all
        the reported files. Yields the same events the old inline fix block
        did; returns False when the retry loop must stop (no failure could be
        attributed to a file, or no fix call succeeded)."""
        broken_files = guess_broken_files(fail_output, list(migrated.keys()))
        if not broken_files:
            # Structured scan found nothing — fall back to the single-file
            # guesser's older parsing/blind-match behaviour.
            single = guess_broken_file(fail_output, list(migrated.keys()))
            broken_files = [single] if single else []
        if not broken_files:
            yield {"type": "info", "message": "Could not identify which file caused the failure — stopping retries."}
            return False
        print(f"[fix] pass for attempt {next_attempt}: {len(broken_files)} file(s) flagged -> {broken_files}", flush=True)

        fixed_any = False
        for broken in broken_files:
            meta = file_meta[broken]
            yield {"type": "file_fixing", "new_path": broken, "attempt": next_attempt}
            try:
                error_category = classify_build_error(fail_output)
                if error_category == "missing_dependency":
                    build_output_for_fix = fail_output + "\n\nNOTE: This error is almost certainly caused by importing an npm package that isn't available. Rewrite this file to avoid importing any package other than react/react-dom."
                else:
                    build_output_for_fix = fail_output

                fixed = call_with_retry(fix_file_with_build_error, meta["original_path"], broken, migrated[broken], meta["notes"], build_output_for_fix, retries=1)
                # If the fixer's second attempt still split the file out, don't ship
                # that silently — put a visible warning into the event stream.
                if introduces_new_relative_import(migrated[broken], fixed):
                    yield {"type": "info", "message": f"Warning: the fix for {broken} still imports a file that does not exist in this project — the build may fail again."}
                migrated[broken] = fixed
                (OUTPUT_PATH / broken).write_text(fixed, encoding="utf-8")
                yield {"type": "file_fixed", "new_path": broken, "attempt": next_attempt}
                fixed_any = True
            except Exception as e:
                # One file's fix failing shouldn't block the others — keep going
                # and only end the retry loop if nothing at all was fixed.
                yield {"type": "file_error", "file": broken, "message": f"{type(e).__name__}: {e}"}
        return fixed_any

    while True:
        cp = write_all_files(base_cp, migrated)
        # Build and lint run as two separate steps so the client can be told
        # when the build has passed and the lint check is now running.
        build_passed, build_out = run_build(cp)
        if not build_passed:
            yield {"type": "verify_result", "attempt": build_attempt, "passed": False, "stage": "build", "output": build_out[-1500:]}
            if build_attempt >= MAX_BUILD_RETRIES:
                stage = "build"
                build_output = build_out
                break
            if not (yield from apply_fix(build_out, build_attempt + 1)):
                break
            build_attempt += 1
            continue

        # Build passed — move into the lint phase (its own independent budget).
        yield {"type": "verify_stage_progress", "attempt": build_attempt, "stage": "lint", "message": "Build passed — checking lint..."}
        lint_passed, lint_out = run_lint(cp)
        if lint_passed:
            passed = True
            stage = None
            build_output = build_out + "\n\n--- Lint ---\n" + lint_out
            yield {"type": "verify_result", "attempt": lint_attempt, "passed": True, "stage": None, "output": build_output[-1500:]}
            break

        yield {"type": "verify_result", "attempt": lint_attempt, "passed": False, "stage": "lint", "output": lint_out[-1500:]}
        if lint_attempt >= MAX_LINT_RETRIES:
            stage = "lint"
            build_output = lint_out
            break
        if not (yield from apply_fix(lint_out, lint_attempt + 1)):
            break
        lint_attempt += 1
        # Loop back around — the build is re-run first as a safety check, so a
        # lint fix that broke the build again consumes a BUILD attempt.

    final_status = "pass" if passed else "fail"
    results = []
    for new_path, meta in file_meta.items():
        results.append({"file": meta["original_path"], "new_path": new_path, "status": final_status})
        yield {"type": "file_complete", "file": meta["original_path"], "new_path": new_path, "status": final_status}

    yield {"type": "execution_complete", "results": results, "verified": passed, "build_attempts": build_attempt, "lint_attempts": lint_attempt}


def execute_plan(repo_path: Path, cache_key: str | None = None):
    """CLI wrapper — prints progress as the stream comes in."""
    results = []
    for event in execute_plan_stream(repo_path, cache_key):
        t = event["type"]
        if t == "file_start":
            print(f"\nGenerating: {event['file']} -> {event['new_path']}")
        elif t == "file_generated":
            print("  Generated.")
        elif t == "verify_start":
            print("\nSetting up sandbox and verifying full build...")
        elif t == "verify_stage_progress":
            print(f"  {event['message']}")
        elif t == "verify_result":
            stage_label = f" [{event.get('stage')}]" if event.get("stage") else ""
            print(f"  Attempt {event['attempt']}:{stage_label} {'PASS' if event['passed'] else 'FAIL'}")
            if not event["passed"]:
                print(f"  Build output (tail):\n{event['output']}")
        elif t == "file_fixing":
            print(f"  Fixing {event['new_path']} (attempt {event['attempt']})...")
        elif t == "file_fixed":
            print(f"  Fix applied to {event['new_path']}.")
        elif t in ("error", "file_error"):
            print(f"  ERROR: {event['message']}")
        elif t == "execution_complete":
            results = event["results"]
            build_att = event.get("build_attempts", 0)
            lint_att = event.get("lint_attempts", 0)
            print(f"\nFinal verified: {event['verified']} (build {build_att}/{MAX_BUILD_RETRIES}, lint {lint_att}/{MAX_LINT_RETRIES} attempt(s))")

    print("\n" + "=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    for r in results:
        print(f"  [{r['status'].upper()}]  {r['file']} -> {r['new_path']}")
    return results


if __name__ == "__main__":
    from pathlib import Path
    default_path = Path(__file__).parent.parent / "test-repos" / "sample-jquery-app"
    execute_plan(default_path)