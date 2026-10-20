// Motor de geração: monta a massa de um cenário a partir dos modelos de entidade.
// Determinístico: mesmo cenário, mesma semente e mesma data de referência geram a mesma massa.
import type {
  CadastroUsado, Campo, CasoBorda, Conferencia, DefinicaoCenario, Esperado, Gerador, ModeloEntidade, Perfil, RegistroGerado,
} from './tipos.ts';
import { Rng, distribuir, hashSemente } from './rng.ts';
import { OMITIR, executarGerador, type CtxGerador } from './geradores.ts';
import { avaliar, renderizar } from './expr.ts';
import { clonar, definir, obter } from './caminhos.ts';

export interface EntradaGeracao {
  modelos: ModeloEntidade[];
  cenario: DefinicaoCenario;
  semente: number;
  dataReferencia: string;
  codigoExecucao: string;
  variaveis: Record<string, unknown>;
  cadastros?: Record<string, CadastroUsado>;
}

export const ESPERADO_PADRAO: Esperado = { status: [200, 299] };

// Ordem das entidades: cada pai antes dos filhos.
export function ordenarEntidades(modelos: Map<string, ModeloEntidade>, nomes: string[]): string[] {
  const visitados = new Set<string>();
  const emCurso = new Set<string>();
  const saida: string[] = [];
  const presentes = new Set(nomes);
  const visitar = (n: string) => {
    if (visitados.has(n)) return;
    if (emCurso.has(n)) throw new Error(`As relações formam um ciclo em ${n}.`);
    emCurso.add(n);
    for (const r of modelos.get(n)?.relacoes ?? []) {
      if (r.via) continue;
      if (!presentes.has(r.entidade)) {
        throw new Error(`A entidade ${n} depende de ${r.entidade} (relação ${r.nome}): inclua ${r.entidade} no cenário.`);
      }
      visitar(r.entidade);
    }
    emCurso.delete(n);
    visitados.add(n);
    saida.push(n);
  };
  for (const n of nomes) visitar(n);
  return saida;
}

// Expõe os pais no registro sem que entrem no JSON salvo.
function anexarPais(obj: Record<string, unknown>, pais: Record<string, Record<string, unknown>>): void {
  for (const [nome, dados] of Object.entries(pais)) {
    if (!(nome in obj)) Object.defineProperty(obj, nome, { value: dados, enumerable: false, configurable: true, writable: true });
  }
}

interface Resolvido {
  campo: Campo;
  gerador?: Gerador;
}

// Campos do modelo com os geradores do perfil e do caso por cima.
// "items[].unit" sobrepõe (ou acrescenta) um campo dentro dos itens da lista "items".
function camposEfetivos(modelo: ModeloEntidade, perfil?: Perfil, caso?: CasoBorda): Resolvido[] {
  const sobrepor: Record<string, Gerador> = { ...(perfil?.campos ?? {}), ...(caso?.campos ?? {}) };
  const usados = new Set<string>();
  const saida: Resolvido[] = modelo.campos.map((c) => {
    if (c.tipo === 'lista' && c.itens) {
      const prefixo = `${c.nome}[].`;
      const subs = Object.entries(sobrepor).filter(([k]) => k.startsWith(prefixo));
      if (subs.length) {
        for (const [k] of subs) usados.add(k);
        const sub = Object.fromEntries(subs.map(([k, g]) => [k.slice(prefixo.length), g]));
        const camposItem = c.itens.campos.map((ci) => (sub[ci.nome] ? { ...ci, gerador: sub[ci.nome] } : ci));
        for (const [nome, g] of Object.entries(sub)) {
          if (!c.itens.campos.some((ci) => ci.nome === nome)) camposItem.push({ nome, gerador: g });
        }
        const campo: Campo = { ...c, itens: { ...c.itens, campos: camposItem } };
        usados.add(c.nome);
        return { campo, gerador: sobrepor[c.nome] };
      }
    }
    usados.add(c.nome);
    return { campo: c, gerador: sobrepor[c.nome] ?? c.gerador };
  });
  for (const [nome, g] of Object.entries(sobrepor)) {
    if (!usados.has(nome) && !nome.includes('[].')) saida.push({ campo: { nome }, gerador: g });
  }
  return saida;
}

