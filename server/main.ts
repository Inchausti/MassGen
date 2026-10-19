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
import { existeRoot, garantirRoots } from './usuarios.ts';

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};

garantirPacotesEmbutidos();
marcarInterrompidas();
auditar('app.iniciar', `MassGen iniciado na porta ${config.porta}`, {
  detalhes: { dominiosPermitidos: config.dominiosPermitidos, host: config.host ?? 'todas as interfaces', confiarCloudflareAccess: config.confiarCloudflareAccess },
});
const primeirosAcessos = garantirRoots();

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
  // Sem moldura em outro site (a tela de login não pode ser embutida) e sem o link do convite no Referer.
  res.writeHead(200, {
    'content-type': TIPOS[ext] ?? 'application/octet-stream',
    'cache-control': arquivo.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });
  createReadStream(arquivo).pipe(res);
});

const LOOPBACK = (h: string) => h === 'localhost' || h === '::1' || h.startsWith('127.');

servidor.listen({ port: config.porta, host: config.host }, () => {
  const h = config.host && config.host !== '0.0.0.0' && config.host !== '::' ? config.host : 'localhost';
  console.log(`MassGen no ar: http://${h.includes(':') ? `[${h}]` : h}:${config.porta}`);
  console.log(`Escutando em ${config.host ?? 'todas as interfaces'}`);
  console.log(`Domínios permitidos como destino: ${config.dominiosPermitidos.join(', ')}`);
  // Roots sem senha: o link de primeiro acesso só aparece aqui, no console do servidor (válido por 24 h; cada subida gera um novo).
  for (const p of primeirosAcessos) console.log(`Primeiro acesso de ${p.email}: ${p.link}`);
  if (!existeRoot()) console.warn('Nenhum root cadastrado, e ninguém consegue entrar. Defina MASSGEN_ROOTS no .env (e-mails separados por vírgula) e reinicie.');
  if (config.confiarCloudflareAccess) {
    console.log('Identidade pelo Cloudflare Access: o e-mail autenticado entra na trilha de auditoria.');
    if (!config.host || !LOOPBACK(config.host)) {
      console.warn('Atenção: MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true sem MASSGEN_HOST=127.0.0.1. Quem alcançar o app sem passar pelo túnel pode forjar o e-mail.');
    }
  }
});
