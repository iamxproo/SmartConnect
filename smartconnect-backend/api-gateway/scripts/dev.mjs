// Development loop without extra dependencies: `tsc --watch` rebuilds dist/ on change and `node --watch` restarts
// the gateway when dist/ changes. `npm run dev` performs the initial build before this runs. Ctrl-C stops both.
import { spawn } from 'node:child_process';

const children = [
  spawn('tsc', ['-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--env-file-if-exists=.env', '--watch', 'dist/main.js'], { stdio: 'inherit' }),
];

for (const child of children) {
  child.on('exit', (code) => {
    for (const other of children) if (other !== child && other.exitCode === null) other.kill('SIGTERM');
    process.exitCode = code ?? 0;
  });
}

// Forward stop signals (e.g. an IDE's stop button signals only this process) so neither child is orphaned.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  });
}
