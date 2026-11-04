// POC da apuração assistida (proposta v4.3): o cliente e a competência, as notas dele, o envio sob demanda,
// o barramento dos dois entes emulados (Comitê Gestor no IBS, Receita Federal na CBS) e os envios. O relógio é o dia
// simulado da POC.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { baixar, del, get, post, put } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { useSessao } from '../sessao.tsx';
import { Abas, Cabecalho, CaixaErro, Campo, Carregando, Gaveta, Json, Metodo, Modal, Painel, SeloStatusHttp, Vazio, copiar, numero, quando, useAcao, useAvisos, useCarregar } from '../ui.tsx';

// ---------------------------------------------------------------- formatos e selos

export const diaBr = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
export const moeda = (v?: number | null) => (v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const competenciaBr = (c: string) => `${c.slice(5, 7)}/${c.slice(0, 4)}`;

export const ROTULO_PAPEL_NOTA: Record<string, string> = { adquirente: 'Entrada', fornecedor: 'Saída' };
export const ROTULO_FINALIDADE: Record<string, string> = { normal: 'Normal', complementar: 'Complementar', ajuste: 'Ajuste', devolucao: 'Devolução' };

const SITUACAO_EVENTO: Record<string, [string, string, string]> = {
  planejado: ['Planejado', 'info', 'Sai quando o relógio fechar o dia dele.'],
  disponivel: ['Disponível', 'destaque', 'No arquivo do ente (o Delta do IBS ou a base da CBS), ainda sem aviso aceito pelo SplitHub.'],
  avisado: ['Avisado', 'destaque', 'O SplitHub respondeu 2xx ao aviso; falta o download.'],
  recebido: ['Recebido', 'ok', 'O SplitHub baixou o arquivo com este evento.'],
  nao_recebido: ['Não recebido', 'erro', 'O aviso falhou, ou o arquivo ou o link expirou sem download.'],
  substituido: ['Substituído', '', 'Um envio manual tornou este evento repetido; ele não sai.'],
};
export function SeloEvento({ situacao }: { situacao: string }) {
  const [t, c, d] = SITUACAO_EVENTO[situacao] ?? [situacao, '', ''];
  return <span className={`selo ${c}`} title={d}>{t}</span>;
}

const SITUACAO_SOLIC: Record<string, [string, string]> = {
  SOLICITADA: ['Solicitada', 'info'], GERADA: ['Gerada', 'info'], ENVIADA: ['Enviada', 'ok'], CANCELADA: ['Cancelada', ''], EXPIRADA: ['Expirada', 'aviso'],
};
const SeloSolicitacao = ({ s }: { s: string }) => { const [t, c] = SITUACAO_SOLIC[s] ?? [s, '']; return <span className={`selo ${c}`}>{t}</span>; };

const RESULTADO_AVISO: Record<string, [string, string]> = { ok: ['Avisado', 'ok'], erro: ['Sem 2xx', 'erro'], sem_webhook: ['Sem webhook', 'aviso'] };
export function SeloAviso({ a }: { a: { resultado?: string | null; status?: number | null; tentativas?: number | null } | null | undefined }) {
  if (!a) return <span className="dica">sem aviso</span>;
  const [t, c] = a.resultado ? RESULTADO_AVISO[a.resultado] ?? [a.resultado, ''] : ['Avisando', 'info'];
  return <span className={`selo ${c}`} title={`${a.tentativas ?? 0} tentativa(s)${a.status ? `, HTTP ${a.status}` : ''}`}>{t}{a.status ? ` · ${a.status}` : ''}</span>;
}

export const SeloAusente = () => <span className="selo aviso sem-ponto" title="Marcada como não importada pelo SplitHub: os eventos dela só saem com &quot;incluir não importadas&quot; (T08)">Fora do SplitHub</span>;

const SeloPapelNota = ({ papel }: { papel?: string | null }) => (papel ? <span className={`selo sem-ponto ${papel === 'adquirente' ? 'info' : 'destaque'}`}>{ROTULO_PAPEL_NOTA[papel]}</span> : <span className="dica">—</span>);

export const ENTE: Record<string, { sigla: string; nome: string }> = {
  ibs: { sigla: 'IBS', nome: 'Comitê Gestor emulado' },
  cbs: { sigla: 'CBS', nome: 'Receita Federal emulada' },
};
export const SeloEnte = ({ ente }: { ente: string }) => <span className="selo sem-ponto mono" title={ENTE[ente]?.nome}>{ENTE[ente]?.sigla ?? ente}</span>;

// Efeito do evento nos campos do ente (os sete do extrato no IBS; os da foto na CBS), só os que mexem.
export function efeito(valores: Record<string, number> | undefined, campos: { campo: string; rotulo: string }[]): ReactNode {
  const mexe = campos.filter((c) => valores?.[c.campo]);
  if (!mexe.length) return <span className="dica">sem efeito nos saldos</span>;
  return <span className="chip-lista">{mexe.map((c) => <span key={c.campo} className="chip mono" title={c.rotulo}>{c.campo} {valores![c.campo] > 0 ? '+' : '−'}{moeda(Math.abs(valores![c.campo]))}</span>)}</span>;
}

// Na CBS, pagamento e recolhimento não mexem na foto: viram um registro no endpoint deles.
export function efeitoDoItem(i: { ente: string; endpoint?: string; valores?: Record<string, number>; dados?: any }, catalogo: any): ReactNode {
  if (i.ente === 'cbs' && (i.endpoint === 'pagamentos' || i.endpoint === 'recolhimentos')) {
    const d = i.dados ?? {};
    return <span className="dica">registro em /{i.endpoint}{d.multa || d.juros ? `, com multa de ${moeda(d.multa)} e juros de ${moeda(d.juros)}` : ''}</span>;
  }
  return efeito(i.valores, i.ente === 'cbs' ? catalogo?.camposCbs ?? [] : catalogo?.campos ?? []);
}

export const diaCurto = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '—');
const periodoBr = (p?: [string, string] | null) => (!p ? '—' : p[0] === p[1] ? diaBr(p[0]) : `${diaCurto(p[0])} a ${diaBr(p[1])}`);

const resumoAvisoIbs = (a: any) => (a?.resultado === 'ok' ? `aceito (${a.status})` : a?.resultado === 'sem_webhook' ? 'não enviado: o SplitHub não habilitou' : `sem 2xx${a?.status ? ` (${a.status})` : ''}`);
const resumoDelta = (p: any) => {
  if (p.semDelta) return `IBS de ${diaBr(p.dia)}: sem Delta nem aviso (T06); ${numero(p.lancamentos)} lançamento(s) esperam o Arquivo Manual`;
  const nome = p.tipo === 'MANUAL' ? `Arquivo Manual ${p.idSolic}, período ${periodoBr(p.periodo)}` : `Delta ${p.idSolic} de ${diaBr(p.dia)}`;
  return `IBS, ${nome}: ${numero(p.lancamentos)} lançamento(s) em ${p.arquivos.length} arquivo(s)${p.provocado ? ` (${p.provocado.caso})` : ''}; aviso ${resumoAvisoIbs(p.aviso)}`;
};
const resumoCbs = (c: any) => {
  const ok = c.avisos.filter((a: any) => a.resultado === 'ok').length;
  return `CBS de ${diaBr(c.dia)}: ${numero(c.eventos)} evento(s); ${c.tiquetes.length
    ? `aviso sem pedido em ${c.tiquetes.map((t: any) => `/${t.endpoint}`).join(', ')} (${ok} de ${c.tiquetes.length} aceito(s))`
    : 'sem urlRetorno validada, fica para a coleta por pedido'}`;
};
const resumoFechamento = (f: any) => [...f.processados.map(resumoDelta), ...(f.cbs ?? []).map(resumoCbs)];

// ---------------------------------------------------------------- credenciais (mostradas uma vez)

interface Credencial { ente: string; url: string; clientId: string; clientSecret: string }

function CredencialUmaVez({ creds, aoFechar, rodape }: { creds: Credencial[]; aoFechar: () => void; rodape?: ReactNode }) {
  const avisar = useAvisos();
  const linha = (rotulo: string, valor: string) => (
    <><dt>{rotulo}</dt><dd><div className="linha-flex"><code className="quebra">{valor}</code><button className="botao pequeno" onClick={() => copiar(valor, avisar, `${rotulo} copiado.`)}>Copiar</button></div></dd></>
  );
  return (
    <Modal titulo={creds.length > 1 ? 'Credenciais dos entes emulados' : `Credencial do ${ENTE[creds[0].ente].nome}`} aoFechar={aoFechar} rodape={rodape ?? <button className="botao primario" onClick={aoFechar}>Já guardei</button>}>
      <div className="alerta aviso"><div>O segredo aparece só agora, como nos entes. Guarde no cofre do SplitHub da POC: o MassGen guarda só o hash.</div></div>
      {creds.map((c) => c.ente === 'cbs' ? (
        <div key={c.ente} className="pilha" style={{ gap: 8 }}>
          <h3>{ENTE.cbs.nome} (CBS)</h3>
          <dl className="kv">{linha('URL base', c.url)}{linha('client_id', c.clientId)}{linha('client_secret', c.clientSecret)}</dl>
          <p className="dica">O SplitHub da POC pede o token em /token (OAuth 2.0, client credentials) e chama as APIs de Apuração da CBS v2 com ele, como faria com a Receita Federal.</p>
        </div>
      ) : (
        <div key={c.ente} className="pilha" style={{ gap: 8 }}>
          <h3>{ENTE.ibs.nome} (IBS)</h3>
          <dl className="kv">{linha('URL base', c.url)}{linha('clientid', c.clientId)}{linha('clientsecret', c.clientSecret)}</dl>
          <p className="dica">O SplitHub da POC chama essa URL com o clientid e o clientsecret nos cabeçalhos, como faria com o Comitê Gestor.</p>
        </div>
      ))}
      <p className="dica">A aba Barramento mostra as rotas de cada ente, o que o MassGen avisou e o que o SplitHub baixou.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- lista

function NovaPoc({ aoFechar }: { aoFechar: () => void }) {
  const { navegar } = useRota();
  const acao = useAcao();
  const [f, setF] = useState({ nome: '', cnpj: '', competencia: '' });
  const [criada, setCriada] = useState<any>(null);
  const criar = async () => {
    const r = await acao.executar(() => post('/pocs', f), 'POC criada.');
    if (r) setCriada(r);
  };
  if (criada) {
    return <CredencialUmaVez creds={criada.credenciais} aoFechar={() => navegar(`/pocs/${criada.poc.id}`)} rodape={<button className="botao primario" onClick={() => navegar(`/pocs/${criada.poc.id}`)}>Já guardei, abrir a POC</button>} />;
  }
  return (
    <Modal titulo="Nova POC" aoFechar={aoFechar} rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado} onClick={criar}>Criar</button></>}>
      <CaixaErro erro={acao.erro} />
      <Campo rotulo="Nome"><input type="text" autoFocus value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} placeholder="Cliente · novembro" /></Campo>
      <Campo rotulo="CNPJ do cliente" ajuda="O raiz (8 primeiros caracteres) diz se cada nota é de entrada ou de saída. Aceita o CNPJ alfanumérico."><input type="text" value={f.cnpj} onChange={(e) => setF({ ...f, cnpj: e.target.value })} placeholder="12.345.678/0001-90" /></Campo>
      <Campo rotulo="Competência" ajuda="AAAA-MM. O relógio da POC começa no dia 1."><input type="text" value={f.competencia} onChange={(e) => setF({ ...f, competencia: e.target.value })} placeholder="2026-11" /></Campo>
      <p className="dica">Os XMLs do cliente ficam só no banco desta POC e saem com ela quando você a apagar.</p>
    </Modal>
  );
}

