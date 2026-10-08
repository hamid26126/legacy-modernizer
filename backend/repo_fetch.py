import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from utils import call_with_retry

MAX_REPO_FILES = 60          # safety cap — reject repos larger than this
RELEVANT_EXTENSIONS = {".js", ".html", ".css"}


class RepoFetchError(Exception):
    pass


def validate_github_url(url: str) -> str:
    """Basic validation — must be a github.com URL. Returns the normalized URL."""
    parsed = urlparse(url)
    if parsed.netloc not in ("github.com", "www.github.com"):
        raise RepoFetchError("Only github.com URLs are supported.")
    path_parts = [p for p in parsed.path.split("/") if p]
    if len(path_parts) < 2:
        raise RepoFetchError("URL must point to a repo, e.g. https://github.com/owner/repo")
    owner, repo = path_parts[0], path_parts[1]
    repo = repo.removesuffix(".git")
    return f"https://github.com/{owner}/{repo}.git"


def detect_jquery_usage(repo_path: Path) -> bool:
    """Heuristic check: does this repo appear to be a jQuery-based app?
    Checks HTML files for a jquery script reference, and JS files for
    common jQuery usage patterns."""
    import re
    html_files = list(repo_path.rglob("*.html"))
    js_files = [f for f in repo_path.rglob("*.js") if "node_modules" not in f.parts]

    for f in html_files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            if re.search(r'jquery[.\-]?[\d.]*\.min\.js|jquery\.js|code\.jquery\.com', content, re.IGNORECASE):
                return True
        except Exception:
            continue

    jquery_patterns = re.compile(r'\$\(document\)\.ready|\$\([\'"][^\'"]+[\'"]\)\.(on|click|ajax|css|hide|show|toggle|append)|jQuery\(')
    for f in js_files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
            if jquery_patterns.search(content):
                return True
        except Exception:
            continue
    return False


def clone_repo(url: str) -> Path:
    """
    Shallow-clones the repo into a fresh temp directory and returns its path.
    Caller is responsible for cleanup via cleanup_repo().
    """
    clone_url = validate_github_url(url)
    dest: Path | None = None

    def _clone_attempt() -> Path:
        """One clone attempt. Each attempt gets its OWN fresh temp directory —
        git refuses to clone into a directory that already exists and is not
        empty, so reusing one dest across retries always failed on attempt 2+."""
        nonlocal dest
        dest = Path(tempfile.mkdtemp(prefix="legacy_modernizer_"))
        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", clone_url, str(dest)],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except Exception:
            shutil.rmtree(dest, ignore_errors=True)
            raise
        return dest

    try:
        dest = call_with_retry(_clone_attempt, retries=2, delay=3)
    except subprocess.CalledProcessError as e:
        if dest is not None:
            shutil.rmtree(dest, ignore_errors=True)
        stderr = (e.stderr or "").lower()
        if "not found" in stderr or "repository not found" in stderr:
            raise RepoFetchError("This repository doesn't exist or is private. Please check the URL and try again.")
        elif "could not resolve host" in stderr or "network" in stderr:
            raise RepoFetchError("Could not reach GitHub. Please check your internet connection and try again.")
        elif "timed out" in stderr:
            raise RepoFetchError("The connection to GitHub timed out. Please try again.")
        else:
            raise RepoFetchError("Could not clone this repository. Please check the URL and try again.")
    except subprocess.TimeoutExpired:
        if dest is not None:
            shutil.rmtree(dest, ignore_errors=True)
        raise RepoFetchError("Clone timed out after 60s.")

    relevant_files = [
        f for f in dest.rglob("*")
        if f.is_file() and f.suffix in RELEVANT_EXTENSIONS and "node_modules" not in f.parts
    ]
    if len(relevant_files) == 0:
        shutil.rmtree(dest, ignore_errors=True)
        raise RepoFetchError("No .js/.html/.css files found in this repo.")
    if len(relevant_files) > MAX_REPO_FILES:
        shutil.rmtree(dest, ignore_errors=True)
        raise RepoFetchError(
            f"Repo has {len(relevant_files)} relevant files, which exceeds the current "
            f"limit of {MAX_REPO_FILES}. This tool currently targets small-to-medium apps."
        )
    if not detect_jquery_usage(dest):
        shutil.rmtree(dest, ignore_errors=True)
        raise RepoFetchError(
            "This doesn't look like a jQuery application. This tool currently "
            "only supports migrating vanilla jQuery apps to React. Support for "
            "other frameworks/languages may be added in the future."
        )
    return dest


def _remove_readonly(func, path, _):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def cleanup_repo(path: Path):
    shutil.rmtree(path, onerror=_remove_readonly)
