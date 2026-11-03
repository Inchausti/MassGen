// POC da apuração assistida (proposta v4.3): o cliente e a competência, as notas dele, o envio sob demanda,
// o barramento do Comitê Gestor emulado (IBS) e os envios. O relógio é o dia simulado da POC.
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
  disponivel: ['Disponível', 'destaque', 'No arquivo do Delta, ainda sem aviso aceito pelo SplitHub.'],
  avisado: ['Avisado', 'destaque', 'O webhook do SplitHub respondeu 2xx; falta o download.'],
  recebido: ['Recebido', 'ok', 'O SplitHub baixou o arquivo com este evento.'],
  nao_recebido: ['Não recebido', 'erro', 'O aviso falhou ou o arquivo expirou sem download.'],
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

const SeloPapelNota = ({ papel }: { papel?: string | null }) => (papel ? <span className={`selo sem-ponto ${papel === 'adquirente' ? 'info' : 'destaque'}`}>{ROTULO_PAPEL_NOTA[papel]}</span> : <span className="dica">—</span>);

// Efeito do evento nos sete campos do extrato, só os que mexem.
export function efeito(valores: Record<string, number> | undefined, campos: { campo: string; rotulo: string }[]): ReactNode {
  const mexe = campos.filter((c) => valores?.[c.campo]);
  if (!mexe.length) return <span className="dica">sem efeito nos saldos</span>;
  return <span className="chip-lista">{mexe.map((c) => <span key={c.campo} className="chip mono" title={c.rotulo}>{c.campo} {valores![c.campo] > 0 ? '+' : '−'}{moeda(Math.abs(valores![c.campo]))}</span>)}</span>;
}

const resumoDelta = (p: any) => `Delta ${p.idSolic} de ${diaBr(p.dia)}: ${numero(p.lancamentos)} lançamento(s) em ${p.arquivos.length} arquivo(s); aviso ${p.aviso?.resultado === 'ok' ? `aceito (${p.aviso.status})` : p.aviso?.resultado === 'sem_webhook' ? 'não enviado: o SplitHub não habilitou' : `sem 2xx${p.aviso?.status ? ` (${p.aviso.status})` : ''}`}`;

// ---------------------------------------------------------------- credencial (mostrada uma vez)

