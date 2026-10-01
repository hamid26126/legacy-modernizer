import os
import json
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI
from tavily import TavilyClient
from utils import call_with_retry, normalize_plan

import sys
sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

client = OpenAI(
    api_key=os.environ["NEBIUS_API_KEY"],
    base_url="https://api.tokenfactory.nebius.com/v1/",
)
tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

ULTRA_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b"
REPO_PATH = Path(__file__).parent.parent / "test-repos" / "sample-jquery-app"
PLAN_CACHE = Path(__file__).parent / "plan_cache.json"

# Only read source files that actually matter for migration
RELEVANT_EXTENSIONS = {".js", ".html", ".css"}


def read_repo(repo_path: Path) -> str:
    """Concatenate all relevant files in the repo into one labeled string."""
    parts = []
    for file in sorted(repo_path.rglob("*")):
        if file.is_file() and file.suffix in RELEVANT_EXTENSIONS:
            rel_path = file.relative_to(repo_path)
            content = file.read_text(encoding="utf-8")
            parts.append(f"--- FILE: {rel_path} ---\n{content}\n")
    return "\n".join(parts)


def ground_with_tavily(query: str) -> str:
    """Pull current migration guidance so the plan isn't based on stale training data."""
    results = tavily.search(query, max_results=3, search_depth="basic")
    snippets = []
    for r in results.get("results", []):
        snippets.append(f"Source: {r['url']}\n{r['content'][:500]}")
    return "\n\n".join(snippets)


def build_prompt(repo_content: str, tavily_context: str) -> list:
    system_msg = (
        "You are a senior software architect planning a migration of a jQuery "
        "codebase to React. You will be given the full source of a small jQuery "
        "project and some current migration reference material. "
        "IMPORTANT CONSTRAINT: Each entry in the plan must correspond to exactly ONE "
        "original file producing exactly ONE new file. Do NOT propose splitting a single "
        "original file into multiple new component files, even if that would normally be "
        "good React practice — the execution pipeline processes one new file per plan "
        "entry and cannot coordinate imports across newly-split files. "
        "Respond with ONLY valid JSON, no markdown fences, no commentary before or after. "
        "The JSON schema must be exactly:\n"
        "{\n"
        '  "files": [\n'
        '    {\n'
        '      "path": "string, original file path",\n'
        '      "new_path": "string, proposed React file path (e.g. src/components/TaskList.jsx)",\n'
        '      "priority": integer, migration order starting at 1,\n'
        '      "depends_on": ["list of other original file paths this depends on"],\n'
        '      "migration_notes": "string, specific jQuery patterns in this file and how to convert them"\n'
        "    }\n"
        "  ],\n"
        '  "overall_notes": "string, high-level migration strategy and risks"\n'
        "}"
    )
    user_msg = (
        f"REFERENCE MATERIAL (current React/migration docs):\n{tavily_context}\n\n"
        f"CODEBASE TO MIGRATE:\n{repo_content}\n\n"
        "Produce the migration plan JSON now."
    )
    return [
        {"role": "system", "content": system_msg},
        {"role": "user", "content": user_msg},
    ]


def parse_json_response(raw: str) -> dict:
    """Strip markdown code fences if the model added them anyway, then parse."""
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text.strip())


def get_migration_plan_stream(force_refresh: bool = False):
    """
    Generator version — yields progress events as dicts so a web layer (or the
    CLI) can show live status. The final event is always either
    {"type": "plan_complete", "plan": {...}} or {"type": "error", "message": "..."}.
    """
    if PLAN_CACHE.exists() and not force_refresh:
        yield {"type": "info", "message": "Using cached plan (delete plan_cache.json to force a fresh one)."}
        yield {"type": "plan_complete", "plan": json.loads(PLAN_CACHE.read_text())}
        return

    try:
        yield {"type": "progress", "step": "reading_repo", "message": "Reading repo..."}
        repo_content = read_repo(REPO_PATH)

        yield {"type": "progress", "step": "grounding", "message": "Grounding with Tavily..."}
        tavily_context = ground_with_tavily("jQuery to React migration guide best practices 2026")

        yield {"type": "progress", "step": "planning", "message": "Calling Nemotron 3 Ultra for the migration plan (this costs credits)..."}
        messages = build_prompt(repo_content, tavily_context)
        response = call_with_retry(
            client.chat.completions.create,
            model=ULTRA_MODEL,
            messages=messages,
            temperature=0.2,
            max_tokens=4000,
        )
        raw = response.choices[0].message.content
        plan = parse_json_response(raw)
        plan = normalize_plan(plan)

        PLAN_CACHE.write_text(json.dumps(plan, indent=2))
        yield {"type": "info", "message": f"Plan saved to {PLAN_CACHE}"}
        yield {"type": "plan_complete", "plan": plan}

    except Exception as e:
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}


def get_migration_plan(force_refresh: bool = False) -> dict:
    """CLI-friendly wrapper — consumes the stream, prints progress, returns the final plan."""
    plan = None
    for event in get_migration_plan_stream(force_refresh):
        if event["type"] in ("progress", "info"):
            print(event["message"])
        elif event["type"] == "error":
            raise RuntimeError(event["message"])
        elif event["type"] == "plan_complete":
            plan = event["plan"]
    return plan


if __name__ == "__main__":
    plan = get_migration_plan()
    print(json.dumps(plan, indent=2))