// Core logic: search YouTube, pick the first long video per channel per date, build DownSub links.
// No API key and no npm dependencies; reads the ytInitialData JSON embedded in the search page.
import { getHolidays, isWeekend } from './holidays.mjs';

export const DEFAULT_CHANNELS = [
  { name: 'Zee Business', query: 'Zee Business First Trade {date}', owner: 'zee business' },
  { name: 'CNBC Awaaz', query: 'CNBC Awaaz {date}', owner: 'cnbc awaaz' },
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// "2026-10-16" -> "16 October 2026"
export function humanDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function dateRange(from, to) {
  const out = [];
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(from + 'T00:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Spellings of a month (1-12) seen in titles: "September", "Sep", "Sept".
function monthAlt(m) {
  const full = MONTHS[m - 1].toLowerCase();
  return [full, full.slice(0, 3), ...(m === 9 ? ['sept'] : [])].join('|');
}

// "8:49:11" -> seconds
function parseLength(text) {
  if (!text) return 0;
  return text.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

// True when the title mentions this date, e.g. "16th October 2026", "16 Oct 2026", "16-10-2026".
function titleHasDate(title, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = title.toLowerCase();
  const named = new RegExp(`\\b0?${d}(st|nd|rd|th)?[\\s\\-,.]*(${monthAlt(m)})\\b[\\s\\-,.]*${y}\\b`);
  const named2 = new RegExp(`\\b(${monthAlt(m)})\\b[\\s\\-,.]*0?${d}(st|nd|rd|th)?[\\s\\-,.]*${y}\\b`);
  const numeric = new RegExp(`\\b0?${d}[\\-/.]0?${m}[\\-/.](${y}|${String(y).slice(2)})\\b`);
  return named.test(t) || named2.test(t) || numeric.test(t);
}

async function fetchSearchData(query) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&hl=en&gl=IN';
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' } });
  if (!res.ok) throw new Error(`YouTube returned HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!m) throw new Error('Could not read YouTube search results (page format changed or blocked)');
  return JSON.parse(m[1]);
}

// The first date written in a title, as YYYY-MM-DD: "19th October 2026", "Oct 19, 2026", "19-10-2026". Else null.
export function dateFromTitle(title) {
  const t = String(title || '').toLowerCase();
  const months = MONTHS.map((_, i) => monthAlt(i + 1)).join('|');
  const monthNo = name => 1 + MONTHS.findIndex((m, i) => new RegExp(`^(${monthAlt(i + 1)})$`).test(name));
  const iso = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d)); // rejects 31 February and the like
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  let m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-,.]*(${months})\\b[\\s\\-,.]*(\\d{4})\\b`));
  if (m) return iso(+m[3], monthNo(m[2]), +m[1]);
  m = t.match(new RegExp(`\\b(${months})\\b[\\s\\-,.]*(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-,.]*(\\d{4})\\b`));
  if (m) return iso(+m[3], monthNo(m[1]), +m[2]);
  m = t.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  return null;
}

function titleHasAnyDate(title) {
  const t = title.toLowerCase();
  const months = MONTHS.map((_, i) => monthAlt(i + 1)).join('|');
  return new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?[\\s\\-,.]*(${months})\\b`).test(t) ||
    new RegExp(`\\b(${months})\\b[\\s\\-,.]*\\d{1,2}(st|nd|rd|th)?\\b`).test(t) ||
    /\b\d{1,2}[-/.]\d{1,2}[-/.](\d{4}|\d{2})\b/.test(t);
}

export async function searchYouTube(query) {
  let data;
  for (let attempt = 1; ; attempt++) {
    try { data = await fetchSearchData(query); break; } catch (err) {
      if (attempt === 3) throw err;
      await pause(2000 * attempt);
    }
  }
  const videos = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      videos.push({
        id: v.videoId,
        title: (v.title?.runs || []).map(r => r.text).join('') || v.title?.simpleText || '',
        duration: v.lengthText?.simpleText || '',
        seconds: parseLength(v.lengthText?.simpleText),
        channel: v.ownerText?.runs?.[0]?.text || '',
        published: v.publishedTimeText?.simpleText || '',
      });
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return videos;
}

export function downsubLink(youtubeUrl) {
  return 'https://downsub.com/?url=' + encodeURIComponent(youtubeUrl);
}

// Returns one result row for (date, channel).
export async function findForChannel(iso, channel, { minHours = 7, requireDate = true } = {}) {
  const date = humanDate(iso);
  const query = channel.query.replace('{date}', date);
  const base = { date, iso, channel: channel.name, query };
  try {
    const videos = await searchYouTube(query);
    const long = videos.filter(v =>
      v.seconds > minHours * 3600 && v.channel.toLowerCase().includes(channel.owner));
    let pick = requireDate ? long.find(v => titleHasDate(v.title, iso)) : long[0];
    let note = '';
    if (!pick && requireDate) {
      // Only fall back to a title with no date at all; a title naming another day is another day's stream.
      pick = long.find(v => !titleHasAnyDate(v.title));
      if (pick) note = 'Date not in title, check it';
    }
    if (!pick) return { ...base, found: false, message: `No video >${minHours} hrs found` };
    const url = `https://www.youtube.com/watch?v=${pick.id}`;
    return { ...base, found: true, title: pick.title, duration: pick.duration, published: pick.published,
      url, downsub: downsubLink(url), note };
  } catch (err) {
    return { ...base, found: false, message: 'Error: ' + err.message };
  }
}

export const pause = ms => new Promise(r => setTimeout(r, ms));

// opts.tradingDaysOnly skips weekends and NSE holidays (still accepts the older skipWeekends flag).
export async function findAll(from, to, opts = {}) {
  const channels = opts.channels?.length ? opts.channels : DEFAULT_CHANNELS;
  let dates = dateRange(from, to || from);
  if (opts.tradingDaysOnly || opts.skipWeekends) {
    const { holidays } = opts.tradingDaysOnly ? await getHolidays() : { holidays: {} };
    dates = dates.filter(d => !isWeekend(d) && !holidays[d]);
  }
  const rows = [];
  for (const iso of dates) {
    for (const ch of channels) {
      if (rows.length) await pause(800); // be gentle with YouTube on long ranges
      rows.push(await findForChannel(iso, ch, opts));
    }
  }
  return rows;
}
