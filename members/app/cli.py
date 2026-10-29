"""Command-line entry point: python -m app.cli URL [URL ...]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .core import captions, whisper_fallback
from .core.captions import CookieSource
from .core.errors import classify
from .core.paths import default_cookies_path, default_output_dir, expand
from .core.pipeline import JobOptions, check_cookie_source, read_url_list, run_job

_COLORS = {"error": "\x1b[31m", "warning": "\x1b[33m", "success": "\x1b[32m", "debug": "\x1b[90m"}
_PREFIX = {"error": "ERROR: ", "warning": "Warning: ", "success": "OK ", "debug": "  "}


def _make_log(verbose: bool):
    color = sys.stdout.isatty()

    def log(level: str, msg: str) -> None:
        if level == "debug" and not verbose:
            return
        text = _PREFIX.get(level, "") + msg
        print(f"{_COLORS[level]}{text}\x1b[0m" if color and level in _COLORS else text, flush=True)

    return log


def _ask(question: str) -> bool:
    if not sys.stdin or not sys.stdin.isatty():
        return False
    print("\n" + question)
    return input("[y/N] ").strip().lower() in ("y", "yes")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="transcript-app",
                                description="Download YouTube transcripts (incl. members-only) as .srt and .txt.")
    p.add_argument("urls", nargs="*", help="video URL(s)")
    p.add_argument("-i", "--input", metavar="FILE", help="text file with one URL per line")
    c = p.add_mutually_exclusive_group()
    c.add_argument("-c", "--cookies", metavar="FILE", help=f"Netscape cookies.txt (default: {default_cookies_path()})")
    c.add_argument("--firefox", action="store_true", help="read cookies from Firefox instead of a file")
    c.add_argument("--no-cookies", action="store_true", help="don't use cookies (public videos only)")
    p.add_argument("-l", "--lang", default="native",
                   help="languages, comma separated: native, hi, en, or any code (default: native)")
    p.add_argument("-o", "--output", metavar="DIR", default=str(default_output_dir()), help="output folder")
    p.add_argument("--formats", default="srt,txt", help="srt, txt or srt,txt (default: both)")
    p.add_argument("--no-bom", action="store_true", help="write .txt as UTF-8 without BOM")
    p.add_argument("--keep-raw", action="store_true", help="also keep the original downloaded .vtt")
    p.add_argument("--list", action="store_true", help="only list available caption languages")
    p.add_argument("--check-cookies", action="store_true", help="only validate the cookies file")
    p.add_argument("--skip-cookie-check", action="store_true", help="don't abort on cookie-file problems")
    p.add_argument("--delete-cookies", action="store_true", help="delete the cookies file after the run")
    p.add_argument("--delay", type=float, default=3.0, help="seconds between batch items (default: 3)")
    p.add_argument("--retries", type=int, default=3, help="retries on HTTP 429 (default: 3)")
    w = p.add_argument_group("speech-to-text fallback (needs faster-whisper)")
    w.add_argument("--whisper", choices=["ask", "auto", "never"], default="ask",
                   help="when a video has no captions (default: ask)")
    w.add_argument("--whisper-model", default=whisper_fallback.DEFAULT_MODEL,
                   help="small / medium (default: medium)")
    w.add_argument("--translate", action="store_true", help="Whisper: translate to English instead of transcribing")
    w.add_argument("--keep-audio", action="store_true", help="keep the downloaded audio file")
    p.add_argument("-v", "--verbose", action="store_true", help="show yt-dlp details")
    return p


def _cookie_source(args) -> tuple[CookieSource | None, bool]:
    """Returns (source, explicit)."""
    if args.no_cookies:
        return None, True
    if args.firefox:
        return CookieSource(browser="firefox"), True
    if args.cookies:
        return CookieSource(path=expand(args.cookies)), True
    return CookieSource(path=default_cookies_path()), False


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if stream and hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    args = build_parser().parse_args(argv)
    log = _make_log(args.verbose)
    cookies, explicit = _cookie_source(args)

    if cookies and cookies.path:
        report = check_cookie_source(cookies, log)
        if args.check_cookies:
            return 0 if report and report.ok else 2
        if report and not report.ok:
            if not explicit and report.path is None:
                log("warning", "Continuing without cookies (public videos only).")
                cookies = None
            elif not args.skip_cookie_check:
                log("error", "Fix the cookies file first (or pass --skip-cookie-check / --no-cookies).")
                return 2
    elif args.check_cookies:
        log("info", "No cookies file to check.")
        return 0

    urls = list(args.urls)
    if args.input:
        try:
            urls += read_url_list(expand(args.input).read_text(encoding="utf-8-sig"))
        except OSError as e:
            log("error", f"Can't read {args.input}: {e}")
            return 2
    urls = read_url_list("\n".join(urls))
    if not urls:
        build_parser().print_usage()
        log("error", "Give at least one URL or --input FILE.")
        return 2

    if args.list:
        status = 0
        for url in urls:
            try:
                for line in captions.describe_tracks(captions.fetch_info(url, cookies, log, args.verbose)):
                    print(line)
            except Exception as e:  # noqa: BLE001
                log("error", str(classify(e)))
                status = 1
        return status

    formats = {f.strip().lower() for f in args.formats.split(",")}
    opts = JobOptions(
        cookies=cookies,
        languages=captions.parse_lang_spec(args.lang),
        output_dir=expand(args.output),
        write_srt="srt" in formats,
        write_txt="txt" in formats,
        txt_bom=not args.no_bom,
        keep_raw=args.keep_raw,
        retries=args.retries,
        batch_delay=args.delay,
        whisper_mode=args.whisper,
        whisper_model=args.whisper_model,
        whisper_task="translate" if args.translate else "transcribe",
        keep_audio=args.keep_audio,
        delete_cookies_after=args.delete_cookies,
        verbose=args.verbose,
    )
    log("info", f"Using {cookies.describe() if cookies else 'no cookies'}; output: {opts.output_dir}")
    results = run_job(urls, opts, log, ask=_ask)
    return 0 if results and all(r.ok for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
