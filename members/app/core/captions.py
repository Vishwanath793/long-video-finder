"""List and download caption tracks with yt-dlp (used as a library)."""
from __future__ import annotations

import copy
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import yt_dlp

from .errors import FriendlyError, TranscriptError
from .paths import find_ffmpeg

Log = Callable[[str, str], None]  # (level, message); level in debug/info/warning/error/success

# Warnings yt-dlp prints about missing *video formats* are irrelevant when we only need captions.
_NOISY_WARNINGS = re.compile(r"JavaScript runtime|formats may be missing|PO Token|nsig|n challenge|"
                             r"Requested format is not available|Only images are available|SABR|impersonat", re.I)


@dataclass
class CookieSource:
    path: Path | None = None
    browser: str | None = None  # e.g. "firefox"

    def ydl_opts(self) -> dict:
        if self.browser:
            return {"cookiesfrombrowser": (self.browser, None, None, None)}
        if self.path:
            return {"cookiefile": str(self.path)}
        return {}

    def describe(self) -> str:
        if self.browser:
            return f"{self.browser} browser cookies"
        return f"cookies file {self.path}" if self.path else "no cookies (public videos only)"


@dataclass
class Track:
    code: str
    name: str
    source: str  # "manual" (uploaded) or "auto" (automatic captions)


@dataclass
class VideoInfo:
    id: str
    title: str
    url: str
    duration: float | None
    language: str | None
    native: str | None
    manual: dict[str, Track]
    auto: dict[str, Track]
    availability: str | None = None
    raw: dict = field(default_factory=dict, repr=False)
    channel: str = ""
    upload_date: str | None = None  # YYYYMMDD

    @property
    def iso(self) -> str:
        """Upload date as YYYY-MM-DD (today if YouTube didn't say)."""
        d = self.upload_date
        if d and len(d) == 8 and d.isdigit():
            return f"{d[:4]}-{d[4:6]}-{d[6:]}"
        from datetime import date
        return date.today().isoformat()

    @property
    def auto_originals(self) -> list[Track]:
        return [t for c, t in self.auto.items() if c.endswith("-orig")]


@dataclass
class Selection:
    request: str  # what the user asked for, e.g. "native" or "en"
    track: Track

    @property
    def label(self) -> str:
        """Language code used in output file names (hi-orig -> hi)."""
        return self.track.code.removesuffix("-orig")


class _YdlLogger:
    def __init__(self, log: Log, verbose: bool):
        self.log, self.verbose = log, verbose

    def debug(self, msg: str) -> None:
        if self.verbose:
            self.log("debug", msg)

    info = debug

    def warning(self, msg: str) -> None:
        if self.verbose or not _NOISY_WARNINGS.search(msg):
            self.log("warning", msg)

    def error(self, msg: str) -> None:
        # The same text arrives as a DownloadError and is shown in friendly form by the caller.
        if self.verbose:
            self.log("debug", msg)


def base_opts(cookies: CookieSource | None, log: Log, verbose: bool = False) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": False,
        "noprogress": True,
        "skip_download": True,
        "noplaylist": True,
        "ignore_no_formats_error": True,
        "socket_timeout": 30,
        "retries": 3,
        "logger": _YdlLogger(log, verbose),
    }
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    if cookies:
        opts.update(cookies.ydl_opts())
    return opts


def _tracks(data: dict | None, source: str) -> dict[str, Track]:
    out: dict[str, Track] = {}
    for code, formats in (data or {}).items():
        if code == "live_chat" or not formats:
            continue
        name = next((f.get("name") for f in formats if f.get("name")), "") or code
        out[code] = Track(code, name, source)
    return out


def detect_native(info: dict, manual: dict[str, Track], auto: dict[str, Track]) -> str | None:
    origs = [c.removesuffix("-orig") for c in auto if c.endswith("-orig")]
    if origs:
        return origs[0]
    lang = info.get("language")
    if lang:
        return lang
    if len(manual) == 1:
        return next(iter(manual))
    return None


