// An AI model (Claude or DeepSeek) reads each transcript in ~45-minute chunks, pulls out stock calls and key points,
// then writes a short summary of the whole stream. Results go to data/ai/<file>.json.
import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadLibrary, loadSegments, clock } from './subtitles.mjs';
import { resolveSymbol } from './prices.mjs';

const DATA = new URL('./data/', import.meta.url);
const AI_DIR = new URL('ai/', DATA);
const SETTINGS = new URL('settings.json', DATA);
const CHUNK_MS = 45 * 60 * 1000;

// $ per million tokens. Haiku's price doubles above 100K prompt tokens; our chunks stay well under that.
// DeepSeek prices are peak rates; off-peak (most of the Indian evening) is half, worked out per request.
export const MODELS = {
  'claude-opus-5-5': { provider: 'claude', label: 'Claude Opus 5.5 (best quality)', input: 4, output: 20, fallback: true },
  'claude-sonnet-5-5': { provider: 'claude', label: 'Claude Sonnet 5.5 (balanced)', input: 2, output: 10, fallback: true },
  'claude-haiku-5-5': { provider: 'claude', label: 'Claude Haiku 5.5 (lowest cost)', input: 0.1, output: 0.5, fallback: false },
  // deepseek-flash is DeepSeek-V4.1-Flash (Sep 2026), DeepSeek's newest and recommended model.
  'deepseek-flash': { provider: 'deepseek', label: 'DeepSeek V4.1 Flash (latest)', input: 0.3, cached: 0.006, output: 1.2 },
  'deepseek-v4-pro': { provider: 'deepseek', label: 'DeepSeek V4 Pro (older, being phased out)', input: 1.32, cached: 0.044, output: 3.96 },
};
const DEFAULTS = { provider: 'claude', apiKey: '', deepseekKey: '', model: 'claude-opus-5-5', deepseekModel: 'deepseek-flash',
  autoAnalyze: false, usdToInr: 88, deepseekTokensPerChar: 0.5 };

// DeepSeek peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. Other times cost half.
function deepseekPeak(d = new Date()) {
  const h = d.getUTCHours(), day = d.getUTCDay();
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}
const activeModel = s => s.provider === 'deepseek' ? s.deepseekModel : s.model;

