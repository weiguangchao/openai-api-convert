import { spawn } from 'node:child_process';

const deadlineMs = 900_000;
const deadlineAt = Date.now() + deadlineMs;
let active;
let timedOut = false;
let forceTermination;

const terminate = () => {
  if (!active || active.exitCode !== null) return;
  if (process.platform !== 'win32') process.kill(-active.pid, 'SIGTERM');
  else active.kill('SIGTERM');
  forceTermination = setTimeout(() => {
    if (!active || active.exitCode !== null) return;
    if (process.platform !== 'win32') process.kill(-active.pid, 'SIGKILL');
    else active.kill('SIGKILL');
  }, 10_000);
};

const deadline = setTimeout(() => {
  timedOut = true;
  terminate();
}, Math.max(0, deadlineAt - Date.now()));

const run = (command, args, env) => new Promise((resolve, reject) => {
  active = spawn(command, args, { stdio: 'inherit', detached: process.platform !== 'win32', env });
  active.once('error', reject);
  active.once('exit', (code, signal) => {
    clearTimeout(forceTermination);
    code === 0 ? resolve() : reject(new Error(`${command} exited with ${signal ?? code}`));
  });
});

try {
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'test:unit']);
  if (timedOut) throw new Error('Release preflight timed out');
  await run(process.execPath, ['dist/scripts/release-smoke.js', 'config.test.yaml'], {
    ...process.env,
    RELEASE_GATE_DEADLINE_AT: String(deadlineAt),
  });
  if (timedOut) throw new Error('Release preflight timed out');
} catch (error) {
  if (timedOut) throw new Error('Release preflight timed out');
  throw error;
} finally {
  clearTimeout(deadline);
  clearTimeout(forceTermination);
}