async function gerarCampos(
  campos: Resolvido[],
  alvo: Record<string, unknown>,
  ctx: CtxGerador,
  unicos: Map<string, Set<string>> | undefined,
  checarUnicos: boolean,
): Promise<void> {
  for (const { campo, gerador } of campos) {
    if (campo.tipo === 'lista' && campo.itens && !gerador) {
      const qtd = ctx.rng.inteiro(campo.itens.quantidade.min, campo.itens.quantidade.max);
      const itens: Record<string, unknown>[] = [];
      for (let i = 0; i < qtd; i++) {
        const item: Record<string, unknown> = {};
        const ctxItem: CtxGerador = { ...ctx, entrada: item, vars: { ...ctx.vars, registro: alvo, indiceItem: i + 1 } };
        await gerarCampos(campo.itens.campos.map((c) => ({ campo: c, gerador: c.gerador })), item, ctxItem, undefined, false);
        itens.push(item);
      }
      definir(alvo, campo.nome, itens);
      continue;
    }
    if (!gerador) continue;
    let valor = await executarGerador(gerador, ctx);
    if (valor === OMITIR) continue;
    if (campo.unico && checarUnicos && unicos) {
      const conjunto = unicos.get(campo.nome) ?? new Set<string>();
      unicos.set(campo.nome, conjunto);
      for (let t = 0; t < 25 && conjunto.has(JSON.stringify(valor)); t++) valor = await executarGerador(gerador, ctx);
      conjunto.add(JSON.stringify(valor));
    }
    definir(alvo, campo.nome, valor);
  }
}

function escolherMaisEspecifico<T>(...opcoes: (T | undefined)[]): T | undefined {
  return opcoes.find((o) => o !== undefined);
}

