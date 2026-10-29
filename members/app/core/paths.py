"""Default locations and helper-binary discovery (Windows-first, works elsewhere)."""
from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

APP_NAME = "TranscriptApp"

_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def expand(path: str | os.PathLike) -> Path:
    """Expand ~ and %VARS% / $VARS in a user-supplied path."""
    return Path(os.path.expandvars(os.path.expanduser(str(path))))


def downloads_dir() -> Path:
    return Path.home() / "Downloads"


def default_cookies_path() -> Path:
    return downloads_dir() / "cookies.txt"


def default_output_dir() -> Path:
    return downloads_dir() / "Transcripts"


def app_data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / APP_NAME


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def find_ffmpeg() -> str | None:
    """Return the folder containing ffmpeg, or None. Checks next to the exe, PATH, then winget's links."""
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    candidates: list[Path] = []
    if is_frozen():
        candidates.append(Path(sys.executable).parent)
        if hasattr(sys, "_MEIPASS"):
            candidates.append(Path(sys._MEIPASS))  # type: ignore[attr-defined]
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(Path(found).parent)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "Microsoft" / "WinGet" / "Links")
    for folder in candidates:
        if (folder / exe).is_file():
            return str(folder)
    return None


def safe_filename(name: str, max_len: int = 120) -> str:
    """Make a title safe for a Windows filename while keeping Unicode (e.g. Devanagari)."""
    name = _INVALID_CHARS.sub("_", name)
    name = re.sub(r"\s+", " ", name).strip().rstrip(". ")
    if len(name) > max_len:
        name = name[:max_len].rstrip(". ")
    if not name:
        name = "video"
    if name.split(".")[0].upper() in _RESERVED:
        name = "_" + name
    return name
