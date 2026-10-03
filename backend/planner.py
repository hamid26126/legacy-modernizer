import os
import json
from pathlib import Path
from dotenv import load_dotenv
from openai import OpenAI
from tavily import TavilyClient
from utils import call_with_retry, normalize_plan, get_plan_cache_path

import sys
sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

client = OpenAI(
    api_key=os.environ["NEBIUS_API_KEY"],
    base_url="https://api.tokenfactory.nebius.com/v1/",
)
tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])

ULTRA_MODEL = "nvidia/Nemotron-3-Ultra-550b-a55b"

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
    results = call_with_retry(tavily.search, query, max_results=3, search_depth="basic")
    snippets = []
    for r in results.get("results", []):
        snippets.append(f"Source: {r['url']}\n{r['content'][:500]}")
    return "\n\n".join(snippets)


def build_prompt(repo_content: str, tavily_context: str, allowed_files: list) -> list:
    system_msg = (
        "You are a senior software architect planning a migration of a jQuery "
        "codebase to React. You will be given the full source of a small jQuery "
        "project and some current migration reference material. "
        "IMPORTANT CONSTRAINT: Each entry in the plan must correspond to exactly ONE "
        "original file producing exactly ONE new file. Do NOT propose splitting a single "
        "original file into multiple new component files, even if that would normally be "
        "good React practice — the execution pipeline processes one new file per plan "
        "entry and cannot coordinate imports across newly-split files. "
        "CRITICAL: Every 'path' you output MUST be copied verbatim from the list of "
        "existing source files given below. You are planning migrations of EXISTING legacy "
        "files only. Do NOT emit entries for files that do not exist yet, and do NOT emit "
        "entries for build tooling or config (package.json, vite.config.ts, tsconfig.json, "
        ".github workflows, manifest.webmanifest, images, .json files) — those are never "
        "migrated by this pipeline. Create at most one entry per listed file. "
        "Respond with ONLY valid JSON, no markdown fences, no commentary before or after. "
        "Keep each file's migration_notes concise — 2 to 4 sentences, under 60 words, covering "
        "the key conversions needed, not an exhaustive walkthrough. Keep 'overall_notes' under "
        "40 words. This brevity is critical to avoid truncating the response. "
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
    allowed = "\n".join(f"- {p}" for p in allowed_files)
    user_msg = (
        f"REFERENCE MATERIAL (current React/migration docs):\n{tavily_context}\n\n"
        f"FILES YOU ARE ALLOWED TO PLAN (use these 'path' values verbatim, nothing else):\n{allowed}\n\n"
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


MIGRATABLE_EXTENSIONS = {".js", ".html", ".css"}
MAX_PLAN_ENTRIES = 40


def list_migratable_files(repo_path: Path) -> list:
    return sorted(
        f.relative_to(repo_path).as_posix()
        for f in repo_path.rglob("*")
        if f.is_file() and f.suffix in RELEVANT_EXTENSIONS
    )


def prune_plan(plan: dict, repo_path: Path) -> list:
    """Drop entries that don't name a real migratable source file, and fill in
    any missing keys. The model sometimes plans files it intends to CREATE
    (package.json, vite.config.ts, src/api/*.ts) — those aren't legacy sources
    and the executor cannot read them, so they are discarded rather than
    failing the whole plan. Returns the list of dropped paths."""
    allowed = set(list_migratable_files(repo_path))
    files = plan.get("files")
    if not isinstance(files, list):
        return []
    kept, dropped = [], []
    for f in files:
        path = f.get("path") if isinstance(f, dict) else None
        if not isinstance(path, str) or path not in allowed:
            dropped.append(path if isinstance(path, str) else "<malformed entry>")
            continue
        f.setdefault("depends_on", [])
        f.setdefault("priority", len(kept) + 1)
        if not isinstance(f["priority"], int):
            f["priority"] = len(kept) + 1
        f["migration_notes"] = f.get("migration_notes") or ""
        f["new_path"] = f.get("new_path") or f"src/{Path(path).stem}.jsx"
        kept.append(f)
    plan["files"] = kept
    return dropped


def validate_plan(plan: dict) -> list:
    """Return a list of schema problems. Empty list means the plan is usable."""
    if not isinstance(plan, dict):
        return ["Plan must be a JSON object."]
    files = plan.get("files")
    if not isinstance(files, list) or not files:
        return ["Plan must contain a non-empty top-level 'files' array."]
    if len(files) > MAX_PLAN_ENTRIES:
        return [f"Plan has {len(files)} entries; at most {MAX_PLAN_ENTRIES} are allowed."]
    problems = []
    for i, f in enumerate(files):
        if not isinstance(f, dict):
            problems.append(f"files[{i}] must be an object.")
        elif not str(f.get("migration_notes", "")).strip():
            problems.append(f"files[{i}] ({f.get('path')}) has empty 'migration_notes'.")
    return problems


def _parse_and_prune(raw, repo_path: Path):
    """Parse a model response into a usable plan. Returns (plan, problems, dropped).
    Unparseable JSON or a missing 'files' array are reported as problems so the
    caller can trigger one correction. Phantom entries naming non-existent files
    are pruned and are NOT a problem by themselves: pruning one bad entry out of
    an otherwise-valid plan is the pruning mechanism working correctly. They are
    only fatal if nothing valid is left after pruning."""
    try:
        plan = parse_json_response(raw)
    except Exception as e:
        return None, [f"Response was not valid JSON ({type(e).__name__}: {e}). Output complete JSON only."], []
    if not isinstance(plan, dict) or not isinstance(plan.get("files"), list):
        return None, validate_plan(plan if isinstance(plan, dict) else {}), []
    dropped = prune_plan(plan, repo_path)
    problems = validate_plan(plan)
    if dropped and not plan["files"]:
        problems.insert(0, "All entries named files that do not exist; nothing left to migrate: "
                        + ", ".join(dropped[:8]))
    return plan, problems, dropped


def get_migration_plan_stream(repo_path: Path, force_refresh: bool = False, cache_key: str | None = None):
    """
    Generator version — yields progress events as dicts so a web layer (or the
    CLI) can show live status. The final event is always either
    {"type": "plan_complete", "plan": {...}} or {"type": "error", "message": "..."}.
    """
    plan_cache = get_plan_cache_path(repo_path, cache_key)
    if plan_cache.exists() and not force_refresh:
        yield {"type": "info", "message": f"Using cached plan (delete {plan_cache.name} to force a fresh one)."}
        yield {"type": "plan_complete", "plan": json.loads(plan_cache.read_text())}
        return

    try:
        yield {"type": "progress", "step": "reading_repo", "message": "Reading repo..."}
        repo_content = read_repo(repo_path)

        yield {"type": "progress", "step": "grounding", "message": "Grounding with Tavily..."}
        tavily_context = ground_with_tavily("jQuery to React migration guide best practices 2026")

        yield {"type": "progress", "step": "planning", "message": "Calling Nemotron 3 Ultra for the migration plan (this costs credits)..."}
        migratable_files = list_migratable_files(repo_path)
        messages = build_prompt(repo_content, tavily_context, migratable_files)
        response = call_with_retry(
            client.chat.completions.create,
            model=ULTRA_MODEL,
            messages=messages,
            temperature=0.2,
            max_tokens=12000,
        )
        raw = response.choices[0].message.content
        plan, problems, dropped = _parse_and_prune(raw, repo_path)
        if problems:
            yield {"type": "info", "message": "Plan did not match the required schema - retrying with a correction..."}
            correction_messages = messages + [
                {"role": "assistant", "content": raw},
                {"role": "user", "content": (
                    "Your response was truncated or did not match the required schema. Respond with "
                    "ONLY a single complete JSON object of the form "
                    "{\"files\": [{\"path\": ..., \"new_path\": ..., \"priority\": <int>, "
                    "\"depends_on\": [], \"migration_notes\": \"...\"}], \"overall_notes\": \"...\"}. "
                    "Every 'path' MUST be copied verbatim from the allowed file list I gave you. "
                    "Do NOT write a project plan, phase breakdown, task list, risk register or "
                    "timeline. Keep each migration_notes under 60 words and overall_notes under 40 "
                    "words so the JSON is not cut off.\n\n"
                    "Problems found:\n- " + "\n- ".join(problems[:20]) + "\n\n"
                    "Your response did not match the required schema, OR listed files that don't exist in "
                    "this repository. You MUST respond with ONLY a JSON object containing a top-level "
                    "'files' array. Each entry's 'path' MUST be exactly one of these real files — do not "
                    "invent any other path: " + ", ".join(migratable_files) + ". "
                    "Do not list any file more than once. Try again now."
                )},
            ]
            response = call_with_retry(
                client.chat.completions.create,
                model=ULTRA_MODEL,
                messages=correction_messages,
                temperature=0.2,
                max_tokens=12000,
            )
            raw = response.choices[0].message.content
            plan, remaining, dropped = _parse_and_prune(raw, repo_path)
            if remaining:
                raise ValueError(
                    "Plan still did not match the required schema after one correction attempt: "
                    + "; ".join(remaining[:10])
                )

        if dropped and plan is not None and plan.get("files"):
            yield {"type": "info", "message": f"Pruned {len(dropped)} invalid file entries from the plan; proceeding with {len(plan['files'])} valid entries."}

        from utils import dedupe_plan_paths, ensure_core_files_present
        plan = dedupe_plan_paths(plan)
        plan = ensure_core_files_present(plan, migratable_files)
        if not plan.get("files"):
            raise ValueError("Plan has no valid file entries after pruning and safety nets.")

        plan = normalize_plan(plan)

        plan_cache.write_text(json.dumps(plan, indent=2))
        yield {"type": "info", "message": f"Plan saved to {plan_cache}"}
        yield {"type": "plan_complete", "plan": plan}

    except Exception as e:
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}


def get_migration_plan(repo_path: Path, force_refresh: bool = False, cache_key: str | None = None) -> dict:
    """CLI-friendly wrapper — consumes the stream, prints progress, returns the final plan."""
    plan = None
    for event in get_migration_plan_stream(repo_path, force_refresh, cache_key):
        if event["type"] in ("progress", "info"):
            print(event["message"])
        elif event["type"] == "error":
            raise RuntimeError(event["message"])
        elif event["type"] == "plan_complete":
            plan = event["plan"]
    return plan


if __name__ == "__main__":
    from pathlib import Path
    default_path = Path(__file__).parent.parent / "test-repos" / "sample-jquery-app"
    plan = get_migration_plan(default_path)
    print(json.dumps(plan, indent=2))