// Downloads YouTube auto-captions directly and stores them as .json (for search), .srt and .txt.
// The web caption URL needs a token scripts can't get, so this asks YouTube's Android client API instead.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const DATA = new URL('./data/', import.meta.url);
export const TRANSCRIPTS = new URL('transcripts/', DATA);
const LIBRARY = new URL('library.json', DATA);
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

export async function loadLibrary() {
  try { return JSON.parse(await readFile(LIBRARY, 'utf8')); } catch { return []; }
}

async function saveLibrary(lib) {
  lib.sort((a, b) => b.iso.localeCompare(a.iso) || a.channel.localeCompare(b.channel));
  await writeFile(LIBRARY, JSON.stringify(lib, null, 2));
}

// Members-only downloads (source: 'members') don't count as that day's channel stream.
export function hasTranscript(lib, iso, channel) {
  return lib.some(e => e.iso === iso && e.channel === channel && e.source !== 'members');
}

// Adds or replaces entries by file name.
export async function addEntries(entries) {
  const files = new Set(entries.map(e => e.file));
  const lib = (await loadLibrary()).filter(e => !files.has(e.file));
  lib.push(...entries);
  await saveLibrary(lib);
}

// YouTube's player data for a video (title, length, channel, caption tracks).
async function fetchPlayer(videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ANDROID_UA },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'IN' } },
      videoId,
    }),
  });
  if (!res.ok) throw new Error(`YouTube player API returned HTTP ${res.status}`);
  return res.json();
}

// Returns [{ t: startMs, s: text }]; prefers a manual Hindi/English track, else auto-generated.
export async function fetchCaptions(videoId, player = null) {
  player ||= await fetchPlayer(videoId);
  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('No captions available yet (YouTube may still be processing this stream)');
  const rank = t => (t.kind === 'asr' ? 10 : 0) + (['hi', 'en'].includes(t.languageCode) ? 0 : 5);
  const track = [...tracks].sort((a, b) => rank(a) - rank(b))[0];

  const capRes = await fetch(track.baseUrl.replace(/&fmt=[^&]*/, '') + '&fmt=json3', { headers: { 'User-Agent': ANDROID_UA } });
  const body = await capRes.text();
  if (!capRes.ok || !body.startsWith('{')) throw new Error(`Caption download blocked (HTTP ${capRes.status}); try again later`);
  const segments = [];
  for (const e of JSON.parse(body).events || []) {
    if (!e.segs) continue;
    const s = e.segs.map(x => x.utf8).join('').replace(/\s+/g, ' ').trim();
    if (s) segments.push({ t: e.tStartMs, s });
  }
  if (!segments.length) throw new Error('Caption track was empty');
  return { language: track.languageCode, auto: track.kind === 'asr', segments };
}

