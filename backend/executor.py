import os
import json
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI
from sandbox_verify import build_base_checkpoint, write_all_files, run_build, guess_broken_file

MAX_VERIFY_RETRIES = 2
load_dotenv()

client = OpenAI(
    api_key=os.environ["NEBIUS_API_KEY"],
    base_url="https://api.tokenfactory.nebius.com/v1/",
)

SUPER_MODEL = "nvidia/nemotron-3-super-120b-a12b"
REPO_PATH = Path(__file__).parent.parent / "test-repos" / "sample-jquery-app"
OUTPUT_PATH = Path(__file__).parent.parent / "output"
PLAN_CACHE = Path(__file__).parent / "plan_cache.json"


def load_plan() -> dict:
    if not PLAN_CACHE.exists():
        raise FileNotFoundError("No plan_cache.json found. Run planner.py first.")
    return json.loads(PLAN_CACHE.read_text())


def migrate_file(original_path: str, new_path: str, migration_notes: str, original_content: str) -> str:
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
    "Respond with ONLY the final code for the new file — no markdown fences, "
    "no explanation, no commentary. Just the raw file content, ready to write to disk."
)
    user_msg = (
        f"ORIGINAL FILE: {original_path}\n"
        f"NEW FILE PATH: {new_path}\n\n"
        f"MIGRATION NOTES FOR THIS FILE:\n{migration_notes}\n\n"
        f"ORIGINAL CONTENT:\n{original_content}\n\n"
        "Produce the migrated file content now."
    )
    response = client.chat.completions.create(
        model=SUPER_MODEL,
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.2,
    )
    raw = response.choices[0].message.content.strip()

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





def fix_file_with_build_error(original_path, new_path, current_content, notes, build_error):
    """Feed the real sandbox build error back to Super and ask for a corrected version."""
    system_msg = (
        "You are fixing a React file that failed a real build. You will get the "
        "current file content, the original migration notes, and the exact build "
        "error output. Fix ONLY what's needed to make the build pass — do not "
        "rewrite unrelated parts. Respond with ONLY the corrected file content, "
        "no markdown fences, no commentary."
    )
    user_msg = (
        f"FILE: {new_path} (migrated from {original_path})\n\n"
        f"ORIGINAL MIGRATION NOTES:\n{notes}\n\n"
        f"CURRENT CONTENT:\n{current_content}\n\n"
        f"BUILD ERROR:\n{build_error}\n\n"
        "Produce the corrected file content now."
    )
    response = client.chat.completions.create(
        model=SUPER_MODEL,
        messages=[{"role": "system", "content": system_msg}, {"role": "user", "content": user_msg}],
        temperature=0.2,
    )
    raw = response.choices[0].message.content.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1]) if lines[-1].strip() == "```" else "\n".join(lines[1:])
    return raw


def execute_plan_stream():
    try:
        plan = load_plan()
    except Exception as e:
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
        return

    files = sorted(plan["files"], key=lambda f: f["priority"])
    OUTPUT_PATH.mkdir(exist_ok=True)

    migrated = {}   # new_path -> content
    file_meta = {}  # new_path -> {"original_path", "notes"}

    # Phase 1: generate each file with Super (as before)
    for entry in files:
        original_path = entry["path"]
        new_path = entry["new_path"]
        notes = entry["migration_notes"]
        file_meta[new_path] = {"original_path": original_path, "notes": notes}

        yield {"type": "file_start", "file": original_path, "new_path": new_path}
        try:
            original_content = (REPO_PATH / original_path).read_text(encoding="utf-8")
            content = migrate_file(original_path, new_path, notes, original_content)
            migrated[new_path] = content
            output_file = OUTPUT_PATH / new_path
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(content, encoding="utf-8")
            yield {"type": "file_generated", "file": original_path, "new_path": new_path}
        except Exception as e:
            yield {"type": "file_error", "file": original_path, "message": f"{type(e).__name__}: {e}"}

    # Phase 2: verify the WHOLE app in a real sandbox build, with self-correction retries
    yield {"type": "verify_start", "attempt": 1}
    try:
        base_cp = build_base_checkpoint()
    except Exception as e:
        yield {"type": "error", "message": f"Sandbox setup failed: {type(e).__name__}: {e}"}
        results = [{"file": m["original_path"], "new_path": p, "status": "unverified"} for p, m in file_meta.items()]
        yield {"type": "execution_complete", "results": results}
        return

    attempt = 1
    passed = False
    build_output = ""
    while attempt <= MAX_VERIFY_RETRIES + 1:
        cp = write_all_files(base_cp, migrated)
        passed, build_output = run_build(cp)
        yield {"type": "verify_result", "attempt": attempt, "passed": passed, "output": build_output[-1500:]}

        if passed or attempt > MAX_VERIFY_RETRIES:
            break

        broken = guess_broken_file(build_output, list(migrated.keys()))
        if not broken:
            yield {"type": "info", "message": "Could not identify which file caused the failure — stopping retries."}
            break

        meta = file_meta[broken]
        yield {"type": "file_fixing", "new_path": broken, "attempt": attempt + 1}
        try:
            fixed = fix_file_with_build_error(meta["original_path"], broken, migrated[broken], meta["notes"], build_output)
            migrated[broken] = fixed
            (OUTPUT_PATH / broken).write_text(fixed, encoding="utf-8")
            yield {"type": "file_fixed", "new_path": broken, "attempt": attempt + 1}
        except Exception as e:
            yield {"type": "file_error", "file": broken, "message": f"{type(e).__name__}: {e}"}
            break
        attempt += 1

    final_status = "pass" if passed else "fail"
    results = []
    for new_path, meta in file_meta.items():
        results.append({"file": meta["original_path"], "new_path": new_path, "status": final_status})
        yield {"type": "file_complete", "file": meta["original_path"], "new_path": new_path, "status": final_status}

    yield {"type": "execution_complete", "results": results, "verified": passed, "attempts": attempt}


def execute_plan():
    """CLI wrapper — prints progress as the stream comes in."""
    results = []
    for event in execute_plan_stream():
        t = event["type"]
        if t == "file_start":
            print(f"\nGenerating: {event['file']} -> {event['new_path']}")
        elif t == "file_generated":
            print("  Generated.")
        elif t == "verify_start":
            print("\nSetting up sandbox and verifying full build...")
        elif t == "verify_result":
            print(f"  Attempt {event['attempt']}: {'PASS' if event['passed'] else 'FAIL'}")
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
            print(f"\nFinal verified: {event['verified']} (after {event['attempts']} attempt(s))")

    print("\n" + "=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    for r in results:
        print(f"  [{r['status'].upper()}]  {r['file']} -> {r['new_path']}")
    return results


if __name__ == "__main__":
    execute_plan()