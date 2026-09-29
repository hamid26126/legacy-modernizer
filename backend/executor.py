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


def execute_plan():
    plan = load_plan()
    files = sorted(plan["files"], key=lambda f: f["priority"])

    OUTPUT_PATH.mkdir(exist_ok=True)
    results = []

    for entry in files:
        original_path = entry["path"]
        new_path = entry["new_path"]
        notes = entry["migration_notes"]

        print(f"\nMigrating: {original_path} -> {new_path}")
        original_full_path = REPO_PATH / original_path
        original_content = original_full_path.read_text(encoding="utf-8")

        migrated_content = migrate_file(original_path, new_path, notes, original_content)

        output_file = OUTPUT_PATH / new_path
        output_file.parent.mkdir(parents=True, exist_ok=True)
        output_file.write_text(migrated_content, encoding="utf-8")
        print(f"  Written to {output_file}")

        passed = run_checks(output_file)
        status = "PASS (dry-run, real checks pending)" if passed else "FAIL"
        results.append({"file": original_path, "new_path": new_path, "status": status})

    print("\n" + "=" * 60)
    print("MIGRATION SUMMARY")
    print("=" * 60)
    for r in results:
        print(f"  [{r['status']}]  {r['file']} -> {r['new_path']}")

    return results


if __name__ == "__main__":
    execute_plan()