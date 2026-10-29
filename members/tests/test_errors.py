import pytest

from app.core.errors import FriendlyError, TranscriptError, classify, clean_message, is_rate_limited

# Error strings as yt-dlp prints them.
CASES = [
    ("ERROR: [youtube] dQw4w9WgXcQ: Join this channel to get access to members-only content like this video, "
     "and other exclusive perks.", "MEMBERS_ONLY"),
    ("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests", "RATE_LIMITED"),
    ("ERROR: [youtube] abcdefghijk: Unable to download webpage: HTTP Error 429: Too Many Requests", "RATE_LIMITED"),
    ("[info] There are no subtitles for the requested languages", "NO_SUBTITLES"),
    ("dQw4w9WgXcQ has no subtitles", "NO_SUBTITLES"),
    ("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies",
     "BOT_CHECK"),
    ("ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users.",
     "AGE_RESTRICTED"),
    ("ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access to this video", "PRIVATE"),
    ("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable", "UNAVAILABLE"),
    ("ERROR: [youtube] dQw4w9WgXcQ: This live event will begin in 3 hours.", "NOT_LIVE_YET"),
    ("ERROR: 'not a url' is not a valid URL. Set --default-search \"ytsearch\" to search YouTube", "BAD_URL"),
    ("ERROR: Unsupported URL: https://example.com/", "BAD_URL"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "FORBIDDEN"),
    ("ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location",
     "FFMPEG"),
    ("http.cookiejar.LoadError: 'cookies.txt' does not look like a Netscape format cookies file", "COOKIE_FILE"),
    ("ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>",
     "NETWORK"),
    ("[Errno 13] Permission denied: 'C:\\out\\video.hi.txt'", "FILE_LOCKED"),
]


@pytest.mark.parametrize("raw,code", CASES)
def test_classify(raw, code):
    friendly = classify(raw)
    assert friendly.code == code
    assert friendly.message and friendly.fix
    assert "Traceback" not in str(friendly)


def test_members_only_fix_mentions_cookies():
    f = classify(Exception(CASES[0][0]))
    assert "cookies.txt" in f.fix and "member" in f.fix


def test_unknown_error_keeps_detail():
    f = classify("ERROR: [youtube] dQw4w9WgXcQ: Something completely new happened")
    assert f.code == "UNKNOWN"
    assert f.detail == "Something completely new happened"


def test_clean_message_strips_prefixes_and_colour():
    assert clean_message("\x1b[0;31mERROR:\x1b[0m [youtube] dQw4w9WgXcQ: Video unavailable") == "Video unavailable"
    assert clean_message("ERROR: Unsupported URL: https://x.y/") == "Unsupported URL: https://x.y/"


def test_transcript_error_passthrough():
    f = FriendlyError("PLAYLIST", "msg", "fix")
    assert classify(TranscriptError(f)) is f


def test_is_rate_limited():
    assert is_rate_limited(Exception("HTTP Error 429: Too Many Requests"))
    assert not is_rate_limited(Exception("Video unavailable"))
