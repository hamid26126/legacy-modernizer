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
        # Prefer whichever JS file the model already mapped to the React entry —
        # priority alone can rank a service worker above the real app logic.
        already_tagged = [f for f in js_entries if f.get("new_path") == "src/App.jsx"]
        if already_tagged:
            entry_js = already_tagged[0]
        else:
            entry_js = max(js_entries, key=lambda f: f.get("priority", 0))
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
