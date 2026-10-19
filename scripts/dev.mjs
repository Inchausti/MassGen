// Sobe o servidor (com recarga) e a interface do Vite juntos, para desenvolvimento.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const filhos = [
  spawn(npm, ['run', 'dev:server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev:web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

function encerrar() {
  for (const f of filhos) f.kill();
  process.exit();
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
for (const f of filhos) f.on('exit', (codigo) => { if (codigo) encerrar(); });
