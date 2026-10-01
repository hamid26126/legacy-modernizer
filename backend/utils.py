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
    """
    Force predictable output paths for the files our sandbox scaffold depends
    on, regardless of what the LLM named them. The scaffold hardcodes
    index.html at the project root and main.jsx importing from './App.jsx'
    and './index.css' — so these three roles must always resolve to those
    exact paths, independent of whatever new_path the plan proposed.
    """
    files = plan.get("files", [])

    html_entries = [f for f in files if f["path"].lower().endswith(".html")]
    js_entries = [f for f in files if f["path"].lower().endswith(".js")]
    css_entries = [f for f in files if f["path"].lower().endswith(".css")]

    if html_entries:
        html_entries[0]["new_path"] = "index.html"

    if js_entries:
        entry_js = max(js_entries, key=lambda f: f.get("priority", 0))
        entry_js["new_path"] = "src/App.jsx"

    if css_entries:
        css_entries[0]["new_path"] = "src/index.css"

    return plan
