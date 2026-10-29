// Local web app: node server.mjs  ->  http://localhost:3000 (only reachable from this PC)
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { findAll, DEFAULT_CHANNELS } from './finder.mjs';
import { collectRange, runDaily } from './collector.mjs';
import { loadLibrary, downloadForRow, downloadByUrl, TRANSCRIPTS } from './subtitles.mjs';
import { search, mentions, loadWatchlist, saveWatchlist, suggestSpellings, untrackedStocks } from './analysis.mjs';
import { getHolidays } from './holidays.mjs';
import { taskStatus, installTask, removeTask } from './scheduler.mjs';
import { makeZip } from './zip.mjs';
import { publicSettings, saveSettings, estimate, analyzeMany, jobStatus, unanalyzed, loadAllAnalyses } from './ai.mjs';
import { listCalls, analystReport } from './calls.mjs';
import { loadAllRuleResults } from './rules.mjs';
import { loadMembersSettings, membersStatus, startMembersJob, membersJob, answerMembers, stopMembers,
  openTranscriptsFolder } from './members.mjs';
import { accountStatus, openSignIn, signOut } from './ytbrowser.mjs';

const PORT = Number(process.env.PORT) || 3000;
const page = new URL('./index.html', import.meta.url);
const DATA = new URL('./data/', import.meta.url);
let dailyRunning = false;

async function body(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || '{}');
}