export function Pocs() {
  const { navegar } = useRota();
  const { usuario } = useSessao();
  const { dados, erro, carregando } = useCarregar(() => get('/pocs'), []);
  const [nova, setNova] = useState(false);
  return (
    <div className="pagina">
      <Cabecalho
        titulo="POCs da apuração assistida"
        sub="Cada POC é um cliente e uma competência. As notas dele entram aqui e o MassGen faz o papel do Comitê Gestor (IBS) e da Receita Federal (CBS) diante do SplitHub da POC: monta o barramento de cada ente, avisa e serve os arquivos."
        acoes={usuario.papel !== 'leitor' && <button className="botao primario" onClick={() => setNova(true)}>Nova POC</button>}
      />
      <CaixaErro erro={erro} />
      <Painel semPad>
        {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo="Nenhuma POC">Crie uma para importar os XMLs do cliente e emular o IBS e a CBS.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>POC</th><th>Cliente</th><th>Dia simulado</th><th className="num">Notas</th><th className="num">Eventos recebidos</th><th className="num">Pendentes</th><th>IBS</th><th>CBS</th></tr></thead>
            <tbody>{dados.map((p: any) => {
              const ev = p.eventos ?? {};
              const pendentes = (ev.disponivel ?? 0) + (ev.avisado ?? 0) + (ev.nao_recebido ?? 0);
              return (
                <tr key={p.id} className="clicavel" onClick={() => navegar(`/pocs/${p.id}`)}>
                  <td><Link para={`/pocs/${p.id}`}>{p.nome}</Link><div className="dica">{quando(p.criadoEm)}</div></td>
                  <td><span className="mono">{p.cnpjRaiz}</span><div className="dica">competência {competenciaBr(p.competencia)}</div></td>
                  <td className="nowrap">{diaBr(p.dia)}</td>
                  <td className="num">{numero(p.notas.aceitas)}<div className="dica">{numero(p.notas.entrada)} entrada · {numero(p.notas.saida)} saída</div></td>
                  <td className="num">{numero(ev.recebido)}<div className="dica">IBS {numero(p.eventosPorEnte?.ibs?.recebido)} · CBS {numero(p.eventosPorEnte?.cbs?.recebido)}</div></td>
                  <td className="num">{pendentes ? <span style={{ color: 'var(--aviso)' }}>{numero(pendentes)}</span> : '0'}{ev.planejado ? <div className="dica">{numero(ev.planejado)} planejado(s)</div> : null}</td>
                  <td>{p.ibs.habilitado ? <span className="selo ok">Habilitado</span> : <span className="selo aviso">Sem habilitação</span>}</td>
                  <td>{p.cbs.urlRetorno ? <span className="selo ok" title="O fechamento do dia avisa a urlRetorno sem pedido">Avisa sem pedido</span> : <span className="selo info" title="Sem urlRetorno validada: o SplitHub coleta por pedido">Só por pedido</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Painel>
      {nova && <NovaPoc aoFechar={() => setNova(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- detalhe

type Aba = 'notas' | 'cobertura' | 'enviar' | 'barramento' | 'envios' | 'config';

function Relogio({ poc, aoMudar }: { poc: any; aoMudar: () => void }) {
  const { usuario } = useSessao();
  const acao = useAcao();
  const avisar = useAvisos();
  const [ate, setAte] = useState('');
  const fechar = async (corpo: { ate?: string }) => {
    const r = await acao.executar(() => post(`/pocs/${poc.id}/relogio/fechar`, corpo));
    if (!r) return;
    const resumo = resumoFechamento(r);
    avisar(resumo.length ? `${r.diasFechados} dia(s) fechado(s). ${resumo.join(' · ')}` : `${r.diasFechados} dia(s) fechado(s), sem evento planejado. O relógio está em ${diaBr(r.dia)}.`);
    setAte('');
    aoMudar();
  };
  return (
    <div className="relogio" aria-label="Relógio da POC">
      <div>
        <div className="dica">Dia simulado</div><div className="relogio-dia">{diaBr(poc.dia)}</div>
        {(poc.proximos?.ibs || poc.proximos?.cbs) && <div className="dica" title="O próximo dia com evento planejado em cada ente">próximo: IBS {diaCurto(poc.proximos.ibs)} · CBS {diaCurto(poc.proximos.cbs)}</div>}
      </div>
      {usuario.papel !== 'leitor' && <>
        <button className="botao" disabled={acao.ocupado} onClick={() => fechar({})} title="Gera o Delta do IBS e muda as fotos da CBS com os eventos planejados, avisa o SplitHub e passa ao dia seguinte">Fechar o dia</button>
        <input type="date" aria-label="Fechar até" value={ate} min={poc.dia} onChange={(e) => setAte(e.target.value)} />
        <button className="botao" disabled={acao.ocupado || !ate} onClick={() => fechar({ ate })}
          title="Fecha cada dia até a data, inclusive. Na CBS, o link vale 48 horas no relógio: fechar muitos dias de uma vez pode vencer um link que o SplitHub ainda não baixou; a coleta por pedido recupera">Fechar até</button>
      </>}
    </div>
  );
}

export function PocDetalhe({ id }: { id: string }) {
  const { busca, navegar } = useRota();
  const poc = useCarregar(() => get(`/pocs/${id}`), [id]);
  const catalogo = useCarregar(() => get('/catalogo/eventos'), []);
  const [versao, setVersao] = useState(0);
  const aba = (busca.get('aba') as Aba) || 'notas';
  const mudou = () => { setVersao((v) => v + 1); poc.recarregar(true); };
  const p = poc.dados;
  if (!p) return <div className="pagina">{poc.erro ? <CaixaErro erro={poc.erro} /> : <Carregando />}</div>;
  const ev = p.eventos ?? {};
  const semSubstituidos = (e: Record<string, number> = {}) => Object.entries(e).filter(([k]) => k !== 'substituido').reduce((s, [, n]) => s + n, 0);
  const total = semSubstituidos(ev);
  const pendentes = (ev.disponivel ?? 0) + (ev.avisado ?? 0) + (ev.nao_recebido ?? 0);
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para="/pocs">POCs</Link>}
        titulo={p.nome}
        sub={<>CNPJ <span className="mono">{p.cnpj}</span> · competência {competenciaBr(p.competencia)} · {p.ibs.habilitado ? <>IBS habilitado em {quando(p.ibs.habilitadoEm)}</> : 'o SplitHub ainda não habilitou o IBS emulado'} · {p.cbs.urlRetorno ? 'CBS avisa sem pedido' : 'CBS só por pedido'}</>}
        acoes={<Relogio poc={p} aoMudar={mudou} />}
      />
      <div className="grade grade-4">
        <div className="painel numero"><div className="rot">Notas aceitas</div><div className="val">{numero(p.notas.aceitas)}</div><div className="det">{numero(p.notas.entrada)} entrada · {numero(p.notas.saida)} saída</div></div>
        <div className="painel numero"><div className="rot">De fora</div><div className="val">{numero(p.notas.fora)}</div><div className="det">com o motivo na lista</div></div>
        <div className="painel numero"><div className="rot">Eventos recebidos</div><div className="val">{numero(ev.recebido)}</div><div className="det">de {numero(total)} · IBS {numero(p.eventosPorEnte?.ibs?.recebido)} de {numero(semSubstituidos(p.eventosPorEnte?.ibs))} · CBS {numero(p.eventosPorEnte?.cbs?.recebido)} de {numero(semSubstituidos(p.eventosPorEnte?.cbs))}</div></div>
        <div className="painel numero"><div className="rot">Pendentes</div><div className="val" style={pendentes ? { color: 'var(--aviso)' } : undefined}>{numero(pendentes)}</div><div className="det">{numero(ev.planejado)} planejado(s) para os próximos dias</div></div>
      </div>
      <Abas<Aba>
        abas={[
          { id: 'notas', rotulo: 'Notas', contagem: p.notas.aceitas + p.notas.fora },
          { id: 'cobertura', rotulo: 'Cobertura' },
          { id: 'enviar', rotulo: 'Enviar eventos' },
          { id: 'barramento', rotulo: 'Barramento' },
          { id: 'envios', rotulo: 'Envios' },
          { id: 'config', rotulo: 'Configuração' },
        ]}
        ativa={aba}
        aoMudar={(a) => navegar(`/pocs/${id}?aba=${a}`, true)}
      />
      <CaixaErro erro={catalogo.erro} />
      {aba === 'notas' && <AbaNotas poc={p} catalogo={catalogo.dados} versao={versao} aoMudar={mudou} />}
      {aba === 'cobertura' && <AbaCobertura poc={p} versao={versao} aoMudar={mudou} />}
      {aba === 'enviar' && (catalogo.dados ? <AbaEnviar key={busca.get('notas') ?? ''} poc={p} catalogo={catalogo.dados} iniciais={(busca.get('notas') ?? '').split(',').filter(Boolean)} aoEnviar={mudou} /> : <Carregando />)}
      {aba === 'barramento' && <AbaBarramento poc={p} catalogo={catalogo.dados} versao={versao} aoMudar={mudou} />}
      {aba === 'envios' && <AbaEnvios poc={p} versao={versao} />}
      {aba === 'config' && <AbaConfig poc={p} aoMudar={mudou} />}
    </div>
  );
}

// ---------------------------------------------------------------- notas

const LIMITE_LOTE = 18 * 1024 * 1024; // o corpo da API aceita 25 MB, e o base64 cresce um terço

async function paraBase64(f: File): Promise<string> {
  const b = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function ResultadoImportacao({ r, aoFechar }: { r: any; aoFechar: () => void }) {
  const problemas = r.itens.filter((i: any) => i.resultado !== 'aceita' && i.resultado !== 'cancelamento');
  return (
    <div className={`alerta ${problemas.length ? 'aviso' : 'ok'}`}>
      <div className="pilha" style={{ gap: 6, flex: 1, minWidth: 0 }}>
        <div className="linha-flex">
          <strong>{numero(r.aceitas)} aceita(s), {numero(r.fora)} de fora, {numero(r.cancelamentos)} cancelamento(s), {numero(r.repetidas)} repetida(s){r.ligadas ? `; ${numero(r.ligadas)} complementar(es) ou devolução(ões) ligada(s) à original` : ''}.</strong>
          <span className="espaco" /><button className="botao fantasma pequeno" onClick={aoFechar}>Fechar</button>
        </div>
        {problemas.length > 0 && <ul>{problemas.slice(0, 50).map((i: any, k: number) => <li key={k}><span className="mono quebra">{i.nota ?? i.arquivo}</span>: {i.motivo ?? i.resultado}</li>)}</ul>}
        {problemas.length > 50 && <div className="dica">E mais {problemas.length - 50}. A lista de notas mostra o motivo de cada uma que ficou de fora.</div>}
      </div>
    </div>
  );
}

function AbaNotas({ poc, catalogo, versao, aoMudar }: { poc: any; catalogo: any; versao: number; aoMudar: () => void }) {
  const { navegar } = useRota();
  const { usuario } = useSessao();
  const acao = useAcao();
  const [filtro, setFiltro] = useState({ busca: '', papel: '', situacao: '', splithub: '' });
  const consulta = new URLSearchParams(Object.entries(filtro).filter(([, v]) => v)).toString();
  const { dados, erro, carregando, recarregar } = useCarregar(() => get(`/pocs/${poc.id}/notas${consulta ? `?${consulta}` : ''}`), [poc.id, consulta, versao]);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [resultado, setResultado] = useState<any>(null);
  const [roteiro, setRoteiro] = useState(false);
  const pode = usuario.papel !== 'leitor';

  const importar = async (lista: FileList | null) => {
    const arquivos = Array.from(lista ?? []);
    if (!arquivos.length) return;
    const tamanho = arquivos.reduce((s, f) => s + f.size, 0);
    if (tamanho > LIMITE_LOTE) { acao.executar(() => Promise.reject(new Error(`O lote tem ${(tamanho / 1048576).toFixed(1)} MB; importe até 18 MB por vez.`))); return; }
    const r = await acao.executar(async () => post(`/pocs/${poc.id}/notas`, { arquivos: await Promise.all(arquivos.map(async (f) => ({ nome: f.name, conteudo: await paraBase64(f), base64: true }))) }));
    if (r) { setResultado(r); recarregar(true); aoMudar(); }
  };
  const alternar = (id: string) => setMarcadas((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // T08: até a conferência pela API do SplitHub (etapa 4), quem diz que a nota não está lá é o operador.
  const marcarAusente = async (ausente: boolean) => {
    const r = await acao.executar(() => put(`/pocs/${poc.id}/notas/splithub`, { notaIds: [...marcadas], splithub: ausente ? 'ausente' : 'nao_conferido' }),
      ausente ? `${numero(marcadas.size)} nota(s) marcada(s) como fora do SplitHub. Elas só saem com "incluir não importadas" (T08).` : `${numero(marcadas.size)} nota(s) de volta a não conferidas no SplitHub.`);
    if (r) { recarregar(true); aoMudar(); }
  };
  const aceitas = (dados ?? []).filter((n: any) => n.situacao === 'aceita');
  const todasMarcadas = aceitas.length > 0 && aceitas.every((n: any) => marcadas.has(n.id));

  return (
    <div className="pilha">
      <CaixaErro erro={erro ?? acao.erro} />
      {resultado && <ResultadoImportacao r={resultado} aoFechar={() => setResultado(null)} />}
      <Painel
        titulo="Notas do cliente"
        acoes={pode && <label className="botao primario" style={{ cursor: 'pointer' }}>{acao.ocupado ? 'Importando…' : 'Importar XML ou ZIP'}<input type="file" accept=".xml,.zip" multiple hidden disabled={acao.ocupado} onChange={(e) => { importar(e.target.files); e.target.value = ''; }} /></label>}
        semPad
      >
        <div className="painel-corpo pilha">
          <p className="dica">Os mesmos XMLs que o SplitHub da POC importou. Entram NF-e autorizadas de produção com o grupo de IBS e CBS (D-MG-10); o resto fica de fora com o motivo. O XML de cancelamento marca a nota; a complementar e a de devolução se ligam à original.</p>
          <div className="linha-flex">
            <input type="search" placeholder="Chave, número, CNPJ ou nome" value={filtro.busca} onChange={(e) => setFiltro({ ...filtro, busca: e.target.value })} style={{ flex: '1 1 220px' }} />
            <select aria-label="Papel" value={filtro.papel} onChange={(e) => setFiltro({ ...filtro, papel: e.target.value })}><option value="">Entrada e saída</option><option value="adquirente">Entrada</option><option value="fornecedor">Saída</option></select>
            <select aria-label="Situação" value={filtro.situacao} onChange={(e) => setFiltro({ ...filtro, situacao: e.target.value })}><option value="">Aceitas e de fora</option><option value="aceita">Aceitas</option><option value="fora">De fora</option></select>
            <select aria-label="No SplitHub" value={filtro.splithub} onChange={(e) => setFiltro({ ...filtro, splithub: e.target.value })}><option value="">No SplitHub ou fora</option><option value="ausente">Fora do SplitHub (T08)</option><option value="nao_conferido">Não conferidas</option></select>
          </div>
          {pode && marcadas.size > 0 && (
            <div className="alerta info"><div className="linha-flex" style={{ flex: 1 }}>
              <strong>{numero(marcadas.size)} marcada(s)</strong><span className="espaco" />
              <button className="botao pequeno" onClick={() => setMarcadas(new Set())}>Desmarcar</button>
              <button className="botao pequeno" disabled={acao.ocupado} onClick={() => marcarAusente(true)} title="Para o T08: a nota que o SplitHub não importou">Fora do SplitHub</button>
              <button className="botao pequeno" disabled={acao.ocupado} onClick={() => marcarAusente(false)}>No SplitHub</button>
              <button className="botao pequeno" onClick={() => setRoteiro(true)}>Aplicar roteiro</button>
              <button className="botao primario pequeno" onClick={() => navegar(`/pocs/${poc.id}?aba=enviar&notas=${[...marcadas].join(',')}`)}>Enviar eventos</button>
            </div></div>
          )}
        </div>
        {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo={consulta ? 'Nenhuma nota com esse filtro' : 'Nenhuma nota importada'}>{!consulta && 'Importe os XMLs do cliente, soltos ou num ZIP.'}</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr>
              {pode && <th><input type="checkbox" aria-label="Marcar todas as aceitas" checked={todasMarcadas} onChange={() => setMarcadas(todasMarcadas ? new Set() : new Set(aceitas.map((n: any) => n.id)))} /></th>}
              <th>Nota</th><th>Papel</th><th>Contraparte</th><th>Emissão</th><th className="num">IBS · CBS</th><th>Eventos</th><th>Roteiro</th>
            </tr></thead>
            <tbody>{dados.map((n: any) => {
              const contra = n.papel === 'fornecedor' ? n.destinatario : n.emitente;
              return (
                <tr key={n.id} className={`clicavel ${marcadas.has(n.id) ? 'selecionada' : ''}`} onClick={() => navegar(`/pocs/${poc.id}/notas/${n.id}`)}>
                  {pode && <td onClick={(e) => e.stopPropagation()}>{n.situacao === 'aceita' && <input type="checkbox" aria-label={`Marcar ${n.rotulo}`} checked={marcadas.has(n.id)} onChange={() => alternar(n.id)} />}</td>}
                  <td>
                    <Link para={`/pocs/${poc.id}/notas/${n.id}`}>{n.rotulo}</Link>
                    <div className="dica mono quebra">{n.chave}</div>
                    {n.situacao === 'fora' && <div><span className="selo aviso sem-ponto" title={n.motivo}>De fora</span> <span className="dica">{n.motivo}</span></div>}
                    {n.finalidade !== 'normal' && <span className="selo sem-ponto">{ROTULO_FINALIDADE[n.finalidade] ?? n.finalidade}</span>}
                    {n.canceladaEm && <span className="selo erro sem-ponto">Cancelada</span>}
                    {n.splithub === 'ausente' && <SeloAusente />}
                  </td>
                  <td><SeloPapelNota papel={n.papel} /></td>
                  <td>{contra?.nome ?? '—'}<div className="dica mono">{contra?.doc ?? ''}</div></td>
                  <td className="nowrap">{diaBr(n.emissao?.slice(0, 10))}</td>
                  <td className="num">{moeda(n.vIbs)}<div className="dica">CBS {moeda(n.vCbs)}</div></td>
                  <td className="nowrap">{n.eventos.total ? <>
                    {numero(n.eventos.recebidos)} de {numero(n.eventos.total)} recebido(s)
                    {n.eventos.pendentes > 0 && <div className="dica" style={{ color: 'var(--aviso)' }}>{numero(n.eventos.pendentes)} pendente(s)</div>}
                    {n.eventos.planejados > 0 && <div className="dica">{numero(n.eventos.planejados)} planejado(s)</div>}
                  </> : <span className="dica">—</span>}</td>
                  <td>{n.roteiro ? <span className="selo sem-ponto mono">{n.roteiro}</span> : <span className="dica">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Painel>
      {roteiro && catalogo && <AplicarRoteiro poc={poc} catalogo={catalogo} notaIds={[...marcadas]} aoFechar={() => setRoteiro(false)} aoAplicar={() => { setRoteiro(false); setMarcadas(new Set()); recarregar(true); aoMudar(); }} />}
    </div>
  );
}

function TabelaPlano({ itens, catalogo, comDia }: { itens: any[]; catalogo: any; comDia?: boolean }) {
  return (
    <div className="tabela-wrap"><table className="tabela">
      <thead><tr><th>Nota</th>{comDia && <th>Dia</th>}<th>Ente</th><th>Evento</th><th>Origem</th><th className="num">Valor</th><th>Efeito</th></tr></thead>
      <tbody>{itens.map((i, k) => (
        <tr key={k}>
          <td className="nowrap">{i.nota}{i.relNota && <div className="dica">com {i.relNota}</div>}</td>
          {comDia && <td className="nowrap">{diaBr(i.dia)}</td>}
          <td><SeloEnte ente={i.ente} />{i.endpoint && <div className="dica mono">/{i.endpoint}</div>}</td>
          <td><span className="mono">{i.id}</span><div className="dica">{i.mov}</div></td>
          <td>{i.origem === 'pre-requisito' ? <span className="selo aviso sem-ponto" title="Entrou antes porque o tipo escolhido depende dele">Pré-requisito</span> : i.origem === 'roteiro' ? <span className="selo sem-ponto">Roteiro{i.pct ? ` · ${i.pct}%` : ''}</span> : <span className="selo info sem-ponto">Escolhido{i.pct ? ` · ${i.pct}%` : ''}</span>}{i.forcado && <span className="selo erro sem-ponto">Forçado</span>}</td>
          <td className="num">{moeda(i.valor)}</td>
          <td>{efeitoDoItem(i, catalogo)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Bloqueios({ lista }: { lista: any[] }) {
  if (!lista.length) return null;
  return (
    <div className="alerta aviso"><div>
      <strong>{numero(lista.length)} não entra(m):</strong>
      <ul>{lista.map((b, k) => <li key={k}>{b.nota}{b.id && <> · <span className="mono">{b.id}</span></>}: {b.motivo}</li>)}</ul>
    </div></div>
  );
}

function AplicarRoteiro({ poc, catalogo, notaIds, aoFechar, aoAplicar }: { poc: any; catalogo: any; notaIds: string[]; aoFechar: () => void; aoAplicar: () => void }) {
  const acao = useAcao();
  const avisar = useAvisos();
  const roteiros = catalogo.roteiros;
  const [roteiro, setRoteiro] = useState<string>(roteiros[0]?.id ?? '');
  const [intervalo, setIntervalo] = useState(1);
  const [defasagem, setDefasagem] = useState<number>(poc.defasagemCbs ?? 0);
  const [ausentes, setAusentes] = useState(false);
  const [previa, setPrevia] = useState<any>(null);
  const [erroPrevia, setErroPrevia] = useState<any>(null);
  const chave = notaIds.join(',');
  const corpo = { notaIds, roteiro, intervaloDias: intervalo, defasagem, incluirAusentes: ausentes };
  // A prévia acompanha o roteiro, o intervalo e a defasagem escolhidos.
  useEffect(() => {
    let vivo = true;
    setPrevia(null);
    post(`/pocs/${poc.id}/roteiros/previa`, { ...corpo, notaIds: chave.split(',') })
      .then((r) => { if (vivo) { setPrevia(r); setErroPrevia(null); } }, (e) => { if (vivo) setErroPrevia(e); });
    return () => { vivo = false; };
  }, [poc.id, chave, roteiro, intervalo, defasagem, ausentes]);
  const r = roteiros.find((x: any) => x.id === roteiro);
  const aplicar = async () => {
    const res = await acao.executar(() => post(`/pocs/${poc.id}/roteiros`, corpo));
    if (res) { avisar(`${roteiro}: ${numero(res.itens.length)} evento(s) planejado(s) até ${diaBr(res.ultimoDia)}. Eles saem quando o relógio fechar cada dia.`); aoAplicar(); }
  };
  return (
    <Modal titulo={`Aplicar roteiro a ${numero(notaIds.length)} nota(s)`} aoFechar={aoFechar}
      rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado || !previa?.itens.length} onClick={aplicar}>Planejar {previa ? numero(previa.itens.length) : ''} evento(s)</button></>}>
      <CaixaErro erro={acao.erro ?? erroPrevia} />
      <div className="grade grade-2">
        <Campo rotulo="Roteiro" ajuda={r ? [r.historia, ...(['ibs', 'cbs'] as const).filter((e) => r[e].length).map((e) => `${ENTE[e].sigla}: ${r[e].map((p: any) => `${p.tipo}${p.pct ? ` (${p.pct}%)` : ''}`).join(' → ')}`)].join('. ') : undefined}>
          <select value={roteiro} onChange={(e) => setRoteiro(e.target.value)}>
            <optgroup label="Nota de entrada">{roteiros.filter((x: any) => x.lado === 'adquirente').map((x: any) => <option key={x.id} value={x.id}>{x.id} · {x.historia}</option>)}</optgroup>
            <optgroup label="Nota de saída">{roteiros.filter((x: any) => x.lado === 'fornecedor').map((x: any) => <option key={x.id} value={x.id}>{x.id} · {x.historia}</option>)}</optgroup>
          </select>
        </Campo>
        <Campo rotulo="Dias entre um passo e o seguinte" ajuda={`O primeiro passo cai em ${diaBr(poc.dia)} ou na emissão, o que vier depois.`}>
          <input type="number" min={0} max={30} value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))} />
        </Campo>
        <Campo rotulo="Defasagem da CBS, em dias" ajuda="Positivo: a CBS começa tantos dias depois do IBS; negativo: antes. Zero: os dois entes no mesmo dia. O padrão vem da configuração da POC.">
          <input type="number" min={-30} max={30} value={defasagem} onChange={(e) => setDefasagem(Number(e.target.value))} />
        </Campo>
      </div>
      <label className="check"><input type="checkbox" checked={ausentes} onChange={(e) => setAusentes(e.target.checked)} /> Incluir não importadas: as notas marcadas como fora do SplitHub entram também (T08)</label>
      <p className="dica">Só nas notas sem evento nos entes do roteiro. Com a defasagem, o ente que vem depois começa mais tarde; se um deles não couber, a nota fica de fora inteira. RT-A7, RT-A8, RT-A9 e RT-F8 só têm CBS. Se depois você enviar sob demanda um tipo que o roteiro já planejou, o planejado vira substituído.</p>
      {!previa && !erroPrevia ? <Carregando texto="Montando a prévia…" /> : previa && <>
        <Bloqueios lista={previa.bloqueios} />
        {previa.itens.length > 0 && <TabelaPlano itens={previa.itens} catalogo={catalogo} comDia />}
      </>}
    </Modal>
  );
}

// ---------------------------------------------------------------- plano e cobertura (seção 08; D-MG-04 a D-MG-06)

const COR_SITUACAO_TIPO = (s: string) =>
  s === 'coberto' ? 'ok' : s === 'não recebido' ? 'erro' : s === 'não baixado' || s.startsWith('disponível') ? 'destaque' : s.startsWith('planejado') ? 'info' : s.startsWith('falta') ? 'aviso' : '';
const SeloSituacaoTipo = ({ s }: { s: string }) => <span className={`selo ${COR_SITUACAO_TIPO(s)}`}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>;

const MOTIVO_PLANO: Record<string, string> = {
  feliz: 'caminho feliz: não acrescenta tipo novo',
  caso: 'caminho feliz, com dois passos do IBS no mesmo dia, para o T05 e o T07',
};

function Faltam({ lista }: { lista: { texto: string }[] }) {
  if (!lista.length) return null;
  return (
    <div className="alerta aviso"><div>
      <strong>O lote não cobre tudo; nenhuma nota é inventada (D-MG-05):</strong>
      <ul>{lista.map((f, k) => <li key={k}>{f.texto}</li>)}</ul>
    </div></div>
  );
}

function MontarPlano({ poc, refazer: refazerInicial, aoFechar, aoAplicar }: { poc: any; refazer: boolean; aoFechar: () => void; aoAplicar: () => void }) {
  const acao = useAcao();
  const avisar = useAvisos();
  const [refazer, setRefazer] = useState(refazerInicial);
  const [intervalo, setIntervalo] = useState(1);
  const [defasagem, setDefasagem] = useState<number>(poc.defasagemCbs ?? 0);
  const [previa, setPrevia] = useState<any>(null);
  const [erroPrevia, setErroPrevia] = useState<any>(null);
  const corpo = { refazer, intervaloDias: intervalo, defasagem };
  // A prévia roda o mesmo plano no banco e desfaz: o que ela mostra é o que o botão grava.
  useEffect(() => {
    let vivo = true;
    setPrevia(null);
    setErroPrevia(null);
    post(`/pocs/${poc.id}/plano/previa`, corpo).then((r) => { if (vivo) setPrevia(r); }, (e) => { if (vivo) setErroPrevia(e); });
    return () => { vivo = false; };
  }, [poc.id, refazer, intervalo, defasagem]);
  const aplicar = async () => {
    const r = await acao.executar(() => post(`/pocs/${poc.id}/plano`, corpo));
    if (r) { avisar(`Plano ${refazer ? 'refeito' : 'montado'}: ${numero(r.notas)} nota(s) em ${numero(r.envios.length)} envio(s), ${numero(r.eventos)} evento(s). Eles saem quando o relógio fechar cada dia.`); aoAplicar(); }
  };
  const c = previa?.cobertura;
  const tipos = c ? c.porEnte.ibs.meta + c.porEnte.cbs.meta : 0;
  const comNota = c ? [...c.ibs, ...c.cbs].filter((l: any) => l.notas > 0).length : 0;
  return (
    <Modal titulo={refazer ? 'Refazer o plano de cobertura' : 'Montar o plano de cobertura'} aoFechar={aoFechar}
      rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado || !previa || (!previa.envios.length && !previa.liberadas.notas)} onClick={aplicar}>{refazer ? 'Refazer' : 'Planejar'} {previa ? numero(previa.eventos) : ''} evento(s)</button></>}>
      <CaixaErro erro={acao.erro ?? erroPrevia} />
      <div className="grade grade-2">
        <Campo rotulo="Dias entre um passo e o seguinte"><input type="number" min={0} max={30} value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))} /></Campo>
        <Campo rotulo="Defasagem da CBS, em dias" ajuda="Positivo: a CBS começa depois do IBS; negativo: antes.">
          <input type="number" min={-30} max={30} value={defasagem} onChange={(e) => setDefasagem(Number(e.target.value))} />
        </Campo>
      </div>
      <label className="check"><input type="checkbox" checked={refazer} onChange={(e) => setRefazer(e.target.checked)} /> Refazer: as notas que só têm eventos planejados por roteiro voltam a ficar livres e entram no plano de novo</label>
      <p className="dica">O plano cobre primeiro os tipos que faltam (D-MG-04): as notas com cancelamento, complementar ou devolução vão antes, porque só elas abrem certos tipos; a nota que não acrescenta tipo novo segue o caminho feliz. As notas marcadas como fora do SplitHub só entram com o T08 ligado. Depois, troque o roteiro de qualquer nota na página dela.</p>
      {!previa && !erroPrevia ? <Carregando texto="Montando a prévia…" /> : previa && <>
        <div className="alerta info"><div>
          <strong>{numero(previa.notas)} nota(s) em {numero(previa.envios.length)} envio(s), {numero(previa.eventos)} evento(s).</strong> Com o plano, {numero(comNota)} dos {numero(tipos)} tipos dos dois entes têm nota.
          {previa.liberadas.notas > 0 && <> {numero(previa.liberadas.notas)} nota(s) liberada(s): {numero(previa.liberadas.eventos)} evento(s) planejado(s) viram substituídos.</>}
        </div></div>
        <Faltam lista={c.faltam} />
        {previa.semPlano.length > 0 && <Bloqueios lista={previa.semPlano} />}
        {!previa.envios.length && <Vazio titulo="Nenhuma nota livre">Todas as notas já têm roteiro ou eventos.{!refazer && ' Marque Refazer para liberar as que só têm eventos planejados.'}</Vazio>}
        {previa.envios.length > 0 && (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Roteiro</th><th>Início</th><th className="num">Eventos</th><th>Notas e o que cada uma acrescenta</th></tr></thead>
            <tbody>{previa.envios.map((e: any, k: number) => (
              <tr key={k}>
                <td><span className="selo sem-ponto mono">{e.roteiro}</span><div className="dica">{e.historia}</div></td>
                <td className="nowrap">{diaBr(e.inicio)}<div className="dica">{numero(e.intervalo)} dia(s) entre passos</div></td>
                <td className="num">{numero(e.eventos)}</td>
                <td><div className="pilha" style={{ gap: 4 }}>{e.notas.map((n: any) => (
                  <div key={n.id}>{n.rotulo}: {n.motivo === 'cobre' ? <span className="chip-lista">{n.novos.map((t: string) => <span key={t} className="chip mono">{t}</span>)}</span> : <span className="dica">{MOTIVO_PLANO[n.motivo]}</span>}</div>
                ))}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </>}
    </Modal>
  );
}

function TabelaTipos({ pocId, linhas }: { pocId: string; linhas: any[] }) {
  return (
    <div className="tabela-wrap"><table className="tabela">
      <thead><tr><th>Tipo</th><th className="num">Notas no plano</th><th className="num">Avisado</th><th className="num">Recebido</th><th>Situação</th></tr></thead>
      <tbody>{linhas.map((l) => (
        <tr key={l.id}>
          <td><span className="mono">{l.id}</span> {l.mov}<div className="dica">{l.grupo}{l.roteiros.length ? ` · ${l.roteiros.join(', ')}` : ''}</div></td>
          <td className="num">{numero(l.notas)}{l.exemplos.length > 0 && <div className="dica">{l.exemplos.map((e: any, k: number) => <span key={e.id}>{k ? ', ' : ''}<Link para={`/pocs/${pocId}/notas/${e.id}`}>{e.rotulo}</Link></span>)}</div>}</td>
          <td className="num">{numero(l.avisado)}</td>
          <td className="num">{numero(l.recebido)}</td>
          <td><SeloSituacaoTipo s={l.situacao} />{l.falta && <div className="dica">precisa de {l.falta}</div>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

// O selo já diz armado, provocado ou à espera, e a coluna do SplitHub já diz o que fecha o caso: sobra o meio caminho
// do T09 e onde o MassGen ainda vai provocar.
const detalheCaso = (s: string) => s.split(' · ').filter((p) => !/^(armado|provocado|espera o SplitHub|coberto$|desligado$)/.test(p)).join(' · ');

function TabelaCasos({ poc, casos, leitor, aoMudar }: { poc: any; casos: any[]; leitor: boolean; aoMudar: () => void }) {
  const acao = useAcao();
  const definir = async (c: any, corpo: { ligado?: boolean; rearmar?: boolean }, msg: string) => {
    if ((await acao.executar(() => put(`/pocs/${poc.id}/casos/${c.id}`, corpo), msg)) !== undefined) aoMudar();
  };
  const selo = (c: any) => c.coberto ? ['ok', 'Coberto'] : !c.ligado ? ['', 'Desligado'] : c.armado.length ? ['info', 'Armado'] : c.provocacoes.length ? ['aviso', 'Provocado'] : ['aviso', 'Espera o SplitHub'];
  return <>
    <CaixaErro erro={acao.erro} />
    <div className="tabela-wrap"><table className="tabela">
      <thead><tr><th>Caso</th><th>Ente</th><th>O SplitHub precisa</th><th>O MassGen</th><th>Situação</th>{!leitor && <th>Ações</th>}</tr></thead>
      <tbody>{casos.map((c) => {
        const [cor, rotulo] = selo(c);
        return (
          <tr key={c.id}>
            <td><span className="mono">{c.id}</span> {c.nome}</td>
            <td className="nowrap">{c.ente === 'ambos' ? <><SeloEnte ente="ibs" /> <SeloEnte ente="cbs" /></> : <SeloEnte ente={c.ente} />}</td>
            <td>{c.espera}<div className="dica">Fecha com: {c.comoFechar}</div></td>
            <td className="dica">{c.provoca}{c.provocacoes.length > 0 && <div>Provocado: {c.provocacoes.map((p: any) => `${ENTE[p.ente].sigla} em ${diaCurto(p.dia)}`).join(', ')}</div>}</td>
            <td><span className={`selo ${cor}`}>{rotulo}</span>{detalheCaso(c.situacao) && <div className="dica">{detalheCaso(c.situacao)}</div>}</td>
            {!leitor && <td><div className="linha-flex">
              <label className="check"><input type="checkbox" checked={c.ligado} disabled={acao.ocupado} onChange={(e) => definir(c, { ligado: e.target.checked }, `${c.id} ${e.target.checked ? 'ligado: entra na meta' : 'desligado: sai da meta'}.`)} /> Ligado</label>
              {c.ligado && c.arma.length > 0 && <button className="botao pequeno" disabled={acao.ocupado || c.armado.length === c.arma.length} onClick={() => definir(c, { rearmar: true }, `${c.id} armado de novo: o MassGen provoca na próxima oportunidade.`)}>Provocar de novo</button>}
            </div></td>}
          </tr>
        );
      })}</tbody>
    </table></div>
  </>;
}

type SubCobertura = 'ibs' | 'cbs' | 'casos';

function AbaCobertura({ poc, versao, aoMudar }: { poc: any; versao: number; aoMudar: () => void }) {
  const { usuario } = useSessao();
  const leitor = usuario.papel === 'leitor';
  const { dados, erro, recarregar } = useCarregar(() => get(`/pocs/${poc.id}/cobertura`), [poc.id, versao], 5000);
  const [sub, setSub] = useState<SubCobertura>('ibs');
  const [plano, setPlano] = useState<{ refazer: boolean } | null>(null);
  if (!dados) return erro ? <CaixaErro erro={erro} /> : <Carregando />;
  const d = dados;
  const naoLigados = d.casos.filter((c: any) => !c.ligado).length;
  const noPlano = [...d.ibs, ...d.cbs].filter((l: any) => !l.coberto && l.notas > 0).length + d.casos.filter((c: any) => c.ligado && !c.coberto).length;
  const pct = (n: number) => `${d.meta ? (100 * n) / d.meta : 0}%`;
  const fracao = (e: { meta: number; recebidos: number }) => `${numero(e.recebidos)}/${numero(e.meta)}`;
  const mudou = () => { recarregar(true); aoMudar(); };
  return (
    <div className="pilha">
      <CaixaErro erro={erro} />
      <Painel titulo="Cobertura da POC" acoes={!leitor && <>
        <button className="botao pequeno" onClick={() => setPlano({ refazer: true })}>Refazer plano</button>
        <button className="botao primario pequeno" onClick={() => setPlano({ refazer: false })}>Montar plano</button>
      </>}>
        <div className="pilha">
          <div className="linha-flex">
            <strong className="cobertura-total">{numero(d.recebidos)} de {numero(d.meta)} tipos recebidos</strong>
            <span className="dica">IBS {fracao(d.porEnte.ibs)} · CBS {fracao(d.porEnte.cbs)} · transporte e falha {fracao(d.porEnte.casos)}</span>
          </div>
          <div className="progresso" role="progressbar" aria-label="Tipos recebidos" aria-valuemin={0} aria-valuemax={d.meta} aria-valuenow={d.recebidos}>
            <span className="ok" style={{ width: pct(d.recebidos) }} /><span className="neutro" style={{ width: pct(noPlano) }} />
          </div>
          <div className="dica">Verde: o SplitHub baixou um arquivo com o tipo. Cinza: o tipo está no plano ou à espera do SplitHub. O tipo conta quando chega a pelo menos uma nota.</div>
          <dl className="kv">
            <dt>Notas livres</dt><dd>{numero(d.notasLivres)} <span className="dica">sem roteiro nem evento, prontas para o plano</span></dd>
            <dt>Próximo dia planejado</dt><dd>IBS {diaBr(d.proximos.ibs)} · CBS {diaBr(d.proximos.cbs)}</dd>
            <dt>Defasagem da CBS</dt><dd>{d.defasagem ? `${d.defasagem > 0 ? '+' : ''}${d.defasagem} dia(s)` : 'nenhuma: os dois entes no mesmo dia'} <span className="dica">o padrão fica na Configuração</span></dd>
          </dl>
          {naoLigados > 0 && <div className="alerta info"><div>{numero(naoLigados)} dos {numero(d.porEnte.casos.catalogo)} casos de transporte e falha estão desligados e ficam fora da meta. Ligue-os na aba Transporte e falha para a meta chegar a {numero(d.porEnte.ibs.meta + d.porEnte.cbs.meta + d.porEnte.casos.catalogo)}.</div></div>}
          <Faltam lista={d.faltam} />
          <p className="dica">Feche os dias no relógio, lá em cima, para os eventos planejados saírem. O plano não chama o SplitHub: os entes emulados avisam, e o tipo só conta quando o SplitHub baixa.</p>
        </div>
      </Painel>
      <Abas<SubCobertura>
        abas={[
          { id: 'ibs', rotulo: 'IBS', contagem: fracao(d.porEnte.ibs) },
          { id: 'cbs', rotulo: 'CBS', contagem: fracao(d.porEnte.cbs) },
          { id: 'casos', rotulo: 'Transporte e falha', contagem: fracao(d.porEnte.casos) },
        ]}
        ativa={sub}
        aoMudar={setSub}
      />
      <Painel semPad>
        {sub === 'ibs' && <TabelaTipos pocId={poc.id} linhas={d.ibs} />}
        {sub === 'cbs' && <TabelaTipos pocId={poc.id} linhas={d.cbs} />}
        {sub === 'casos' && <TabelaCasos poc={poc} casos={d.casos} leitor={leitor} aoMudar={mudou} />}
      </Painel>
      {plano && <MontarPlano poc={poc} refazer={plano.refazer} aoFechar={() => setPlano(null)} aoAplicar={() => { setPlano(null); mudou(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- envio sob demanda (T-MG-03)

interface Escolha { pct: string; valor: string }

function AbaEnviar({ poc, catalogo, iniciais, aoEnviar }: { poc: any; catalogo: any; iniciais: string[]; aoEnviar: () => void }) {
  const { usuario } = useSessao();
  const acao = useAcao();
  const notas = useCarregar(() => get(`/pocs/${poc.id}/notas?situacao=aceita`), [poc.id]);
  const [busca, setBusca] = useState('');
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set(iniciais));
  const [tipos, setTipos] = useState<Map<string, Escolha>>(new Map());
  const [forcar, setForcar] = useState(false);
  const [ausentes, setAusentes] = useState(false);
  const [previa, setPrevia] = useState<any>(null);
  const [feito, setFeito] = useState<any>(null);
  const root = usuario.papel === 'root';
  const leitor = usuario.papel === 'leitor';

  // Os tipos por ente e, dentro de cada um, pelo grupo do catálogo.
  const porEnte = useMemo(() => (['ibs', 'cbs'] as const).map((ente) => {
    const m = new Map<string, any[]>();
    for (const t of catalogo[ente] ?? []) m.set(t.grupo, [...(m.get(t.grupo) ?? []), { ...t, ente }]);
    return { ente, total: (catalogo[ente] ?? []).length, grupos: [...m] };
  }), [catalogo]);
  const visiveis = (notas.dados ?? []).filter((n: any) => !busca || `${n.rotulo} ${n.chave} ${n.emitente?.nome ?? ''} ${n.destinatario?.nome ?? ''}`.toLowerCase().includes(busca.toLowerCase()));
  const invalidar = () => { setPrevia(null); setFeito(null); };
  const alternarNota = (id: string) => { invalidar(); setMarcadas((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const alternarTipo = (n: string) => { invalidar(); setTipos((m) => { const x = new Map(m); if (x.has(n)) x.delete(n); else x.set(n, { pct: '', valor: '' }); return x; }); };
  const ajustar = (n: string, campo: keyof Escolha, v: string) => { invalidar(); setTipos((m) => new Map(m).set(n, { ...m.get(n)!, [campo]: v })); };
  const corpo = () => ({
    notaIds: [...marcadas], forcar, incluirAusentes: ausentes,
    tipos: [...tipos].map(([tipo, e]) => ({ tipo, pct: e.pct || undefined, valor: forcar && e.valor ? Number(e.valor.replace(',', '.')) : undefined })),
  });
  const revisar = async () => { const r = await acao.executar(() => post(`/pocs/${poc.id}/envios/previa`, corpo())); if (r) setPrevia(r); };
  const executar = async () => {
    const r = await acao.executar(() => post(`/pocs/${poc.id}/envios`, corpo()), 'Eventos enviados.');
    if (r) { setFeito(r); setPrevia(null); notas.recarregar(true); aoEnviar(); }
  };

  if (leitor) return <div className="alerta info"><div>O envio sob demanda é de root e operador. O histórico de cada nota mostra o que já saiu.</div></div>;
  return (
    <div className="pilha">
      <CaixaErro erro={acao.erro ?? notas.erro} />
      {feito && (
        <div className="alerta ok"><div className="pilha" style={{ gap: 4 }}>
          <strong>Envio nº {feito.envio.numero}: {numero(feito.itens.filter((i: any) => i.ente === 'ibs').length)} evento(s) do IBS e {numero(feito.itens.filter((i: any) => i.ente === 'cbs').length)} da CBS{feito.envio.substituidos ? `; ${numero(feito.envio.substituidos)} planejado(s) do roteiro viraram substituídos` : ''}.</strong>
          {resumoFechamento(feito.fechamento).map((t, k) => <div key={k}>{t}.</div>)}
          <div className="dica">O relógio passou para {diaBr(feito.fechamento.dia)}. O histórico de cada nota mostra o recebimento quando o SplitHub baixar o arquivo.</div>
        </div></div>
      )}
      <div className="lado-a-lado">
        <Painel titulo={`1. Notas (${numero(marcadas.size)})`} acoes={marcadas.size > 0 && <button className="botao fantasma pequeno" onClick={() => { invalidar(); setMarcadas(new Set()); }}>Desmarcar</button>}>
          <div className="pilha">
            <input type="search" placeholder="Filtrar por número, chave ou nome" value={busca} onChange={(e) => setBusca(e.target.value)} />
            {notas.carregando && !notas.dados ? <Carregando /> : !visiveis.length ? <Vazio titulo="Nenhuma nota aceita">Importe os XMLs na aba Notas.</Vazio> : (
              <div className="lista-rolavel">{visiveis.map((n: any) => (
                <label key={n.id} className={`opcao ${marcadas.has(n.id) ? 'marcada' : ''}`}>
                  <input type="checkbox" checked={marcadas.has(n.id)} onChange={() => alternarNota(n.id)} />
                  <span className="opcao-texto"><strong>{n.rotulo}</strong> <SeloPapelNota papel={n.papel} />{n.finalidade !== 'normal' && <span className="selo sem-ponto">{ROTULO_FINALIDADE[n.finalidade]}</span>}{n.canceladaEm && <span className="selo erro sem-ponto">Cancelada</span>}{n.splithub === 'ausente' && <SeloAusente />}
                    <span className="dica"> IBS {moeda(n.vIbs)} · CBS {moeda(n.vCbs)} · {numero(n.eventos.total)} evento(s)</span></span>
                </label>
              ))}</div>
            )}
          </div>
        </Painel>
        <Painel titulo={`2. Tipos de evento (${numero(tipos.size)})`} acoes={tipos.size > 0 && <button className="botao fantasma pequeno" onClick={() => { invalidar(); setTipos(new Map()); }}>Desmarcar</button>}>
          <div className="pilha">
            <p className="dica">Os 24 do IBS (MOC v1.10) e os 26 da CBS (APIs de Apuração v2). O que falta antes de um tipo escolhido entra sozinho, como pré-requisito. O valor sai do saldo da operação no IBS e da foto do documento na CBS; nos parciais, informe o percentual.</p>
            <div className="lista-rolavel">{porEnte.map(({ ente, total, grupos }) => (
              <div key={ente} className="pilha" style={{ gap: 8 }}>
                <h3>{ENTE[ente].sigla} · {ENTE[ente].nome} <span className="dica">{numero(total)} tipos</span></h3>
                {grupos.map(([g, ts]) => (
                  <div key={g} className="pilha" style={{ gap: 4 }}>
                    <div className="rotulo">{g}</div>
                    {ts.map((t: any) => {
                      const e = tipos.get(t.id);
                      return (
                        <div key={t.id} className={`opcao ${e ? 'marcada' : ''}`}>
                          <input type="checkbox" id={`tipo-${t.id}`} checked={!!e} onChange={() => alternarTipo(t.id)} />
                          <label htmlFor={`tipo-${t.id}`} className="opcao-texto">
                            <span className="mono">{t.id}</span> {t.mov}
                            <span className="dica"> · {t.lado === 'ambos' ? 'entrada e saída' : ROTULO_PAPEL_NOTA[t.lado].toLowerCase()}{t.endpoint ? ` · /${t.endpoint}` : ''}{t.relacionada === 'ajuste' ? ' · com a complementar, a devolução ou o cancelamento' : t.relacionada ? ` · com a nota ${t.relacionada === 'cancelamento' ? 'cancelada' : t.relacionada === 'complementar' ? 'complementar' : 'de devolução'}` : ''}</span>
                            {t.nota && <span className="dica" style={{ display: 'block' }}>{t.nota}</span>}
                          </label>
                          {e && (t.parcial || forcar) && (
                            <span className="opcao-extra">
                              {t.parcial && <input type="number" min={1} max={100} placeholder="100" aria-label={`Percentual de ${t.id}`} value={e.pct} onChange={(x) => ajustar(t.id, 'pct', x.target.value)} />}
                              {t.parcial && <span className="dica">%</span>}
                              {forcar && <input type="text" inputMode="decimal" placeholder="valor" aria-label={`Valor forçado de ${t.id}`} value={e.valor} onChange={(x) => ajustar(t.id, 'valor', x.target.value)} />}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}</div>
          </div>
        </Painel>
      </div>
      <Painel titulo="3. Revisar e enviar">
        <div className="pilha">
          <p>Os eventos saem com a data do relógio, <strong>{diaBr(poc.dia)}</strong>. Executar fecha esse dia na hora (D-MG-14): no IBS, o Delta do dia é gerado e o webhook é avisado; na CBS, as fotos mudam e, com a urlRetorno validada, o SplitHub recebe o aviso sem pedido (sem ela, coleta por pedido). Depois o relógio passa ao dia seguinte.</p>
          {root && (
            <label className="check"><input type="checkbox" checked={forcar} onChange={(e) => { invalidar(); setForcar(e.target.checked); }} /> Forçar: ignora a ordem, a unicidade, o saldo e a data, para testar a reação do SplitHub a um barramento fora da regra</label>
          )}
          <label className="check"><input type="checkbox" checked={ausentes} onChange={(e) => { invalidar(); setAusentes(e.target.checked); }} /> Incluir não importadas: as notas marcadas como fora do SplitHub saem também, para o SplitHub gravar o movimento e abrir a inconsistência (T08)</label>
          {forcar && <div className="alerta erro"><div>O envio forçado sai como está, inclusive repetido ou sem saldo. Fica marcado como forçado no histórico e na trilha.</div></div>}
          <div className="linha-flex">
            <button className="botao" disabled={acao.ocupado || !marcadas.size || !tipos.size} onClick={revisar}>Revisar</button>
            <button className="botao primario" disabled={acao.ocupado || !previa?.itens.length} onClick={executar}>{acao.ocupado ? 'Enviando…' : `Executar e enviar${previa ? ` ${numero(previa.itens.length)} evento(s)` : ''}`}</button>
            {!previa && marcadas.size > 0 && tipos.size > 0 && <span className="dica">Revise antes: a prévia mostra o que entra, o que entra como pré-requisito e o que não cabe.</span>}
          </div>
          {previa && <>
            <Bloqueios lista={previa.bloqueios} />
            {previa.itens.length ? <TabelaPlano itens={previa.itens} catalogo={catalogo} /> : <Vazio titulo="Nada a enviar">Nenhum evento coube nas notas marcadas.</Vazio>}
          </>}
        </div>
      </Painel>
    </div>
  );
}

// ---------------------------------------------------------------- barramento

function GavetaArquivo({ pocId, arquivoId, aoFechar }: { pocId: string; arquivoId: string; aoFechar: () => void }) {
  const acao = useAcao();
  const { dados, erro } = useCarregar(() => get(`/pocs/${pocId}/arquivos/${arquivoId}`), [arquivoId]);
  return (
    <Gaveta titulo={dados?.nome ?? 'Arquivo'} sub={dados && `idArq ${dados.idArq} · gerado ${dados.geradoEm}`} aoFechar={aoFechar}
      acoes={<button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/pocs/${pocId}/arquivos/${arquivoId}?baixar=zip`))}>Baixar ZIP</button>}>
      <CaixaErro erro={erro ?? acao.erro} />
      {!dados ? <Carregando /> : <>
        <dl className="kv"><dt>SHA-256 do ZIP</dt><dd className="mono">{dados.hash}</dd><dt>Tamanho</dt><dd>{numero(dados.tamanho)} bytes</dd></dl>
        <p className="dica">O JSON de dentro do ZIP, no leiaute do Anexo I. É o mesmo que o SplitHub baixa pelo Obter Arquivo; baixar por aqui não conta como recebimento.</p>
        <Json valor={dados.conteudo} alturaMax={520} />
      </>}
    </Gaveta>
  );
}

function GavetaAviso({ pocId, avisoId, aoFechar, aoReenviar }: { pocId: string; avisoId: string; aoFechar: () => void; aoReenviar: () => void }) {
  const { usuario } = useSessao();
  const acao = useAcao();
  const { dados, erro, recarregar } = useCarregar(() => get(`/pocs/${pocId}/avisos/${avisoId}`), [avisoId]);
  const reenviar = async () => {
    const r = await acao.executar(() => post(`/pocs/${pocId}/avisos/${avisoId}/reenviar`));
    if (r) { recarregar(true); aoReenviar(); }
  };
  const cbs = dados?.ente === 'cbs';
  return (
    <Gaveta titulo={cbs ? 'Aviso na urlRetorno do SplitHub (CBS)' : 'Aviso ao webhook do SplitHub (IBS)'} sub={dados && `${quando(dados.em)}${dados.por ? ` · ${dados.por}` : ''}`} aoFechar={aoFechar}
      acoes={usuario.papel !== 'leitor' && <button className="botao pequeno" disabled={acao.ocupado} onClick={reenviar} title={cbs ? 'Repete o mesmo aviso, com o mesmo tíquete e o mesmo link; nenhum evento novo' : 'Repete o mesmo aviso, com o mesmo arquivo; nenhum evento novo'}>Reenviar aviso</button>}>
      <CaixaErro erro={erro ?? acao.erro} />
      {!dados ? <Carregando /> : <>
        <dl className="kv">
          <dt>Resultado</dt><dd><SeloAviso a={dados} /></dd>
          <dt>{cbs ? 'urlRetorno' : 'Webhook'}</dt><dd className="mono">{dados.url ?? '—'}</dd>
          {dados.erro && <><dt>Erro</dt><dd>{dados.erro}</dd></>}
          {dados.reenvioDe && <><dt>Reenvio de</dt><dd className="mono">{dados.reenvioDe}</dd></>}
        </dl>
        <h3>Corpo</h3>
        {cbs && <p className="dica">O link assinado fica mascarado aqui: só o SplitHub o recebe, e baixar por ele é a prova de recebimento.</p>}
        <Json valor={dados.corpo} alturaMax={320} />
        <h3>Tentativas</h3>
        {!dados.chamadas.length ? <p className="dica">{cbs ? 'Nenhuma: a urlRetorno foi recusada antes do envio.' : 'Nenhuma: o SplitHub não habilitou o IBS emulado, então não há webhook.'}</p> : (
          <ul className="tempo">{dados.chamadas.map((c: any) => (
            <li key={c.id}><div>
              <div className="linha-flex"><strong>Tentativa {c.tentativa}</strong><SeloStatusHttp status={c.status} /><span className="dica">{numero(c.duracaoMs)} ms</span></div>
              <div className="quando">{quando(c.em)}</div>
              {c.erro && <div className="dica">{c.erro}</div>}
              {c.resposta && <pre className="codigo" style={{ maxHeight: 120 }}>{String(c.resposta).slice(0, 2000)}</pre>}
            </div></li>
          ))}</ul>
        )}
      </>}
    </Gaveta>
  );
}

const ESTADO_TIQUETE: Record<string, [string, string]> = { PENDENTE: ['Pendente', 'info'], EM_PROCESSAMENTO: ['Em processamento', 'info'], CONCLUIDA: ['Concluída', 'ok'], ERRO: ['Erro', 'erro'] };
const SeloTiquete = ({ t }: { t: any }) => {
  if (t.estado === 'CONCLUIDA' && t.expirado) return <span className="selo aviso" title={`O link venceu em ${quando(t.expiraEm)}`}>Link vencido</span>;
  const [r, c] = ESTADO_TIQUETE[t.estado] ?? [t.estado, ''];
  return <span className={`selo ${c}`}>{r}</span>;
};
const curto = (tiquete: string) => `${tiquete.slice(0, 8)}…`;

function GavetaTiquete({ pocId, tiqueteId, aoFechar }: { pocId: string; tiqueteId: string; aoFechar: () => void }) {
  const { navegar } = useRota();
  const acao = useAcao();
  const { dados, erro } = useCarregar(() => get(`/pocs/${pocId}/tiquetes/${tiqueteId}`), [tiqueteId]);
  return (
    <Gaveta titulo={dados ? <>Tíquete <span className="mono">{curto(dados.tiquete)}</span> · /{dados.endpoint}</> : 'Tíquete'}
      sub={dados && `${dados.origem === 'pedido' ? 'Pedido do SplitHub' : 'Aviso sem pedido'} · ${quando(dados.criadoEm)}`} aoFechar={aoFechar}
      acoes={dados?.conteudo && <button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/pocs/${pocId}/tiquetes/${tiqueteId}/arquivo`))}>Baixar o JSON</button>}>
      <CaixaErro erro={erro ?? acao.erro} />
      {!dados ? <Carregando /> : <>
        <dl className="kv">
          <dt>tiqueteSolicitacao</dt><dd className="mono quebra">{dados.tiquete}</dd>
          <dt>Estado</dt><dd><SeloTiquete t={dados} />{dados.codigoErro && <div className="dica">{dados.codigoErro}: {dados.mensagemErro}</div>}</dd>
          {dados.janela && <><dt>Janela</dt><dd>{quando(dados.janela[0])} a {quando(dados.janela[1])}</dd></>}
          <dt>Gerado em</dt><dd className="mono">{dados.geradoEm ?? '—'}</dd>
          <dt>Link vale até</dt><dd className="mono">{dados.expiraEm ?? '—'}{dados.expirado && <> · <span className="selo aviso sem-ponto">vencido</span></>}</dd>
          <dt>Download</dt><dd>{dados.downloads.total ? `${dados.downloads.total}× · primeiro ${quando(dados.downloads.primeiro)}` : 'O SplitHub ainda não baixou.'}</dd>
          {dados.hash && <><dt>SHA-256</dt><dd className="mono quebra">{dados.hash}</dd></>}
          {dados.tamanho !== null && <><dt>Tamanho</dt><dd>{numero(dados.tamanho)} bytes · {numero(dados.documentos)} registro(s)</dd></>}
        </dl>
        <h3>Eventos no arquivo</h3>
        {!dados.eventosDoTiquete.length ? <p className="dica">Nenhum: a janela não pegou mudança.</p> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Nota</th><th>Evento</th><th>Situação</th></tr></thead>
            <tbody>{dados.eventosDoTiquete.map((e: any) => (
              <tr key={e.id} className="clicavel" onClick={() => navegar(`/pocs/${pocId}/notas/${e.notaId}`)}>
                <td><Link para={`/pocs/${pocId}/notas/${e.notaId}`}>{e.nota}</Link></td>
                <td className="mono">{e.tipo}</td>
                <td><SeloEvento situacao={e.situacao} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <h3>Arquivo</h3>
        <p className="dica">O JSON como saiu, no leiaute das APIs de Apuração da CBS v2. É o mesmo que o SplitHub baixa pelo link assinado; baixar por aqui não conta como recebimento.</p>
        {dados.conteudo ? <Json valor={dados.conteudo} alturaMax={520} /> : <p className="dica">O arquivo sai quando o tíquete conclui.</p>}
      </>}
    </Gaveta>
  );
}

function PainelCbs({ poc, cbs, aoMudar, aoCredencial }: { poc: any; cbs: any; aoMudar: () => void; aoCredencial: (c: Credencial) => void }) {
  const { usuario } = useSessao();
  const avisar = useAvisos();
  const acao = useAcao();
  const [url, setUrl] = useState<string>(cbs.urlRetorno ?? '');
  const leitor = usuario.papel === 'leitor';
  const salvar = async (valor: string) => {
    const r = await acao.executar(() => put(`/pocs/${poc.id}/cbs/url-retorno`, { urlRetorno: valor }), valor ? 'urlRetorno validada e salva.' : 'urlRetorno removida.');
    if (r) { setUrl(r.urlRetorno ?? ''); aoMudar(); }
  };
  const novaCredencial = async () => {
    if (!confirm('Gerar uma credencial nova da CBS? A atual e os tokens dela deixam de valer na hora, e o SplitHub da POC precisa da nova para pedir token.')) return;
    const r = await acao.executar(() => post(`/pocs/${poc.id}/credencial-cbs`));
    if (r) { aoCredencial(r); aoMudar(); }
  };
  return (
    <Painel titulo="Receita Federal emulada (CBS)" acoes={<>
      <button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/pocs/${poc.id}/collection?ente=cbs`))}>Baixar a collection</button>
      {!leitor && <button className="botao pequeno" onClick={novaCredencial}>Gerar credencial nova</button>}
    </>}>
      <div className="pilha">
        <CaixaErro erro={acao.erro} />
        <div className="lado-a-lado">
          <dl className="kv">
            <dt>URL base</dt><dd><div className="linha-flex"><code className="quebra">{cbs.url}</code><button className="botao pequeno" onClick={() => copiar(cbs.url, avisar, 'URL copiada.')}>Copiar</button></div></dd>
            <dt>client_id</dt><dd><div className="linha-flex"><code className="quebra">{cbs.clientId}</code><button className="botao pequeno" onClick={() => copiar(cbs.clientId, avisar, 'client_id copiado.')}>Copiar</button></div></dd>
            <dt>client_secret</dt><dd className="dica">Mostrado uma vez. Perdeu? Gere uma credencial nova.</dd>
            <dt>CNPJ base</dt><dd className="mono">{poc.cnpjRaiz}</dd>
            <dt>Aviso sem pedido</dt><dd>{cbs.urlRetorno ? <><span className="selo ok">Ligado</span> <span className="dica">validado {quando(cbs.urlValidadaEm)}</span></> : <span className="selo info">Desligado: só por pedido</span>}</dd>
          </dl>
          <div className="pilha">
            <div className="rotulo">Rotas das APIs de Apuração da CBS v2 servidas pelo MassGen</div>
            <div className="pilha" style={{ gap: 6 }}>
              <div><Metodo m="POST" /> <code>/token</code> <span className="dica">OAuth 2.0, client credentials</span></div>
              <div><Metodo m="POST" /> <code>/apuracao-cbs/v2/{'{endpoint}'}/{'{cnpj8}'}</code> <span className="dica">debitos, creditos, pagamentos, recolhimentos</span></div>
              <div><Metodo m="GET" /> <code>/apuracao-cbs/v2/situacao/{'{tiquete}'}</code></div>
              <div><Metodo m="GET" /> <code>/download/v2/{'{assinatura}'}</code> <span className="dica">link assinado, 48 horas no relógio</span></div>
              <div><Metodo m="POST" /> <code>urlRetorno</code> <span className="dica">o MassGen chama o SplitHub</span></div>
            </div>
            <p className="dica">Onde a documentação ainda não define (os códigos de erro além do APURACAO-001, o tipo do pagamento, o aviso sem pedido), a decisão do emulador vai declarada na collection.</p>
          </div>
        </div>
        {!leitor && (
          <Campo rotulo="urlRetorno do aviso sem pedido" ajuda="Com ela, cada dia fechado avisa o SplitHub de cada endpoint que mudou (D-MG-03). Validar faz o mesmo HEAD que o pedido faz; sem 2xx, nada é salvo.">
            <div className="linha-flex">
              <input type="url" style={{ flex: '1 1 260px' }} placeholder="https://splithub.exemplo/retorno/cbs" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button className="botao primario pequeno" disabled={acao.ocupado || !url.trim()} onClick={() => salvar(url.trim())}>Validar e salvar</button>
              {cbs.urlRetorno && <button className="botao pequeno" disabled={acao.ocupado} onClick={() => salvar('')}>Desligar</button>}
            </div>
          </Campo>
        )}
      </div>
    </Painel>
  );
}

const catalogoCaso = (catalogo: any, id: string) => (catalogo?.casos ?? []).find((c: any) => c.id === id);

// Onde o MassGen provocou o caso, pelo detalhe que ele registrou.
function onde(p: any): string {
  const d = p.detalhe ?? {};
  switch (p.caso) {
    case 'T02': return `tíquete ${curto(d.tiquete ?? '')} em /${d.endpoint}: o link nasceu vencido`;
    case 'T03': return `tíquete ${curto(d.tiquete ?? '')} em /${d.endpoint}: ERRO APURACAO-408`;
    case 'T05': return `Delta ${d.idSolic}: a operação ${d.operacao} (${d.nota}) saiu em ${d.partes} arquivos`;
    case 'T06': return `${numero(d.lancamentos)} lançamento(s) de ${numero(d.operacoes)} operação(ões) sem Delta`;
    case 'T07': return `Delta ${d.idSolic}: o lançamento ${d.lancamento} da operação ${d.operacao} (${d.nota}) ficou de fora`;
    case 'T09': return p.ente === 'ibs' ? `aviso da solicitação ${d.idSolic}: a primeira resposta 2xx foi descartada` : `aviso do tíquete ${curto(d.tiquete ?? '')} em /${d.endpoint}: a primeira resposta 2xx foi descartada`;
    default: return '—';
  }
}

function AbaBarramento({ poc, catalogo, versao, aoMudar }: { poc: any; catalogo: any; versao: number; aoMudar: () => void }) {
  const { usuario } = useSessao();
  const avisar = useAvisos();
  const acao = useAcao();
  const { dados, erro, recarregar } = useCarregar(() => get(`/pocs/${poc.id}/barramento`), [poc.id, versao], 5000);
  const [arquivo, setArquivo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [tiquete, setTiquete] = useState<string | null>(null);
  const [cred, setCred] = useState<Credencial | null>(null);
  const ibs = dados?.ibs ?? poc.ibs;
  const novaCredencial = async () => {
    if (!confirm('Gerar uma credencial nova? A atual deixa de valer na hora, e o SplitHub da POC precisa da nova para chamar o IBS emulado.')) return;
    const r = await acao.executar(() => post(`/pocs/${poc.id}/credencial-ibs`));
    if (r) { setCred(r); aoMudar(); }
  };
  return (
    <div className="pilha">
      <CaixaErro erro={erro ?? acao.erro} />
      <Painel titulo="Comitê Gestor emulado (IBS)" acoes={<>
        <button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/pocs/${poc.id}/collection`))}>Baixar a collection</button>
        {usuario.papel !== 'leitor' && <button className="botao pequeno" onClick={novaCredencial}>Gerar credencial nova</button>}
      </>}>
        <div className="lado-a-lado">
          <dl className="kv">
            <dt>URL base</dt><dd><div className="linha-flex"><code className="quebra">{ibs.url}</code><button className="botao pequeno" onClick={() => copiar(ibs.url, avisar, 'URL copiada.')}>Copiar</button></div></dd>
            <dt>clientid</dt><dd><div className="linha-flex"><code className="quebra">{ibs.clientId}</code><button className="botao pequeno" onClick={() => copiar(ibs.clientId, avisar, 'clientid copiado.')}>Copiar</button></div></dd>
            <dt>clientsecret</dt><dd className="dica">Mostrado uma vez. Perdeu? Gere uma credencial nova.</dd>
            <dt>Habilitação</dt><dd>{ibs.habilitado ? <><span className="selo ok">Habilitado</span> <span className="dica">{quando(ibs.habilitadoEm)}</span></> : <span className="selo aviso">Aguardando o SplitHub</span>}</dd>
            <dt>webhookUrl</dt><dd className="mono quebra">{ibs.webhookUrl ?? '—'}</dd>
            <dt>tokenContrib</dt><dd>{ibs.tokenContrib ? 'Registrado no cofre; volta no cabeçalho de cada aviso' : '—'}</dd>
          </dl>
          <div className="pilha">
            <div className="rotulo">Rotas do MOC v1.10 servidas pelo MassGen</div>
            <div className="pilha" style={{ gap: 6 }}>
              <div><Metodo m="POST" /> <code>/v1/aassist/habilitar</code> <span className="dica">5.1</span></div>
              <div><Metodo m="GET" /> <code>/v1/aassist/solicitacao/listar/{'{ini}&{fim}&{sit}'}</code> <span className="dica">5.4</span></div>
              <div><Metodo m="GET" /> <code>/v1/aassist/solicitacao/incluir</code> <span className="dica">5.5, Arquivo Manual</span></div>
              <div><Metodo m="DELETE" /> <code>/v1/aassist/solicitacao/cancelamento/{'{idSolic}'}</code> <span className="dica">5.6</span></div>
              <div><Metodo m="GET" /> <code>/v1/aassist/arquivo/{'{nomeArq}'}</code> <span className="dica">5.3, rota provisória</span></div>
              <div><Metodo m="POST" /> <code>webhookUrl</code> <span className="dica">5.2, o MassGen chama o SplitHub</span></div>
            </div>
            <p className="dica">Onde o MOC ainda não define (a rota do Obter Arquivo, o hash do extrato, o horário do Processamento Diário), a decisão do emulador vai declarada na collection.</p>
          </div>
        </div>
      </Painel>
      <Painel titulo="IBS · solicitações e arquivos" semPad>
        {!dados ? <Carregando /> : !dados.solicitacoes.length ? <Vazio titulo="Nenhum Delta ainda">Aplique um roteiro ou envie eventos e feche o dia. O Arquivo Manual que o SplitHub pedir em 5.5 também aparece aqui.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>idSolic</th><th>Dia</th><th>Situação</th><th className="num">Operações</th><th>Arquivos</th><th>Avisos</th></tr></thead>
            <tbody>{dados.solicitacoes.map((s: any) => (
              <tr key={s.id}>
                <td><span className="mono">{s.idSolic}</span>
                  <div>{s.tipo === 'MANUAL' ? <span className="selo info sem-ponto" title="Pedido pelo SplitHub em 5.5">Arquivo Manual</span> : <span className="selo sem-ponto">Delta</span>}{s.provocacao && <span className="selo aviso sem-ponto" title="O MassGen provocou este caso aqui">{s.provocacao}</span>}</div></td>
                <td className="nowrap">{diaBr(s.dia)}{s.tipo === 'MANUAL' && <div className="dica">período {periodoBr(s.periodo)}</div>}{s.validade && <div className="dica">válido até {diaBr(s.validade.slice(0, 10))}</div>}</td>
                <td><SeloSolicitacao s={s.situacao} /></td>
                <td className="num">{numero(s.operacoes)}</td>
                <td>{s.arquivos.map((a: any) => (
                  <div key={a.id}><button className="botao fantasma pequeno mono quebra" onClick={() => setArquivo(a.id)}>{a.nome}</button>
                    <span className="dica">{numero(a.lancamentos)} lanç. · {a.downloads ? `baixado ${numero(a.downloads)}×` : 'sem download'}</span></div>
                ))}</td>
                <td>{s.avisos.map((a: any) => (
                  <div key={a.id}><button className="botao fantasma pequeno" onClick={() => setAviso(a.id)}><SeloAviso a={a} /></button><span className="dica">{a.reenvioDe ? 'reenvio · ' : ''}{quando(a.em)}</span></div>
                ))}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {dados ? <PainelCbs key={dados.cbs.urlRetorno ?? ''} poc={poc} cbs={dados.cbs} aoMudar={() => { recarregar(true); aoMudar(); }} aoCredencial={setCred} /> : <Carregando />}
      <Painel titulo="CBS · tíquetes" semPad>
        {!dados ? <Carregando /> : !dados.tiquetes.length ? <Vazio titulo="Nenhum tíquete ainda">O SplitHub abre um pedido em /apuracao-cbs/v2; com a urlRetorno validada, cada dia fechado também abre o aviso sem pedido.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Tíquete</th><th>Endpoint</th><th>Dia</th><th>Estado</th><th className="num">Registros</th><th>Link</th><th>Avisos</th></tr></thead>
            <tbody>{dados.tiquetes.map((t: any) => (
              <tr key={t.id} className="clicavel" onClick={() => setTiquete(t.id)}>
                <td><button className="botao fantasma pequeno mono" onClick={(e) => { e.stopPropagation(); setTiquete(t.id); }}>{curto(t.tiquete)}</button>
                  <div>{t.origem === 'pedido' ? <span className="selo info sem-ponto">Pedido</span> : <span className="selo sem-ponto">Sem pedido</span>}{t.provocacao && <span className="selo aviso sem-ponto" title="O MassGen provocou este caso aqui">{t.provocacao}</span>}</div></td>
                <td className="mono">/{t.endpoint}</td>
                <td className="nowrap">{diaBr(t.dia)}{t.janela && <div className="dica">desde {diaBr(t.janela[0].slice(0, 10))}</div>}</td>
                <td><SeloTiquete t={t} /></td>
                <td className="num">{numero(t.documentos)}<div className="dica">{numero(t.eventos)} evento(s)</div></td>
                <td>{t.expiraEm ? <><span className="dica">até {quando(t.expiraEm)}</span><div className="dica">{t.downloads.total ? `baixado ${numero(t.downloads.total)}×` : 'sem download'}</div></> : <span className="dica">—</span>}</td>
                <td onClick={(e) => e.stopPropagation()}>{t.avisos.length ? t.avisos.map((a: any) => (
                  <div key={a.id}><button className="botao fantasma pequeno" onClick={() => setAviso(a.id)}><SeloAviso a={a} /></button><span className="dica">{a.reenvioDe ? 'reenvio · ' : ''}{quando(a.em)}</span></div>
                )) : <span className="dica">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {dados?.provocacoes?.length > 0 && (
        <Painel titulo="Casos provocados pelo MassGen" semPad>
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Quando</th><th>Caso</th><th>Ente</th><th>Dia simulado</th><th>Onde</th></tr></thead>
            <tbody>{dados.provocacoes.map((p: any, k: number) => (
              <tr key={k}>
                <td className="nowrap">{quando(p.em)}</td>
                <td><span className="mono">{p.caso}</span><div className="dica">{catalogoCaso(catalogo, p.caso)?.nome ?? ''}</div></td>
                <td><SeloEnte ente={p.ente} /></td>
                <td className="nowrap">{diaBr(p.dia)}</td>
                <td className="dica">{onde(p)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Painel>
      )}
      <Painel titulo="Chamadas recebidas do SplitHub" semPad>
        {!dados ? <Carregando /> : !dados.chamadas.length ? <Vazio titulo="Nenhuma chamada">Quando o SplitHub da POC chamar um dos entes emulados, a chamada aparece aqui.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Quando</th><th>Ente</th><th>Rota</th><th>Status</th><th>Origem</th><th className="num">Duração</th></tr></thead>
            <tbody>{dados.chamadas.map((c: any) => (
              <tr key={c.id}>
                <td className="nowrap">{quando(c.em)}</td>
                <td><SeloEnte ente={c.ente} /></td>
                <td><Metodo m={c.metodo} /> <code className="quebra">{c.rota}</code></td>
                <td><SeloStatusHttp status={c.status} /></td>
                <td className="mono">{c.ip ?? '—'}</td>
                <td className="num">{numero(c.duracaoMs)} ms</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {arquivo && <GavetaArquivo pocId={poc.id} arquivoId={arquivo} aoFechar={() => setArquivo(null)} />}
      {aviso && <GavetaAviso pocId={poc.id} avisoId={aviso} aoFechar={() => setAviso(null)} aoReenviar={() => { recarregar(true); aoMudar(); }} />}
      {tiquete && <GavetaTiquete pocId={poc.id} tiqueteId={tiquete} aoFechar={() => setTiquete(null)} />}
      {cred && <CredencialUmaVez creds={[cred]} aoFechar={() => setCred(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- envios e configuração

function AbaEnvios({ poc, versao }: { poc: any; versao: number }) {
  const { dados, erro, carregando } = useCarregar(() => get(`/pocs/${poc.id}/envios`), [poc.id, versao]);
  return (
    <Painel semPad>
      <CaixaErro erro={erro} />
      {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo="Nenhum envio">Os roteiros aplicados e os envios sob demanda aparecem aqui, com quem fez.</Vazio> : (
        <div className="tabela-wrap"><table className="tabela">
          <thead><tr><th>Nº</th><th>Tipo</th><th>Dia</th><th className="num">Notas</th><th className="num">Eventos</th><th>Tipos</th><th>Por</th></tr></thead>
          <tbody>{dados.map((e: any) => (
            <tr key={e.id}>
              <td className="mono">{e.numero}</td>
              <td>{e.tipo === 'roteiro' ? <span className="selo sem-ponto mono">{e.roteiro}</span> : <span className="selo info sem-ponto">Sob demanda</span>}{e.forcar && <span className="selo erro sem-ponto">Forçado</span>}</td>
              <td className="nowrap">{diaBr(e.dia)}</td>
              <td className="num">{numero(e.notas)}</td>
              <td className="num">{numero(e.resumo?.eventos)}{e.resumo?.cbs !== undefined && <div className="dica">IBS {numero(e.resumo.ibs)} · CBS {numero(e.resumo.cbs)}</div>}{e.resumo?.bloqueios ? <div className="dica">{numero(e.resumo.bloqueios)} não couberam</div> : null}</td>
              <td><span className="chip-lista">{e.tipos.map((t: string) => <span key={t} className="chip mono">{t}</span>)}</span></td>
              <td>{e.por}<div className="dica">{quando(e.em)}</div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Painel>
  );
}

function AbaConfig({ poc, aoMudar }: { poc: any; aoMudar: () => void }) {
  const { usuario } = useSessao();
  const { navegar } = useRota();
  const acao = useAcao();
  const [f, setF] = useState({ nome: poc.nome, lancamentosPorArquivo: String(poc.lancamentosPorArquivo), limitesRelaxados: !!poc.limitesRelaxados, defasagemCbs: String(poc.defasagemCbs ?? 0) });
  const leitor = usuario.papel === 'leitor';
  const salvar = async () => {
    const corpo = { nome: f.nome, lancamentosPorArquivo: Number(f.lancamentosPorArquivo), limitesRelaxados: f.limitesRelaxados, defasagemCbs: Number(f.defasagemCbs) };
    if ((await acao.executar(() => put(`/pocs/${poc.id}`, corpo), 'POC salva.')) !== undefined) aoMudar();
  };
  const apagar = async () => {
    const nome = prompt(`Apagar a POC leva as ${numero(poc.notas.aceitas + poc.notas.fora)} nota(s) do cliente, os eventos, os arquivos e os avisos; a trilha de auditoria fica. Para confirmar, digite o nome da POC:`);
    if (nome === null) return;
    if (nome.trim() !== poc.nome) { acao.executar(() => Promise.reject(new Error('O nome não confere; nada foi apagado.'))); return; }
    if ((await acao.executar(() => del(`/pocs/${poc.id}`), 'POC apagada.')) !== undefined) navegar('/pocs');
  };
  return (
    <div className="pilha">
      <CaixaErro erro={acao.erro} />
      <Painel titulo="Configuração" acoes={!leitor && <button className="botao primario pequeno" disabled={acao.ocupado} onClick={salvar}>Salvar</button>}>
        <div className="grade grade-2">
          <Campo rotulo="Nome"><input type="text" value={f.nome} disabled={leitor} onChange={(e) => setF({ ...f, nome: e.target.value })} /></Campo>
          <Campo rotulo="Lançamentos por arquivo" ajuda="Acima disso, a operação é fatiada em partes, com o cabeçalho repetido e o hash acumulado (Anexo I).">
            <input type="number" min={1} max={100000} value={f.lancamentosPorArquivo} disabled={leitor} onChange={(e) => setF({ ...f, lancamentosPorArquivo: e.target.value })} />
          </Campo>
          <Campo rotulo="Defasagem da CBS, em dias" ajuda="O padrão do plano e dos roteiros: positivo, a CBS sai tantos dias depois do IBS; negativo, antes. Vale para o que for planejado daqui em diante.">
            <input type="number" min={-30} max={30} value={f.defasagemCbs} disabled={leitor} onChange={(e) => setF({ ...f, defasagemCbs: e.target.value })} />
          </Campo>
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={f.limitesRelaxados} disabled={leitor} onChange={(e) => setF({ ...f, limitesRelaxados: e.target.checked })} />
          Limites relaxados: a CBS emulada aceita mais de 4 pedidos por dia simulado em cada endpoint, e o IBS emulado mais de 2 Arquivos Manuais por dia, para repetir um teste sem avançar o relógio
        </label>
        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>CNPJ</dt><dd className="mono">{poc.cnpj}</dd>
          <dt>Competência</dt><dd>{competenciaBr(poc.competencia)}</dd>
          <dt>Criada</dt><dd>{quando(poc.criadoEm)} · {poc.criadoPor}</dd>
        </dl>
      </Painel>
      {usuario.papel === 'root' && (
        <Painel titulo="Fim da POC">
          <div className="linha-flex">
            <p style={{ flex: '1 1 320px' }}>Ao fim da POC, apague-a: os XMLs do cliente saem com ela (D-MG-12). As credenciais do IBS e da CBS emulados deixam de valer na hora.</p>
            <button className="botao perigo" disabled={acao.ocupado} onClick={apagar}>Apagar a POC</button>
          </div>
        </Painel>
      )}
    </div>
  );
}
