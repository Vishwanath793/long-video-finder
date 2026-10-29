// Rule-based (free, no API key) stock-call extraction and daily summary.
// Calls are found from "टारगेट" / "स्टॉप लॉस" levels; the stock is the nearest company name said shortly before,
// matched against the NSE list by sound, and kept only if that day's NSE price fits the levels.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadLibrary, loadSegments, clock } from './subtitles.mjs';
import { getEquityList, getBhav } from './prices.mjs';
import { loadWatchlist, mentionTone, nonSpeechLines } from './analysis.mjs';
import { findHandovers, speakerAt, canonicalName } from './analysts.mjs';
import { skelEn, isDev, skel, GENERIC } from './phonetic.mjs';

const RULES_VERSION = 9; // 9: ads skipped, better direction/price/stock reading, option/commodity/past calls labelled, nothing dropped silently
const DIR = new URL('./data/rules/', import.meta.url);



// key -> [{ symbol, name }] where key is a skeleton of the company's first word or first two words.
let index = null;
async function companyIndex() {
  if (index) return index;
  const map = new Map();
  const add = (key, item) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).some(x => x.symbol === item.symbol)) map.get(key).push(item);
  };
  for (const c of await getEquityList()) {
    const words = c.name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const item = { symbol: c.symbol, name: c.name };
    const two = words.slice(0, 2).filter(w => !['limited', 'ltd'].includes(w));
    if (two.length === 2 && !GENERIC.has(two[1]) || two.length === 2 && !GENERIC.has(two[0])) add(skelEn(two.join('')), item);
    if (!GENERIC.has(words[0]) && skelEn(words[0]).length >= 4) add(skelEn(words[0]), item);
    if (c.symbol.length >= 4 && !GENERIC.has(c.symbol.toLowerCase())) add('sym:' + c.symbol.toLowerCase(), item);
  }
  // Watchlist spellings (both scripts) point at their NSE symbol.
  const names = new Map((await getEquityList()).map(c => [c.symbol, c.name]));
  for (const s of await loadWatchlist()) {
    // "Not a stock" phrases ("sbi mutual fund", "रेिलियंस" = resilience) block any company match inside them.
    if (s.type === 'ignore') { for (const al of s.aliases) add('alias:' + aliasKey(al), { ignore: true }); continue; }
    if (s.type !== 'stock' || !names.has(s.symbol)) continue;
    for (const a of s.aliases) {
      const parts = a.split(/\s+/);
      const key = parts.map(skel).join('');
      if (key.length >= 3) add(key, { symbol: s.symbol, name: names.get(s.symbol) });
      add('alias:' + aliasKey(a), { symbol: s.symbol, name: names.get(s.symbol) });
      if (!isDev(a) && a.replace(/\s+/g, '').length >= 3) add('sym:' + a.toLowerCase().replace(/\s+/g, ''), { symbol: s.symbol, name: names.get(s.symbol) });
    }
  }
  return (index = map);
}

