// Cadastros mestres: registros salvos de qualquer entidade, reaproveitados nos cenários e vinculados a cada destino.
// Quando o modelo diz por qual campo a integração liga o registro ao pai (relação com "campo" e "chave"), o cadastro
// só é salvo ligado a um pai cadastrado — o contrato a um fornecedor existente, pelo CNPJ, como a API exige.
import { agora, executar, json, novoId, todos, um } from '../db.ts';
import { ErroHttp } from '../http.ts';
import type { CadastroUsado, DefinicaoCenario, Relacao } from '../core/tipos.ts';
import { modelosDoPacote } from './pacotes.ts';
import { renderizar } from '../core/expr.ts';

export interface Ligacao {
  relacao: string;
  entidade: string;
  campo: string;
  chave: string;
  valor: string;
  cadastroId?: string;
  rotulo?: string;
  problema?: string;
}

export interface Cadastro {
  id: string;
  pacoteId: string | null;
  entidade: string;
  rotulo: string;
  dados: Record<string, unknown>;
  etiquetas: string[];
  versao: number;
  pais: Record<string, string>;
  criadoEm: string;
  atualizadoEm: string;
  vinculos: { destinoId: string; destino?: string; idRemoto: string; atualizadoEm: string }[];
}

function linha(l: Record<string, unknown>): Cadastro {
  const vinculos = todos<{ destino_id: string; nome: string | null; id_remoto: string; atualizado_em: string }>(
    `SELECT v.destino_id, d.nome, v.id_remoto, v.atualizado_em FROM cadastro_vinculos v LEFT JOIN destinos d ON d.id = v.destino_id WHERE v.cadastro_id = ?`,
    l.id as string,
  ).map((v) => ({ destinoId: v.destino_id, destino: v.nome ?? undefined, idRemoto: v.id_remoto, atualizadoEm: v.atualizado_em }));
  return {
    id: l.id as string, pacoteId: (l.pacote_id as string) ?? null, entidade: l.entidade as string, rotulo: l.rotulo as string,
    dados: json(l.dados, {}), etiquetas: json(l.etiquetas, []), versao: l.versao as number, pais: json(l.pais, {}),
    criadoEm: l.criado_em as string, atualizadoEm: l.atualizado_em as string, vinculos,
  };
}

function obterCampo(obj: unknown, caminho: string): unknown {
  return caminho.split('.').reduce<unknown>((o, p) => (o == null || typeof o !== 'object' ? undefined : (o as Record<string, unknown>)[p]), obj);
}

