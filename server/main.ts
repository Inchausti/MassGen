// Servidor do MassGen: API em /api e a interface compilada em web/dist.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import './db.ts';
import { despachar, responderJson } from './http.ts';
import { rotas } from './rotas.ts';
import { garantirPacotesEmbutidos } from './servicos/pacotes.ts';
import { marcarInterrompidas } from './servicos/execucoes.ts';
import { auditar } from './auditoria.ts';

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

garantirPacotesEmbutidos();
marcarInterrompidas();
auditar('app.iniciar', `MassGen iniciado na porta ${config.porta}`, { detalhes: { dominiosPermitidos: config.dominiosPermitidos } });

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (!(await despachar(rotas, req, res, url))) responderJson(res, 404, { erro: 'Rota não encontrada.' });
    return;
  }
  if (!existsSync(config.dirWeb)) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<p style="font-family:sans-serif">A interface ainda não foi compilada. Rode <code>npm run build</code> ou use <code>npm start</code>, que compila antes de subir.</p>');
    return;
  }
  const alvo = path.normalize(path.join(config.dirWeb, decodeURIComponent(url.pathname)));
  const dentro = alvo.startsWith(config.dirWeb);
  const arquivo = dentro && existsSync(alvo) && statSync(alvo).isFile() ? alvo : path.join(config.dirWeb, 'index.html');
  const ext = path.extname(arquivo);
  res.writeHead(200, {
    'content-type': TIPOS[ext] ?? 'application/octet-stream',
    'cache-control': arquivo.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(arquivo).pipe(res);
});

servidor.listen(config.porta, () => {
  console.log(`MassGen no ar: http://localhost:${config.porta}`);
  console.log(`Domínios permitidos como destino: ${config.dominiosPermitidos.join(', ')}`);
});