function srtTime(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function clock(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function toSrt(segs) {
  return segs.map((x, i) => {
    const end = segs[i + 1] ? segs[i + 1].t : x.t + 3000;
    return `${i + 1}\n${srtTime(x.t)} --> ${srtTime(end)}\n${x.s}\n`;
  }).join('\n');
}

// Plain text with a [h:mm:ss] marker roughly every minute.
function toTxt(segs) {
  let out = '', lastMark = -60000;
  for (const x of segs) {
    if (x.t - lastMark >= 60000) { out += `\n\n[${clock(x.t)}] `; lastMark = x.t; }
    out += x.s + ' ';
  }
  return out.trim() + '\n';
}

// Downloads captions for one finder result row and records it in the library.
export async function downloadForRow(row) {
  const videoId = new URL(row.url).searchParams.get('v');
  const { language, auto, segments } = await fetchCaptions(videoId);
  const base = `${row.iso}_${row.channel.replace(/[^a-z0-9]+/gi, '-')}_${videoId}`;
  await mkdir(TRANSCRIPTS, { recursive: true });
  await writeFile(new URL(base + '.json', TRANSCRIPTS), JSON.stringify(segments));
  await writeFile(new URL(base + '.srt', TRANSCRIPTS), '﻿' + toSrt(segments));
  await writeFile(new URL(base + '.txt', TRANSCRIPTS), '﻿' + `${row.title}\n${row.url}\n` + toTxt(segments));

  const entry = { iso: row.iso, date: row.date, channel: row.channel, videoId, title: row.title,
    duration: row.duration, url: row.url, downsub: row.downsub, language, auto,
    lines: segments.length, file: base, downloadedAt: new Date().toISOString() };
  // Replaces that day's earlier automatic download; videos added by hand (members, URL) are kept.
  const lib = (await loadLibrary()).filter(e => !(e.iso === row.iso && e.channel === row.channel && !['members', 'url'].includes(e.source)));
  lib.push(entry);
  await saveLibrary(lib);
  return entry;
}

// "https://youtu.be/ID", ".../watch?v=ID", ".../live/ID", ".../shorts/ID", ".../embed/ID" or a bare 11-character ID.
export function videoIdFromUrl(text) {
  const s = String(text || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(u.hostname)) return null;
    const id = u.hostname.toLowerCase().endsWith('youtu.be') ? u.pathname.slice(1).split('/')[0]
      : u.searchParams.get('v') || (u.pathname.match(/^\/(?:live|shorts|embed|v)\/([\w-]{11})/) || [])[1];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

const hms = sec => `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

// The publish date from the video's YouTube page, as YYYY-MM-DD, or null.
async function publishDate(videoId) {
  try {
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', Cookie: 'CONSENT=YES+1' },
    })).text();
    const m = html.match(/"(?:publishDate|uploadDate)":"(\d{4}-\d{2}-\d{2})/) || html.match(/itemprop="(?:datePublished|uploadDate)" content="(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Downloads the subtitles of one YouTube link into the library (source: 'url').
// iso / channel override what's worked out from the video; channels map uploader names to your channel names.
export async function downloadByUrl(text, { iso = '', channel = '', channels = [] } = {}) {
  const { humanDate, downsubLink, dateFromTitle } = await import('./finder.mjs');
  const videoId = videoIdFromUrl(text);
  if (!videoId) throw new Error('Not a YouTube video link');
  const player = await fetchPlayer(videoId);
  const v = player.videoDetails;
  if (!v) throw new Error(player.playabilityStatus?.reason || 'YouTube did not return this video (private, removed or members-only?)');
  if (v.isLive) throw new Error('This stream is still live; download it after it ends');
  const author = String(v.author || 'YouTube').trim();
  const known = channels.find(c => c.owner && author.toLowerCase().includes(c.owner.toLowerCase()));
  const name = channel || known?.name || author.replace(/[.\s]+$/, '');
  let dateSource = 'you chose it';
  let day = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  if (!day && (day = dateFromTitle(v.title))) dateSource = 'from the title';
  if (!day && (day = await publishDate(videoId))) dateSource = 'YouTube publish date';
  if (!day) { day = new Date().toLocaleDateString('en-CA'); dateSource = 'today (no date found)'; }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const { language, auto, segments } = await fetchCaptions(videoId, player);
  const base = `${day}_${name.replace(/[^a-z0-9]+/gi, '-')}_${videoId}`;
  await mkdir(TRANSCRIPTS, { recursive: true });
  await writeFile(new URL(base + '.json', TRANSCRIPTS), JSON.stringify(segments));
  await writeFile(new URL(base + '.srt', TRANSCRIPTS), '﻿' + toSrt(segments));
  await writeFile(new URL(base + '.txt', TRANSCRIPTS), '﻿' + `${v.title}\n${url}\n` + toTxt(segments));
  const entry = { iso: day, date: humanDate(day), channel: name, videoId, title: v.title,
    duration: hms(Number(v.lengthSeconds) || 0), url, downsub: downsubLink(url), language, auto,
    lines: segments.length, file: base, source: 'url', dateSource, downloadedAt: new Date().toISOString() };
  // The same video added again (even under another date or channel) replaces its earlier copy.
  const lib = (await loadLibrary()).filter(e => !(e.source === 'url' && e.videoId === videoId));
  lib.push(entry);
  await saveLibrary(lib);
  return entry;
}

export async function loadSegments(entry) {
  return JSON.parse(await readFile(new URL(entry.file + '.json', TRANSCRIPTS), 'utf8'));
}
