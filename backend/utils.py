import time
import hashlib
from pathlib import Path

def call_with_retry(fn, *args, retries=2, delay=2, **kwargs):
    """Retry a function call on exception, with a short delay between attempts.
    Used to absorb transient network errors when calling the Nemotron API."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(delay)
    raise last_err


def normalize_plan(plan: dict) -> dict:
    files = plan.get("files", [])

    # Fill in any missing keys and give every entry a usable new_path, so a
    # partially-formed plan can never raise KeyError during execution.
    for i, f in enumerate(files):
        f.setdefault("priority", i + 1)
        f.setdefault("depends_on", [])
        f.setdefault("migration_notes", "")
        f.setdefault("new_path", f"src/{Path(f['path']).stem}.jsx")
        if not isinstance(f["priority"], int):
            f["priority"] = i + 1

    html_entries = [f for f in files if f["path"].lower().endswith(".html")]
    js_entries = [f for f in files if f["path"].lower().endswith(".js")]
    css_entries = [f for f in files if f["path"].lower().endswith(".css")]

    if html_entries:
        html_entries[0]["new_path"] = "index.html"

    entry_js = None
    if js_entries:
        already_tagged = [f for f in js_entries if f.get("new_path") == "src/App.jsx"]

        # Prefer files whose original name suggests main application logic
        # over service workers, which are a distinct, non-UI script type.
        def is_likely_service_worker(f):
            name = Path(f["path"]).stem.lower()
            return "service-worker" in name or name in ("sw", "serviceworker")

        recovered_non_sw = [
            f for f in js_entries
            if str(f.get("new_path", "")).startswith("src/_recovered_")
            and not is_likely_service_worker(f)
        ]
        tagged_non_sw = [f for f in already_tagged if not is_likely_service_worker(f)]
        if recovered_non_sw and not tagged_non_sw:
            # Safety net (ensure_core_files_present): the model omitted a core
            # non-service-worker JS file entirely. The recovered copy must become
            # the entry even if the model explicitly tagged a service worker as
            # src/App.jsx — a plan missing its core logic is broken either way.
            entry_js = recovered_non_sw[0]
        elif already_tagged:
            entry_js = already_tagged[0]
        else:
            non_sw = [f for f in js_entries if not is_likely_service_worker(f)]
            candidates = non_sw if non_sw else js_entries
            entry_js = max(candidates, key=lambda f: f.get("priority", 0))
        entry_js["new_path"] = "src/App.jsx"

    # Any OTHER js file must not keep a new_path that could collide with the
    # entry file's "src/App.jsx" — park it under a name the build and linter
    # ignore entirely, so it can never shadow or be picked up.
    for other in js_entries:
        if other is not entry_js:
            other["new_path"] = f"src/_unused_{Path(other['path']).stem}.jsx.txt"
            other["migration_notes"] = (
                "NOTE: This file was not migrated as a standalone module — its logic, if "
                "relevant, should already be covered by the main component file in this plan. "
                "This entry exists for traceability only and is not used in the build."
            )

    if css_entries:
        css_entries[0]["new_path"] = "src/index.css"
        if entry_js is not None:
            entry_js["migration_notes"] = (
                entry_js.get("migration_notes", "")
                + "\n\nIMPORTANT: The migrated stylesheet is already imported globally by the "
                  "app's entry point (main.jsx). Do NOT add any CSS import statement to this file "
                  "yourself, and do not reference any CSS filename directly in this file."
                + "\n\nOVERRIDE — IGNORE ANY CONFLICTING INSTRUCTION ABOVE: Do NOT call createRoot, "
                  "ReactDOM.render, or any app-mounting code anywhere in this file, even if an earlier "
                  "note in this same message said to. This file must ONLY define the component and "
                  "end with `export default ComponentName;` — nothing else. The actual mounting is "
                  "handled entirely by a separate entry point file (main.jsx) that is not part of this "
                  "migration and already exists."
            )

    return plan


def get_plan_cache_path(repo_path: Path, cache_key: str | None = None) -> Path:
    """Each cloned repo gets its own cache file, keyed by its resolved path,
    so two different repos never collide on a single shared cache file.
    Pass cache_key (e.g. the GitHub URL) to make the key stable across clones —
    otherwise a fresh temp dir per clone would produce a fresh cache miss."""
    key_source = cache_key if cache_key else str(Path(repo_path).resolve())
    key = hashlib.sha256(key_source.encode()).hexdigest()[:16]
    return Path(__file__).parent / f"plan_cache_{key}.json"


def dedupe_plan_paths(plan: dict) -> dict:
    """
    Removes duplicate entries sharing the same original 'path' — keeping only
    the first occurrence. This guards against degenerate plans where the model
    lists the same file many times (observed: 11 duplicate index.html entries
    in one real-world test).
    """
    seen = set()
    deduped = []
    for entry in plan.get("files", []):
        path = entry.get("path")
        if path in seen:
            continue
        seen.add(path)
        deduped.append(entry)
    plan["files"] = deduped
    return plan


def ensure_core_files_present(plan: dict, migratable_files: list) -> dict:
    """
    Safety net: if the plan completely omits a real, relevant JS file from the
    repo (the most likely place for core app logic to live), add it back with
    safe defaults rather than silently proceeding without it. This has been
    observed to happen — the model's plan omitting script.js entirely while
    still being schema-valid otherwise.
    """
    planned_paths = {f.get("path") for f in plan.get("files", [])}
    max_priority = max((f.get("priority", 0) for f in plan.get("files", [])), default=0)

    for rel_path in migratable_files:
        if rel_path.endswith(".js") and rel_path not in planned_paths:
            max_priority += 1
            plan.setdefault("files", []).append({
                "path": rel_path,
                "new_path": f"src/_recovered_{Path(rel_path).stem}.jsx",
                "priority": max_priority,
                "depends_on": [],
                "migration_notes": (
                    "This file was omitted from the original plan and has been "
                    "automatically added back. Convert its jQuery logic to React "
                    "following the same conventions as other files in this migration."
                ),
            })
    return plan