export async function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(await readFile(SETTINGS, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

// The UI never gets the key back, only whether one is saved.
export async function publicSettings() {
  const s = await getSettings();
  return { provider: s.provider, model: s.model, deepseekModel: s.deepseekModel, activeModel: activeModel(s),
    autoAnalyze: s.autoAnalyze, usdToInr: s.usdToInr,
    hasKey: !!(s.provider === 'deepseek' ? s.deepseekKey : s.apiKey),
    claude: { hasKey: !!s.apiKey, keyHint: s.apiKey ? '…' + s.apiKey.slice(-4) : '' },
    deepseek: { hasKey: !!s.deepseekKey, keyHint: s.deepseekKey ? '…' + s.deepseekKey.slice(-4) : '' },
    models: MODELS };
}

export async function saveSettings(patch) {
  const s = await getSettings();
  if (patch.apiKey !== undefined && patch.apiKey !== '') s.apiKey = String(patch.apiKey).trim();
  if (patch.clearKey) s.apiKey = '';
  if (patch.deepseekKey) s.deepseekKey = String(patch.deepseekKey).trim();
  if (patch.clearDeepseekKey) s.deepseekKey = '';
  if (['claude', 'deepseek'].includes(patch.provider)) s.provider = patch.provider;
  if (patch.model && MODELS[patch.model]?.provider === 'claude') s.model = patch.model;
  if (patch.deepseekModel && MODELS[patch.deepseekModel]?.provider === 'deepseek') s.deepseekModel = patch.deepseekModel;
  if (patch.deepseekTokensPerChar) s.deepseekTokensPerChar = patch.deepseekTokensPerChar;
  if (patch.autoAnalyze !== undefined) s.autoAnalyze = !!patch.autoAnalyze;
  if (patch.usdToInr) s.usdToInr = Number(patch.usdToInr) || DEFAULTS.usdToInr;
  await mkdir(DATA, { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(s, null, 2));
  return publicSettings();
}

async function client() {
  const s = await getSettings();
  if (s.provider === 'deepseek') {
    if (!s.deepseekKey) throw new Error('Add your DeepSeek API key in Settings first');
    return { api: { deepseekKey: s.deepseekKey }, settings: s, model: s.deepseekModel };
  }
  if (!s.apiKey && !process.env.ANTHROPIC_API_KEY) throw new Error('Add your Claude API key in Settings first');
  return { api: new Anthropic(s.apiKey ? { apiKey: s.apiKey } : {}), settings: s, model: s.model };
}

class DeepSeekError extends Error {
  constructor(status, message) { super(`DeepSeek ${status}: ${message}`); this.status = status; }
}

// DeepSeek's JSON mode guarantees valid JSON but not its shape, so the schema goes in the prompt and is checked after.
async function askDeepSeek(key, model, system, userText, schema, usage) {
  const body = {
    // V4.1 Flash can write up to 384K tokens; its reasoning plus a long call list once ran past 32K.
    model, max_tokens: 64000, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `${system}\n\nReply with a single json object only, matching this JSON Schema exactly (every required field present, null where unknown):\n${JSON.stringify(schema)}` },
      { role: 'user', content: userText },
    ],
  };
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json.error?.message || res.statusText;
      if (res.status === 402) throw new DeepSeekError(402, 'your DeepSeek balance is empty. Top up at platform.deepseek.com, then analyse again.');
      // 429: DeepSeek limits how many requests run at once by account balance; wait and try again.
      if ((res.status === 429 || res.status >= 500) && attempt < 6) { await new Promise(r => setTimeout(r, 10000 * attempt)); continue; }
      throw new DeepSeekError(res.status, msg);
    }
    const u = json.usage || {};
    const hit = u.prompt_cache_hit_tokens || 0, miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens || 0) - hit;
    const p = MODELS[model], f = deepseekPeak() ? 1 : 0.5;
    usage.input += u.prompt_tokens || 0;
    usage.output += u.completion_tokens || 0;
    usage.usd = (usage.usd || 0) + f * (hit * p.cached + miss * p.input + (u.completion_tokens || 0) * p.output) / 1e6;
    usage.promptChars = (usage.promptChars || 0) + body.messages.reduce((n, m) => n + m.content.length, 0);
    const choice = json.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('Answer was cut off (max_tokens)');
    const text = choice?.message?.content?.trim();
    if (!text) { if (attempt < 3) continue; throw new Error('DeepSeek returned an empty answer'); }
    const out = JSON.parse(text);
    for (const k of schema.required || []) if (!(k in out)) out[k] = schema.properties[k].type === 'array' ? [] : null;
    return out;
  }
}

// Transcript text with a [h:mm:ss] marker about every 30 seconds, split into ~45-minute chunks.
function chunkTranscript(segs) {
  const chunks = [];
  let cur = null, lastMark = -Infinity;
  for (const x of segs) {
    if (!cur || x.t - cur.start >= CHUNK_MS) {
      cur = { start: x.t, text: '' };
      chunks.push(cur);
      lastMark = -Infinity;
    }
    if (x.t - lastMark >= 30000) { cur.text += `\n[${clock(x.t)}] `; lastMark = x.t; }
    cur.text += x.s + ' ';
  }
  return chunks;
}