export async function gerarMassa(e: EntradaGeracao): Promise<{ registros: RegistroGerado[]; avisos: string[] }> {
  const modelos = new Map(e.modelos.map((m) => [m.nome, m]));
  const avisos: string[] = [];
  const porNome = new Map(e.cenario.entidades.map((x) => [x.entidade, x]));
  for (const x of e.cenario.entidades) {
    if (!modelos.has(x.entidade)) throw new Error(`O cenário usa a entidade ${x.entidade}, que não tem modelo.`);
  }
  const ordem = ordenarEntidades(modelos, e.cenario.entidades.map((x) => x.entidade));
  const geradosPorEntidade = new Map<string, RegistroGerado[]>();
  const porId = new Map<string, RegistroGerado>();
  const todos: RegistroGerado[] = [];
  const regDoCadastro = new Map<string, string>();
  const execucao = { codigo: e.codigoExecucao, semente: e.semente };

  for (const [posicao, nome] of ordem.entries()) {
    const modelo = modelos.get(nome)!;
    const def = porNome.get(nome)!;
    const rng = new Rng(hashSemente(e.semente, nome));
    const lista: RegistroGerado[] = [];
    geradosPorEntidade.set(nome, lista);
    const unicos = new Map<string, Set<string>>();

    // 1. Cadastros mestres escolhidos entram primeiro, como estão, ligados aos cadastros pai que já entraram
    //    (o contrato ao seu fornecedor): os pais vêm antes pela ordem das entidades.
    for (const cadId of def.cadastros ?? []) {
      const cad = e.cadastros?.[cadId];
      if (!cad) { avisos.push(`Cadastro ${cadId} não encontrado; ignorado.`); continue; }
      const paisDoCadastro: Record<string, string> = {};
      for (const [rel, cadPai] of Object.entries(cad.pais ?? {})) {
        const regPai = regDoCadastro.get(cadPai);
        if (regPai) paisDoCadastro[rel] = regPai;
      }
      const reg: RegistroGerado = {
        id: `${e.codigoExecucao}:${nome}:${lista.length + 1}`,
        entidade: nome, indice: lista.length + 1, ordem: posicao, rotulo: cad.rotulo,
        cadastroId: cad.id, idRemoto: cad.idRemoto, pais: paisDoCadastro, dados: clonar(cad.dados),
        esperado: modelo.esperado ?? ESPERADO_PADRAO, conferencia: modelo.conferencia, avisos: [],
      };
      regDoCadastro.set(cad.id, reg.id);
      lista.push(reg);
      porId.set(reg.id, reg);
      todos.push(reg);
    }

    // 2. Quantos gerar e de quais pais, quando a quantidade é por pai.
    const relacoes = modelo.relacoes ?? [];
    const paisFixos: (RegistroGerado | undefined)[] = [];
    const poolDe = (entidade: string) => {
      const regs = geradosPorEntidade.get(entidade) ?? [];
      const normais = regs.filter((r) => !r.caso);
      return normais.length ? normais : regs;
    };
    let n = def.quantidade ?? 0;
    if (def.porPai) {
      const rel = relacoes.find((r) => r.nome === def.porPai!.relacao);
      if (!rel) throw new Error(`${nome}: a relação ${def.porPai.relacao} não existe no modelo.`);
      n = 0;
      for (const pai of poolDe(rel.entidade)) {
        const k = rng.inteiro(def.porPai.min, def.porPai.max);
        for (let i = 0; i < k; i++) paisFixos.push(pai);
        n += k;
      }
    }

    // 3. Perfis por peso (contagens exatas) e casos de borda em posições sorteadas.
    const pesos = (modelo.perfis ?? []).map((p) => ({ valor: p.nome, peso: def.perfis?.[p.nome] ?? p.peso }));
    const perfisSorteados = pesos.length ? distribuir(rng, n, pesos) : [];
    const casosPorPosicao = new Map<number, CasoBorda>();
    const posicoes = rng.embaralhar([...Array(n).keys()]);
    let cursor = 0;
    for (const [casoId, qtd] of Object.entries(def.casos ?? {})) {
      const caso = modelo.casos?.find((c) => c.id === casoId);
      if (!caso) { avisos.push(`${nome}: caso de borda ${casoId} não existe no modelo; ignorado.`); continue; }
      for (let i = 0; i < qtd && cursor < n; i++) casosPorPosicao.set(posicoes[cursor++], caso);
    }

    // 4. Cada registro.
    for (let i = 0; i < n; i++) {
      const indice = lista.length + 1;
      const perfil = modelo.perfis?.find((p) => p.nome === perfisSorteados[i]);
      const caso = casosPorPosicao.get(i);
      const pais: Record<string, string> = {};
      const dadosPais: Record<string, Record<string, unknown>> = {};
      for (const rel of relacoes.filter((r) => !r.via)) {
        let pai: RegistroGerado | undefined;
        if (def.porPai?.relacao === rel.nome) pai = paisFixos[i];
        else {
          const pool = poolDe(rel.entidade);
          if (pool.length) pai = rel.modo === 'um_para_um' ? pool[i % pool.length] : rng.escolher(pool);
        }
        if (pai) { pais[rel.nome] = pai.id; dadosPais[rel.nome] = pai.dados; }
      }
      for (const rel of relacoes.filter((r) => r.via)) {
        const intermediario = porId.get(pais[rel.via!] ?? '');
        const paiId = intermediario?.pais[rel.nome];
        const pai = paiId ? porId.get(paiId) : undefined;
        if (pai) { pais[rel.nome] = pai.id; dadosPais[rel.nome] = pai.dados; }
      }
      const dados: Record<string, unknown> = {};
      anexarPais(dados, dadosPais);
      const ctx: CtxGerador = {
        rng,
        entrada: dados,
        referencia: e.dataReferencia,
        indice,
        anteriores: lista,
        vars: { var: e.variaveis, exec: execucao, ref: e.dataReferencia, indice },
      };
      await gerarCampos(camposEfetivos(modelo, perfil, caso), dados, ctx, unicos, !caso);

      const avisosReg: string[] = [];
      for (const regra of modelo.regras ?? []) {
        if (caso?.quebra === regra.nome) continue;
        let ok: unknown;
        try {
          ok = await avaliar(regra.expr, dados, ctx.vars);
        } catch (err) {
          avisosReg.push(`Regra ${regra.nome}: ${(err as Error).message}`);
          continue;
        }
        if (!ok) avisosReg.push(`Regra ${regra.nome}: ${regra.mensagem}`);
      }
      for (const c of modelo.campos) {
        if (c.obrigatorio && obter(dados, c.nome) === undefined && !caso) avisosReg.push(`Campo obrigatório vazio: ${c.nome}`);
      }

      let rotulo = `${modelo.rotulo} ${indice}`;
      if (modelo.rotuloRegistro) {
        try { rotulo = String(await renderizar(modelo.rotuloRegistro, dados, ctx.vars)) || rotulo; } catch { /* mantém o padrão */ }
      }
      const reg: RegistroGerado = {
        id: `${e.codigoExecucao}:${nome}:${indice}`,
        entidade: nome,
        indice,
        ordem: posicao,
        rotulo,
        perfil: perfil?.nome,
        caso: caso?.id,
        pais,
        dados: JSON.parse(JSON.stringify(dados)),
        esperado: escolherMaisEspecifico<Esperado>(caso?.esperado, perfil?.esperado, modelo.esperado) ?? ESPERADO_PADRAO,
        conferencia: escolherMaisEspecifico<Conferencia>(caso?.conferencia, perfil?.conferencia, modelo.conferencia),
        avisos: avisosReg,
      };
      lista.push(reg);
      porId.set(reg.id, reg);
      todos.push(reg);
    }
  }
  return { registros: todos, avisos };
}

// Gera um registro de exemplo de um modelo isolado (para o editor de modelos).
export async function exemploDeModelo(
  modelo: ModeloEntidade, modelos: ModeloEntidade[], variaveis: Record<string, unknown>, semente = 1,
): Promise<RegistroGerado[]> {
  const nomes = new Set<string>();
  const coletar = (m: ModeloEntidade) => {
    if (nomes.has(m.nome)) return;
    for (const r of m.relacoes ?? []) {
      const pai = modelos.find((x) => x.nome === r.entidade);
      if (pai && !r.via) coletar(pai);
    }
    nomes.add(m.nome);
  };
  coletar(modelo);
  const { registros } = await gerarMassa({
    modelos,
    cenario: { entidades: [...nomes].map((nome) => ({ entidade: nome, quantidade: nome === modelo.nome ? 3 : 1 })) },
    semente,
    dataReferencia: new Date().toISOString().slice(0, 10),
    codigoExecucao: 'EXEMPLO',
    variaveis,
  });
  return registros.filter((r) => r.entidade === modelo.nome);
}
