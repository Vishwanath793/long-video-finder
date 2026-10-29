# Long Video Finder

Finds the long daily streams of Zee Business (First Trade) and CNBC Awaaz, downloads their subtitles,
and lets you search them and count stock mentions. Needs only Node.js; no API key, no packages.

## Start
Double-click `start.bat` (or run `node server.mjs`) and open http://localhost:3000.

## Tabs
- **Find & download**: pick dates. "Find + download subtitles" saves `.srt`, `.txt` and searchable `.json`
  files to `data/transcripts/`. NSE holidays and weekends are skipped. "Today" fills both dates. A saved video only
  counts as "already in library" if it is at least Min hours long; shorter ones are replaced when the full stream is found.
  "Add videos by URL" downloads the subtitles of any pasted YouTube links (date from the title, else the publish date,
  unless you pick one); these are never replaced by the automatic search.
- **Members-only**: transcripts of any YouTube video, including members-only videos of channels you've joined. Just
  paste the URLs. Setup is one-time: double-click `memberssetup.bat` (it needs Python 3.11+). Then click **Sign in to
  YouTube**: a separate Chrome (or Edge) window opens with this app's own profile (`datayoutube-browser`, separate from
  your normal Chrome). Sign in with the account that has the membership, and close the window. After that, each download
  briefly opens that profile hidden, refreshes and reads the YouTube cookies, gives them to yt-dlp in a temporary file,
  and deletes the file when the job ends. Cookie values are never logged. **Switch account** removes the profile.
  Language: Native prefers uploaded subtitles, then the original-language auto track such as `hi-orig`. **List
  languages** shows every caption track. **Download** saves a clean `.srt`, a `.txt` with no timestamps or rolling
  repeats, and a `.json`. They go to `data/transcripts/` and the Library (named `<upload date>_<channel>_<id>_<lang>`),
  so Search, Stock mentions and Calls include them. These entries don't count as a channel's daily stream. HTTP 429 is
  retried with backoff. Members-only, rate-limit and no-caption errors come with the fix. For videos without captions,
  optional Whisper speech-to-text runs on the CPU: `members.venvScriptspip install -r membersequirements-whisper.txt`.
  **Advanced** offers other sign-in sources (a `cookies.txt` file, Firefox, or nothing for public videos), **Check
  sign-in**, and **Update yt-dlp**, which fixes most breakages after YouTube changes.
- **Library**: every saved transcript with SRT, TXT, YouTube and DownSub links.
- **Search**: any English or Hindi phrase, or a stock (RELIANCE, जियो…). Each hit links to that second of the video.
- **Stock mentions**: mentions per stock, per channel and per day. Click a name to read every mention.
  What counts as a mention:
  - **Ads, show promos and sponsor credits are skipped.** Two consecutive caption lines that air word-for-word on 3+
    days are a recorded block, and lines with "प्रायोजक" or "प्रेजेंट्स" are sponsor credits.
  - **Jingles are skipped.** A line that is one name sung 3+ times ("Jio Jio Jio") doesn't count.
  - **Repeats collapse.** The same name said again within 10 seconds is one mention.
  - **Some names need context.** Names that are also everyday words (`needsContext`, e.g. "जियो") count only near a
    business word.
  - **Some phrases are blocked.** An entry with `"type": "ignore"` lists phrases that contain a stock name but aren't the
    stock ("SBI Mutual Fund", "ICICI Pru", "आईटीसी क्लेम"). Longer names win, so they block the shorter one.

  Edit `watchlist.json` (or the editor on that tab) to add stocks and their English and Hindi spellings. **Improve
  accuracy** on that tab suggests spellings that captions use for a stock, and NSE companies that are discussed but not
  tracked. Each suggestion shows how often it occurs, how often a business word is nearby, and an example line. Check
  the example before you click Add, because sound-alikes include real words ("टैक्स" sounds like TCS).
