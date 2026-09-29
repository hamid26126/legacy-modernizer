import os
import json
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI

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


def execute_plan_stream():
    """
    Generator version — yields progress events per file. Final event is
    {"type": "execution_complete", "results": [...]}.
    """
    try:
        plan = load_plan()
    except Exception as e:
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
        return

    files = sorted(plan["files"], key=lambda f: f["priority"])
    OUTPUT_PATH.mkdir(exist_ok=True)
    results = []

    for entry in files:
        original_path = entry["path"]
        new_path = entry["new_path"]
        notes = entry["migration_notes"]

        yield {"type": "file_start", "file": original_path, "new_path": new_path}

        try:
            original_full_path = REPO_PATH / original_path
            original_content = original_full_path.read_text(encoding="utf-8")

            migrated_content = migrate_file(original_path, new_path, notes, original_content)

            output_file = OUTPUT_PATH / new_path
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(migrated_content, encoding="utf-8")

            passed = run_checks(output_file)
            status = "pass" if passed else "fail"

        except Exception as e:
            status = "error"
            yield {"type": "file_error", "file": original_path, "message": f"{type(e).__name__}: {e}"}

        result = {"file": original_path, "new_path": new_path, "status": status}
        results.append(result)
        yield {"type": "file_complete", **result}

    yield {"type": "execution_complete", "results": results}


def execute_plan():
    """CLI-friendly wrapper — consumes the stream, prints progress, returns results."""
    results = []
    for event in execute_plan_stream():
        if event["type"] == "file_start":
            print(f"\nMigrating: {event['file']} -> {event['new_path']}")
        elif event["type"] == "file_complete":
            print(f"  Status: {event['status'].upper()}")
        elif event["type"] == "file_error":
            print(f"  ERROR: {event['message']}")
        elif event["type"] == "error":
            print(f"FATAL: {event['message']}")
        elif event["type"] == "execution_complete":
            results = event["results"]

    print("\n" + "=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    for r in results:
        print(f"  [{r['status'].upper()}]  {r['file']} -> {r['new_path']}")
    return results


if __name__ == "__main__":
    execute_plan()