const EXTRACT_SYSTEM = `You analyse transcripts of Indian business TV channels (Zee Business, CNBC Awaaz). The transcripts are auto-generated Hindi captions with English words mixed in, so expect spelling errors, run-on sentences and misheard stock names. Lines start with [h:mm:ss] timestamps.

From the transcript part you are given, extract:

1. Stock calls: explicit trade recommendations an anchor, analyst or guest makes on a specific stock, such as "buy X, target Y, stop loss Z" or "sell X". Include picks from segments like "आज का इक्का", "stock of the day", futures and cash calls, and long-term picks. Do not include a stock that is merely mentioned in news, results discussion or an open-interest list without a clear buy/sell view. One entry per distinct call; if the same call is repeated, keep the first occurrence. Index calls (Nifty, Bank Nifty) count only if they come with levels.
   - stock: the company name in English as usually written.
   - nse_symbol: your best guess of the NSE trading symbol (e.g. RELIANCE, HDFCBANK, LT), or null for indices or if unsure.
   - action: buy, sell, hold or avoid.
   - entry, target, stop_loss: prices in rupees if said; use the first target if several are given; null if not said.
   - timeframe: intraday, btst (buy today sell tomorrow), short_term (days to weeks), positional (weeks to months), long_term, or unknown.
   - analyst: the person making the call if named (e.g. "Anil Singhvi"), else null.
   - time: the [h:mm:ss] marker closest before the call.
   - quote: the key words of the call copied from the transcript, at most 20 words.
2. Notes: the 3 to 8 most important points in this part (market view, big news, sector themes), each with its time.

Write everything in English except the quote. If there are no calls, return an empty list.`;

const CALL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stock', 'nse_symbol', 'action', 'entry', 'target', 'stop_loss', 'timeframe', 'analyst', 'time', 'quote'],
  properties: {
    stock: { type: 'string' },
    nse_symbol: { type: ['string', 'null'] },
    action: { type: 'string', enum: ['buy', 'sell', 'hold', 'avoid'] },
    entry: { type: ['number', 'null'] },
    target: { type: ['number', 'null'] },
    stop_loss: { type: ['number', 'null'] },
    timeframe: { type: 'string', enum: ['intraday', 'btst', 'short_term', 'positional', 'long_term', 'unknown'] },
    analyst: { type: ['string', 'null'] },
    time: { type: 'string' },
    quote: { type: 'string' },
  },
};
const TIMED = { type: 'object', additionalProperties: false, required: ['time', 'text'],
  properties: { time: { type: 'string' }, text: { type: 'string' } } };

const EXTRACT_SCHEMA = { type: 'object', additionalProperties: false, required: ['calls', 'notes'],
  properties: { calls: { type: 'array', items: CALL_SCHEMA }, notes: { type: 'array', items: TIMED } } };

const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['market_view', 'bullets', 'top_picks', 'key_news'],
  properties: {
    market_view: { type: 'string' },
    bullets: { type: 'array', items: TIMED },
    top_picks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['stock', 'view', 'time'],
      properties: { stock: { type: 'string' }, view: { type: 'string' }, time: { type: 'string' } } } },
    key_news: { type: 'array', items: TIMED },
  },
};