// ---------- tokenising ----------
function tokens(segs) {
  const out = [];
  segs.forEach((x, seg) => {
    for (const raw of x.s.split(/\s+/)) {
      const w = raw.replace(/^[\["'(]+|[\]"'),।!?:;]+$/g, '');
      if (w) out.push({ w, t: x.t, raw, seg });
    }
  });
  return out;
}
const NUM = /^₹?(\d[\d,]*(?:\.\d+)?)\.?$/;
const numOf = w => { const m = w.match(NUM); return m ? Number(m[1].replace(/,/g, '')) : null; };
const UNIT_AFTER = /^(करोड़|करोड|लाख|साल|सालों|दिन|दिनों|महीने|मिनट|बजे|डीएमए|प्रतिशत|फीसदी|%|पर्सेंट|परसेंट|गुना|हफ्ते|घंटे)/;

const isTarget = w => /^(टारगेट|टारगेट्स|टार्गेट|लक्ष्य|target|targets)$/i.test(w);
function isStopLoss(toks, i) {
  const w = toks[i].w;
  if (/^(स्टॉपलॉस|stoploss|stop-loss|एसएल)$/i.test(w)) return 1;
  if (/^(स्टॉप|स्टाप|stop)$/i.test(w) && /^(लॉस|लोस|loss|लॉसेस)/i.test(toks[i + 1]?.w || '')) return 2;
  // "स्टॉप लगाएंगे 9930 का", "स्टॉप रखिए 405 पर"
  if (/^(स्टॉप|stop)$/i.test(w) && /^(लगा|रख)/.test(toks[i + 1]?.w || '')) return 1;
  return 0;
}

// The price that belongs to a level word at i (length len): "टारगेट 2910", "515 का होगा टारगेट", "500 के स्टॉप लॉस".
const isLevel = (toks, j) => isTarget(toks[j]?.w || '') || isStopLoss(toks, j) > 0;
const POSS = /^(का|के|की)$/;
// Said between a number and its "का/के": "2410 तक का टारगेट", "1300 प्लस के टारगेट्स".
const NUM_SUFFIX = /^(तक|प्लस|plus|\+)$/i;
// Said between "582 का" and its level word: "582 का लगाना है आपको स्टॉप लॉस".
const LINK_WORDS = /^(लगाना|लगाने|रखना|रखने|है|हैं|आपको|हमें|होगा|रहेगा|रहेंगे|लगाइए|रखिए|रखें|लगाएं|लगाएंगे|रखेंगे|ही|भी|आपका|आपके|अपना|मेंटेन|करना)$/;
// "515 का होगा टारगेट", "500 के स्टॉप लॉस": the number said just before a level word, as a token index.
function numBefore(toks, i) {
  let j = i - 1;
  for (let skipped = 0; j > 0 && skipped < 4 && LINK_WORDS.test(toks[j].w); skipped++) j--;
  for (let k = j; k >= Math.max(0, j - 2); k--) {
    if (isLevel(toks, k) || (k > 0 && isStopLoss(toks, k - 1) === 2)) break;
    const n = numOf(toks[k].w);
    if (n == null || n < 1) continue;
    let after = k + 1;
    if (NUM_SUFFIX.test(toks[after]?.w || '')) after++;
    if (POSS.test(toks[after]?.w || '')) return k;
  }
  return -1;
}
function levelAt(toks, i, len) {
  const j = numBefore(toks, i);
  if (j >= 0) {
    // In "टारगेट रखेंगे 3565 का और स्टॉप लॉस" the 3565 belongs to the earlier target, which has no number of its own before it.
    let claimed = false;
    for (let k = j - 1; k >= Math.max(0, j - 3); k--) if (isLevel(toks, k) && numBefore(toks, k) < 0) claimed = true;
    if (!claimed) return numOf(toks[j].w);
  }
  for (let j = i + len; j < Math.min(toks.length, i + len + 9); j++) {
    if (isLevel(toks, j)) break;
    const n = numOf(toks[j].w);
    if (n == null || n < 1 || UNIT_AFTER.test(toks[j + 1]?.w || '')) continue;
    // "टारगेट … 210 से बढ़ाकर 260": the new level is the one after "बढ़ाकर" / "घटाकर".
    if (toks[j + 1]?.w === 'से' && /^(बढ़ाकर|बढ़ा|घटाकर|घटा|कम|रिवाइज)/.test(toks[j + 2]?.w || '')) continue;
    // "… 500 के स्टॉप लॉस": this number belongs to the next level word.
    if (POSS.test(toks[j + 1]?.w || '') && (isLevel(toks, j + 2) || isLevel(toks, j + 3))) break;
    return n;
  }
  return null;
}

// Direction words. Whole words only: "सेल्स" is sales and "सेलिब्रेशन" a celebration, not "sell".
const BUY = /^(खरीद\S*|बाय|buy|बाइंग|buying|लॉन्ग|long|बीटीएसटी|btst|आउटपरफॉर्म\S*|outperform\S*|ओवरवेट|overweight|एक्यूमुलेट\S*|एक्यूमुलेशन|अक्यूमुलेट\S*|accumulate|accumulation)$/i;
const SELL = /^(बेच\S*|सेल|sell|शॉर्ट|short|शॉर्टिंग|shorting|बिकवाली|एसटीबीटी|stbt|अंडरपरफॉर्म\S*|underperform\S*|अंडरवेट|underweight|रिड्यूस|reduce)$/i;
const HOLD = /^(होल्ड|hold)$/i;
// "शॉर्ट टर्म" is short term and "शॉर्ट कवरिंग" is buying back; "बाय 30%" / "बाय द वे" is the word "by".
function directionAt(toks, j) {
  const w = toks[j].w, next = toks[j + 1]?.w || '';
  if (/^(टर्म|term|कवरिंग|covering|टाइम)/i.test(next) && /^(शॉर्ट|short|लॉन्ग|long)$/i.test(w)) return null;
  if (/^(बाय|by)$/i.test(w) && (numOf(next) != null || /^(द|the|वे|way|\d)/i.test(next))) return null;
  if (BUY.test(w)) return 'buy';
  if (SELL.test(w)) return 'sell';
  // "बने रहने की सलाह", "होल्ड करना चाहिए"
  if (HOLD.test(w) || (/^(बने|बनी|बना)$/.test(w) && /^(रहने|रहें|रहिए|रहे|रहो)$/.test(next))) return 'hold';
  return null;
}
const OPTION_WORD = /^(कॉल|पुट|call|put|ऑप्शन|ऑप्शंस|ऑप्शन्स|option|options|प्रीमियम|premium|स्ट्राइक|strike|सीई|पीई|ce|pe)$/i;
const INDEX_WORD = /^(निफ्टी|निफ्ट्टी|nifty|सेंसेक्स|sensex|बैंकनिफ्टी)$/i;
// Index levels are in the tens of thousands; a "190 का टारगेट" said after "निफ्टी" is about a stock.
const INDEX_MIN = 15000;
const COMMODITY = /^(सोना|सोने|गोल्ड|gold|चांदी|सिल्वर|silver|क्रूड|crude|कॉपर|copper|नेचुरल|जिंक|zinc|एल्युमिनियम|aluminium)$/i;

function timeframeOf(words) {
  const t = words.join(' ').toLowerCase();
  if (/इंट्राडे|intraday|आज के लिए/.test(t)) return 'intraday';
  if (/बीटीएसटी|btst/.test(t)) return 'btst';
  if (/लॉन्ग टर्म|long term|लंबी अवधि|एक साल|इन्वेस्टमेंट|निवेश के लिहाज/.test(t)) return 'long_term';
  if (/पोजीशनल|positional|हफ्ते|महीने/.test(t)) return 'positional';
  if (/फ्यूचर|future|ऑप्शन|option|कॉल|पुट/.test(t)) return 'short_term';
  return 'unknown';
}

// Levels must look like real prices for this stock on the call date.
function fitsPrice(close, action, target, sl, timeframe) {
  if (!close) return false;
  // Only long-term buy targets may sit far away; sell targets and stop-losses are always near the price.
  const far = action === 'buy' && (timeframe === 'long_term' || timeframe === 'positional') ? 0.6 : 0.2;
  if (target != null && Math.abs(target - close) / close > far) return false;
  if (sl != null && Math.abs(sl - close) / close > 0.12) return false;
  if (target != null && sl != null && Math.abs(target - close) > 6 * Math.max(Math.abs(close - sl), close * 0.005)) return false;
  if (action === 'buy') return (target == null || target > close * 0.97) && (sl == null || sl < close * 1.03);
  return (target == null || target < close * 1.03) && (sl == null || sl > close * 0.97);
}

// Devanagari words that appear in at least 40% of transcripts are everyday Hindi, not company names.
let common = null;
async function commonWords() {
  if (common) return common;
  const lib = await loadLibrary();
  const df = new Map();
  for (const e of lib) {
    const seen = new Set((await loadSegments(e)).flatMap(x => x.s.split(/\s+/)).filter(isDev).map(w => w.replace(/[।,.!?]/g, '')));
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const min = Math.max(3, lib.length * 0.4);
  return (common = new Set([...df].filter(([, n]) => n >= min).map(([w]) => w)));
}

// Stock candidates said between tokens [from, to), nearest first.
async function candidatesBefore(toks, from, to) {
  return candidatesIn(toks, from, to, -1);
}

// Stock (and index / commodity) names said in tokens [from, to); dir -1 = nearest to `to` first, +1 = nearest to `from` first.
async function candidatesIn(toks, from, to, dir) {
  const everyday = await commonWords();
  const idx = await companyIndex();
  const found = [];
  const order = [];
  for (let i = from; i < to; i++) order.push(i);
  if (dir < 0) order.reverse();
  for (const i of order) {
    if (INDEX_WORD.test(toks[i].w)) found.push({ index: true, pos: i, len: 1 });
    if (COMMODITY.test(toks[i].w)) found.push({ commodity: true, name: toks[i].w, pos: i, len: 1 });
    for (const n of [3, 2, 1]) {
      if (i + n > to) continue;
      const words = toks.slice(i, i + n).map(x => x.w);
      // An exact watchlist spelling always counts, however short ("एमफेसिस").
      const exact = idx.get('alias:' + aliasKey(words.join(' '))) || [];
      for (const c of exact) found.push(c.ignore ? { ignore: true, pos: i, len: n } : { ...c, pos: i, len: n, heard: words.join(' ') });
      if (exact.length) continue;
      // At least one word must be unusual; a name made only of everyday words is noise.
      if (words.every(w => isDev(w) ? everyday.has(w) : GENERIC.has(w.toLowerCase()))) continue;
      const keys = [words.map(skel).join('')];
      if (n === 1 && !isDev(words[0])) keys.push('sym:' + words[0].toLowerCase().replace(/[^a-z0-9&-]/g, ''));
      for (const k of keys) {
        if (!k || (!k.startsWith('sym:') && k.length < (n === 1 ? 4 : 5))) continue;
        for (const c of idx.get(k) || []) found.push({ ...c, pos: i, len: n, heard: words.join(' ') });
      }
    }
  }
  // "हिंदुस्तान जिंक", "नेशनल एल्युमिनियम": a commodity word inside a company name is the company. Likewise a
  // shorter name inside a longer one is the longer one: "सिटी यूनियन बैंक" is City Union Bank, not Union Bank.
  const companies = found.filter(c => c.symbol);
  const blocks = found.filter(c => c.ignore);
  const inside = c => companies.some(s => s !== c && s.len > c.len && c.pos >= s.pos && c.pos + c.len <= s.pos + s.len);
  const blocked = c => blocks.some(b => c.pos >= b.pos && c.pos + c.len <= b.pos + b.len);
  return found.filter(c => !c.ignore && !blocked(c) && (c.commodity ? !companies.some(s => c.pos >= s.pos && c.pos < s.pos + s.len) : !inside(c)));
}
const aliasKey = s => s.normalize('NFC').toLowerCase().replace(/़/g, '').replace(/[^\p{L}\p{M}\p{N}&]+/gu, '');

export async function extractRuleCalls(entry) {
  return (await extractRuleCallsDetailed(entry)).calls;
}

// Why a call-like statement wasn't turned into a call (shown on the Calls tab under "Needs review").
export const REVIEW_REASONS = {
  no_price: 'Target or stop-loss said, but no price was understood',
  no_direction: 'Levels said, but not whether to buy or sell',
  index: 'Levels for Nifty / Bank Nifty (index levels are not checked against stock prices)',
  no_stock: 'Levels said, but no company name was recognised before them',
  price_mismatch: "A company was recognised, but the levels don't fit its price that day (option premium, or a different stock?)",
  commodity: 'Levels for a commodity (gold, silver, crude, copper…), not a stock',
  levels_on_screen: 'A call whose levels were shown on screen, not said',
  option: 'An options trade: the levels are option premiums on this stock, not its share price',
  past: 'Levels of an earlier call being talked about ("टारगेट था …", "हिट हुआ")',
  repeated_segment: 'Levels in a segment that airs word-for-word on 3+ days (a promo, or an expert segment shown again)',
};

// { calls, review }: review lists every call-like statement that didn't become a call, with the reason.
export async function extractRuleCallsDetailed(entry) {
  const toks = tokens(await loadSegments(entry));
  const handovers = findHandovers(toks);
  const bhav = await getBhav(entry.iso).catch(() => null);
  const ads = await nonSpeechLines(entry).catch(() => new Set()); // ads, promos, jingles, sponsor credits
  const review = [];
  const quoteAt = (a, b) => toks.slice(Math.max(0, a), Math.min(toks.length, b)).map(x => x.w).join(' ');
  const addReview = async (reason, pos, extra = {}) => review.push({
    reason, time: clock(toks[pos].t), quote: quoteAt(pos - 20, pos + 15),
    analyst: await canonicalName(speakerAt(handovers, pos, toks[pos].t)), source: 'rules', ...extra,
  });
  const directionNear = (from, to, at) => {
    let best = Infinity, action = null;
    for (let j = Math.max(0, from); j < Math.min(toks.length, to); j++) {
      if (ads.has(toks[j].seg)) continue;
      const d = directionAt(toks, j);
      // buy/sell beat hold at the same distance; a nearer word wins.
      if (d && (Math.abs(j - at) < best || (Math.abs(j - at) === best && action === 'hold'))) { best = Math.abs(j - at); action = d; }
    }
    return action;
  };

  // 1. Level mentions with a number (level words without one are kept to report if no call is near them).
  const levels = [], bare = [], repeats = [];
  let lastRepeat = -Infinity;
  for (let i = 0; i < toks.length; i++) {
    const slLen = isStopLoss(toks, i);
    const kind = isTarget(toks[i].w) ? 'target' : slLen ? 'sl' : null;
    if (!kind) continue;
    if (ads.has(toks[i].seg)) { // "… टारगेट ₹32 तक … कमाई का अड्डा" promo, or a recorded segment aired again
      if (toks[i].t - lastRepeat > 60000) { lastRepeat = toks[i].t; repeats.push(i); }
      if (slLen === 2) i++;
      continue;
    }
    let value = levelAt(toks, i, slLen || 1);
    if (value != null && value < 5) value = null; // "2 टारगेट्स" is two targets, not ₹2
    if (value != null) levels.push({ kind, value, pos: i, t: toks[i].t });
    else bare.push({ kind, pos: i, t: toks[i].t });
    if (slLen === 2) i++;
  }

  // 2. Group levels said within 40 seconds of each other into one call. A level far from the group's other
  // levels ("945 का एसएल … 980 तक" then "6100 के टारगेट") belongs to a different stock: it starts a new call.
  const groups = [];
  const consistent = (g, v) => { const m = g.map(x => x.value).sort((a, b) => a - b)[Math.floor(g.length / 2)]; return v / m < 1.6 && m / v < 1.6; };
  for (const l of levels) {
    const g = groups.at(-1);
    if (g && l.t - g.at(-1).t <= 40000 && consistent(g, l.value) &&
      !(l.kind === 'target' && g.some(x => x.kind === 'target') && g.some(x => x.kind === 'sl') && l.t - g.at(-1).t > 15000)) g.push(l);
    else groups.push([l]);
  }

  const calls = [];
  let prevEnd = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const start = g[0].pos, end = g.at(-1).pos;
    const target = g.find(x => x.kind === 'target')?.value ?? null;
    let sl = g.find(x => x.kind === 'sl')?.value ?? null;
    if (sl != null && sl === target) sl = null;
    const levelsOf = { target, stop_loss: sl };
    // "टारगेट था 2100 का", "सारे टारगेट हिट हुए": an earlier call being talked about, not a new one.
    const pastAfter = p => toks.slice(p + 1, p + 6).some((x, k, a) => /^(था|थी|थे)$/.test(x.w) ||
      (/^(हिट|अचीव|achieve)/i.test(x.w) && /^(हुआ|हुए|हुई|हो|कर|किया)$/.test(a[k + 1]?.w || '') && !/^होने/.test(a[k + 1]?.w || '')));
    // One level said in the past tense is enough: the others are usually the same old call ("738 एंड 755 … अचीव हुआ").
    if (g.some(l => pastAfter(l.pos))) {
      prevEnd = end; await addReview('past', start, levelsOf); continue;
    }

    // Action: levels decide when both are known, else the nearest buy/sell/hold word, else (below) the stock's price.
    const ctxFrom = Math.max(0, start - 40), ctxTo = Math.min(toks.length, end + 15);
    let action = target != null && sl != null && target !== sl ? (target > sl ? 'buy' : 'sell') : directionNear(ctxFrom, ctxTo, start);
    const timeframe = timeframeOf(toks.slice(ctxFrom, ctxTo).map(x => x.w));

    // Stock: nearest company said in the 150 seconds before (not before the previous call); if none fits,
    // one named right after the levels ("1700, 1750 के दो टारगेट्स शेफर इंडिया में").
    let from = start;
    while (from > prevEnd && toks[start].t - toks[from - 1].t <= 150000) from--;
    const nextStart = groups[gi + 1]?.[0].pos ?? toks.length;
    const before = (await candidatesBefore(toks, from, start + 1)).filter(c => !ads.has(toks[c.pos].seg));
    const after = (await candidatesIn(toks, end + 1, Math.min(nextStart, end + 25), 1)).filter(c => !ads.has(toks[c.pos].seg));
    prevEnd = end;

    // Closest name first, whether said before or right after the levels.
    const dist = c => c.pos <= start ? start - c.pos : c.pos - end;
    const stocks = [...before, ...after].filter(c => c.symbol).sort((a, b) => dist(a) - dist(b));
    const fits = (c, a) => fitsPrice(bhav?.[c.symbol]?.c, a, target, sl, timeframe);
    let pick = null;
    if (!bhav) pick = action ? stocks[0] || null : null; // no prices that day: only calls with a stated direction
    else if (action === 'buy' || action === 'sell') pick = stocks.find(c => fits(c, action)) || null;
    else {
      // No direction word (or only "hold"): the price decides. A target above the close is a buy, below a sell.
      for (const c of stocks) {
        const close = bhav[c.symbol]?.c;
        if (!close) continue;
        const ref = target ?? sl;
        const a = target != null ? (ref > close ? 'buy' : 'sell') : (ref < close ? 'buy' : 'sell');
        // "Hold" with a stop-loss is a hold; "hold" with an upside target is a buy view.
        if (fits(c, a)) { pick = c; action = action === 'hold' && target == null ? 'hold' : a; break; }
      }
    }
    // No stock fits: Nifty / Bank Nifty levels (tens of thousands; a "190 का टारगेट" after "निफ्टी" isn't one),
    // or a commodity said just before.
    if (!pick && before[0]?.index && Math.max(target ?? 0, sl ?? 0) >= INDEX_MIN) { await addReview('index', start, { action, ...levelsOf }); continue; }
    if (!pick && before[0]?.commodity) { await addReview('commodity', start, { action, ...levelsOf, commodity: before[0].name }); continue; }
    // "1280 का सीई बाय … SL 29 … टारगेट 37": option premiums, far below the share price.
    const optionWords = toks.slice(Math.max(0, start - 25), Math.min(toks.length, end + 10)).some(x => OPTION_WORD.test(x.w));
    const under = stocks.find(c => { const close = bhav?.[c.symbol]?.c; return close && Math.max(target ?? 0, sl ?? 0) < close * 0.3; });
    if (!pick && optionWords && under) {
      await addReview('option', start, { action, ...levelsOf, candidates: [{ symbol: under.symbol, name: under.name, heard: under.heard, close: bhav[under.symbol].c }] });
      continue;
    }
    if (!pick) {
      const heard = [...new Map(stocks.map(c => [c.symbol, c])).values()].slice(0, 3)
        .map(c => ({ symbol: c.symbol, name: c.name, heard: c.heard, close: bhav?.[c.symbol]?.c ?? null }));
      const reason = heard.length ? 'price_mismatch' : action ? 'no_stock' : 'no_direction';
      await addReview(reason, start, { action, ...levelsOf, timeframe, candidates: heard });
      continue;
    }

    const words = toks.slice(Math.max(from, start - 12), Math.min(toks.length, end + 6)).map(x => x.w);
    calls.push({
      stock: pick.name, nse_symbol: pick.symbol, symbol: pick.symbol, heard: pick.heard, action, entry: null,
      target, stop_loss: sl, timeframe, analyst: await canonicalName(speakerAt(handovers, start, toks[start].t)),
      time: clock(toks[start].t), quote: words.slice(0, 30).join(' '), source: 'rules',
    });
  }

  // Level words with no price and no call near them. Only reported when it sounds like a call (a buy/sell word or
  // "on your screen" is near); "सारे टारगेट हिट हुए" or retirement "टारगेट्स" aren't calls.
  const near = (t, list) => list.some(l => Math.abs(l.t - t) <= 40000);
  let lastBare = -Infinity;
  for (const b of bare) {
    if (near(b.t, levels) || b.t - lastBare <= 40000) continue;
    const around = quoteAt(b.pos - 15, b.pos + 15);
    const onScreen = /स्क्रीन|screen/i.test(around);
    const dir = directionNear(b.pos - 15, b.pos + 15, b.pos);
    if (!onScreen && !dir) continue;
    lastBare = b.t;
    const stocks = (await candidatesIn(toks, Math.max(0, b.pos - 40), b.pos + 10, -1)).filter(c => c.symbol);
    await addReview(onScreen ? 'levels_on_screen' : 'no_price', b.pos, { action: dir,
      candidates: [...new Map(stocks.map(c => [c.symbol, c])).values()].slice(0, 3).map(c => ({ symbol: c.symbol, name: c.name, heard: c.heard })) });
  }
  // Levels inside a segment that airs word-for-word on 3+ days: usually a promo, sometimes a re-aired expert segment.
  for (const pos of repeats) await addReview('repeated_segment', pos);
  review.sort((a, b) => a.time.localeCompare(b.time, undefined, { numeric: true }));

  // Same stock and levels repeated later in the stream: keep the first.
  const seen = new Set();
  return { calls: calls.filter(c => { const k = `${c.symbol}|${c.action}|${c.target}|${c.stop_loss}`; return !seen.has(k) && seen.add(k); }), review };
}

// ---------- rule-based summary ----------
const BULL = ['तेजी', 'बढ़त', 'मजबूत', 'मजबूती', 'रिकवरी', 'ब्रेकआउट', 'पॉजिटिव', 'उछाल', 'खरीदारी', 'खरीदें', 'अपसाइड', 'रैली', 'positive', 'bullish', 'strong'];
const BEAR = ['गिरावट', 'कमजोर', 'कमजोरी', 'दबाव', 'बिकवाली', 'नेगेटिव', 'टूटा', 'फिसला', 'बेचें', 'डाउनसाइड', 'मंदी', 'negative', 'bearish', 'weak'];

export async function ruleSummary(entry, calls) {
  const segs = await loadSegments(entry);
  const text = segs.map(x => x.s).join(' ');
  const count = list => list.reduce((n, w) => n + (text.match(new RegExp(w, 'gi')) || []).length, 0);
  const bull = count(BULL), bear = count(BEAR);
  const share = bull + bear ? Math.round(100 * bull / (bull + bear)) : 50;
  const tone = share >= 58 ? 'bullish' : share <= 42 ? 'bearish' : 'mixed';
  const stocks = (await mentionTone(entry)).filter(s => s.type === 'stock').slice(0, 10);
  const indices = (await mentionTone(entry)).filter(s => s.type === 'index');
  return {
    tone, bullishShare: share, bullWords: bull, bearWords: bear,
    topStocks: stocks.map(s => ({ symbol: s.symbol, name: s.name, mentions: s.count, tone: s.tone, first: s.first })),
    indices: indices.map(s => ({ name: s.name, mentions: s.count, tone: s.tone })),
    calls: calls.length, buyCalls: calls.filter(c => c.action === 'buy').length, sellCalls: calls.filter(c => c.action === 'sell').length,
  };
}

// Cached per transcript; recomputed when the rules change.
export async function loadRuleResult(entry) {
  const file = new URL(entry.file + '.json', DIR);
  try {
    const r = JSON.parse(await readFile(file, 'utf8'));
    if (r.version === RULES_VERSION) return r;
  } catch {}
  const { calls, review } = await extractRuleCallsDetailed(entry);
  const result = { version: RULES_VERSION, file: entry.file, iso: entry.iso, channel: entry.channel, calls, review,
    summary: await ruleSummary(entry, calls) };
  await mkdir(DIR, { recursive: true });
  await writeFile(file, JSON.stringify(result, null, 2));
  return result;
}

export async function loadAllRuleResults({ from, to, channel } = {}) {
  const lib = (await loadLibrary()).filter(e => (!from || e.iso >= from) && (!to || e.iso <= to) && (!channel || e.channel === channel));
  const out = [];
  for (const e of lib) out.push({ entry: e, analysis: await loadRuleResult(e) });
  return out;
}