const routes = {
  'GET /': async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(page));
  },
  'GET /api/defaults': async () => ({ channels: DEFAULT_CHANNELS }),
  'POST /api/find': async req => {
    const { from, to, minHours, requireDate, tradingDaysOnly, channels } = await body(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) throw new Error('Pick a start date');
    return { rows: await findAll(from, to || from, { minHours: Number(minHours) || 7, requireDate, tradingDaysOnly, channels }) };
  },
  'POST /api/collect': async req => {
    const { from, to, minHours, requireDate, tradingDaysOnly, channels, redownload } = await body(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) throw new Error('Pick a start date');
    const log = [];
    const results = await collectRange(from, to || from, { minHours: Number(minHours) || 7, requireDate,
      tradingDaysOnly, redownload, channels: channels?.length ? channels : DEFAULT_CHANNELS, log: m => log.push(m) });
    return { results, log };
  },
  'POST /api/download': async req => ({ entry: await downloadForRow((await body(req)).row) }),
  // Subtitles for pasted YouTube links: { urls: [...], iso?, channel?, channels? } -> one result per link.
  'POST /api/urls': async req => {
    const { urls, iso, channel, channels } = await body(req);
    const list = [...new Set((urls || []).map(u => String(u).trim()).filter(Boolean))];
    if (!list.length) throw new Error('Paste at least one YouTube link');
    if (list.length > 50) throw new Error('Up to 50 links at a time');
    const results = [];
    for (const u of list) {
      if (results.length) await new Promise(r => setTimeout(r, 800)); // be gentle with YouTube
      try { results.push({ url: u, status: 'saved', entry: await downloadByUrl(u, { iso, channel, channels: channels?.length ? channels : DEFAULT_CHANNELS }) }); }
      catch (err) { results.push({ url: u, status: 'error', error: err.message }); }
    }
    return { results };
  },
  'GET /api/library': async () => ({ library: await loadLibrary() }),
  'GET /api/settings': async () => publicSettings(),
  'PUT /api/settings': async req => saveSettings(await body(req)),
  // Transcripts in range that have no AI analysis yet.
  'GET /api/ai/pending': async (req, res, url) => {
    const { from, to, channel } = Object.fromEntries(url.searchParams);
    const lib = (await loadLibrary()).filter(e => (!from || e.iso >= from) && (!to || e.iso <= to) && (!channel || e.channel === channel));
    return { pending: (await unanalyzed(lib)).map(e => e.file), total: lib.length };
  },
  'POST /api/ai/estimate': async req => {
    const files = new Set((await body(req)).files || []);
    return estimate((await loadLibrary()).filter(e => files.has(e.file)));
  },
  'POST /api/ai/analyze': async req => {
    const files = new Set((await body(req)).files || []);
    const entries = (await loadLibrary()).filter(e => files.has(e.file)).sort((a, b) => a.iso.localeCompare(b.iso));
    if (!entries.length) throw new Error('Nothing to analyse');
    analyzeMany(entries).catch(() => {}); // runs in the background; the page polls /api/ai/job
    return { started: entries.length };
  },
  'GET /api/ai/job': async () => ({ job: jobStatus() }),
  'GET /api/calls': async (req, res, url) => listCalls(Object.fromEntries(url.searchParams)),
  // Analyst report: optionally fetches the period's missing transcripts first, then ranks analysts.
  'POST /api/report': async req => {
    const { from, to, channel, source, fetchMissing, channels } = await body(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new Error('Pick the dates');
    const log = [];
    if (fetchMissing) {
      const chs = (channels?.length ? channels : DEFAULT_CHANNELS).filter(c => !channel || c.name === channel);
      await collectRange(from, to, { channels: chs, log: m => log.push(m) });
    }
    const report = await analystReport({ from, to, channel, source });
    const lib = (await loadLibrary()).filter(e => e.iso >= from && e.iso <= to && (!channel || e.channel === channel));
    return { ...report, log, transcripts: lib.map(e => ({ iso: e.iso, channel: e.channel, file: e.file })) };
  },
  'GET /api/summaries': async (req, res, url) => {
    const q = Object.fromEntries(url.searchParams);
    if (q.source !== 'ai') {
      const items = await loadAllRuleResults(q);
      return { source: 'rules', items: items.map(({ entry, analysis: a }) => ({ iso: entry.iso, date: entry.date, channel: entry.channel,
        title: entry.title, url: entry.url, rules: a.summary,
        topCalls: a.calls.slice(0, 8).map(c => ({ time: c.time, stock: c.stock, symbol: c.symbol, action: c.action, target: c.target, stop_loss: c.stop_loss })) }))
        .sort((x, y) => y.iso.localeCompare(x.iso) || x.channel.localeCompare(y.channel)) };
    }
    const items = await loadAllAnalyses(q);
    return { items: items.map(({ entry, analysis: a }) => ({ iso: entry.iso, date: entry.date, channel: entry.channel,
      title: entry.title, url: entry.url, model: a.model, costUsd: a.costUsd, calls: a.calls.length, summary: a.summary }))
      .sort((x, y) => y.iso.localeCompare(x.iso) || x.channel.localeCompare(y.channel)) };
  },
  // Body: { files: [library file base names], ext: 'txt' | 'srt' } -> one .zip
  'POST /api/zip': async (req, res) => {
    const { files, ext } = await body(req);
    if (!['txt', 'srt'].includes(ext)) throw new Error('ext must be txt or srt');
    const known = new Set((await loadLibrary()).map(e => e.file));
    const names = [...new Set(files || [])].filter(f => known.has(f));
    if (!names.length) throw new Error('No saved subtitles to download');
    const zip = makeZip(await Promise.all(names.map(async f =>
      ({ name: `${f}.${ext}`, data: await readFile(new URL(`${f}.${ext}`, TRANSCRIPTS)) }))));
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length });
    res.end(zip);
  },
  'GET /api/search': async (req, res, url) => search(Object.fromEntries(url.searchParams)),
  'GET /api/mentions': async (req, res, url) => mentions(Object.fromEntries(url.searchParams)),
  'GET /api/watchlist': async () => ({ watchlist: await loadWatchlist() }),
  'PUT /api/watchlist': async req => { await saveWatchlist((await body(req)).watchlist); return { ok: true }; },
  // Suggestions for a person to review: other spellings of a tracked stock, and NSE stocks heard but not tracked.
  'GET /api/watchlist/suggest': async (req, res, url) => suggestSpellings(url.searchParams.get('symbol') || ''),
  'GET /api/watchlist/untracked': async () => untrackedStocks(),
  // Members-only transcripts (Python helper in ./members).
  'GET /api/members/settings': async () => ({ settings: await loadMembersSettings() }),
  'GET /api/members/status': async () => membersStatus(),
  'POST /api/members/run': async req => {
    const { action, ...input } = await body(req);
    return { job: await startMembersJob(action, input) };
  },
  'GET /api/members/job': async (req, res, url) => ({ job: membersJob(Number(url.searchParams.get('since')) || 0) }),
  'POST /api/members/answer': async req => ({ job: answerMembers((await body(req)).yes) }),
  'POST /api/members/stop': async () => ({ job: stopMembers() }),
  'POST /api/members/open-folder': async () => openTranscriptsFolder(),
  // The app's own signed-in YouTube browser profile.
  'GET /api/members/account': async (req, res, url) => accountStatus({ fresh: url.searchParams.has('fresh') }),
  'POST /api/members/sign-in': async () => openSignIn(),
  'POST /api/members/sign-out': async () => signOut(),
  'GET /api/holidays': async (req, res, url) => getHolidays({ refresh: url.searchParams.has('refresh') }),
  'GET /api/schedule': async () => {
    let lastRun = null;
    try { lastRun = JSON.parse(await readFile(new URL('last-run.json', DATA), 'utf8')); } catch {}
    return { task: await taskStatus(), lastRun, running: dailyRunning };
  },
  'POST /api/schedule': async req => {
    const { action, time } = await body(req);
    if (action === 'install') return { task: await installTask(time) };
    if (action === 'remove') return { task: await removeTask() };
    if (action === 'run-now') {
      if (dailyRunning) throw new Error('A run is already in progress');
      dailyRunning = true;
      try { await runDaily(); } finally { dailyRunning = false; }
      return { ok: true };
    }
    throw new Error('Unknown action');
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // Transcript files: /files/<name>.srt|.txt|.json
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const name = decodeURIComponent(url.pathname.slice(7));
      if (!/^[\w.-]+\.(srt|txt|json)$/.test(name)) throw new Error('Bad file name');
      const data = await readFile(new URL(name, TRANSCRIPTS));
      const type = name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
      return res.end(data);
    }
    // Other websites must not be able to drive the members-only helper (it reads your cookies file).
    const origin = req.headers.origin;
    if (url.pathname.startsWith('/api/members/') && origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Forbidden origin' }));
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return res.writeHead(404).end('Not found');
    const result = await handler(req, res, url);
    if (result !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// If the port is taken (e.g. an older copy is still running), use the next free one.
// `node server.mjs --open` (start.bat) then opens the browser at whichever port it got.
let port = PORT;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && port < PORT + 10) {
    console.log(`Port ${port} is already in use (an older Long Video Finder may still be running); trying ${port + 1}...`);
    server.listen(++port, '127.0.0.1');
  } else throw err;
});
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Long Video Finder running at ${url}`);
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
});
server.listen(port, '127.0.0.1');
