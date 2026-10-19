// Usuários do MassGen: login com e-mail e senha, sessões, pré-cadastro com convite e papéis.
// root gerencia usuários e faz tudo; operador configura e envia; leitor só consulta.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { config } from './config.ts';
import { agora, executar, novoId, todos, um } from './db.ts';
import { ErroHttp } from './http.ts';
import { MAQUINA, auditar, sha256, type ContextoUso, type Papel } from './auditoria.ts';

export const PAPEIS: Papel[] = ['root', 'operador', 'leitor'];
export const COOKIE = 'massgen_sessao';
const SENHA_MINIMA = 10;
const HORA = 3600 * 1000;
const VALIDADE: Record<TipoConvite, number> = { primeiro_acesso: 24 * HORA, convite: 7 * 24 * HORA, redefinicao: 24 * HORA };

type TipoConvite = 'primeiro_acesso' | 'convite' | 'redefinicao';
type Status = 'convidado' | 'ativo' | 'desativado';

interface LinhaUsuario {
  id: string; email: string; nome: string | null; papel: Papel; status: Status; senha_hash: string | null;
  criado_por: string; criado_em: string; atualizado_em: string; ultimo_acesso: string | null;
}

export interface Usuario {
  id: string; email: string; nome: string | null; papel: Papel; status: Status; temSenha: boolean;
  criadoPor: string; criadoEm: string; ultimoAcesso: string | null;
  convitePendente: { tipo: TipoConvite; expiraEm: string } | null;
}

const normalizarEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const emailValido = (e: string) => e.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e);

function publico(l: LinhaUsuario): Usuario {
  const c = um<{ tipo: TipoConvite; expira_em: string }>(
    'SELECT tipo, expira_em FROM convites WHERE usuario_id = ? AND usado_em IS NULL AND expira_em > ? ORDER BY criado_em DESC LIMIT 1', l.id, agora());
  return {
    id: l.id, email: l.email, nome: l.nome, papel: l.papel, status: l.status, temSenha: !!l.senha_hash,
    criadoPor: l.criado_por, criadoEm: l.criado_em, ultimoAcesso: l.ultimo_acesso,
    convitePendente: c ? { tipo: c.tipo, expiraEm: c.expira_em } : null,
  };
}

// ---------------------------------------------------------------- senha