def fetch_info(url: str, cookies: CookieSource | None, log: Log, verbose: bool = False) -> VideoInfo:
    """Fetch metadata (including caption lists) without downloading anything."""
    with yt_dlp.YoutubeDL(base_opts(cookies, log, verbose)) as ydl:
        info = ydl.extract_info(url, download=False, process=False)
        for _ in range(3):  # follow redirects such as short links
            if info and info.get("_type") in ("url", "url_transparent"):
                info = ydl.extract_info(info["url"], download=False, process=False)
            else:
                break
    if not info:
        raise TranscriptError(FriendlyError("UNAVAILABLE", "YouTube returned no information for this URL.",
                                            "Check the link in a browser."))
    if info.get("_type") in ("playlist", "multi_video"):
        raise TranscriptError(FriendlyError(
            "PLAYLIST", "That's a playlist/channel link, not a single video.",
            "Paste individual video URLs (one per line) or a link containing watch?v=..."))
    manual = _tracks(info.get("subtitles"), "manual")
    auto = _tracks(info.get("automatic_captions"), "auto")
    return VideoInfo(
        id=info.get("id") or "",
        title=info.get("title") or info.get("id") or "video",
        url=info.get("webpage_url") or url,
        duration=info.get("duration"),
        language=info.get("language"),
        native=detect_native(info, manual, auto),
        manual=manual,
        auto=auto,
        availability=info.get("availability"),
        raw=info,
        channel=info.get("channel") or info.get("uploader") or "",
        upload_date=info.get("upload_date") or info.get("release_date"),
    )


def parse_lang_spec(spec: str) -> list[str]:
    """'native, hi,EN' -> ['native', 'hi', 'en'] (de-duplicated, order kept)."""
    seen: list[str] = []
    for part in re.split(r"[,\s;]+", spec or ""):
        part = part.strip()
        if not part:
            continue
        part = "native" if part.lower() in ("native", "original", "orig") else part
        if part.lower() not in [s.lower() for s in seen]:
            seen.append(part)
    return seen or ["native"]


def resolve_track(video: VideoInfo, code: str) -> Track | None:
    """Uploaded subs beat ASR; then the original-language ASR track (-orig); then any auto track."""
    lc = code.lower()

    def find(tracks: dict[str, Track], want: str, prefix: bool = False) -> Track | None:
        for c, t in tracks.items():
            if c.lower() == want or (prefix and c.lower().startswith(want + "-") and not c.endswith("-orig")):
                return t
        return None

    return (find(video.manual, lc) or find(video.manual, lc, prefix=True)
            or find(video.auto, lc + "-orig") or find(video.auto, lc))


def select_tracks(video: VideoInfo, requests: list[str]) -> tuple[list[Selection], list[str]]:
    """Return (selections, missing_requests)."""
    selections: list[Selection] = []
    missing: list[str] = []
    for req in requests:
        code = video.native if req == "native" else req
        track = resolve_track(video, code) if code else None
        if track is None:
            missing.append(req if req != "native" or not code else f"native ({code})")
            continue
        if all(s.track.code != track.code for s in selections):
            selections.append(Selection(req, track))
    return selections, missing


def download_raw(video: VideoInfo, selections: list[Selection], cookies: CookieSource | None, log: Log,
                 verbose: bool = False) -> tuple[Path, dict[str, Path]]:
    """Download chosen tracks into a fresh temp folder. Returns (temp_dir, {track_code: file})."""
    tmp = Path(tempfile.mkdtemp(prefix=f"yt-subs-{video.id}-"))
    opts = base_opts(cookies, log, verbose)
    opts.update({
        "writesubtitles": any(s.track.source == "manual" for s in selections),
        "writeautomaticsub": any(s.track.source == "auto" for s in selections),
        "subtitleslangs": [re.escape(s.track.code) for s in selections],
        "subtitlesformat": "vtt/srt/best",
        "outtmpl": {"default": "%(id)s.%(ext)s", "subtitle": "%(id)s.%(ext)s"},
        "paths": {"home": str(tmp), "temp": str(tmp)},
    })
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.process_ie_result(copy.deepcopy(video.raw), download=True)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    files: dict[str, Path] = {}
    for s in selections:
        hits = sorted(p for p in tmp.iterdir() if p.name.startswith(f"{video.id}.{s.track.code}."))
        if hits:
            files[s.track.code] = hits[0]
    return tmp, files


def describe_tracks(video: VideoInfo) -> list[str]:
    lines = [f"{video.title} [{video.id}]",
             f"  Native language: {video.native or 'unknown'}"
             + (f"   (availability: {video.availability})" if video.availability else "")]
    if video.manual:
        lines.append("  Uploaded subtitles: " + ", ".join(f"{t.code} ({t.name})" for t in video.manual.values()))
    else:
        lines.append("  Uploaded subtitles: none")
    origs = video.auto_originals
    if origs:
        lines.append("  Automatic captions (original): " + ", ".join(f"{t.code} ({t.name})" for t in origs))
    translated = [c for c in video.auto if not c.endswith("-orig")]
    if translated:
        shown = ", ".join(translated[:25]) + (" ..." if len(translated) > 25 else "")
        lines.append(f"  Auto-translated captions ({len(translated)}): {shown}")
    if not video.manual and not video.auto:
        lines.append("  No captions at all - the Whisper speech-to-text fallback can transcribe it.")
    return lines
