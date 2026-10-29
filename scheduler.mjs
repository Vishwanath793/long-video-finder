// Windows Task Scheduler entry that runs run-daily.bat every weekday evening.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TASK = 'LongVideoFinderDaily';
const BAT = fileURLToPath(new URL('./run-daily.bat', import.meta.url));

function schtasks(args) {
  return new Promise(resolve => execFile('schtasks', args, { windowsHide: true },
    (err, stdout, stderr) => resolve({ ok: !err, out: (stdout || '') + (stderr || '') })));
}

export async function taskStatus() {
  const r = await schtasks(['/Query', '/TN', TASK, '/V', '/FO', 'LIST']);
  if (!r.ok) return { installed: false };
  const field = name => (r.out.match(new RegExp(`^${name}:\\s*(.*)$`, 'mi')) || [])[1]?.trim();
  return { installed: true, nextRun: field('Next Run Time'), lastRun: field('Last Run Time'),
    lastResult: field('Last Result'), time: field('Start Time'), command: field('Task To Run') };
}

// time is "HH:MM" in the PC's local time.
export async function installTask(time = '20:30') {
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('Time must be HH:MM');
  const r = await schtasks(['/Create', '/F', '/TN', TASK, '/SC', 'WEEKLY', '/D', 'MON,TUE,WED,THU,FRI',
    '/ST', time, '/TR', `"${BAT}"`]);
  if (!r.ok) throw new Error(r.out.trim());
  return taskStatus();
}

export async function removeTask() {
  const r = await schtasks(['/Delete', '/F', '/TN', TASK]);
  if (!r.ok && !/cannot find/i.test(r.out)) throw new Error(r.out.trim());
  return { installed: false };
}