- **Source switch (Calls and Summaries)**: "Built-in rules (free)" needs no API key. It finds calls said with a target
  or stop-loss ("टारगेट", "स्टॉप लॉस"), matches the stock against the NSE list by sound, and keeps it only if that
  day's NSE price fits the levels. Its summary gives the overall tone, the most discussed stocks with their tone, and the calls.
  It can't name the analyst and misses calls given without levels. "Claude AI" catches more and names analysts.
  How the rules read a call:
  - **Direction.** Buy/sell words, brokerage ratings (outperform, overweight), accumulate, BTST/STBT and hold.
    "शॉर्ट टर्म" (short term) and "बाय 30%" ("by") are not directions. With no direction word, the stock's price
    decides: a target above that day's close is a buy.
  - **Prices.** Read with words in between ("2410 तक का टारगेट", "582 का लगाना है आपको स्टॉप लॉस", "210 से बढ़ाकर
    260" → 260). A level far from the call's other levels starts a new call.
  - **Stock.** The closest fitting name, said before or right after the levels. Exact watchlist spellings and
    mixed-script captions ("Vedanता") count, and a longer name wins over the shorter one inside it ("सिटी यूनियन बैंक").
  - **Nothing is dropped silently.** Every call-like statement that isn't turned into a call appears under **Needs
    review** on the Calls tab, with a ▶ link, the quote and the reason. The reasons are: Nifty/Bank Nifty levels,
    commodity, options trade (premium levels), an earlier call being talked about, a promo or re-aired segment, levels
    shown on screen, no price understood, no buy/sell said, no stock recognised, or levels that don't fit the stock's
    price. "Likely calls" (a buy/sell said with both a target and a stop-loss) are listed first.
- **Calls**: stock calls (buy/sell, entry, target, stop-loss, analyst, timestamp) extracted by Claude, each checked
  against NSE daily prices: target hit, stop-loss hit or open, plus 1/5/20-day returns and scorecards by analyst and channel.
  "Analyse missing transcripts" shows the exact token count and estimated cost before anything runs.
- **Analyst report**: pick a year and ISO week (or dates). It downloads missing transcripts, finds each call and
  who made it (the person last handed the mic: "कुणाल जी गुड मॉर्निंग", "… का स्वागत"), checks each call on NSE
  daily prices, and ranks analysts by average return per call (₹10,000 a call; exit at target/stop-loss, else the
  close on day 20). Pre-market calls are priced at the day's open, later ones at the close. Shows a verdict, a mini
  chart per call, and lets you download that week's TXT files. Merge name spellings in `analysts.json`.
- **AI summaries**: market view, key points, top picks and news for each stream, with timestamp links.
- **Settings**: your Claude API key (stored only in `data/settings.json`), the model, and whether the daily run
  should analyse new transcripts automatically.
- **Daily auto-run**: turns on a Windows scheduled task (Mon–Fri, default 20:30) that runs `run-daily.bat`.
  It collects that day and retries any missing day from the last 10. Logs go to `data/daily.log`.

## Command line
- `node cli.mjs 2026-10-16 [2026-10-20]`: print links only.
- `node daily.mjs`: run the daily collection once.

## Files
`finder.mjs` YouTube search · `subtitles.mjs` caption download · `holidays.mjs` NSE holidays ·
`collector.mjs` find + download + daily job · `analysis.mjs` search, mentions and watchlist suggestions · `phonetic.mjs` sound-alike keys · `scheduler.mjs` Task Scheduler ·
`server.mjs` + `index.html` web app · `ytbrowser.mjs` the app's YouTube sign-in profile · `members.mjs` runs the Python helper in `members/` (`app/bridge.py` speaks JSON lines;
`app/core/` holds the cookie check, yt-dlp captions, cleanup and Whisper; `members\.venv\Scripts\python -m pytest` runs its 59 tests;
`python -m app.cli -h` is a command-line version).

## Tests
`npx playwright test` runs 53 tests: the core logic (prices, holidays, rule calls, speaker detection, call checking,
search), every tab clicked through in a real browser, 7 for Members-only (its Python helper and sign-in are mocked), and
7 for mention accuracy (ads, jingles, repeats, misspellings, sister companies, and the suggestion helpers), and 6 for
rule-based calls (real misread statements, options/commodities/promos, and the Needs review list). They are safe to run any time:
AI analysis, settings, watchlist saves and the Windows task are intercepted, and cost boxes get "Not now".
After a run, `npx playwright show-report test-report` opens the HTML report.
