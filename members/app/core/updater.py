"""Update yt-dlp: pip in a normal install; a verified PyPI wheel in a user folder for the packaged .exe."""
from __future__ import annotations

import hashlib
import importlib.abc
import importlib.machinery
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from .paths import app_data_dir, is_frozen

PYPI_JSON = "https://pypi.org/pypi/yt-dlp/json"


def user_lib_dir() -> Path:
    return app_data_dir() / "lib"


class _UserLibFinder(importlib.abc.MetaPathFinder):
    """Load yt_dlp from the user folder before PyInstaller's bundled copy."""

    def __init__(self, root: Path):
        self.root = str(root)

    def find_spec(self, name, path=None, target=None):
        if name == "yt_dlp" or name.startswith("yt_dlp."):
            return importlib.machinery.PathFinder.find_spec(name, path if name != "yt_dlp" else [self.root])
        return None


def activate_user_lib() -> None:
    """Call before yt_dlp is imported. No-op unless running as the packaged exe with an updated copy."""
    root = user_lib_dir()
    if is_frozen() and (root / "yt_dlp" / "__init__.py").is_file() and "yt_dlp" not in sys.modules:
        sys.meta_path.insert(0, _UserLibFinder(root))


def current_version() -> str:
    try:
        from yt_dlp.version import __version__
        return __version__
    except Exception:  # noqa: BLE001
        return "unknown"


def update_yt_dlp() -> str:
    """Returns a message for the user. Raises on failure."""
    if not is_frozen():
        proc = subprocess.run([sys.executable, "-m", "pip", "install", "-U", "yt-dlp[default]"],
                              capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout).strip().splitlines()[-1])
        return "yt-dlp updated with pip. Restart the app to use the new version."

    with urllib.request.urlopen(PYPI_JSON, timeout=30) as r:
        meta = json.load(r)
    version = meta["info"]["version"]
    wheel = next(f for f in meta["urls"] if f["packagetype"] == "bdist_wheel" and f["filename"].endswith("none-any.whl"))
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / wheel["filename"]
        with urllib.request.urlopen(wheel["url"], timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        if hashlib.sha256(dest.read_bytes()).hexdigest() != wheel["digests"]["sha256"]:
            raise RuntimeError("Downloaded yt-dlp failed its checksum; not installed.")
        staging = Path(tmp) / "lib"
        with zipfile.ZipFile(dest) as z:
            z.extractall(staging, [n for n in z.namelist() if n.startswith("yt_dlp/")])
        target = user_lib_dir()
        target.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(target / "yt_dlp", ignore_errors=True)
        shutil.move(str(staging / "yt_dlp"), target / "yt_dlp")
    return f"yt-dlp {version} installed. Restart the app to use it."
