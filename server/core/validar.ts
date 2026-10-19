// Confere a estrutura de um modelo de entidade e de um cenário antes de salvar.
import jsonata from 'jsonata';
import type { Campo, DefinicaoCenario, ModeloEntidade } from './tipos.ts';
import { GERADORES } from './geradores.ts';

function conferirExpr(expr: unknown, onde: string, erros: string[]): void {
  if (typeof expr !== 'string' || !expr.trim()) { erros.push(`${onde}: expressão vazia.`); return; }
  try { jsonata(expr); } catch (e) { erros.push(`${onde}: expressão inválida — ${(e as Error).message}`); }
}

function conferirModelosDeTexto(valor: unknown, onde: string, erros: string[]): void {
  if (typeof valor !== 'string') return;
  for (const m of valor.matchAll(/\{\{\s*([\s\S]+?)\s*\}\}/g)) {
    if (m[1].startsWith('$remoto.')) continue;
    conferirExpr(m[1], onde, erros);
  }
}

function conferirGerador(g: unknown, onde: string, erros: string[]): void {
  if (!g || typeof g !== 'object') { erros.push(`${onde}: gerador ausente.`); return; }
  const tipo = (g as { tipo?: unknown }).tipo;
  if (typeof tipo !== 'string' || !GERADORES[tipo]) { erros.push(`${onde}: gerador desconhecido "${String(tipo)}".`); return; }
  if (tipo === 'expressao') conferirExpr((g as { expr?: unknown }).expr, onde, erros);
  for (const v of Object.values(g as object)) conferirModelosDeTexto(v, onde, erros);
}

function conferirCampos(campos: unknown, onde: string, erros: string[]): void {
  if (!Array.isArray(campos)) { erros.push(`${onde}: "campos" precisa ser uma lista.`); return; }
  const nomes = new Set<string>();
  for (const [i, c] of (campos as Campo[]).entries()) {
    const local = `${onde} › campo ${c?.nome ?? i + 1}`;
    if (!c || typeof c.nome !== 'string' || !c.nome.trim()) { erros.push(`${onde}: o campo ${i + 1} não tem nome.`); continue; }
    if (nomes.has(c.nome)) erros.push(`${local}: nome repetido.`);
    nomes.add(c.nome);
    if (c.tipo === 'lista' && c.itens) {
      if (!c.itens.quantidade || c.itens.quantidade.min > c.itens.quantidade.max) erros.push(`${local}: quantidade de itens inválida.`);
      conferirCampos(c.itens.campos, local, erros);
    } else if (c.gerador) {
      conferirGerador(c.gerador, local, erros);
    }
  }
}

export function validarModelo(m: ModeloEntidade, outros: ModeloEntidade[] = []): string[] {
  const erros: string[] = [];
  if (!m || typeof m !== 'object') return ['O modelo precisa ser um objeto JSON.'];
  if (!/^[a-z][a-z0-9_]*$/.test(m.nome ?? '')) erros.push('nome: use letras minúsculas, números e _, começando por letra.');
  if (!m.rotulo) erros.push('rotulo: obrigatório.');
  conferirCampos(m.campos, m.nome ?? 'modelo', erros);
  const nomesRel = new Set<string>();
  for (const r of m.relacoes ?? []) {
    if (!r.nome || !r.entidade) { erros.push('relacoes: cada relação precisa de nome e entidade.'); continue; }
    nomesRel.add(r.nome);
    if (outros.length && !outros.some((o) => o.nome === r.entidade) && r.entidade !== m.nome) {
      erros.push(`relação ${r.nome}: a entidade ${r.entidade} não existe no pacote.`);
    }
  }
  for (const r of m.relacoes ?? []) {
    if (r.via && !nomesRel.has(r.via)) erros.push(`relação ${r.nome}: "via" aponta para ${r.via}, que não é relação deste modelo.`);
  }
  for (const p of m.perfis ?? []) {
    if (!p.nome) erros.push('perfis: cada perfil precisa de nome.');
    if (typeof p.peso !== 'number' || p.peso < 0) erros.push(`perfil ${p.nome}: peso precisa ser um número maior ou igual a zero.`);
    for (const [campo, g] of Object.entries(p.campos ?? {})) conferirGerador(g, `perfil ${p.nome} › ${campo}`, erros);
  }
  for (const r of m.regras ?? []) conferirExpr(r.expr, `regra ${r.nome}`, erros);
  for (const c of m.casos ?? []) {
    if (!c.id || !c.rotulo) erros.push('casos: cada caso precisa de id e rotulo.');
    if (!c.esperado) erros.push(`caso ${c.id}: falta o resultado esperado.`);
    for (const [campo, g] of Object.entries(c.campos ?? {})) conferirGerador(g, `caso ${c.id} › ${campo}`, erros);
  }
  if (m.rotuloRegistro) conferirModelosDeTexto(m.rotuloRegistro, 'rotuloRegistro', erros);
  return erros;
}

export function validarCenario(d: DefinicaoCenario, modelos: ModeloEntidade[]): string[] {
  const erros: string[] = [];
  if (!d || !Array.isArray(d.entidades) || !d.entidades.length) return ['O cenário precisa de pelo menos uma entidade.'];
  const vistos = new Set<string>();
  for (const e of d.entidades) {
    const m = modelos.find((x) => x.nome === e.entidade);
    if (!m) { erros.push(`Entidade ${e.entidade}: não há modelo com esse nome.`); continue; }
    if (vistos.has(e.entidade)) erros.push(`Entidade ${e.entidade}: aparece duas vezes.`);
    vistos.add(e.entidade);
    if (e.porPai) {
      if (!m.relacoes?.some((r) => r.nome === e.porPai!.relacao)) erros.push(`${e.entidade}: a relação ${e.porPai.relacao} não existe.`);
      if (e.porPai.min < 0 || e.porPai.max < e.porPai.min) erros.push(`${e.entidade}: mínimo e máximo por pai inválidos.`);
    } else if (!(Number(e.quantidade) >= 0)) {
      erros.push(`${e.entidade}: informe a quantidade.`);
    }
    for (const id of Object.keys(e.casos ?? {})) {
      if (!m.casos?.some((c) => c.id === id)) erros.push(`${e.entidade}: o caso ${id} não existe.`);
    }
    for (const p of Object.keys(e.perfis ?? {})) {
      if (!m.perfis?.some((x) => x.nome === p)) erros.push(`${e.entidade}: o perfil ${p} não existe.`);
    }
  }
  if (d.dataReferencia && !/^\d{4}-\d{2}-\d{2}$/.test(d.dataReferencia)) erros.push('Data de referência: use AAAA-MM-DD.');
  return erros;
}
