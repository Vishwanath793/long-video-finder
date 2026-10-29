// Members-only transcripts: runs the Python helper in ./members (yt-dlp with your own cookies.txt) and adds
// what it saves to the library, so Search, Stock mentions and Calls see it too.
// One job at a time; the page polls /api/members/job. Cookie contents never pass through here, only the path.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TRANSCRIPTS, addEntries, clock } from './subtitles.mjs';
import { exportCookies } from './ytbrowser.mjs';

const DIR = fileURLToPath(new URL('./members/', import.meta.url));
const SETTINGS = new URL('./data/members-settings.json', import.meta.url);
// cookiesMode: app (the app's signed-in browser profile) | file (cookies.txt) | firefox | none
const DEFAULTS = { cookiesMode: 'app', cookiesPath: '', language: 'native', customLanguage: '',
  whisperMode: 'ask', whisperModel: 'medium', whisperTask: 'transcribe', keepAudio: false, deleteCookies: false };
const ACTIONS = ['check', 'list', 'download', 'update'];

let job = null;
let nextId = 1;

function python() {
  const venv = DIR + '.venv\\Scripts\\python.exe';
  return existsSync(venv) ? venv : null;
}

export async function loadMembersSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(await readFile(SETTINGS, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}

async function saveMembersSettings(s) {
  const clean = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, s[k] ?? DEFAULTS[k]]));
  await writeFile(SETTINGS, JSON.stringify(clean, null, 2));
  return clean;
}

// Spawns the bridge with one command; onEvent gets each JSON line. Resolves with the final result data.
function runBridge(cmd, onEvent = () => {}) {
  const exe = python();
  if (!exe) return Promise.reject(new Error('The members-only helper is not set up yet: double-click members\\setup.bat'));
  const child = spawn(exe, ['-m', 'app.bridge'], { cwd: DIR, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  child.stdin.write(JSON.stringify(cmd) + '\n');
  let buf = '', result, stderr = '';
  const promise = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') result = ev.data;
        else onEvent(ev);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => {
      child.stdin.destroy();
      if (result) resolve(result);
      else reject(new Error(code === null ? 'Stopped' : `Helper exited (${code}): ${stderr.trim().split('\n').at(-1) || 'no output'}`));
    });
  });
  promise.child = child;
  return promise;
}

export async function membersStatus() {
  if (!python()) return { ready: false, folder: DIR };
  try { return { ready: true, folder: DIR, ...(await runBridge({ cmd: 'status' })) }; }
  catch (e) { return { ready: false, folder: DIR, error: e.message }; }
}

const longDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// One library entry per saved language track.
export function toEntries(videos, now = new Date().toISOString()) {
  const entries = [];
  for (const v of videos || []) {
    const url = v.url_canonical || v.url;
    for (const t of v.tracks || []) {
      entries.push({ iso: v.iso, date: longDate(v.iso), channel: v.channel || 'YouTube', videoId: v.id,
        title: v.tracks.length > 1 ? `${v.title} [${t.label}${t.whisper ? ', Whisper' : ''}]` : v.title,
        duration: v.duration ? clock(v.duration * 1000) : '', url,
        downsub: `https://downsub.com/?url=${encodeURIComponent(url)}`,
        language: t.label, auto: t.auto, whisper: t.whisper, lines: t.lines, file: t.file,
        downloadedAt: now, source: 'members' });
    }
  }
  return entries;
}

function languagesOf(s) {
  if (s.language === 'custom') return s.customLanguage || 'native';
  return s.language || 'native';
}

// Starts check / list / download / update in the background.
export async function startMembersJob(action, input) {
  if (!ACTIONS.includes(action)) throw new Error('Unknown action');
  if (job?.running) throw new Error('A members-only job is already running');
  const s = await saveMembersSettings({ ...(await loadMembersSettings()), ...input });
  const urls = String(input.urls || '').trim();
  if ((action === 'list' || action === 'download') && !urls) throw new Error('Paste at least one video URL');
  await mkdir(TRANSCRIPTS, { recursive: true });
  const cmd = { cmd: action, urls, cookies: { mode: s.cookiesMode, path: s.cookiesPath || undefined },
    languages: languagesOf(s), outputDir: fileURLToPath(TRANSCRIPTS), whisperMode: s.whisperMode,
    whisperModel: s.whisperModel, whisperTask: s.whisperTask, keepAudio: s.keepAudio,
    deleteCookies: s.cookiesMode === 'file' && s.deleteCookies, srt: true, txt: true, bom: true };

  const j = { id: nextId++, action, running: true, log: [], progress: 0, question: null, result: null, error: null, added: 0 };
  job = j;
  runJob(j, cmd).catch(e => { j.error = e.message; })
    .finally(() => { j.running = false; j.question = null; j.child = null; });
  return membersJob();
}

async function runJob(j, cmd) {
  const say = (level, msg) => j.log.push({ level, msg });
  let cleanup = async () => {};
  try {
    if (cmd.cookies.mode === 'app' && cmd.cmd !== 'update') {
      say('info', 'Reading your YouTube sign-in from the app browser…');
      const exported = await exportCookies(msg => say('debug', msg));
      cleanup = exported.cleanup;
      if (exported.signedIn) {
        say('success', 'Signed in to YouTube: using your account for members-only videos.');
        cmd.cookies = { mode: 'file', path: exported.path };
      } else {
        say('warning', 'Not signed in to YouTube, so only public videos will work. Use "Sign in to YouTube" above for members-only videos.');
        cmd.cookies = { mode: 'none' };
      }
      if (cmd.cmd === 'check') { j.result = { ok: exported.signedIn }; return; }
    }
    if (j.cancelled) throw new Error('Stopped');
    const p = runBridge(cmd, ev => {
      if (ev.type === 'log') say(ev.level, ev.msg);
      else if (ev.type === 'progress') j.progress = ev.value;
      else if (ev.type === 'ask') j.question = ev.question;
    });
    j.child = p.child;
    const result = await p;
    if (result.error) j.error = result.fix ? `${result.error} Fix: ${result.fix}` : result.error;
    if (cmd.cmd === 'download') {
      const entries = toEntries(result.videos);
      if (entries.length) await addEntries(entries);
      j.added = entries.length;
    }
    j.result = result;
  } finally {
    await cleanup(); // the temporary cookies file never outlives the job
  }
}

export function membersJob(since = 0) {
  if (!job) return null;
  const { child, log, ...rest } = job;
  return { ...rest, log: log.slice(since), logCount: log.length };
}

export function answerMembers(yes) {
  if (!job?.running || !job.question || !job.child) throw new Error('Nothing is waiting for an answer');
  job.question = null;
  job.child.stdin.write(JSON.stringify({ answer: !!yes }) + '\n');
  return membersJob();
}

// Asks the helper to stop after the current step; kills it if it hasn't after 20 s.
export function stopMembers() {
  if (!job?.running) return membersJob();
  job.cancelled = true;
  if (!job.child) return membersJob(); // still reading the sign-in; the helper won't start
  const { child } = job;
  job.log.push({ level: 'warning', msg: 'Stopping after the current step...' });
  child.stdin.write(JSON.stringify({ cancel: true }) + '\n');
  setTimeout(() => { if (child.exitCode === null) child.kill(); }, 20_000).unref();
  return membersJob();
}

export function openTranscriptsFolder() {
  spawn('explorer.exe', [fileURLToPath(TRANSCRIPTS)], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
}