// CNPJ com ou sem máscara é o mesmo CNPJ.
const normalizar = (v: unknown) => String(v ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase();
const vazio = (v: unknown) => v === undefined || v === null || v === '';

// Relações que a integração faz por chave: o campo deste registro guarda a chave do pai.
function relacoesPorChave(pacoteId: string | null, entidade: string): { rel: Relacao; rotulo: string; rotuloPai: string }[] {
  if (!pacoteId) return [];
  const modelos = modelosDoPacote(pacoteId);
  const m = modelos.find((x) => x.nome === entidade);
  return (m?.relacoes ?? [])
    .filter((r) => r.campo && r.chave && !r.via)
    .map((r) => ({ rel: r, rotulo: (m!.rotulo ?? entidade).toLowerCase(), rotuloPai: (modelos.find((x) => x.nome === r.entidade)?.rotulo ?? r.entidade).toLowerCase() }));
}

// A quem cada relação por chave do registro aponta, entre os cadastros do pai. Sem pai cadastrado, vem o problema.
export function ligacoesDo(pacoteId: string | null, entidade: string, dados: Record<string, unknown>): Ligacao[] {
  return relacoesPorChave(pacoteId, entidade).map(({ rel, rotulo, rotuloPai }) => {
    const valor = obterCampo(dados, rel.campo!);
    const base: Ligacao = { relacao: rel.nome, entidade: rel.entidade, campo: rel.campo!, chave: rel.chave!, valor: vazio(valor) ? '' : String(valor) };
    if (vazio(valor)) return { ...base, problema: `${rel.campo}: escolha o ${rotuloPai} cadastrado deste ${rotulo}.` };
    const alvo = normalizar(valor);
    const pai = todos<{ id: string; rotulo: string; dados: string }>('SELECT id, rotulo, dados FROM cadastros WHERE entidade = ? ORDER BY atualizado_em DESC', rel.entidade)
      .find((c) => normalizar(obterCampo(json(c.dados, {}), rel.chave!)) === alvo);
    if (!pai) return { ...base, problema: `${rel.campo}: ${valor} não é o ${rel.chave} de nenhum ${rotuloPai} cadastrado. Cadastre o ${rotuloPai} antes, como a integração exige.` };
    return { ...base, cadastroId: pai.id, rotulo: pai.rotulo };
  });
}

function exigirLigacoes(pacoteId: string | null, entidade: string, ligacoes: Ligacao[]): Record<string, string> {
  const problemas = ligacoes.filter((l) => l.problema).map((l) => l.problema!);
  if (problemas.length) {
    const r = relacoesPorChave(pacoteId, entidade)[0];
    throw new ErroHttp(422, `O ${r?.rotulo ?? entidade} precisa estar ligado a um ${r?.rotuloPai ?? 'registro'} cadastrado, como na integração.`, problemas);
  }
  return Object.fromEntries(ligacoes.filter((l) => l.cadastroId).map((l) => [l.relacao, l.cadastroId!]));
}

// Cadastros que apontam para este pela chave (os contratos de um fornecedor).
function filhosDe(cad: Cadastro): { id: string; rotulo: string; entidade: string; campo: string; chave: string }[] {
  if (!cad.pacoteId) return [];
  const saida: { id: string; rotulo: string; entidade: string; campo: string; chave: string }[] = [];
  for (const m of modelosDoPacote(cad.pacoteId)) {
    for (const r of m.relacoes ?? []) {
      if (r.entidade !== cad.entidade || !r.campo || !r.chave || r.via) continue;
      const alvo = normalizar(obterCampo(cad.dados, r.chave));
      if (!alvo) continue;
      for (const c of todos<{ id: string; rotulo: string; dados: string }>('SELECT id, rotulo, dados FROM cadastros WHERE entidade = ?', m.nome)) {
        if (normalizar(obterCampo(json(c.dados, {}), r.campo)) === alvo) saida.push({ id: c.id, rotulo: c.rotulo, entidade: m.nome, campo: r.campo, chave: r.chave });
      }
    }
  }
  return saida;
}

function comLigacoes(c: Cadastro) {
  const ligacoes = ligacoesDo(c.pacoteId, c.entidade, c.dados);
  return {
    ...c,
    ligacoes: ligacoes.filter((l) => l.cadastroId).map((l) => ({ relacao: l.relacao, entidade: l.entidade, campo: l.campo, valor: l.valor, cadastroId: l.cadastroId, rotulo: l.rotulo })),
    pendencias: ligacoes.filter((l) => l.problema).map((l) => l.problema!),
  };
}

export function listarCadastros(filtro: { entidade?: string; busca?: string; etiqueta?: string; pacoteId?: string }) {
  const where: string[] = [];
  const params: string[] = [];
  if (filtro.entidade) { where.push('entidade = ?'); params.push(filtro.entidade); }
  if (filtro.pacoteId) { where.push('pacote_id = ?'); params.push(filtro.pacoteId); }
  if (filtro.busca) { where.push('(rotulo LIKE ? OR dados LIKE ?)'); params.push(`%${filtro.busca}%`, `%${filtro.busca}%`); }
  if (filtro.etiqueta) { where.push('etiquetas LIKE ?'); params.push(`%"${filtro.etiqueta}"%`); }
  return todos(`SELECT * FROM cadastros ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY atualizado_em DESC LIMIT 500`, ...params).map((l) => comLigacoes(linha(l)));
}

function obterBruto(id: string): Cadastro {
  const l = um('SELECT * FROM cadastros WHERE id = ?', id);
  if (!l) throw new ErroHttp(404, 'Cadastro não encontrado.');
  return linha(l);
}

export function obterCadastro(id: string) {
  const c = obterBruto(id);
  return { ...comLigacoes(c), filhos: filhosDe(c).map((f) => ({ id: f.id, rotulo: f.rotulo, entidade: f.entidade })) };
}

async function rotuloPara(pacoteId: string | null, entidade: string, dados: Record<string, unknown>, rotulo?: string): Promise<string> {
  if (rotulo?.trim()) return rotulo.trim();
  const m = pacoteId ? modelosDoPacote(pacoteId).find((x) => x.nome === entidade) : undefined;
  if (m?.rotuloRegistro) {
    try { const r = String(await renderizar(m.rotuloRegistro, dados)); if (r.trim()) return r.trim(); } catch { /* usa o padrão */ }
  }
  return `${m?.rotulo ?? entidade} salvo`;
}

export async function criarCadastro(d: Partial<Cadastro>) {
  if (!d.entidade) throw new ErroHttp(422, 'Informe a entidade do cadastro.');
  if (!d.dados || typeof d.dados !== 'object') throw new ErroHttp(422, 'Os dados do cadastro precisam ser um objeto.');
  const pais = exigirLigacoes(d.pacoteId ?? null, d.entidade, ligacoesDo(d.pacoteId ?? null, d.entidade, d.dados));
  const id = novoId('cad');
  const t = agora();
  executar('INSERT INTO cadastros (id, pacote_id, entidade, rotulo, dados, etiquetas, versao, pais, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    id, d.pacoteId ?? null, d.entidade, await rotuloPara(d.pacoteId ?? null, d.entidade, d.dados, d.rotulo), JSON.stringify(d.dados),
    JSON.stringify(d.etiquetas ?? []), JSON.stringify(pais), t, t);
  return obterCadastro(id);
}

export async function atualizarCadastro(id: string, d: Partial<Cadastro>) {
  const atual = obterBruto(id);
  const dados = d.dados ?? atual.dados;
  const mudouDados = JSON.stringify(dados) !== JSON.stringify(atual.dados);
  const pais = exigirLigacoes(atual.pacoteId, atual.entidade, ligacoesDo(atual.pacoteId, atual.entidade, dados));
  // A chave de um pai não muda por baixo dos filhos: o contrato continuaria apontando para o CNPJ antigo.
  const filhos = filhosDe(atual).filter((f) => normalizar(obterCampo(dados, f.chave)) !== normalizar(obterCampo(atual.dados, f.chave)));
  if (filhos.length) {
    throw new ErroHttp(409, `O ${filhos[0].chave} deste cadastro está em ${filhos.length} cadastro(s) ligados a ele: ${filhos.map((f) => f.rotulo).join(', ')}. Mude neles antes, ou cadastre outro.`);
  }
  executar('UPDATE cadastros SET rotulo = ?, dados = ?, etiquetas = ?, versao = ?, pais = ?, atualizado_em = ? WHERE id = ?',
    await rotuloPara(atual.pacoteId, atual.entidade, dados, d.rotulo ?? atual.rotulo), JSON.stringify(dados),
    JSON.stringify(d.etiquetas ?? atual.etiquetas), atual.versao + (mudouDados ? 1 : 0), JSON.stringify(pais), agora(), id);
  return obterCadastro(id);
}

export function removerCadastro(id: string): void {
  const atual = obterBruto(id);
  const filhos = filhosDe(atual);
  if (filhos.length) {
    throw new ErroHttp(409, `Há ${filhos.length} cadastro(s) ligados a este: ${filhos.map((f) => f.rotulo).join(', ')}. Remova-os ou ligue-os a outro antes.`);
  }
  executar('DELETE FROM cadastros WHERE id = ?', id);
}

export function vincular(cadastroId: string, destinoId: string, idRemoto: string, execucaoId?: string): void {
  executar(
    `INSERT INTO cadastro_vinculos (cadastro_id, destino_id, id_remoto, execucao_id, atualizado_em) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (cadastro_id, destino_id) DO UPDATE SET id_remoto = excluded.id_remoto, execucao_id = excluded.execucao_id, atualizado_em = excluded.atualizado_em`,
    cadastroId, destinoId, idRemoto, execucaoId ?? null, agora(),
  );
}

export function desvincular(cadastroId: string, destinoId: string): void {
  executar('DELETE FROM cadastro_vinculos WHERE cadastro_id = ? AND destino_id = ?', cadastroId, destinoId);
}

// Os cadastros usados num cenário, com o id que já têm no destino da execução e o cadastro pai de cada relação por chave.
export function cadastrosParaGeracao(ids: string[], destinoId: string | null): Record<string, CadastroUsado> {
  const saida: Record<string, CadastroUsado> = {};
  for (const id of ids) {
    const l = um('SELECT * FROM cadastros WHERE id = ?', id);
    if (!l) continue;
    const c = linha(l);
    const pais = Object.fromEntries(ligacoesDo(c.pacoteId, c.entidade, c.dados).filter((x) => x.cadastroId).map((x) => [x.relacao, x.cadastroId!]));
    saida[id] = { id: c.id, entidade: c.entidade, rotulo: c.rotulo, dados: c.dados, idRemoto: c.vinculos.find((v) => v.destinoId === destinoId)?.idRemoto, pais };
  }
  return saida;
}

// Completa o cenário com os cadastros pai que os escolhidos exigem — o fornecedor do contrato entra antes dele, mesmo
// que o cenário não o tenha escolhido. Cadastro sem o pai que a integração exige impede a geração.
export function fecharCadastros(def: DefinicaoCenario): { definicao: DefinicaoCenario; incluidos: string[] } {
  const entidades = def.entidades.map((e) => ({ ...e, cadastros: [...(e.cadastros ?? [])] }));
  const fila = entidades.flatMap((e) => e.cadastros);
  const vistos = new Set(fila);
  const problemas: string[] = [];
  const incluidos: string[] = [];
  while (fila.length) {
    const id = fila.shift()!;
    const l = um('SELECT * FROM cadastros WHERE id = ?', id);
    if (!l) continue;
    const c = linha(l);
    for (const lig of ligacoesDo(c.pacoteId, c.entidade, c.dados)) {
      if (lig.problema) { problemas.push(`${c.rotulo} — ${lig.problema}`); continue; }
      if (!lig.cadastroId || vistos.has(lig.cadastroId)) continue;
      vistos.add(lig.cadastroId);
      let e = entidades.find((x) => x.entidade === lig.entidade);
      if (!e) { e = { entidade: lig.entidade, quantidade: 0, cadastros: [] }; entidades.unshift(e); }
      e.cadastros.unshift(lig.cadastroId);
      incluidos.push(lig.cadastroId);
      fila.push(lig.cadastroId);
    }
  }
  if (problemas.length) throw new ErroHttp(422, 'Há cadastros sem o vínculo que a integração exige. Abra-os em Cadastros e escolha o cadastro pai.', problemas);
  return { definicao: { ...def, entidades }, incluidos };
}

export function etiquetasEmUso(): string[] {
  const s = new Set<string>();
  for (const l of todos<{ etiquetas: string }>('SELECT etiquetas FROM cadastros')) for (const e of json<string[]>(l.etiquetas, [])) s.add(e);
  return [...s].sort();
}
