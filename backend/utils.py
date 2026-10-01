import time

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

    html_entries = [f for f in files if f["path"].lower().endswith(".html")]
    js_entries = [f for f in files if f["path"].lower().endswith(".js")]
    css_entries = [f for f in files if f["path"].lower().endswith(".css")]

    if html_entries:
        html_entries[0]["new_path"] = "index.html"

    entry_js = None
    if js_entries:
        entry_js = max(js_entries, key=lambda f: f.get("priority", 0))
        entry_js["new_path"] = "src/App.jsx"

    if css_entries:
        css_entries[0]["new_path"] = "src/index.css"
        if entry_js is not None:
            entry_js["migration_notes"] = (
                entry_js.get("migration_notes", "")
                + "\n\nIMPORTANT: The migrated stylesheet is already imported globally by the "
                  "app's entry point (main.jsx). Do NOT add any CSS import statement to this file "
                  "yourself, and do not reference any CSS filename directly in this file."
            )

    return plan
