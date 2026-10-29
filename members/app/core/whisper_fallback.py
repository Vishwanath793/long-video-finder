"""Speech-to-text fallback for videos without captions, using faster-whisper on the CPU."""
from __future__ import annotations

import copy
import importlib.util
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Callable

import yt_dlp

from .captions import CookieSource, Log, VideoInfo, base_opts
from .convert import Cue
from .errors import FriendlyError, TranscriptError
from .paths import find_ffmpeg

MODELS = ("small", "medium")
DEFAULT_MODEL = "medium"
# Very rough CPU (int8) processing time as a multiple of audio length.
_SPEED = {"tiny": 0.15, "base": 0.25, "small": 0.5, "medium": 1.3, "large-v3": 3.0}


def is_available() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


def estimate_seconds(duration: float | None, model: str) -> float | None:
    return duration * _SPEED.get(model, 1.3) if duration else None


def human_duration(seconds: float | None) -> str:
    if not seconds:
        return "unknown"
    m = int(round(seconds / 60))
    return f"~{m} min" if m < 90 else f"~{m / 60:.1f} h"


def download_audio(video: VideoInfo, cookies: CookieSource | None, log: Log, verbose: bool = False) -> Path:
    """Download best audio into a temp folder (converted to m4a when ffmpeg is available)."""
    tmp = Path(tempfile.mkdtemp(prefix=f"yt-audio-{video.id}-"))
    opts = base_opts(cookies, log, verbose)
    opts.update({
        "skip_download": False,
        "ignore_no_formats_error": False,
        "format": "bestaudio/best",
        "outtmpl": {"default": "%(id)s.audio.%(ext)s"},
        "paths": {"home": str(tmp), "temp": str(tmp)},
    })
    if find_ffmpeg():
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}]
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.process_ie_result(copy.deepcopy(video.raw), download=True)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    files = sorted((p for p in tmp.iterdir() if p.name.startswith(f"{video.id}.audio.")
                    and not p.name.endswith((".part", ".ytdl"))), key=lambda p: p.stat().st_size, reverse=True)
    if not files:
        shutil.rmtree(tmp, ignore_errors=True)
        raise TranscriptError(FriendlyError("AUDIO", "The audio download produced no file.",
                                            "Update yt-dlp and try again."))
    return files[0]


def transcribe(audio: Path, model_size: str = DEFAULT_MODEL, language: str | None = None,
               task: str = "transcribe", progress: Callable[[float], None] | None = None,
               log: Log | None = None, cancel: threading.Event | None = None) -> tuple[list[Cue], str | None]:
    """Return (cues, detected_language). task is 'transcribe' (original language) or 'translate' (to English)."""
    if not is_available():
        raise TranscriptError(FriendlyError(
            "NO_WHISPER", "Speech-to-text needs the faster-whisper package.",
            "Run: pip install -r requirements-whisper.txt"))
    from faster_whisper import WhisperModel  # heavy import, only when needed

    if log:
        log("info", f"Loading Whisper model '{model_size}' (first use downloads it, ~0.5-1.5 GB)...")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(str(audio), language=language or None, task=task,
                                      vad_filter=True, beam_size=5)
    total = info.duration or 0
    cues: list[Cue] = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            cues.append(Cue(seg.start, seg.end, [text]))
        if progress and total:
            progress(min(1.0, seg.end / total))
        if cancel is not None and cancel.is_set():
            if log:
                log("warning", "Transcription stopped early; saving what was done so far.")
            break
    return cues, getattr(info, "language", None)