// One structured-output request. Opus and Sonnet get server-side refusal fallbacks.
async function ask(api, model, system, userText, schema, usage) {
  if (MODELS[model].provider === 'deepseek') return askDeepSeek(api.deepseekKey, model, system, userText, schema, usage);
  const params = {
    model, max_tokens: 32000, system,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: userText }],
  };
  const msg = MODELS[model].fallback
    ? await api.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }).finalMessage()
    : await api.messages.stream(params).finalMessage();
  usage.input += msg.usage.input_tokens + (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
  usage.output += msg.usage.output_tokens;
  if (msg.stop_reason === 'refusal') throw new Error(`Claude declined this part (${msg.stop_details?.category || 'no category'})`);
  if (msg.stop_reason === 'max_tokens') throw new Error('Answer was cut off (max_tokens)');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

// Models sometimes copy the transcript's brackets: "[0:01:09]" -> "0:01:09".
export function cleanTime(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '0:00:00';
  return m[3] != null ? `${Number(m[1])}:${m[2]}:${m[3]}` : `0:${m[1].padStart(2, '0')}:${m[2]}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export function costOf(usage, model) {
  if (usage.usd != null) return usage.usd; // DeepSeek: priced per request (cache hits, off-peak)
  const p = MODELS[model];
  return (usage.input * p.input + usage.output * p.output) / 1e6;
}

export async function loadAnalysis(entry) {
  try { return JSON.parse(await readFile(new URL(entry.file + '.json', AI_DIR), 'utf8')); } catch { return null; }
}

// Reads one part of a transcript. If the answer is cut off, the part is split in half (at a timestamp line)
// and each half is read separately, so one busy stretch can't fail the whole stream.
async function extractPart(api, model, head, label, text, usage, depth = 0) {
  try {
    return await ask(api, model, EXTRACT_SYSTEM, `${head}${label}.\n\n<transcript>${text}\n</transcript>`, EXTRACT_SCHEMA, usage);
  } catch (err) {
    if (!/cut off/.test(err.message) || depth >= 2) throw err;
    const lines = text.split('\n');
    const mid = Math.floor(lines.length / 2);
    const [a, b] = [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
    const [ra, rb] = [await extractPart(api, model, head, `${label} (first half)`, a, usage, depth + 1),
      await extractPart(api, model, head, `${label} (second half)`, b, usage, depth + 1)];
    return { calls: [...(ra.calls || []), ...(rb.calls || [])], notes: [...(ra.notes || []), ...(rb.notes || [])] };
  }
}

// Analyses one library entry; onProgress(done, total) is called after each chunk.
export async function analyzeEntry(entry, onProgress = () => {}) {
  const { api, model } = await client();
  const chunks = chunkTranscript(await loadSegments(entry));
  const usage = { input: 0, output: 0 };
  const head = `Channel: ${entry.channel}\nDate: ${entry.date}\nVideo title: ${entry.title}\n`;
  let done = 0;
  // DeepSeek allows about 5 requests at once on a small balance; 4 leaves room. Claude stays at 3.
  const parts = await mapLimit(chunks, MODELS[model].provider === 'deepseek' ? 4 : 3, async (c, i) => {
    const r = await extractPart(api, model, head, `Part ${i + 1} of ${chunks.length}, starting at ${clock(c.start)}`, c.text, usage);
    onProgress(++done, chunks.length + 1);
    return r;
  });

  const calls = [];
  const seen = new Set();
  for (const c of parts.flatMap(p => p.calls || [])) {
    // DeepSeek isn't held to the schema, so tidy each call before using it.
    if (!c?.stock || !['buy', 'sell', 'hold', 'avoid'].includes(c.action)) continue;
    for (const k of ['entry', 'target', 'stop_loss']) c[k] = c[k] == null || c[k] === '' ? null : Number(String(c[k]).replace(/[₹,\s]/g, '')) || null;
    c.timeframe ||= 'unknown'; c.time = cleanTime(c.time); c.quote ||= ''; c.analyst ||= null;
    const key = `${(c.nse_symbol || c.stock).toUpperCase()}|${c.action}|${c.target}|${c.stop_loss}`;
    if (seen.has(key)) continue;
    seen.add(key);
    c.symbol = c.nse_symbol ? await resolveSymbol(c.nse_symbol, c.stock).catch(() => null) : await resolveSymbol('', c.stock).catch(() => null);
    calls.push(c);
  }
  const notes = parts.flatMap(p => p.notes || []);

  const summary = await ask(api, model,
    'You write short, factual daily briefs of Indian business TV streams for an investor who did not watch them. Write in English. Keep each bullet to one sentence. Keep the [h:mm:ss] times from the notes so the reader can jump to that moment.',
    `${head}\nBelow are the key points and stock calls extracted from the whole stream, in time order. Write:\n- market_view: two or three sentences on the overall market view expressed on this stream.\n- bullets: the 10 to 15 most useful points for an investor.\n- top_picks: the most strongly argued stock calls (up to 8), with the view in a few words.\n- key_news: the main news items discussed (up to 8).\n\nNotes:\n${notes.map(n => `[${n.time}] ${n.text}`).join('\n')}\n\nStock calls:\n${calls.map(c => `[${c.time}] ${c.action.toUpperCase()} ${c.stock}${c.entry ? ' at ' + c.entry : ''}${c.target ? ' target ' + c.target : ''}${c.stop_loss ? ' SL ' + c.stop_loss : ''} (${c.timeframe}${c.analyst ? ', ' + c.analyst : ''})`).join('\n') || 'none'}`,
    SUMMARY_SCHEMA, usage);
  onProgress(chunks.length + 1, chunks.length + 1);

  // Learn DeepSeek's real tokens-per-character so later estimates are accurate.
  if (MODELS[model].provider === 'deepseek' && usage.promptChars) await saveSettings({ deepseekTokensPerChar: +(usage.input / usage.promptChars).toFixed(3) });
  for (const k of ['bullets', 'top_picks', 'key_news']) {
    summary[k] ||= [];
    for (const b of summary[k]) b.time = cleanTime(b.time);
  }
  summary.market_view ||= '';
  const result = { file: entry.file, iso: entry.iso, channel: entry.channel, provider: MODELS[model].provider, model, analyzedAt: new Date().toISOString(),
    usage, costUsd: costOf(usage, model), chunks: chunks.length, calls, summary };
  await mkdir(AI_DIR, { recursive: true });
  await writeFile(new URL(entry.file + '.json', AI_DIR), JSON.stringify(result, null, 2));
  return result;
}

// Token counting is free, so estimates use the real tokenizer for the chosen model.
const tokenCache = new Map();
export async function estimate(entries) {
  const { api, settings, model } = await client();
  let input = 0;
  // DeepSeek has no token counter, so use the tokens-per-character ratio learned from earlier runs.
  if (MODELS[model].provider === 'deepseek') {
    let chars = 0;
    for (const e of entries) chars += chunkTranscript(await loadSegments(e)).reduce((n, c) => n + c.text.length + EXTRACT_SYSTEM.length + 1500, 0);
    // Measured on a real 9-hour stream: DeepSeek writes ~0.6 output tokens per input token (it reasons before answering).
    const inputTok = Math.round(chars * settings.deepseekTokensPerChar * 1.04), outputTok = Math.round(inputTok * 0.62);
    const p = MODELS[model], f = deepseekPeak() ? 1 : 0.5;
    const usd = f * (inputTok * p.input + outputTok * p.output) / 1e6;
    return { model, streams: entries.length, inputTokens: inputTok, usd, inr: usd * settings.usdToInr, approximate: true, offPeak: f < 1 };
  }
  for (const e of entries) {
    const key = e.file + '|' + model;
    if (!tokenCache.has(key)) {
      const text = chunkTranscript(await loadSegments(e)).map(c => c.text).join('\n');
      const r = await api.messages.countTokens({ model, system: EXTRACT_SYSTEM, messages: [{ role: 'user', content: text }] });
      tokenCache.set(key, r.input_tokens);
    }
    input += tokenCache.get(key);
  }
  // Output (calls, notes and thinking) is roughly 8% of input for this task; the summary call adds a little more.
  const usage = { input: Math.round(input * 1.04), output: Math.round(input * 0.08) };
  const usd = costOf(usage, model);
  return { model, streams: entries.length, inputTokens: usage.input, usd, inr: usd * settings.usdToInr };
}

// One background job at a time, polled by the UI.
let job = null;
export function jobStatus() { return job; }

export async function analyzeMany(entries, log = () => {}) {
  if (job?.running) throw new Error('An analysis is already running');
  job = { running: true, total: entries.length, done: 0, current: '', part: '', errors: [], costUsd: 0, startedAt: Date.now() };
  try {
    for (const e of entries) {
      job.current = `${e.iso} ${e.channel}`;
      try {
        const r = await analyzeEntry(e, (d, t) => { job.part = `${d}/${t}`; });
        job.costUsd += r.costUsd;
        log(`${e.iso} ${e.channel}: ${r.calls.length} calls, $${(r.costUsd || 0).toFixed(3)}`);
      } catch (err) {
        job.errors.push(`${e.iso} ${e.channel}: ${err.message}`);
        log(`${e.iso} ${e.channel}: analysis failed: ${err.message}`);
        if (err instanceof Anthropic.AuthenticationError || err.status === 401 || err.status === 402) break;
      }
      job.done++;
    }
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
  return job;
}

export async function unanalyzed(lib) {
  const out = [];
  for (const e of lib) if (!(await loadAnalysis(e))) out.push(e);
  return out;
}

export async function loadAllAnalyses({ from, to, channel } = {}) {
  const lib = (await loadLibrary()).filter(e => (!from || e.iso >= from) && (!to || e.iso <= to) && (!channel || e.channel === channel));
  const out = [];
  for (const e of lib) {
    const a = await loadAnalysis(e);
    if (a) out.push({ entry: e, analysis: a });
  }
  return out;
}
