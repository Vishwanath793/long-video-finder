// Full-text search and stock-mention counting over downloaded transcripts.
// Captions mix Devanagari and English, so watchlist aliases carry both spellings.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { loadLibrary, loadSegments, clock } from './subtitles.mjs';
import { getEquityList } from './prices.mjs';
import { skel, skelEn, isDev, GENERIC } from './phonetic.mjs';

const WATCHLIST = new URL('./watchlist.json', import.meta.url);

// Same length in and out per character class we touch, applied per segment.
function norm(s) {
  return s.normalize('NFC').toLowerCase()
    .replace(/़/g, '')            // nukta: फ़ -> फ
    .replace(/[‌‍]/g, '')    // zero-width joiners
    .replace(/[।|,.!?;:"“”()\[\]]/g, ' ')
    .replace(/\s+/g, ' ');
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// \b doesn't work for Devanagari, so treat any letter, mark or digit as part of a word.
const compact = s => s.replace(/\s+/g, '');
const word = body => `(?<![\\p{L}\\p{M}\\p{N}])(?:${body})(?![\\p{L}\\p{M}\\p{N}])`;

export async function loadWatchlist() {
  return JSON.parse(await readFile(WATCHLIST, 'utf8'));
}

export async function saveWatchlist(list) {
  if (!Array.isArray(list)) throw new Error('Watchlist must be a list');
  for (const s of list) {
    if (!s.symbol || !Array.isArray(s.aliases) || !s.aliases.length) throw new Error(`Each entry needs a symbol and aliases (check "${s.symbol || s.name}")`);
  }
  await writeFile(WATCHLIST, JSON.stringify(list, null, 2));
  matcherCache = null;
  mentionCache.clear();
}

// One regex over every alias, longest first, so "bank nifty" wins over "nifty"
// and "tech mahindra" over "mahindra".
let matcherCache = null;
async function getMatcher() {
  const st = await stat(WATCHLIST);
  if (matcherCache?.mtime === st.mtimeMs) return matcherCache;
  const list = await loadWatchlist();
  const bySymbol = new Map(list.map(s => [s.symbol, s]));
  const aliasTo = new Map();
  const needsContext = new Set();
  for (const s of list) {
    for (const a of s.aliases) {
      const n = norm(a).trim();
      if (n && !aliasTo.has(compact(n))) aliasTo.set(compact(n), s.symbol);
    }
    for (const a of s.needsContext || []) needsContext.add(compact(norm(a).trim()));
  }
  const aliases = [...new Set(list.flatMap(s => s.aliases.map(a => norm(a).trim())))].filter(Boolean)
    .sort((a, b) => compact(b).length - compact(a).length);
  const re = new RegExp(word(aliases.map(a => escapeRe(a).replace(/ /g, '\\s*')).join('|')), 'gu');
  matcherCache = { mtime: st.mtimeMs, list, bySymbol, aliasTo, needsContext, re };
  mentionCache.clear();
  return matcherCache;
}

// Joins normalized segments so phrases split across caption lines still match.
const docCache = new Map();
async function loadDoc(entry) {
  if (docCache.has(entry.file)) return docCache.get(entry.file);
  const segs = await loadSegments(entry);
  const starts = [];
  let text = '';
  for (const x of segs) { starts.push(text.length); text += norm(x.s) + ' '; }
  const keys = segs.map(x => lineKey(x.s));
  const doc = { segs, starts, text, keys };
  docCache.set(entry.file, doc);
  return doc;
}

// ---------- what is not a mention ----------
// Ads, jingles and show promos are recorded, so they air word-for-word the same every time: two consecutive caption
// lines that recur on 3+ different days are treated as such a block. Natural speech rarely repeats two lines
// verbatim, so a single recurring sentence ("निफ्टी बैंक की बात करें तो") still counts.
const REPEAT_DAYS = 3;
// Sponsor credits ("… प्रायोजक सुजलन", "गैलेंट … प्रेजेंट्स") name the sponsor, not a stock being discussed.
const SPONSOR_RE = /प्रायोजक|प्रायोजित|स्पॉन्सर|sponsor|presented by|powered by|प्रेजेंट्स|presents/;
// Aliases marked needsContext (e.g. "जियो", also an everyday word and a jingle) count only near one of these.
const BUSINESS_RE = /शेयर|स्टॉक|कंपनी|कंपनियों|आईपीओ|ipo|टारगेट|target|स्टॉप|खरीद|बेच|बाय|नतीजे|नतीजों|रिजल्ट|result|प्रतिशत|फीसदी|%|करोड़|रुपये|₹|वैल्यूएशन|लिस्टिंग|सब्सक्राइब|टैरिफ|टेलीकॉम|प्लेटफॉर्म|फाइनेंशियल|डिविडेंड|ब्रोकरेज|रेटिंग|अपसाइड|तेजी|गिरावट|stock|share|company|ग्रोथ|मार्जिन|ऑर्डर|सेक्टर|पोजीशन|ट्रेड|यूजर|ग्राहक|सब्सक्राइबर|रिलायंस|reliance/;
// The same name said again within this many ms is one mention ("Reliance… Reliance में…", "Jio Jio Jio").
const REPEAT_WINDOW_MS = 10_000;

function lineKey(s) { return norm(s).replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim(); }
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const pairHash = (a, b) => hash(a + '\u0001' + b);

let repeatCache = null;
async function repeatedPairs() {
  const lib = (await loadLibrary()).slice().sort((a, b) => a.iso.localeCompare(b.iso));
  const sig = lib.map(e => e.file).join('|');
  if (repeatCache?.sig === sig) return repeatCache.pairs;
  const seen = new Map(); // pair hash -> [last day seen, number of days]
  for (const e of lib) {
    let doc;
    try { doc = await loadDoc(e); } catch { continue; }
    const k = doc.keys;
    for (let i = 1; i < k.length; i++) {
      if (k[i - 1].length + k[i].length < 20) continue; // too short to be distinctive
      const h = pairHash(k[i - 1], k[i]);
      const v = seen.get(h);
      if (!v) seen.set(h, [e.iso, 1]);
      else if (v[0] !== e.iso) { v[0] = e.iso; v[1]++; }
    }
  }
  const pairs = new Set();
  for (const [h, v] of seen) if (v[1] >= REPEAT_DAYS) pairs.add(h);
  repeatCache = { sig, pairs };
  mentionCache.clear();
  return pairs;
}

// 1 for caption lines that are ads, promos or sponsor credits.
async function skippedLines(doc) {
  const pairs = await repeatedPairs();
  const k = doc.keys, skip = new Uint8Array(k.length);
  for (let i = 0; i < k.length; i++) {
    if (SPONSOR_RE.test(k[i])) { skip[i] = 1; if (i + 1 < k.length) skip[i + 1] = 1; } // the sponsor's name often follows
    if (i && pairs.has(pairHash(k[i - 1], k[i]))) skip[i - 1] = skip[i] = 1;
  }
  return skip;
}

// Jingles: a caption line that is just one name sung 3+ times ("Jio Jio Jio Jio Jio", "जिओ जियो जियो जिओ").
// Captioning spells them differently each day, so the word-for-word ad rule above can miss them.
const FILLER = new Set(['संगीत', 'music', 'ओ', 'o', 'धन', 'तक']);
function jingleLines(doc, m) {
  const lines = new Set();
  doc.segs.forEach((x, i) => {
    const words = lineKey(x.s).split(' ').filter(w => w && !FILLER.has(w));
    if (words.length < 3) return;
    const syms = words.map(w => m.aliasTo.get(compact(w)));
    if (syms[0] && syms.every(s => s === syms[0])) lines.add(i);
  });
  return lines;
}

// Caption lines (segment indexes) that are ads, promos, sponsor credits or jingles: not what anyone said on air.
export async function nonSpeechLines(entry) {
  const m = await getMatcher();
  const doc = await loadDoc(entry);
  const skip = await skippedLines(doc);
  const out = jingleLines(doc, m);
  skip.forEach((v, i) => { if (v) out.add(i); });
  return out;
}

// Every counted mention in one transcript: { sym, index, seg }, after the filters above.
async function stockHits(entry) {
  const m = await getMatcher();
  const doc = await loadDoc(entry);
  const skip = await skippedLines(doc);
  const last = new Map();
  const out = [];
  const jingle = jingleLines(doc, m);
  m.re.lastIndex = 0;
  for (const mt of doc.text.matchAll(m.re)) {
    const alias = compact(mt[0]);
    const sym = m.aliasTo.get(alias);
    if (!sym) continue;
    // type "ignore": phrases that contain a stock's name but aren't the stock ("icici pru", "sbi mutual fund").
    // Longer names win in the regex, so they block the shorter name and are then dropped here.
    if (m.bySymbol.get(sym).type === 'ignore') continue;
    const seg = segAt(doc.starts, mt.index);
    if (skip[seg] || jingle.has(seg)) continue;
    if (m.needsContext.has(alias) &&
      !BUSINESS_RE.test(doc.text.slice(Math.max(0, mt.index - 150), mt.index + mt[0].length + 150))) continue;
    const t = doc.segs[seg].t;
    if (last.has(sym) && t - last.get(sym) < REPEAT_WINDOW_MS) continue;
    last.set(sym, t);
    out.push({ sym, index: mt.index, seg });
  }
  return out;
}

function segAt(starts, pos) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

function hit(entry, doc, pos) {
  const i = segAt(doc.starts, pos);
  const t = doc.segs[i].t;
  const sec = Math.max(0, Math.floor(t / 1000) - 5);
  return {
    iso: entry.iso, date: entry.date, channel: entry.channel, title: entry.title,
    time: clock(t), seconds: sec, link: `${entry.url}&t=${sec}s`,
    before: doc.segs.slice(Math.max(0, i - 2), i).map(x => x.s).join(' '),
    text: doc.segs[i].s,
    after: doc.segs.slice(i + 1, i + 3).map(x => x.s).join(' '),
  };
}

function filterLibrary(lib, { from, to, channel }) {
  return lib.filter(e => (!from || e.iso >= from) && (!to || e.iso <= to) && (!channel || e.channel === channel));
}

// Query can be free text (English or Hindi) or a watchlist symbol/name, which expands to all its spellings.
export async function search({ q, from, to, channel, limit = 300 }) {
  q = (q || '').trim();
  if (!q) throw new Error('Type something to search for');
  const m = await getMatcher();
  const nq = norm(q).trim();
  let stock = m.list.find(s => s.symbol.toLowerCase() === nq || norm(s.name).trim() === nq) ||
    (m.aliasTo.has(compact(nq)) ? m.bySymbol.get(m.aliasTo.get(compact(nq))) : null);
  if (stock?.type === 'ignore') stock = null; // "icici pru" etc. are searched as plain text

  const entries = filterLibrary(await loadLibrary(), { from, to, channel });
  const hits = [];
  let total = 0;
  for (const e of entries) {
    const doc = await loadDoc(e);
    if (stock) {
      // The same mentions the Stock mentions tab counts (ads, promos and repeats left out).
      for (const h of await stockHits(e)) {
        if (h.sym !== stock.symbol) continue;
        total++;
        if (hits.length < limit) hits.push(hit(e, doc, h.index));
      }
      continue;
    }
    const re = new RegExp(escapeRe(nq).replace(/ /g, '\\s*'), 'gu');
    for (const mt of doc.text.matchAll(re)) {
      total++;
      if (hits.length < limit) hits.push(hit(e, doc, mt.index));
    }
  }
  return { query: q, stock: stock ? { symbol: stock.symbol, name: stock.name } : null,
    total, shown: hits.length, transcripts: entries.length, hits };
}

const mentionCache = new Map(); // cleared when the watchlist or the set of transcripts changes
async function countMentions(entry) {
  await getMatcher();
  await repeatedPairs();
  if (mentionCache.has(entry.file)) return mentionCache.get(entry.file);
  const counts = {};
  for (const h of await stockHits(entry)) counts[h.sym] = (counts[h.sym] || 0) + 1;
  mentionCache.set(entry.file, counts);
  return counts;
}

// Per-stock mentions in one transcript, with a bullish/bearish tone from words said around each mention.
const BULL_RE = /तेजी|बढ़त|मजबूत|रिकवरी|ब्रेकआउट|पॉजिटिव|उछाल|खरीद|बाय|अपसाइड|रैली|टारगेट|positive|bullish|buy/g;
const BEAR_RE = /गिरावट|कमजोर|दबाव|बिकवाली|नेगेटिव|टूट|फिसल|बेच|सेल|शॉर्ट|डाउनसाइड|मंदी|स्टॉप लॉस|negative|bearish|sell/g;
export async function mentionTone(entry) {
  const m = await getMatcher();
  const doc = await loadDoc(entry);
  const rows = new Map();
  for (const { sym, index, seg } of await stockHits(entry)) {
    const s = m.bySymbol.get(sym);
    if (!rows.has(sym)) rows.set(sym, { symbol: sym, name: s.name, type: s.type, count: 0, bull: 0, bear: 0,
      first: clock(doc.segs[seg].t) });
    const r = rows.get(sym);
    r.count++;
    const around = doc.text.slice(Math.max(0, index - 120), index + 120);
    r.bull += (around.match(BULL_RE) || []).length;
    r.bear += (around.match(BEAR_RE) || []).length;
  }
  return [...rows.values()].map(r => ({ ...r,
    tone: r.bull + r.bear < 3 ? 'neutral' : r.bull >= r.bear * 1.5 ? 'bullish' : r.bear >= r.bull * 1.5 ? 'bearish' : 'mixed' }))
    .sort((a, b) => b.count - a.count);
}

// Mention counts per stock, per date and per channel across the selected transcripts.
export async function mentions({ from, to, channel, type }) {
  const m = await getMatcher();
  const entries = filterLibrary(await loadLibrary(), { from, to, channel });
  const dates = [...new Set(entries.map(e => e.iso))].sort();
  const channels = [...new Set(entries.map(e => e.channel))].sort();
  const rows = new Map();
  for (const e of entries) {
    const counts = await countMentions(e);
    for (const [sym, n] of Object.entries(counts)) {
      const s = m.bySymbol.get(sym);
      if (type && s.type !== type) continue;
      if (!rows.has(sym)) rows.set(sym, { symbol: sym, name: s.name, type: s.type, total: 0, byDate: {}, byChannel: {} });
      const r = rows.get(sym);
      r.total += n;
      r.byDate[e.iso] = (r.byDate[e.iso] || 0) + n;
      r.byChannel[e.channel] = (r.byChannel[e.channel] || 0) + n;
    }
  }
  const stocks = [...rows.values()].sort((a, b) => b.total - a.total);
  // Change vs the previous date in range, to spot names suddenly being talked about.
  if (dates.length > 1) {
    const last = dates.at(-1), prev = dates.at(-2);
    for (const r of stocks) r.change = (r.byDate[last] || 0) - (r.byDate[prev] || 0);
  }
  return { dates, channels, transcripts: entries.length, stocks };
}

// ---------- watchlist helpers: spellings and stocks the captions use that the watchlist doesn't ----------
// Suggestions only; a person decides (sound-alikes include real words: "टैक्स" sounds like TCS, "तुरंत" like Trent).
const EVERYDAY_SHARE = 0.4; // a word in this share of transcripts is everyday speech, not a company name

let vocabCache = null;
async function vocabulary() {
  const lib = await loadLibrary();
  const sig = lib.map(e => e.file).sort().join('|');
  if (vocabCache?.sig === sig) return vocabCache;
  const tf = new Map(), df = new Map();
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
  let docs = 0;
  for (const e of lib) {
    let doc;
    try { doc = await loadDoc(e); } catch { continue; }
    docs++;
    const words = doc.text.split(' ').filter(Boolean);
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
      for (const k of [words[i], i ? words[i - 1] + ' ' + words[i] : null]) {
        if (!k) continue;
        bump(tf, k);
        if (!seen.has(k)) { seen.add(k); bump(df, k); }
      }
    }
  }
  return (vocabCache = { sig, tf, df, docs });
}

// Share of occurrences with a business word nearby, plus up to two example snippets.
async function contextOf(phrases, maxHits = 400) {
  const re = new RegExp(word(phrases.map(p => escapeRe(p).replace(/ /g, '\s*')).join('|')), 'gu');
  let n = 0, biz = 0;
  const examples = [];
  for (const e of await loadLibrary()) {
    let doc;
    try { doc = await loadDoc(e); } catch { continue; }
    for (const mt of doc.text.matchAll(re)) {
      n++;
      if (BUSINESS_RE.test(doc.text.slice(Math.max(0, mt.index - 150), mt.index + mt[0].length + 150))) biz++;
      if (examples.length < 2 && n % 5 === 1) examples.push(doc.segs[segAt(doc.starts, mt.index)].s);
      if (n >= maxHits) return { business: Math.round(100 * biz / n), examples };
    }
  }
  return { business: n ? Math.round(100 * biz / n) : 0, examples };
}

export async function suggestSpellings(symbol) {
  const m = await getMatcher();
  const stock = m.bySymbol.get(symbol);
  if (!stock) throw new Error('Not in the watchlist: ' + symbol);
  const { tf, df, docs } = await vocabulary();
  // Single words are compared with one-word names, two-word phrases with two-word names; every word must carry sound.
  const keyOf = p => { const ks = p.split(' ').map(skel); return ks.every(k => k) ? ks.join('') : ''; };
  const keys = [new Set(), new Set()];
  for (const a of stock.aliases) {
    const n = norm(a).trim(), parts = n.split(' ').length;
    const k = keyOf(n);
    if (parts <= 2 && k.length >= 3) keys[parts - 1].add(k);
  }
  const found = [];
  for (const [w, n] of tf) {
    if (n < 3 || m.aliasTo.has(compact(w))) continue;
    const parts = w.split(' ');
    if (!keys[parts.length - 1].has(keyOf(w))) continue;
    if (parts.length === 2 && parts.some(p => m.aliasTo.has(compact(p)))) continue; // "है tcs" is just "tcs"
    found.push({ spelling: w, count: n, everyday: df.get(w) / docs >= EVERYDAY_SHARE });
  }
  found.sort((a, b) => b.count - a.count);
  const top = found.slice(0, 25);
  for (const f of top) Object.assign(f, await contextOf([f.spelling]));
  // Spellings that almost never come up in market talk are other words that happen to sound alike.
  return { symbol, name: stock.name, aliases: stock.aliases, suggestions: top.filter(f => f.business >= 30).slice(0, 15) };
}

export async function untrackedStocks({ min = 15 } = {}) {
  const m = await getMatcher();
  const { tf, df, docs } = await vocabulary();
  // NSE company -> sound-alike keys of its first word and first two words (generic words like "bank" skipped).
  const byKey = new Map();
  for (const c of await getEquityList()) {
    if (m.bySymbol.has(c.symbol)) continue;
    const words = c.name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w && !['limited', 'ltd', 'the'].includes(w));
    if (!words.length) continue;
    const keys = [];
    if (!GENERIC.has(words[0]) && skelEn(words[0]).length >= 4) keys.push(skelEn(words[0]));
    if (words.length > 1 && !(GENERIC.has(words[0]) && GENERIC.has(words[1]))) keys.push(skelEn(words[0] + words[1]));
    for (const k of keys) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c); }
  }
  const heard = new Map();
  for (const [w, n] of tf) {
    if (n < 5 || df.get(w) / docs >= EVERYDAY_SHARE || m.aliasTo.has(compact(w))) continue;
    const parts = w.split(' ');
    if (parts.every(p => isDev(p) ? false : GENERIC.has(p))) continue;
    const k = parts.map(skel).join('');
    const cands = byKey.get(k);
    if (!cands || cands.length > 2 || k.length < (parts.length > 1 ? 5 : 4)) continue; // ambiguous or too short
    for (const c of cands) {
      const r = heard.get(c.symbol) || { symbol: c.symbol, name: c.name.replace(/\s+(Limited|Ltd\.?)$/i, ''), count: 0, spellings: [] };
      r.count += n;
      r.spellings.push({ spelling: w, count: n });
      heard.set(c.symbol, r);
    }
  }
  const top = [...heard.values()].filter(r => r.count >= min).sort((a, b) => b.count - a.count).slice(0, 40);
  for (const r of top) {
    r.spellings.sort((a, b) => b.count - a.count);
    Object.assign(r, await contextOf(r.spellings.slice(0, 4).map(s => s.spelling)));
  }
  return { stocks: top.filter(r => r.business >= 50), checked: top.length };
}
