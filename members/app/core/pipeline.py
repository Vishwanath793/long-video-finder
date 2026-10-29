"""The download workflow shared by the CLI and the GUI."""
from __future__ import annotations

import json
import re
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TypeVar

from . import captions, convert, whisper_fallback
from .captions import CookieSource, Log, Selection, VideoInfo
from .cookies import CookieReport, check_cookies
from .errors import FriendlyError, TranscriptError, classify
from .paths import safe_filename

T = TypeVar("T")
# ask(question) -> bool; used for the Whisper offer.
Ask = Callable[[str], bool]


@dataclass
class JobOptions:
    cookies: CookieSource | None = None
    languages: list[str] = field(default_factory=lambda: ["native"])
    output_dir: Path = Path(".")
    write_srt: bool = True
    write_txt: bool = True
    txt_bom: bool = True
    keep_raw: bool = False
    retries: int = 3
    retry_delay: float = 20.0  # seconds; doubles on each retry
    batch_delay: float = 3.0
    whisper_mode: str = "ask"  # ask | auto | never
    whisper_model: str = whisper_fallback.DEFAULT_MODEL
    whisper_task: str = "transcribe"  # transcribe | translate
    keep_audio: bool = False
    delete_cookies_after: bool = False
    verbose: bool = False
    library_names: bool = False  # <date>_<channel>_<id>_<lang> names (Long Video Finder)
    write_json: bool = False  # [{t: ms, s: text}] for the finder's search


@dataclass
class VideoResult:
    url: str
    video_id: str = ""
    title: str = ""
    files: list[Path] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    error: FriendlyError | None = None
    video: VideoInfo | None = None
    tracks: list[dict] = field(default_factory=list)  # one per saved language

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.files)


def read_url_list(text: str) -> list[str]:
    """One URL per line; blank lines and # comments ignored; duplicates removed."""
    urls: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and line not in urls:
            urls.append(line)
    return urls


def check_cookie_source(cookies: CookieSource | None, log: Log) -> CookieReport | None:
    """Validate a cookies file and log the findings. Returns None for browser/no cookies."""
    if cookies is None or cookies.path is None:
        return None
    report = check_cookies(cookies.path)
    for level, text in report.lines():
        log(level, text)
    if report.ok:
        log("success", "Cookies look OK.")
        cookies.path = report.path  # e.g. the resolved cookies.txt.txt
    return report


def _sleep(seconds: float, cancel: threading.Event | None) -> bool:
    """Sleep unless cancelled. Returns False if cancelled."""
    if cancel is None:
        time.sleep(seconds)
        return True
    return not cancel.wait(seconds)


def with_retry(fn: Callable[[], T], opts: JobOptions, log: Log, what: str,
               cancel: threading.Event | None = None) -> T:
    """Retry fn on HTTP 429 with exponential backoff."""
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 - classified below
            friendly = classify(e)
            if friendly.code != "RATE_LIMITED" or attempt >= opts.retries:
                raise
            wait = opts.retry_delay * (2 ** attempt)
            attempt += 1
            log("warning", f"Rate-limited by YouTube while {what}; retry {attempt}/{opts.retries} in {int(wait)} s...")
            if not _sleep(wait, cancel):
                raise


def _out_base(opts: JobOptions, video: VideoInfo) -> Path:
    return opts.output_dir / f"{safe_filename(video.title)} [{video.id}]"


def _stem(opts: JobOptions, video: VideoInfo, label: str) -> Path:
    """Output path without extension for one language track."""
    if opts.library_names:
        # Long Video Finder library style: ASCII only so /files/<name> links work.
        slug = re.sub(r"[^A-Za-z0-9]+", "-", video.channel or "").strip("-") or "YouTube"
        return opts.output_dir / f"{video.iso}_{slug}_{video.id}_{re.sub(r'[^A-Za-z0-9-]+', '-', label)}"
    return Path(f"{_out_base(opts, video)}.{label}")


def _write_outputs(stem: Path, cues: list[convert.Cue], opts: JobOptions) -> list[Path]:
    out: list[Path] = []
    if opts.write_srt:
        out.append(convert.write_text(f"{stem}.srt", convert.cues_to_srt(cues)))
    if opts.write_txt:
        out.append(convert.write_text(f"{stem}.txt", convert.cues_to_text(cues), bom=opts.txt_bom))
    if opts.write_json:
        segs = [{"t": int(round(c.start * 1000)), "s": c.text} for c in cues]
        Path(f"{stem}.json").write_text(json.dumps(segs, ensure_ascii=False), encoding="utf-8")
    return out


def _save_tracks(video: VideoInfo, selections: list[Selection], raw_files: dict[str, Path], opts: JobOptions,
                 log: Log, result: VideoResult) -> list[Path]:
    written: list[Path] = []
    for s in selections:
        src = raw_files.get(s.track.code)
        if src is None:
            log("warning", f"Track {s.track.code} wasn't downloaded.")
            continue
        stem = _stem(opts, video, s.label)
        cues, raw = convert.load_cues(src)
        cues = convert.clean_cues(cues, raw, True if s.track.source == "auto" else None)
        out = _write_outputs(stem, cues, opts)
        if opts.keep_raw:
            dest = Path(f"{stem}.raw{src.suffix}")
            shutil.copyfile(src, dest)
            out.append(dest)
        kind = "uploaded" if s.track.source == "manual" else "automatic"
        for p in out:
            log("success", f"Saved {p.name}  ({kind} captions, {s.track.code})")
        written.extend(out)
        result.tracks.append({"label": s.label, "code": s.track.code, "auto": s.track.source == "auto",
                              "whisper": False, "file": stem.name, "lines": len(cues)})
    return written


