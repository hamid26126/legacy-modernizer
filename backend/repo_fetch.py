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


def clone_repo(url: str) -> Path:
    """
    Shallow-clones the repo into a fresh temp directory and returns its path.
    Caller is responsible for cleanup via cleanup_repo().
    """
    clone_url = validate_github_url(url)
    dest = Path(tempfile.mkdtemp(prefix="legacy_modernizer_"))
    try:
        call_with_retry(
            subprocess.run,
            ["git", "clone", "--depth", "1", clone_url, str(dest)],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
            retries=2,
            delay=3,
        )
    except subprocess.CalledProcessError as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise RepoFetchError(f"Could not clone repo: {e.stderr.strip()[:300]}")
    except subprocess.TimeoutExpired:
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
    return dest


def _remove_readonly(func, path, _):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def cleanup_repo(path: Path):
    shutil.rmtree(path, onerror=_remove_readonly)