function hashSenha(senha: string): string {
  const sal = randomBytes(16);
  const h = scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${sal.toString('base64')}$${h.toString('base64')}`;
}

function conferirSenha(senha: string, guardado: string | null): boolean {
  if (!guardado) return false;
  const [alg, N, r, p, sal, h] = guardado.split('$');
  if (alg !== 'scrypt') return false;
  const esperado = Buffer.from(h, 'base64');
  const obtido = scryptSync(senha, Buffer.from(sal, 'base64'), esperado.length, { N: Number(N), r: Number(r), p: Number(p) });
  return obtido.length === esperado.length && timingSafeEqual(obtido, esperado);
}

function validarSenha(senha: unknown, email: string): string {
  const s = String(senha ?? '');
  if (s.length < SENHA_MINIMA) throw new ErroHttp(422, `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`);
  if (s.length > 200) throw new ErroHttp(422, 'A senha pode ter no máximo 200 caracteres.');
  if (s.toLowerCase() === email || s.toLowerCase() === email.split('@')[0]) throw new ErroHttp(422, 'A senha não pode ser o seu e-mail.');
  return s;
}

// ---------------------------------------------------------------- sessão

// IP de quem chamou. O Cf-Connecting-IP só vale vindo da própria máquina (o cloudflared): de fora, poderia ser forjado
// para escapar do limite de tentativas de login.
export function ipDe(req: IncomingMessage): string {
  const direto = req.socket.remoteAddress ?? '';
  const cf = req.headers['cf-connecting-ip'];
  const local = direto === '::1' || direto.startsWith('127.') || direto.startsWith('::ffff:127.');
  return (local && (Array.isArray(cf) ? cf[0] : cf)) || direto;
}

function lerCookie(req: IncomingMessage, nome: string): string | undefined {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function cookieSessao(token: string | null): string {
  const atributos = [`${COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? config.sessaoHoras * 3600 : 0}`];
  if (config.cookieSeguro) atributos.push('Secure');
  return atributos.join('; ');
}

function criarSessao(usuarioId: string, req: IncomingMessage): string {
  const token = randomBytes(32).toString('base64url');
  const t = Date.now();
  executar('INSERT INTO sessoes (token_hash, usuario_id, criada_em, expira_em, ultimo_uso, ip) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), usuarioId, new Date(t).toISOString(), new Date(t + config.sessaoHoras * HORA).toISOString(), new Date(t).toISOString(), ipDe(req));
  executar('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?', new Date(t).toISOString(), usuarioId);
  return token;
}

function encerrarSessoes(usuarioId: string): void {
  executar('DELETE FROM sessoes WHERE usuario_id = ?', usuarioId);
}

function contextoDe(u: LinhaUsuario, origem: ContextoUso['origem']): ContextoUso {
  return { usuario: u.email, maquina: MAQUINA, origem, usuarioId: u.id, papel: u.papel, nome: u.nome };
}

// Quem fez a requisição. Atrás do Cloudflare Access (com MASSGEN_CONFIAR_CLOUDFLARE_ACCESS=true), o e-mail
// autenticado identifica o usuário cadastrado, sem senha; fora disso, vale o cookie de sessão.
// Devolve null sem identificação; lança 403 para e-mail do Access não cadastrado ou desativado.
export function identificar(req: IncomingMessage): ContextoUso | null {
  if (config.confiarCloudflareAccess) {
    const bruto = req.headers['cf-access-authenticated-user-email'];
    const email = normalizarEmail(Array.isArray(bruto) ? bruto[0] : bruto);
    if (email && emailValido(email)) {
      const u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE email = ?', email);
      if (!u) throw new ErroHttp(403, `${email} não está cadastrado no MassGen. Peça um convite a um administrador.`);
      if (u.status === 'desativado') throw new ErroHttp(403, 'Seu acesso ao MassGen está desativado.');
      if (u.status === 'convidado') {
        // Atrás do Access, o e-mail já foi comprovado: o primeiro acesso aceita o convite.
        executar("UPDATE usuarios SET status = 'ativo', atualizado_em = ? WHERE id = ?", agora(), u.id);
        executar("UPDATE convites SET usado_em = ? WHERE usuario_id = ? AND usado_em IS NULL", agora(), u.id);
        auditar('usuario.aceitar_convite', `${u.email} entrou pela primeira vez, autenticado pelo Cloudflare Access`, { alvoTipo: 'usuario', alvoId: u.id, usuario: u.email });
        u.status = 'ativo';
      }
      const t = agora();
      if (!u.ultimo_acesso || Date.parse(t) - Date.parse(u.ultimo_acesso) > 60000) executar('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?', t, u.id);
      return contextoDe(u, 'cloudflare-access');
    }
  }
  const token = lerCookie(req, COOKIE);
  if (!token) return null;
  const s = um<{ usuario_id: string; expira_em: string; ultimo_uso: string | null }>('SELECT usuario_id, expira_em, ultimo_uso FROM sessoes WHERE token_hash = ?', sha256(token));
  if (!s) return null;
  if (s.expira_em <= agora()) {
    executar('DELETE FROM sessoes WHERE token_hash = ?', sha256(token));
    return null;
  }
  const u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', s.usuario_id);
  if (!u || u.status !== 'ativo') return null;
  const t = agora();
  if (!s.ultimo_uso || Date.parse(t) - Date.parse(s.ultimo_uso) > 60000) {
    executar('UPDATE sessoes SET ultimo_uso = ? WHERE token_hash = ?', t, sha256(token));
    executar('UPDATE usuarios SET ultimo_acesso = ? WHERE id = ?', t, u.id);
  }
  return contextoDe(u, 'sessao');
}

// ---------------------------------------------------------------- login

const tentativas = new Map<string, number[]>();
const JANELA = 15 * 60 * 1000;
const MAXIMO_TENTATIVAS = 5;

function registrarFalha(chave: string): void {
  const agoraMs = Date.now();
  tentativas.set(chave, [...(tentativas.get(chave) ?? []).filter((t) => agoraMs - t < JANELA), agoraMs]);
}

export function entrar(emailBruto: unknown, senha: unknown, req: IncomingMessage): { token: string; usuario: Usuario } {
  const email = normalizarEmail(emailBruto);
  const chave = `${email}|${ipDe(req)}`;
  const recentes = (tentativas.get(chave) ?? []).filter((t) => Date.now() - t < JANELA);
  if (recentes.length >= MAXIMO_TENTATIVAS) {
    auditar('usuario.login_bloqueado', `Login bloqueado para ${email} depois de ${MAXIMO_TENTATIVAS} tentativas`, { usuario: email || 'anônimo', detalhes: { ip: ipDe(req) } });
    throw new ErroHttp(429, 'Muitas tentativas. Espere 15 minutos e tente de novo.');
  }
  const u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE email = ?', email);
  const ok = !!u && u.status === 'ativo' && conferirSenha(String(senha ?? ''), u.senha_hash);
  if (!ok) {
    registrarFalha(chave);
    auditar('usuario.login_falhou', `Tentativa de login sem sucesso para ${email || '(vazio)'}`, {
      usuario: email || 'anônimo', alvoTipo: 'usuario', alvoId: u?.id,
      detalhes: { ip: ipDe(req), motivo: !u ? 'e-mail não cadastrado' : u.status !== 'ativo' ? `usuário ${u.status}` : 'senha incorreta' },
    });
    // A mensagem não diz se o e-mail existe: dizer confirmaria quem tem acesso.
    throw new ErroHttp(401, 'E-mail ou senha incorretos.');
  }
  tentativas.delete(chave);
  const token = criarSessao(u.id, req);
  auditar('usuario.login', `${u.email} entrou no MassGen`, { usuario: u.email, alvoTipo: 'usuario', alvoId: u.id, detalhes: { ip: ipDe(req) } });
  return { token, usuario: publico(um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', u.id)!) };
}

export function sair(req: IncomingMessage, quem: ContextoUso | null): void {
  const token = lerCookie(req, COOKIE);
  if (token) executar('DELETE FROM sessoes WHERE token_hash = ?', sha256(token));
  if (quem?.usuarioId) auditar('usuario.logout', `${quem.usuario} saiu do MassGen`, { alvoTipo: 'usuario', alvoId: quem.usuarioId });
}

export function trocarSenha(quem: ContextoUso, atual: unknown, nova: unknown, req: IncomingMessage): string {
  const u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', quem.usuarioId ?? '');
  if (!u) throw new ErroHttp(401, 'Entre no MassGen para continuar.');
  if (u.senha_hash && !conferirSenha(String(atual ?? ''), u.senha_hash)) throw new ErroHttp(422, 'A senha atual não confere.');
  executar('UPDATE usuarios SET senha_hash = ?, atualizado_em = ? WHERE id = ?', hashSenha(validarSenha(nova, u.email)), agora(), u.id);
  encerrarSessoes(u.id);
  auditar('usuario.trocar_senha', `${u.email} trocou a própria senha`, { alvoTipo: 'usuario', alvoId: u.id });
  return criarSessao(u.id, req);
}

// ---------------------------------------------------------------- convites e primeiro acesso

function emitirConvite(usuarioId: string, tipo: TipoConvite, criadoPor: string): { link: string; expiraEm: string } {
  executar('UPDATE convites SET usado_em = ? WHERE usuario_id = ? AND usado_em IS NULL', agora(), usuarioId);
  const token = randomBytes(32).toString('base64url');
  const expiraEm = new Date(Date.now() + VALIDADE[tipo]).toISOString();
  executar('INSERT INTO convites (token_hash, usuario_id, tipo, criado_por, criado_em, expira_em) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), usuarioId, tipo, criadoPor, agora(), expiraEm);
  return { link: `${config.urlPublica}/convite/${token}`, expiraEm };
}

function conviteValido(token: string) {
  const c = um<{ token_hash: string; usuario_id: string; tipo: TipoConvite; expira_em: string; usado_em: string | null }>(
    'SELECT * FROM convites WHERE token_hash = ?', sha256(String(token ?? '')));
  if (!c || c.usado_em) throw new ErroHttp(404, 'Este link não vale mais: já foi usado ou foi substituído por outro. Peça um novo a um administrador.');
  if (c.expira_em <= agora()) throw new ErroHttp(410, 'Este link expirou. Peça um novo a um administrador.');
  const u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', c.usuario_id);
  if (!u || u.status === 'desativado') throw new ErroHttp(403, 'Este acesso está desativado.');
  return { c, u };
}

export function lerConvite(token: string) {
  const { c, u } = conviteValido(token);
  return { email: u.email, nome: u.nome, tipo: c.tipo, expiraEm: c.expira_em };
}

export function aceitarConvite(token: string, nome: unknown, senha: unknown, req: IncomingMessage): { token: string; usuario: Usuario } {
  const { c, u } = conviteValido(token);
  const nomeLimpo = String(nome ?? u.nome ?? '').trim().slice(0, 120) || null;
  executar("UPDATE usuarios SET senha_hash = ?, nome = ?, status = 'ativo', atualizado_em = ? WHERE id = ?",
    hashSenha(validarSenha(senha, u.email)), nomeLimpo, agora(), u.id);
  executar('UPDATE convites SET usado_em = ? WHERE token_hash = ?', agora(), c.token_hash);
  encerrarSessoes(u.id);
  const acao = c.tipo === 'redefinicao' ? 'usuario.redefinir_senha' : 'usuario.aceitar_convite';
  const resumo = c.tipo === 'redefinicao' ? `${u.email} definiu uma senha nova pelo link de redefinição` : c.tipo === 'primeiro_acesso' ? `${u.email} fez o primeiro acesso` : `${u.email} aceitou o convite`;
  auditar(acao, resumo, { usuario: u.email, alvoTipo: 'usuario', alvoId: u.id, detalhes: { ip: ipDe(req), tipo: c.tipo } });
  const sessao = criarSessao(u.id, req);
  return { token: sessao, usuario: publico(um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', u.id)!) };
}

// Na subida: cria os roots que faltam e imprime no console o link de primeiro acesso de quem ainda não tem senha.
// Só quem tem acesso ao console do servidor (a VM, o journalctl) vê esses links.
export function garantirRoots(): { email: string; link: string }[] {
  const links: { email: string; link: string }[] = [];
  for (const email of config.roots) {
    if (!emailValido(email)) { console.warn(`MASSGEN_ROOTS: "${email}" não é um e-mail válido; ignorado.`); continue; }
    let u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE email = ?', email);
    if (!u) {
      const id = novoId('usr');
      const t = agora();
      executar("INSERT INTO usuarios (id, email, papel, status, criado_por, criado_em, atualizado_em) VALUES (?, ?, 'root', 'convidado', 'sistema', ?, ?)", id, email, t, t);
      auditar('usuario.criar', `Root ${email} criado pela configuração MASSGEN_ROOTS`, { alvoTipo: 'usuario', alvoId: id, detalhes: { papel: 'root' } });
      u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', id)!;
    }
    if (u.status === 'convidado' && !u.senha_hash) {
      const { link } = emitirConvite(u.id, 'primeiro_acesso', 'sistema');
      links.push({ email, link });
      auditar('usuario.primeiro_acesso', `Link de primeiro acesso de ${email} gerado na subida (válido por 24 h)`, { alvoTipo: 'usuario', alvoId: u.id });
    }
  }
  return links;
}

// ---------------------------------------------------------------- gestão (root)

export function listarUsuarios(): Usuario[] {
  return todos<LinhaUsuario>("SELECT * FROM usuarios ORDER BY CASE status WHEN 'ativo' THEN 0 WHEN 'convidado' THEN 1 ELSE 2 END, email").map(publico);
}

function obterLinha(id: string): LinhaUsuario {
  const u = um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', id);
  if (!u) throw new ErroHttp(404, 'Usuário não encontrado.');
  return u;
}

function validarPapel(p: unknown): Papel {
  if (!PAPEIS.includes(p as Papel)) throw new ErroHttp(422, 'Papel inválido: use root, operador ou leitor.');
  return p as Papel;
}

export function preCadastrar(quem: ContextoUso, dados: { email?: unknown; nome?: unknown; papel?: unknown }) {
  const email = normalizarEmail(dados.email);
  if (!emailValido(email)) throw new ErroHttp(422, 'Informe um e-mail válido.');
  const papel = validarPapel(dados.papel ?? 'operador');
  if (um('SELECT 1 FROM usuarios WHERE email = ?', email)) throw new ErroHttp(409, `${email} já está cadastrado. Para mandar um link novo, use "Gerar link" na lista.`);
  const id = novoId('usr');
  const t = agora();
  const nome = String(dados.nome ?? '').trim().slice(0, 120) || null;
  executar("INSERT INTO usuarios (id, email, nome, papel, status, criado_por, criado_em, atualizado_em) VALUES (?, ?, ?, ?, 'convidado', ?, ?, ?)",
    id, email, nome, papel, quem.usuario, t, t);
  const convite = emitirConvite(id, 'convite', quem.usuario);
  auditar('usuario.convidar', `${email} pré-cadastrado como ${papel}, com convite válido por 7 dias`, { alvoTipo: 'usuario', alvoId: id, detalhes: { email, papel, expiraEm: convite.expiraEm } });
  return { usuario: publico(obterLinha(id)), ...convite };
}

// Link novo: convite para quem ainda não entrou, redefinição de senha para quem já está ativo.
export function gerarLink(quem: ContextoUso, id: string) {
  const u = obterLinha(id);
  if (u.status === 'desativado') throw new ErroHttp(409, 'Reative o usuário antes de gerar um link.');
  const tipo: TipoConvite = u.status === 'convidado' ? 'convite' : 'redefinicao';
  const convite = emitirConvite(id, tipo, quem.usuario);
  auditar(tipo === 'convite' ? 'usuario.convidar' : 'usuario.redefinicao', tipo === 'convite' ? `Novo convite gerado para ${u.email}` : `Link de redefinição de senha gerado para ${u.email}`,
    { alvoTipo: 'usuario', alvoId: id, detalhes: { tipo, expiraEm: convite.expiraEm } });
  return { usuario: publico(obterLinha(id)), tipo, ...convite };
}

// Há alguém que possa entrar como root (ativo ou com o primeiro acesso pendente)?
export function existeRoot(): boolean {
  return !!um("SELECT 1 FROM usuarios WHERE papel = 'root' AND status != 'desativado' LIMIT 1");
}

function rootsAtivos(excetoId?: string): number {
  return um<{ n: number }>("SELECT COUNT(*) AS n FROM usuarios WHERE papel = 'root' AND status = 'ativo' AND id != ?", excetoId ?? '')!.n;
}

export function alterarUsuario(quem: ContextoUso, id: string, dados: { papel?: unknown; status?: unknown; nome?: unknown }): Usuario {
  const u = obterLinha(id);
  const mudancas: string[] = [];
  if (dados.papel !== undefined && dados.papel !== u.papel) {
    const papel = validarPapel(dados.papel);
    if (u.papel === 'root' && u.status === 'ativo' && rootsAtivos(u.id) === 0) throw new ErroHttp(409, 'É o último root ativo: promova outra pessoa a root antes.');
    executar('UPDATE usuarios SET papel = ?, atualizado_em = ? WHERE id = ?', papel, agora(), id);
    encerrarSessoes(id);
    auditar('usuario.alterar_papel', `Papel de ${u.email}: ${u.papel} → ${papel}`, { alvoTipo: 'usuario', alvoId: id, detalhes: { de: u.papel, para: papel } });
    mudancas.push('papel');
  }
  if (dados.status !== undefined && dados.status !== u.status) {
    if (dados.status === 'desativado') {
      if (u.id === quem.usuarioId) throw new ErroHttp(409, 'Você não pode desativar o próprio acesso.');
      if (u.papel === 'root' && u.status === 'ativo' && rootsAtivos(u.id) === 0) throw new ErroHttp(409, 'É o último root ativo: não dá para desativar.');
      executar("UPDATE usuarios SET status = 'desativado', atualizado_em = ? WHERE id = ?", agora(), id);
      executar('UPDATE convites SET usado_em = ? WHERE usuario_id = ? AND usado_em IS NULL', agora(), id);
      encerrarSessoes(id);
      auditar('usuario.desativar', `Acesso de ${u.email} desativado`, { alvoTipo: 'usuario', alvoId: id });
    } else if (dados.status === 'ativo' && u.status === 'desativado') {
      // Quem nunca definiu senha volta como convidado e precisa de um link novo.
      const novo: Status = u.senha_hash ? 'ativo' : 'convidado';
      executar('UPDATE usuarios SET status = ?, atualizado_em = ? WHERE id = ?', novo, agora(), id);
      auditar('usuario.reativar', `Acesso de ${u.email} reativado${novo === 'convidado' ? ' (aguarda um link de convite)' : ''}`, { alvoTipo: 'usuario', alvoId: id });
    } else {
      throw new ErroHttp(422, 'Situação inválida: use ativo ou desativado.');
    }
    mudancas.push('status');
  }
  if (dados.nome !== undefined) {
    const nome = String(dados.nome ?? '').trim().slice(0, 120) || null;
    if (nome !== u.nome) {
      executar('UPDATE usuarios SET nome = ?, atualizado_em = ? WHERE id = ?', nome, agora(), id);
      auditar('usuario.alterar', `Nome de ${u.email} alterado`, { alvoTipo: 'usuario', alvoId: id, detalhes: { de: u.nome, para: nome } });
    }
  }
  return publico(obterLinha(id));
}

export function eu(quem: ContextoUso) {
  const u = quem.usuarioId ? um<LinhaUsuario>('SELECT * FROM usuarios WHERE id = ?', quem.usuarioId) : undefined;
  return u ? { ...publico(u), origem: quem.origem } : null;
}