function CredencialUmaVez({ cred, aoFechar, rodape }: { cred: { url: string; clientId: string; clientSecret: string }; aoFechar: () => void; rodape?: ReactNode }) {
  const avisar = useAvisos();
  const linha = (rotulo: string, valor: string) => (
    <><dt>{rotulo}</dt><dd><div className="linha-flex"><code className="quebra">{valor}</code><button className="botao pequeno" onClick={() => copiar(valor, avisar, `${rotulo} copiado.`)}>Copiar</button></div></dd></>
  );
  return (
    <Modal titulo="Credencial do Comitê Gestor emulado" aoFechar={aoFechar} rodape={rodape ?? <button className="botao primario" onClick={aoFechar}>Já guardei</button>}>
      <div className="alerta aviso"><div>O <strong>clientsecret</strong> aparece só agora, como no Comitê Gestor. Guarde no cofre do SplitHub da POC: o MassGen guarda só o hash.</div></div>
      <dl className="kv">{linha('URL base', cred.url)}{linha('clientid', cred.clientId)}{linha('clientsecret', cred.clientSecret)}</dl>
      <p className="dica">O SplitHub da POC chama essa URL com o clientid e o clientsecret nos cabeçalhos, como faria com o Comitê Gestor. Habilitar, listar e baixar ficam na aba Barramento.</p>
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
    return <CredencialUmaVez cred={criada.credencial} aoFechar={() => navegar(`/pocs/${criada.poc.id}`)} rodape={<button className="botao primario" onClick={() => navegar(`/pocs/${criada.poc.id}`)}>Já guardei, abrir a POC</button>} />;
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
        sub="Cada POC é um cliente e uma competência. As notas dele entram aqui e o MassGen faz o papel do Comitê Gestor diante do SplitHub da POC: monta o barramento, avisa o webhook e serve os arquivos."
        acoes={usuario.papel !== 'leitor' && <button className="botao primario" onClick={() => setNova(true)}>Nova POC</button>}
      />
      <CaixaErro erro={erro} />
      <Painel semPad>
        {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo="Nenhuma POC">Crie uma para importar os XMLs do cliente e emular o IBS.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>POC</th><th>Cliente</th><th>Dia simulado</th><th className="num">Notas</th><th className="num">Eventos recebidos</th><th className="num">Pendentes</th><th>IBS</th></tr></thead>
            <tbody>{dados.map((p: any) => {
              const ev = p.eventos ?? {};
              const pendentes = (ev.disponivel ?? 0) + (ev.avisado ?? 0) + (ev.nao_recebido ?? 0);
              return (
                <tr key={p.id} className="clicavel" onClick={() => navegar(`/pocs/${p.id}`)}>
                  <td><Link para={`/pocs/${p.id}`}>{p.nome}</Link><div className="dica">{quando(p.criadoEm)}</div></td>
                  <td><span className="mono">{p.cnpjRaiz}</span><div className="dica">competência {competenciaBr(p.competencia)}</div></td>
                  <td className="nowrap">{diaBr(p.dia)}</td>
                  <td className="num">{numero(p.notas.aceitas)}<div className="dica">{numero(p.notas.entrada)} entrada · {numero(p.notas.saida)} saída</div></td>
                  <td className="num">{numero(ev.recebido)}</td>
                  <td className="num">{pendentes ? <span style={{ color: 'var(--aviso)' }}>{numero(pendentes)}</span> : '0'}{ev.planejado ? <div className="dica">{numero(ev.planejado)} planejado(s)</div> : null}</td>
                  <td>{p.ibs.habilitado ? <span className="selo ok">Habilitado</span> : <span className="selo aviso">Sem habilitação</span>}</td>
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

type Aba = 'notas' | 'enviar' | 'barramento' | 'envios' | 'config';

function Relogio({ poc, aoMudar }: { poc: any; aoMudar: () => void }) {
  const { usuario } = useSessao();
  const acao = useAcao();
  const avisar = useAvisos();
  const [ate, setAte] = useState('');
  const fechar = async (corpo: { ate?: string }) => {
    const r = await acao.executar(() => post(`/pocs/${poc.id}/relogio/fechar`, corpo));
    if (!r) return;
    avisar(r.processados.length ? `${r.diasFechados} dia(s) fechado(s). ${r.processados.map(resumoDelta).join(' · ')}` : `${r.diasFechados} dia(s) fechado(s), sem evento planejado. O relógio está em ${diaBr(r.dia)}.`);
    setAte('');
    aoMudar();
  };
  return (
    <div className="relogio" aria-label="Relógio da POC">
      <div><div className="dica">Dia simulado</div><div className="relogio-dia">{diaBr(poc.dia)}</div></div>
      {usuario.papel !== 'leitor' && <>
        <button className="botao" disabled={acao.ocupado} onClick={() => fechar({})} title="Gera o Delta do dia com os eventos planejados, avisa o SplitHub e passa ao dia seguinte">Fechar o dia</button>
        <input type="date" aria-label="Fechar até" value={ate} min={poc.dia} onChange={(e) => setAte(e.target.value)} />
        <button className="botao" disabled={acao.ocupado || !ate} onClick={() => fechar({ ate })} title="Fecha cada dia até a data, inclusive">Fechar até</button>
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
  const total = Object.entries(ev).filter(([k]) => k !== 'substituido').reduce((s, [, n]) => s + (n as number), 0);
  const pendentes = (ev.disponivel ?? 0) + (ev.avisado ?? 0) + (ev.nao_recebido ?? 0);
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para="/pocs">POCs</Link>}
        titulo={p.nome}
        sub={<>CNPJ <span className="mono">{p.cnpj}</span> · competência {competenciaBr(p.competencia)} · {p.ibs.habilitado ? <>IBS habilitado em {quando(p.ibs.habilitadoEm)}</> : 'o SplitHub ainda não habilitou o IBS emulado'}</>}
        acoes={<Relogio poc={p} aoMudar={mudou} />}
      />
      <div className="grade grade-4">
        <div className="painel numero"><div className="rot">Notas aceitas</div><div className="val">{numero(p.notas.aceitas)}</div><div className="det">{numero(p.notas.entrada)} entrada · {numero(p.notas.saida)} saída</div></div>
        <div className="painel numero"><div className="rot">De fora</div><div className="val">{numero(p.notas.fora)}</div><div className="det">com o motivo na lista</div></div>
        <div className="painel numero"><div className="rot">Eventos recebidos</div><div className="val">{numero(ev.recebido)}</div><div className="det">de {numero(total)} no IBS</div></div>
        <div className="painel numero"><div className="rot">Pendentes</div><div className="val" style={pendentes ? { color: 'var(--aviso)' } : undefined}>{numero(pendentes)}</div><div className="det">{numero(ev.planejado)} planejado(s) para os próximos dias</div></div>
      </div>
      <Abas<Aba>
        abas={[
          { id: 'notas', rotulo: 'Notas', contagem: p.notas.aceitas + p.notas.fora },
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
      {aba === 'enviar' && (catalogo.dados ? <AbaEnviar key={busca.get('notas') ?? ''} poc={p} catalogo={catalogo.dados} iniciais={(busca.get('notas') ?? '').split(',').filter(Boolean)} aoEnviar={mudou} /> : <Carregando />)}
      {aba === 'barramento' && <AbaBarramento poc={p} versao={versao} aoMudar={mudou} />}
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
  const [filtro, setFiltro] = useState({ busca: '', papel: '', situacao: '' });
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
          </div>
          {pode && marcadas.size > 0 && (
            <div className="alerta info"><div className="linha-flex" style={{ flex: 1 }}>
              <strong>{numero(marcadas.size)} marcada(s)</strong><span className="espaco" />
              <button className="botao pequeno" onClick={() => setMarcadas(new Set())}>Desmarcar</button>
              <button className="botao pequeno" onClick={() => setRoteiro(true)}>Aplicar roteiro</button>
              <button className="botao primario pequeno" onClick={() => navegar(`/pocs/${poc.id}?aba=enviar&notas=${[...marcadas].join(',')}`)}>Enviar eventos</button>
            </div></div>
          )}
        </div>
        {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo={consulta ? 'Nenhuma nota com esse filtro' : 'Nenhuma nota importada'}>{!consulta && 'Importe os XMLs do cliente, soltos ou num ZIP.'}</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr>
              {pode && <th><input type="checkbox" aria-label="Marcar todas as aceitas" checked={todasMarcadas} onChange={() => setMarcadas(todasMarcadas ? new Set() : new Set(aceitas.map((n: any) => n.id)))} /></th>}
              <th>Nota</th><th>Papel</th><th>Contraparte</th><th>Emissão</th><th className="num">IBS</th><th>Eventos</th><th>Roteiro</th>
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
                  </td>
                  <td><SeloPapelNota papel={n.papel} /></td>
                  <td>{contra?.nome ?? '—'}<div className="dica mono">{contra?.doc ?? ''}</div></td>
                  <td className="nowrap">{diaBr(n.emissao?.slice(0, 10))}</td>
                  <td className="num">{moeda(n.vIbs)}</td>
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

function TabelaPlano({ itens, campos, comDia }: { itens: any[]; campos: any[]; comDia?: boolean }) {
  return (
    <div className="tabela-wrap"><table className="tabela">
      <thead><tr><th>Nota</th>{comDia && <th>Dia</th>}<th>Evento</th><th>Origem</th><th className="num">Valor</th><th>Efeito no extrato</th></tr></thead>
      <tbody>{itens.map((i, k) => (
        <tr key={k}>
          <td className="nowrap">{i.nota}{i.relNota && <div className="dica">com {i.relNota}</div>}</td>
          {comDia && <td className="nowrap">{diaBr(i.dia)}</td>}
          <td><span className="mono">{i.id}</span><div className="dica">{i.mov}</div></td>
          <td>{i.origem === 'pre-requisito' ? <span className="selo aviso sem-ponto" title="Entrou antes porque o tipo escolhido depende dele">Pré-requisito</span> : i.origem === 'roteiro' ? <span className="selo sem-ponto">Roteiro{i.pct ? ` · ${i.pct}%` : ''}</span> : <span className="selo info sem-ponto">Escolhido{i.pct ? ` · ${i.pct}%` : ''}</span>}{i.forcado && <span className="selo erro sem-ponto">Forçado</span>}</td>
          <td className="num">{moeda(i.valor)}</td>
          <td>{efeito(i.valores, campos)}</td>
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
  const roteiros = catalogo.roteiros.filter((r: any) => r.ibs.length);
  const [roteiro, setRoteiro] = useState<string>(roteiros[0]?.id ?? '');
  const [intervalo, setIntervalo] = useState(1);
  const [previa, setPrevia] = useState<any>(null);
  const [erroPrevia, setErroPrevia] = useState<any>(null);
  const chave = notaIds.join(',');
  // A prévia acompanha o roteiro e o intervalo escolhidos.
  useEffect(() => {
    let vivo = true;
    setPrevia(null);
    post(`/pocs/${poc.id}/roteiros/previa`, { notaIds: chave.split(','), roteiro, intervaloDias: intervalo })
      .then((r) => { if (vivo) { setPrevia(r); setErroPrevia(null); } }, (e) => { if (vivo) setErroPrevia(e); });
    return () => { vivo = false; };
  }, [poc.id, chave, roteiro, intervalo]);
  const r = roteiros.find((x: any) => x.id === roteiro);
  const aplicar = async () => {
    const res = await acao.executar(() => post(`/pocs/${poc.id}/roteiros`, { notaIds, roteiro, intervaloDias: intervalo }));
    if (res) { avisar(`${roteiro}: ${numero(res.itens.length)} evento(s) planejado(s) até ${diaBr(res.ultimoDia)}. Eles saem quando o relógio fechar cada dia.`); aoAplicar(); }
  };
  return (
    <Modal titulo={`Aplicar roteiro a ${numero(notaIds.length)} nota(s)`} aoFechar={aoFechar}
      rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado || !previa?.itens.length} onClick={aplicar}>Planejar {previa ? numero(previa.itens.length) : ''} evento(s)</button></>}>
      <CaixaErro erro={acao.erro ?? erroPrevia} />
      <div className="grade grade-2">
        <Campo rotulo="Roteiro" ajuda={r ? `${r.historia}. IBS: ${r.ibs.map((p: any) => `${p.tipo}${p.pct ? ` (${p.pct}%)` : ''}`).join(' → ')}` : undefined}>
          <select value={roteiro} onChange={(e) => setRoteiro(e.target.value)}>
            <optgroup label="Nota de entrada">{roteiros.filter((x: any) => x.lado === 'adquirente').map((x: any) => <option key={x.id} value={x.id}>{x.id} · {x.historia}</option>)}</optgroup>
            <optgroup label="Nota de saída">{roteiros.filter((x: any) => x.lado === 'fornecedor').map((x: any) => <option key={x.id} value={x.id}>{x.id} · {x.historia}</option>)}</optgroup>
          </select>
        </Campo>
        <Campo rotulo="Dias entre um passo e o seguinte" ajuda={`O primeiro passo cai em ${diaBr(poc.dia)} ou na emissão, o que vier depois.`}>
          <input type="number" min={0} max={30} value={intervalo} onChange={(e) => setIntervalo(Number(e.target.value))} />
        </Campo>
      </div>
      <p className="dica">Só nas notas sem evento no IBS. Os roteiros sem IBS (A7, A8, A9 e F8) entram com a CBS, na etapa 2. Se depois você enviar sob demanda um tipo que o roteiro já planejou, o planejado vira substituído.</p>
      {!previa && !erroPrevia ? <Carregando texto="Montando a prévia…" /> : previa && <>
        <Bloqueios lista={previa.bloqueios} />
        {previa.itens.length > 0 && <TabelaPlano itens={previa.itens} campos={catalogo.campos} comDia />}
      </>}
    </Modal>
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
  const [previa, setPrevia] = useState<any>(null);
  const [feito, setFeito] = useState<any>(null);
  const root = usuario.papel === 'root';
  const leitor = usuario.papel === 'leitor';

  const grupos = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const t of catalogo.ibs) m.set(t.grupo, [...(m.get(t.grupo) ?? []), t]);
    return [...m];
  }, [catalogo]);
  const visiveis = (notas.dados ?? []).filter((n: any) => !busca || `${n.rotulo} ${n.chave} ${n.emitente?.nome ?? ''} ${n.destinatario?.nome ?? ''}`.toLowerCase().includes(busca.toLowerCase()));
  const invalidar = () => { setPrevia(null); setFeito(null); };
  const alternarNota = (id: string) => { invalidar(); setMarcadas((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const alternarTipo = (n: string) => { invalidar(); setTipos((m) => { const x = new Map(m); if (x.has(n)) x.delete(n); else x.set(n, { pct: '', valor: '' }); return x; }); };
  const ajustar = (n: string, campo: keyof Escolha, v: string) => { invalidar(); setTipos((m) => new Map(m).set(n, { ...m.get(n)!, [campo]: v })); };
  const corpo = () => ({
    notaIds: [...marcadas], forcar,
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
          <strong>Envio nº {feito.envio.numero}: {numero(feito.itens.length)} evento(s) do IBS{feito.envio.substituidos ? `; ${numero(feito.envio.substituidos)} planejado(s) do roteiro viraram substituídos` : ''}.</strong>
          {feito.fechamento.processados.map((p: any) => <div key={p.idSolic}>{resumoDelta(p)}.</div>)}
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
                  <span className="opcao-texto"><strong>{n.rotulo}</strong> <SeloPapelNota papel={n.papel} />{n.finalidade !== 'normal' && <span className="selo sem-ponto">{ROTULO_FINALIDADE[n.finalidade]}</span>}{n.canceladaEm && <span className="selo erro sem-ponto">Cancelada</span>}
                    <span className="dica"> IBS {moeda(n.vIbs)} · {numero(n.eventos.total)} evento(s)</span></span>
                </label>
              ))}</div>
            )}
          </div>
        </Painel>
        <Painel titulo={`2. Tipos de evento do IBS (${numero(tipos.size)})`} acoes={tipos.size > 0 && <button className="botao fantasma pequeno" onClick={() => { invalidar(); setTipos(new Map()); }}>Desmarcar</button>}>
          <div className="pilha">
            <p className="dica">Os 24 do MOC v1.10. O que falta antes de um tipo escolhido entra sozinho, como pré-requisito. O valor sai do saldo da operação; nos parciais, informe o percentual.</p>
            <div className="lista-rolavel">{grupos.map(([g, ts]) => (
              <div key={g} className="pilha" style={{ gap: 4 }}>
                <div className="rotulo">{g}</div>
                {ts.map((t: any) => {
                  const e = tipos.get(t.n);
                  return (
                    <div key={t.n} className={`opcao ${e ? 'marcada' : ''}`}>
                      <input type="checkbox" id={`tipo-${t.n}`} checked={!!e} onChange={() => alternarTipo(t.n)} />
                      <label htmlFor={`tipo-${t.n}`} className="opcao-texto">
                        <span className="mono">{t.id}</span> {t.mov}
                        <span className="dica"> · {t.lado === 'ambos' ? 'entrada e saída' : ROTULO_PAPEL_NOTA[t.lado].toLowerCase()}{t.relacionada ? ` · com a nota ${t.relacionada === 'cancelamento' ? 'cancelada' : t.relacionada === 'complementar' ? 'complementar' : 'de devolução'}` : ''}</span>
                        {t.nota && <span className="dica" style={{ display: 'block' }}>{t.nota}</span>}
                      </label>
                      {e && (t.parcial || forcar) && (
                        <span className="opcao-extra">
                          {t.parcial && <input type="number" min={1} max={100} placeholder="100" aria-label={`Percentual de ${t.id}`} value={e.pct} onChange={(x) => ajustar(t.n, 'pct', x.target.value)} />}
                          {t.parcial && <span className="dica">%</span>}
                          {forcar && <input type="text" inputMode="decimal" placeholder="valor" aria-label={`Valor forçado de ${t.id}`} value={e.valor} onChange={(x) => ajustar(t.n, 'valor', x.target.value)} />}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}</div>
          </div>
        </Painel>
      </div>
      <Painel titulo="3. Revisar e enviar">
        <div className="pilha">
          <p>Os eventos saem com a data do relógio, <strong>{diaBr(poc.dia)}</strong>. Executar fecha esse dia na hora (D-MG-14): o Delta do dia é gerado, o SplitHub é avisado no webhook e o relógio passa ao dia seguinte.</p>
          {root && (
            <label className="check"><input type="checkbox" checked={forcar} onChange={(e) => { invalidar(); setForcar(e.target.checked); }} /> Forçar: ignora a ordem, a unicidade, o saldo e a data, para testar a reação do SplitHub a um barramento fora da regra</label>
          )}
          {forcar && <div className="alerta erro"><div>O envio forçado sai como está, inclusive repetido ou sem saldo. Fica marcado como forçado no histórico e na trilha.</div></div>}
          <div className="linha-flex">
            <button className="botao" disabled={acao.ocupado || !marcadas.size || !tipos.size} onClick={revisar}>Revisar</button>
            <button className="botao primario" disabled={acao.ocupado || !previa?.itens.length} onClick={executar}>{acao.ocupado ? 'Enviando…' : `Executar e enviar${previa ? ` ${numero(previa.itens.length)} evento(s)` : ''}`}</button>
            {!previa && marcadas.size > 0 && tipos.size > 0 && <span className="dica">Revise antes: a prévia mostra o que entra, o que entra como pré-requisito e o que não cabe.</span>}
          </div>
          {previa && <>
            <Bloqueios lista={previa.bloqueios} />
            {previa.itens.length ? <TabelaPlano itens={previa.itens} campos={catalogo.campos} /> : <Vazio titulo="Nada a enviar">Nenhum evento coube nas notas marcadas.</Vazio>}
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
  return (
    <Gaveta titulo="Aviso ao webhook do SplitHub" sub={dados && `${quando(dados.em)}${dados.por ? ` · ${dados.por}` : ''}`} aoFechar={aoFechar}
      acoes={usuario.papel !== 'leitor' && <button className="botao pequeno" disabled={acao.ocupado} onClick={reenviar} title="Repete o mesmo aviso, com o mesmo arquivo; nenhum evento novo">Reenviar aviso</button>}>
      <CaixaErro erro={erro ?? acao.erro} />
      {!dados ? <Carregando /> : <>
        <dl className="kv">
          <dt>Resultado</dt><dd><SeloAviso a={dados} /></dd>
          <dt>Webhook</dt><dd className="mono">{dados.url ?? '—'}</dd>
          {dados.erro && <><dt>Erro</dt><dd>{dados.erro}</dd></>}
          {dados.reenvioDe && <><dt>Reenvio de</dt><dd className="mono">{dados.reenvioDe}</dd></>}
        </dl>
        <h3>Corpo</h3>
        <Json valor={dados.corpo} alturaMax={320} />
        <h3>Tentativas</h3>
        {!dados.chamadas.length ? <p className="dica">Nenhuma: o SplitHub não habilitou o IBS emulado, então não há webhook.</p> : (
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

function AbaBarramento({ poc, versao, aoMudar }: { poc: any; versao: number; aoMudar: () => void }) {
  const { usuario } = useSessao();
  const avisar = useAvisos();
  const acao = useAcao();
  const { dados, erro, recarregar } = useCarregar(() => get(`/pocs/${poc.id}/barramento`), [poc.id, versao], 5000);
  const [arquivo, setArquivo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [cred, setCred] = useState<any>(null);
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
              <div><Metodo m="GET" /> <code>/v1/aassist/arquivo/{'{nomeArq}'}</code> <span className="dica">5.3, rota provisória</span></div>
              <div><Metodo m="POST" /> <code>webhookUrl</code> <span className="dica">5.2, o MassGen chama o SplitHub</span></div>
            </div>
            <p className="dica">Onde o MOC ainda não define (a rota do Obter Arquivo, o hash do extrato, o horário do Processamento Diário), a decisão do emulador vai declarada na collection.</p>
          </div>
        </div>
      </Painel>
      <Painel titulo="Solicitações e arquivos" semPad>
        {!dados ? <Carregando /> : !dados.solicitacoes.length ? <Vazio titulo="Nenhum Delta ainda">Aplique um roteiro ou envie eventos e feche o dia.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>idSolic</th><th>Dia</th><th>Situação</th><th className="num">Operações</th><th>Arquivos</th><th>Avisos</th></tr></thead>
            <tbody>{dados.solicitacoes.map((s: any) => (
              <tr key={s.id}>
                <td className="mono">{s.idSolic}<div className="dica">{s.tipo}</div></td>
                <td className="nowrap">{diaBr(s.dia)}<div className="dica">válido até {diaBr(s.validade?.slice(0, 10))}</div></td>
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
      <Painel titulo="Chamadas recebidas do SplitHub" semPad>
        {!dados ? <Carregando /> : !dados.chamadas.length ? <Vazio titulo="Nenhuma chamada">Quando o SplitHub da POC habilitar, listar ou baixar, a chamada aparece aqui.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Quando</th><th>Rota</th><th>Status</th><th>Origem</th><th className="num">Duração</th></tr></thead>
            <tbody>{dados.chamadas.map((c: any) => (
              <tr key={c.id}>
                <td className="nowrap">{quando(c.em)}</td>
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
      {cred && <CredencialUmaVez cred={cred} aoFechar={() => setCred(null)} />}
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
              <td className="num">{numero(e.resumo?.eventos)}{e.resumo?.bloqueios ? <div className="dica">{numero(e.resumo.bloqueios)} não couberam</div> : null}</td>
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
  const [f, setF] = useState({ nome: poc.nome, lancamentosPorArquivo: String(poc.lancamentosPorArquivo) });
  const leitor = usuario.papel === 'leitor';
  const salvar = async () => {
    if ((await acao.executar(() => put(`/pocs/${poc.id}`, { nome: f.nome, lancamentosPorArquivo: Number(f.lancamentosPorArquivo) }), 'POC salva.')) !== undefined) aoMudar();
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
        </div>
        <dl className="kv" style={{ marginTop: 14 }}>
          <dt>CNPJ</dt><dd className="mono">{poc.cnpj}</dd>
          <dt>Competência</dt><dd>{competenciaBr(poc.competencia)}</dd>
          <dt>Criada</dt><dd>{quando(poc.criadoEm)} · {poc.criadoPor}</dd>
        </dl>
      </Painel>
      {usuario.papel === 'root' && (
        <Painel titulo="Fim da POC">
          <div className="linha-flex">
            <p style={{ flex: '1 1 320px' }}>Ao fim da POC, apague-a: os XMLs do cliente saem com ela (D-MG-12). A credencial do IBS emulado deixa de valer na hora.</p>
            <button className="botao perigo" disabled={acao.ocupado} onClick={apagar}>Apagar a POC</button>
          </div>
        </Painel>
      )}
    </div>
  );
}
