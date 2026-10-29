"""JSON-lines bridge for the Long Video Finder server.

The server starts `python -m app.bridge`, writes one JSON command line to stdin, then reads events from stdout:
  {"type": "log", "level": "info|success|warning|error|debug", "msg": "..."}
  {"type": "progress", "value": 0.0-1.0}
  {"type": "ask", "question": "..."}          -> server answers with a stdin line {"answer": true|false}
  {"type": "result", "data": {...}}           -> last line
Any time later the server may send {"cancel": true}. Cookie values never leave this process.
"""
from __future__ import annotations

import json
import queue
import sys
import threading
from pathlib import Path

from .core import captions, updater, whisper_fallback
from .core.captions import CookieSource
from .core.errors import classify
from .core.paths import default_cookies_path, expand, find_ffmpeg
from .core.pipeline import JobOptions, check_cookie_source, read_url_list, run_job

_out = sys.stdout
sys.stdout = sys.stderr  # anything else that prints must not corrupt the protocol
_lock = threading.Lock()
answers: queue.Queue = queue.Queue()
cancel = threading.Event()


def emit(kind: str, **data) -> None:
    with _lock:
        _out.write(json.dumps({"type": kind, **data}, ensure_ascii=False) + "\n")
        _out.flush()


def log(level: str, msg: str) -> None:
    emit("log", level=level, msg=msg)


def ask(question: str) -> bool:
    emit("ask", question=question)
    return bool(answers.get())


def _read_stdin() -> None:
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("cancel"):
            cancel.set()
            answers.put(False)
        elif "answer" in msg:
            answers.put(bool(msg["answer"]))
    answers.put(False)  # stdin closed: no more answers, so any question means "no"


def _cookies(cmd: dict) -> CookieSource | None:
    c = cmd.get("cookies") or {}
    mode = c.get("mode", "file")
    if mode == "firefox":
        return CookieSource(browser="firefox")
    if mode == "file":
        return CookieSource(path=expand(c.get("path") or default_cookies_path()))
    return None


def _cookies_ok(cookies: CookieSource | None) -> bool:
    if cookies and cookies.path:
        report = check_cookie_source(cookies, log)
        if report and not report.ok:
            log("error", "Fix the cookies file first, or choose 'No cookies' for public videos.")
            return False
    return True


def cmd_status(cmd: dict) -> dict:
    return {"ytdlp": updater.current_version(), "python": sys.version.split()[0],
            "whisper": whisper_fallback.is_available(), "ffmpeg": bool(find_ffmpeg()),
            "defaultCookies": str(default_cookies_path())}


def cmd_check(cmd: dict) -> dict:
    cookies = _cookies(cmd)
    if cookies is None or cookies.browser:
        log("info", "The cookie file check applies to the 'cookies.txt file' option only.")
        return {"ok": True}
    report = check_cookie_source(cookies, log)
    return {"ok": bool(report and report.ok), "path": str(report.path) if report and report.path else None}


def cmd_list(cmd: dict) -> dict:
    cookies = _cookies(cmd)
    if not _cookies_ok(cookies):
        return {"videos": []}
    videos = []
    for url in read_url_list(cmd.get("urls", "")):
        if cancel.is_set():
            break
        try:
            v = captions.fetch_info(url, cookies, log)
            for line in captions.describe_tracks(v):
                log("info", line)
            videos.append({"url": url, "id": v.id, "title": v.title, "channel": v.channel, "iso": v.iso,
                           "native": v.native, "manual": list(v.manual), "orig": [t.code for t in v.auto_originals],
                           "translated": sum(1 for c in v.auto if not c.endswith("-orig"))})
        except Exception as e:  # noqa: BLE001
            f = classify(e)
            log("error", str(f))
            videos.append({"url": url, "error": {"code": f.code, "message": f.message, "fix": f.fix}})
    return {"videos": videos}


def cmd_download(cmd: dict) -> dict:
    cookies = _cookies(cmd)
    if not _cookies_ok(cookies):
        return {"videos": [], "aborted": True}
    urls = read_url_list(cmd.get("urls", ""))
    opts = JobOptions(
        cookies=cookies,
        languages=captions.parse_lang_spec(cmd.get("languages", "native")),
        output_dir=Path(cmd["outputDir"]),
        write_srt=cmd.get("srt", True),
        write_txt=cmd.get("txt", True),
        txt_bom=cmd.get("bom", True),
        whisper_mode=cmd.get("whisperMode", "ask"),
        whisper_model=cmd.get("whisperModel", whisper_fallback.DEFAULT_MODEL),
        whisper_task=cmd.get("whisperTask", "transcribe"),
        keep_audio=cmd.get("keepAudio", False),
        delete_cookies_after=cmd.get("deleteCookies", False),
        batch_delay=float(cmd.get("delay", 3)),
        library_names=True,
        write_json=True,
    )
    log("info", f"Languages: {', '.join(opts.languages)}; using {cookies.describe() if cookies else 'no cookies'}")
    results = run_job(urls, opts, log, ask=ask, progress=lambda v: emit("progress", value=v), cancel=cancel)
    out = []
    for r in results:
        v = r.video
        out.append({
            "url": r.url, "ok": r.ok, "id": r.video_id, "title": r.title, "missing": r.missing,
            "channel": v.channel if v else "", "iso": v.iso if v else None,
            "duration": v.duration if v else None, "url_canonical": v.url if v else r.url,
            "tracks": r.tracks,
            "error": {"code": r.error.code, "message": r.error.message, "fix": r.error.fix} if r.error else None,
        })
    return {"videos": out}


def cmd_update(cmd: dict) -> dict:
    log("info", f"Updating yt-dlp (current {updater.current_version()})...")
    msg = updater.update_yt_dlp()
    log("success", msg)
    return {"message": msg}


COMMANDS = {"status": cmd_status, "check": cmd_check, "list": cmd_list, "download": cmd_download,
            "update": cmd_update}


def main() -> int:
    try:
        cmd = json.loads(sys.stdin.readline() or "{}")
    except ValueError:
        cmd = {}
    threading.Thread(target=_read_stdin, daemon=True).start()
    handler = COMMANDS.get(cmd.get("cmd"))
    if handler is None:
        emit("result", data={"error": f"Unknown command {cmd.get('cmd')!r}"})
        return 2
    try:
        emit("result", data=handler(cmd))
    except Exception as e:  # noqa: BLE001 - always answer in friendly form
        f = classify(e)
        log("error", str(f))
        emit("result", data={"error": f.message, "fix": f.fix})
    return 0


if __name__ == "__main__":
    sys.exit(main())
