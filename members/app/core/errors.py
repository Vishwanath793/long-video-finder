"""Map raw yt-dlp / OS errors to one-line friendly explanations with a fix."""
from __future__ import annotations

import re
from dataclasses import dataclass

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_PREFIX = re.compile(r"^(?:ERROR:\s*)?(?:\[[\w:]+\]\s*)?(?:[\w-]{11}:\s+)?")  # 11 chars = YouTube video id


@dataclass(frozen=True)
class FriendlyError:
    code: str
    message: str
    fix: str = ""
    detail: str = ""

    def __str__(self) -> str:
        return f"{self.message} Fix: {self.fix}" if self.fix else self.message


class TranscriptError(Exception):
    """An error that already carries a friendly explanation."""

    def __init__(self, friendly: FriendlyError):
        super().__init__(str(friendly))
        self.friendly = friendly


# (code, patterns, message, fix) — first match wins, so specific rules go first.
_RULES: list[tuple[str, list[str], str, str]] = [
    ("MEMBERS_ONLY",
     [r"members[- ]only", r"join this channel"],
     "This is a members-only video and YouTube didn't see a member login.",
     "Re-export cookies.txt (Get cookies.txt LOCALLY) while signed in with your member account on youtube.com, then try again."),
    ("RATE_LIMITED",
     [r"HTTP Error 429", r"Too Many Requests"],
     "YouTube is rate-limiting requests (HTTP 429).",
     "Wait 10-30 minutes, request fewer languages (auto-translated tracks are the worst), and keep a delay between batch items."),
    ("BOT_CHECK",
     [r"confirm you(?:'|’)?re not a bot"],
     "YouTube wants a sign-in to confirm you're not a bot.",
     "Use a fresh cookies.txt exported from a signed-in browser."),
    ("AGE_RESTRICTED",
     [r"confirm your age", r"age[- ]restricted", r"inappropriate for some users"],
     "This video is age-restricted.",
     "Use cookies.txt from an account that has confirmed its age."),
    ("PRIVATE",
     [r"private video"],
     "This video is private.",
     "Only accounts the uploader invited can open it; use cookies.txt from such an account."),
    ("NOT_LIVE_YET",
     [r"live event will begin", r"premieres? in", r"is not available yet", r"recording is not available"],
     "This stream or premiere isn't available yet.",
     "Try again after it ends and YouTube finishes processing it."),
    ("UNAVAILABLE",
     [r"video unavailable", r"this video is not available", r"has been removed",
      r"account associated with this video has been terminated", r"not made this video available in your country"],
     "YouTube says this video is unavailable.",
     "Check the URL in a browser while signed in; it may be deleted, blocked in your country, or the link is wrong."),
    ("NO_SUBTITLES",
     [r"there are no subtitles", r"has no subtitles", r"no subtitles for the requested languages", r"no captions"],
     "This video has no captions in the requested language.",
     "Use 'List languages' to pick another language, or use the speech-to-text (Whisper) fallback."),
    ("COOKIE_FILE",
     [r"Netscape format cookies", r"invalid Netscape", r"cookies?.*(?:not found|no such file)"],
     "The cookies file couldn't be read.",
     "Re-export it in Netscape format with Get cookies.txt LOCALLY and select that file."),
    ("FFMPEG",
     [r"ffmpeg (?:is )?not (?:found|installed)", r"ffprobe and ffmpeg not found", r"ffmpeg-location"],
     "ffmpeg wasn't found.",
     "Install it with: winget install ffmpeg (then restart the app)."),
    ("BAD_URL",
     [r"is not a valid URL", r"Unsupported URL", r"Incomplete YouTube ID", r"not a valid YouTube"],
     "That doesn't look like a YouTube video URL.",
     "Paste a full link like https://www.youtube.com/watch?v=XXXXXXXXXXX (one per line)."),
    ("FORBIDDEN",
     [r"HTTP Error 403"],
     "YouTube refused the request (HTTP 403).",
     "Update yt-dlp (the 'Update yt-dlp' button or pip install -U yt-dlp) and refresh cookies.txt."),
    ("FILE_LOCKED",
     [r"Permission denied", r"being used by another process", r"WinError 32", r"WinError 5\b"],
     "Couldn't write an output file.",
     "Close the file if it's open (e.g. in Notepad) or choose another output folder."),
    ("NETWORK",
     [r"getaddrinfo failed", r"Failed to resolve", r"timed out", r"Connection (?:reset|refused|aborted)",
      r"Temporary failure in name resolution", r"Unable to download webpage", r"SSL"],
     "Network problem while talking to YouTube.",
     "Check your internet connection (and VPN/proxy), then retry."),
]

_COMPILED = [(code, [re.compile(p, re.IGNORECASE) for p in pats], msg, fix) for code, pats, msg, fix in _RULES]


def clean_message(text: str) -> str:
    """First meaningful line of a yt-dlp error, without colour codes or 'ERROR: [youtube] id:' prefixes."""
    text = _ANSI.sub("", text or "").strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    return _PREFIX.sub("", line, count=1).strip() or line


def classify(error: BaseException | str) -> FriendlyError:
    if isinstance(error, TranscriptError):
        return error.friendly
    raw = str(error) if not isinstance(error, str) else error
    if not raw and isinstance(error, BaseException):
        raw = type(error).__name__
    raw = _ANSI.sub("", raw)
    for code, patterns, message, fix in _COMPILED:
        if any(p.search(raw) for p in patterns):
            return FriendlyError(code, message, fix, clean_message(raw))
    detail = clean_message(raw)
    return FriendlyError(
        "UNKNOWN",
        f"Unexpected error: {detail}" if detail else "Unexpected error.",
        "Update yt-dlp and try again; run with --verbose (CLI) for details.",
        detail,
    )


def is_rate_limited(error: BaseException | str) -> bool:
    return classify(error).code == "RATE_LIMITED"