def _whisper(video: VideoInfo, opts: JobOptions, log: Log, ask: Ask | None,
             progress: Callable[[float], None] | None, cancel: threading.Event | None,
             result: VideoResult) -> list[Path]:
    est = whisper_fallback.estimate_seconds(video.duration, opts.whisper_model)
    if opts.whisper_mode == "never":
        return []
    if not whisper_fallback.is_available():
        log("warning", "Speech-to-text fallback unavailable: install it with pip install -r requirements-whisper.txt")
        return []
    action = "translate to English" if opts.whisper_task == "translate" else "transcribe in the original language"
    question = (f"No captions found for '{video.title}'.\n\nDownload the audio and {action} with Whisper "
                f"('{opts.whisper_model}' model)?\nEstimated time on CPU: {whisper_fallback.human_duration(est)} "
                f"for {whisper_fallback.human_duration(video.duration)} of audio.")
    if opts.whisper_mode == "ask" and not (ask and ask(question)):
        log("info", "Skipped speech-to-text.")
        return []
    log("info", f"Downloading audio for Whisper (estimated transcription time {whisper_fallback.human_duration(est)})...")
    audio = with_retry(lambda: whisper_fallback.download_audio(video, opts.cookies, log, opts.verbose),
                       opts, log, "downloading audio", cancel)
    try:
        lang = None
        if opts.whisper_task == "transcribe":
            wanted = [l for l in opts.languages if l != "native"]
            lang = video.native or (wanted[0] if wanted else None)
        log("info", f"Transcribing{' (' + lang + ')' if lang else ''} - this can take a while...")
        cues, detected = whisper_fallback.transcribe(audio, opts.whisper_model, lang, opts.whisper_task,
                                                     progress, log, cancel)
        label = "en" if opts.whisper_task == "translate" else (lang or detected or "auto")
        stem = _stem(opts, video, f"{label}-whisper" if opts.library_names else f"{label}.whisper")
        opts.output_dir.mkdir(parents=True, exist_ok=True)
        written = _write_outputs(stem, cues, opts)
        if opts.keep_audio:
            dest = Path(f"{stem}{audio.suffix}")
            shutil.move(str(audio), dest)
            written.append(dest)
        for p in written:
            log("success", f"Saved {p.name}  (Whisper)")
        result.tracks.append({"label": label, "code": label, "auto": True, "whisper": True,
                              "file": stem.name, "lines": len(cues)})
        return written
    finally:
        shutil.rmtree(audio.parent, ignore_errors=True)


def process_video(url: str, opts: JobOptions, log: Log, ask: Ask | None = None,
                  progress: Callable[[float], None] | None = None,
                  cancel: threading.Event | None = None) -> VideoResult:
    result = VideoResult(url)
    try:
        video = with_retry(lambda: captions.fetch_info(url, opts.cookies, log, opts.verbose),
                           opts, log, "reading the video page", cancel)
        result.video_id, result.title, result.video = video.id, video.title, video
        log("info", f"{video.title} [{video.id}]  native language: {video.native or 'unknown'}")
        selections, missing = captions.select_tracks(video, opts.languages)
        result.missing = missing
        for m in missing:
            log("warning", f"No captions for '{m}'.")
        if selections:
            log("info", "Downloading: " + ", ".join(f"{s.track.code} ({s.track.source})" for s in selections))
            tmp, raw = with_retry(lambda: captions.download_raw(video, selections, opts.cookies, log, opts.verbose),
                                  opts, log, "downloading captions", cancel)
            try:
                opts.output_dir.mkdir(parents=True, exist_ok=True)
                result.files += _save_tracks(video, selections, raw, opts, log, result)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        if missing and not (cancel and cancel.is_set()):
            result.files += _whisper(video, opts, log, ask, progress, cancel, result)
        if not result.files:
            result.error = classify("There are no subtitles for the requested languages")
    except Exception as e:  # noqa: BLE001 - every failure becomes a friendly message
        result.error = classify(e)
    if result.error:
        log("error", str(result.error))
        if result.error.code == "UNKNOWN" or opts.verbose:
            log("debug", f"Details: {result.error.detail}")
    return result


def run_job(urls: list[str], opts: JobOptions, log: Log, ask: Ask | None = None,
            progress: Callable[[float], None] | None = None,
            cancel: threading.Event | None = None) -> list[VideoResult]:
    results: list[VideoResult] = []
    try:
        for i, url in enumerate(urls):
            if cancel and cancel.is_set():
                log("warning", "Stopped.")
                break
            if i and opts.batch_delay and not _sleep(opts.batch_delay, cancel):
                log("warning", "Stopped.")
                break
            log("info", f"[{i + 1}/{len(urls)}] {url}")
            results.append(process_video(url, opts, log, ask, progress, cancel))
            if progress:
                progress((i + 1) / len(urls))
    finally:
        _summarize(results, urls, log)
        if opts.delete_cookies_after and opts.cookies and opts.cookies.path:
            try:
                opts.cookies.path.unlink(missing_ok=True)
                log("info", f"Deleted {opts.cookies.path}")
            except OSError as e:
                log("warning", f"Couldn't delete cookies file: {e}")
    return results


def _summarize(results: list[VideoResult], urls: list[str], log: Log) -> None:
    if len(urls) <= 1 and results:
        return
    ok = [r for r in results if r.ok]
    failed = [r for r in results if not r.ok]
    log("info", f"Done: {len(ok)} succeeded, {len(failed)} failed, {len(urls) - len(results)} not attempted.")
    for r in failed:
        log("error", f"  {r.title or r.url}: {r.error.message if r.error else 'no files'}")
