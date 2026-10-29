// The app's own signed-in YouTube browser profile (data/youtube-browser), so members-only downloads need only a URL.
// Sign in once in a normal Chrome/Edge window that uses this profile; afterwards each download opens the profile
// in hidden Chrome, reads the YouTube cookies over the DevTools protocol (Chrome decrypts its own cookies), and
// writes them to a temporary cookies file for yt-dlp that is deleted when the job ends. Cookie values are never logged.
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILE = process.env.LVF_YT_PROFILE || fileURLToPath(new URL('./data/youtube-browser/', import.meta.url));
const LOGIN_NAMES = ['SID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=' + encodeURIComponent('https://www.youtube.com/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let signInWindow = null; // the visible browser while the user signs in
let cached = null; // last account status

export function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [join(pf, 'Google\\Chrome\\Application\\chrome.exe'), join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    join(local, 'Google\\Chrome\\Application\\chrome.exe'), join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(pf, 'Microsoft\\Edge\\Application\\msedge.exe')].find(p => p && existsSync(p)) || null;
}

// Chrome keeps <profile>/lockfile open while it runs.
function profileInUse() {
  if (signInWindow) return true;
  const lock = join(PROFILE, 'lockfile');
  if (!existsSync(lock)) return false;
  try { closeSync(openSync(lock, 'r+')); return false; } catch { return true; }
}

export function openSignIn() {
  const exe = findBrowser();
  if (!exe) throw new Error('Chrome or Edge is needed for signing in; install Google Chrome');
  if (profileInUse()) throw new Error('The YouTube sign-in window is already open');
  signInWindow = spawn(exe, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', SIGN_IN_URL],
    { stdio: 'ignore' });
  signInWindow.on('exit', () => { signInWindow = null; cached = null; });
  signInWindow.on('error', () => { signInWindow = null; });
  cached = null;
  return { signingIn: true };
}

export async function signOut() {
  if (profileInUse()) throw new Error('Close the YouTube sign-in window first');
  await rm(PROFILE, { recursive: true, force: true });
  cached = null;
  return { signedIn: false };
}

// Minimal DevTools protocol client over the browser's WebSocket.
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('Could not talk to the hidden browser')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  };
  ws.onclose = () => { for (const p of pending.values()) p.rej(new Error('Hidden browser closed')); pending.clear(); };
  // Every call has a deadline, so a browser that stops answering can't freeze a download.
  const send = (method, params = {}, ms = 20_000) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`Hidden browser didn't answer ${method}`)); }, ms);
    pending.set(i, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close() };
}

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref())]);

// Only one hidden browser may use the profile at a time (status checks and downloads take turns).
let profileQueue = Promise.resolve();
function exclusive(fn) {
  const run = profileQueue.then(fn, fn);
  profileQueue = run.catch(() => {});
  return run;
}
let reading = false;

// Opens the profile hidden, optionally visits YouTube so rotating session cookies stay fresh, returns its cookies.
function readProfileCookies({ refresh = true, step = () => {} } = {}) {
  return exclusive(async () => {
    reading = true;
    try { return await readOnce(refresh, step); } finally { reading = false; }
  });
}

async function readOnce(refresh, step) {
  const exe = findBrowser();
  if (!exe) throw new Error('Chrome or Edge is needed; install Google Chrome');
  if (signInWindow || profileInUse()) throw new Error('Close the YouTube sign-in window first (finish signing in, then close it)');
  if (!existsSync(PROFILE)) return [];
  const portFile = join(PROFILE, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  step('Starting the hidden browser...');
  const child = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--no-first-run',
    '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let exited = false;
  child.on('exit', () => { exited = true; });
  let browser;
  try {
    let lines;
    for (let t = 0; t < 200 && !lines; t++) {
      if (exited) throw new Error('The hidden browser could not open the profile (is a sign-in window still open?)');
      try { lines = (await readFile(portFile, 'utf8')).trim().split('\n'); if (lines.length < 2) lines = null; } catch {}
      if (!lines) await sleep(100);
    }
    if (!lines) throw new Error('The hidden browser did not start within 20 s');
    browser = await withTimeout(connect(`ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`), 10_000,
      'Could not connect to the hidden browser');
    if (refresh) {
      step('Refreshing the YouTube session...');
      const { targetId } = await browser.send('Target.createTarget', { url: 'https://www.youtube.com/' });
      await sleep(5000);
      await browser.send('Target.closeTarget', { targetId }, 5000).catch(() => {});
    }
    const { cookies } = await browser.send('Storage.getCookies');
    await browser.send('Browser.close', {}, 5000).catch(() => {}); // graceful: saves refreshed cookies to the profile
    return cookies.filter(c => /(^|\.)(youtube|google)\.com$/.test(c.domain));
  } finally {
    browser?.close();
    for (let t = 0; t < 50 && !exited; t++) await sleep(100);
    if (!exited) child.kill();
  }
}

const isSignedIn = cookies => cookies.some(c => /youtube\.com$/.test(c.domain) && LOGIN_NAMES.includes(c.name)
  && (c.expires <= 0 || c.expires * 1000 > Date.now()));

export async function accountStatus({ fresh = false } = {}) {
  const browser = findBrowser();
  if (!browser) return { browser: null, signedIn: false, signingIn: false };
  // While a download reads the profile, answer from the last known state instead of queueing another browser.
  if (reading && cached) return { browser, signingIn: false, ...cached };
  if (signInWindow || profileInUse()) return { browser, signedIn: cached?.signedIn ?? false, signingIn: !!signInWindow, inUse: true };
  if (!cached || fresh) cached = { signedIn: existsSync(PROFILE) && isSignedIn(await readProfileCookies({ refresh: false })) };
  return { browser, signingIn: false, ...cached };
}

export function netscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Written by Long Video Finder for one yt-dlp run; deleted afterwards.', ''];
  for (const c of cookies) {
    // A leading dot marks a domain cookie; others are host-only. Session cookies have expires -1.
    lines.push([c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      c.expires > 0 ? Math.floor(c.expires) : 0, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

// Returns { path, signedIn, cleanup } — path is null when not signed in (public videos still work).
export async function exportCookies(step = () => {}) {
  const cookies = await readProfileCookies({ refresh: true, step });
  const signedIn = isSignedIn(cookies);
  cached = { signedIn };
  if (!signedIn) return { path: null, signedIn, cleanup: async () => {} };
  const dir = join(tmpdir(), 'long-video-finder');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `yt-${randomBytes(8).toString('hex')}.txt`);
  await writeFile(path, netscape(cookies), { mode: 0o600 });
  return { path, signedIn, cleanup: () => rm(path, { force: true }) };
}
