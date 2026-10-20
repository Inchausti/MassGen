import { useState } from 'react';
import { baixar, del, get, patch, post } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import {
  Abas, Cabecalho, CaixaErro, Carregando, Gaveta, Json, Metodo, Painel, SeloExecucao, SeloRegistro, SeloStatusHttp, Vazio, numero, quando, useAcao, useAvisos, useCarregar,
} from '../ui.tsx';
import { DetalheRequisicao, Monitor } from './Monitor.tsx';

type Aba = 'massa' | 'envio' | 'monitor' | 'conferencia' | 'rastreio';
const ATIVOS = ['enviando', 'conferindo'];

export function ExecucaoDetalhe({ id }: { id: string }) {
  const { busca, navegar } = useRota();
  const [aba, setAba] = useState<Aba>((busca.get('aba') as Aba) || 'massa');
  const [ativa, setAtiva] = useState(false);
  const e = useCarregar(async () => {
    const r = await get(`/execucoes/${id}`);
    setAtiva(r.ativa || ATIVOS.includes(r.status));
    return r;
  }, [id], ativa ? 1500 : 6000);
  const acao = useAcao();
  const mudarAba = (a: Aba) => { setAba(a); navegar(`/execucoes/${id}?aba=${a}`, true); };
  if (e.carregando && !e.dados) return <div className="pagina"><Carregando /></div>;
  if (!e.dados) return <div className="pagina"><CaixaErro erro={e.erro} /></div>;
  const x = e.dados;
  const fazer = async (rota: string, msg: string) => { const r = await acao.executar(() => post(`/execucoes/${id}/${rota}`), msg); if (r) { setAtiva(true); e.recarregar(true); } };
  const pendentes = x.pendentes;
  const falhas = x.erros + x.bloqueados;
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para="/execucoes">Execuções</Link>}
        titulo={<>Execução <span className="mono">{x.codigo}</span> <SeloExecucao status={x.status} /></>}
        sub={<>{x.cenarioNome} → {x.destinoNome ?? 'destino removido'} · semente <span className="mono">{x.semente}</span> · referência {x.dataReferencia} · {numero(x.total)} registros{x.etapa ? ` · ${x.etapa}` : ''}</>}
        acoes={<>
          {['gerada', 'pausada', 'interrompida'].includes(x.status) && pendentes > 0 && <button className="botao primario" disabled={acao.ocupado} onClick={() => fazer(x.status === 'gerada' ? 'enviar' : 'retomar', 'Envio iniciado.')}>{x.status === 'gerada' ? 'Enviar ao destino' : 'Retomar envio'}</button>}
          {ATIVOS.includes(x.status) && <button className="botao" onClick={() => fazer('pausar', 'Pausa pedida: termina o registro atual.')}>Pausar</button>}
          {(ATIVOS.includes(x.status) || ['pausada', 'interrompida'].includes(x.status)) && <button className="botao perigo" onClick={() => confirm('Cancelar o envio? Os registros já enviados ficam no destino.') && fazer('cancelar', 'Cancelamento pedido.')}>Cancelar</button>}
          {['concluida', 'cancelada', 'interrompida'].includes(x.status) && falhas > 0 && <button className="botao" onClick={() => fazer('reenviar-falhas', 'Reenvio das falhas iniciado.')}>Reenviar falhas ({falhas})</button>}
          {!ATIVOS.includes(x.status) && <button className="botao" onClick={async () => { const r = await acao.executar(() => post(`/execucoes/${id}/repetir`), 'Nova execução gerada com a mesma semente.'); if (r) navegar(`/execucoes/${r.id}`); }}>Repetir (mesma semente)</button>}
          <button className="botao" onClick={() => acao.executar(() => baixar(`/execucoes/${id}/rastreabilidade`), 'Pacote de evidências baixado.')}>Evidências</button>
          {!ATIVOS.includes(x.status) && <button className="botao perigo" onClick={async () => { if (confirm('Apagar a execução com os registros e as requisições? A trilha de auditoria registra a remoção.') && (await acao.executar(() => del(`/execucoes/${id}`), 'Execução apagada.')) !== undefined) navegar('/execucoes'); }}>Apagar</button>}
        </>}
      />
      <CaixaErro erro={acao.erro} />
      {x.erro && <div className={`alerta ${x.status === 'erro' || x.status === 'interrompida' ? 'erro' : 'aviso'}`}><div>{x.erro.startsWith('[') ? `Avisos da geração: ${JSON.parse(x.erro).join(' · ')}` : x.erro}</div></div>}
      {x.comAviso > 0 && x.status === 'gerada' && <div className="alerta aviso"><div>{x.comAviso} registro(s) com aviso de regra ou campo obrigatório. Veja na aba Massa, filtro "Com aviso", antes de enviar.</div></div>}
      <Progresso x={x} />
      <Abas<Aba> abas={[
        { id: 'massa', rotulo: 'Massa', contagem: numero(x.total) }, { id: 'envio', rotulo: 'Envio' }, { id: 'monitor', rotulo: 'Monitor de requisições' },
        { id: 'conferencia', rotulo: 'Conferência', contagem: x.divergentes + falhas || undefined }, { id: 'rastreio', rotulo: 'Rastreabilidade' },
      ]} ativa={aba} aoMudar={mudarAba} />
      {aba === 'massa' && <Massa execucao={x} />}
      {aba === 'envio' && <Envio execucao={x} ativa={ativa} />}
      {aba === 'monitor' && <Monitor execucaoId={id} ativo={ativa} />}
      {aba === 'conferencia' && <Conferencia execucao={x} />}
      {aba === 'rastreio' && <Rastreabilidade execucao={x} />}
    </div>
  );
}

function Progresso({ x }: { x: any }) {
  const pct = (n: number) => `${x.total ? (n / x.total) * 100 : 0}%`;
  return (
    <div className="pilha" style={{ gap: 6 }}>
      <div className="progresso" role="img" aria-label={`${x.ok} conformes, ${x.divergentes} divergentes, ${x.erros} erros, ${x.bloqueados} bloqueados, ${x.pendentes} pendentes`}>
        <span className="ok" style={{ width: pct(x.ok) }} /><span className="aviso" style={{ width: pct(x.divergentes) }} /><span className="erro" style={{ width: pct(x.erros) }} /><span className="neutro" style={{ width: pct(x.bloqueados) }} />
      </div>
      <div className="legenda">
        <span><i style={{ background: 'var(--ok)' }} />{numero(x.ok)} conforme o gabarito</span>
        <span><i style={{ background: 'var(--aviso)' }} />{numero(x.divergentes)} divergentes</span>
        <span><i style={{ background: 'var(--erro)' }} />{numero(x.erros)} erros</span>
        <span><i style={{ background: 'var(--neutro)' }} />{numero(x.bloqueados)} bloqueados</span>
        <span><i style={{ background: 'var(--neutro-suave)' }} />{numero(x.pendentes)} pendentes</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- massa

const FILTROS = [['', 'Todos'], ['pendente', 'Pendentes'], ['ok', 'Conformes'], ['divergente', 'Divergentes'], ['erro', 'Erros'], ['bloqueado', 'Bloqueados'], ['caso', 'Casos de borda'], ['aviso', 'Com aviso']];

function Massa({ execucao }: { execucao: any }) {
  const [entidade, setEntidade] = useState(execucao.entidades[0]?.entidade ?? '');
  const [resultado, setResultado] = useState('');
  const [texto, setTexto] = useState('');
  const [pagina, setPagina] = useState(1);
  const q = new URLSearchParams({ pagina: String(pagina), tamanho: '50', ...(entidade ? { entidade } : {}), ...(resultado ? { resultado } : {}), ...(texto ? { busca: texto } : {}) });
  const lista = useCarregar(() => get(`/execucoes/${execucao.id}/registros?${q}`), [q.toString(), execucao.status, execucao.ok]);
  const [aberto, setAberto] = useState<string | null>(null);
  const acao = useAcao();
  const paginas = Math.max(1, Math.ceil((lista.dados?.total ?? 0) / 50));
  return (
    <div className="pilha">
      <div className="linha-flex">
        <Abas abas={execucao.entidades.map((e: any) => ({ id: e.entidade, rotulo: e.entidade, contagem: e.total }))} ativa={entidade} aoMudar={(v) => { setEntidade(v); setPagina(1); }} />
        <span className="espaco" />
        <button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/execucoes/${execucao.id}/exportar?formato=csv&entidade=${entidade}`))}>CSV desta entidade</button>
        <button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/execucoes/${execucao.id}/exportar?formato=json`))}>JSON da massa</button>
      </div>
      <div className="linha-flex">
        <select value={resultado} onChange={(e) => { setResultado(e.target.value); setPagina(1); }} style={{ maxWidth: 200 }} aria-label="Filtro">{FILTROS.map(([v, r]) => <option key={v} value={v}>{r}</option>)}</select>
        <input type="search" placeholder="Buscar no rótulo, nos dados ou no id do destino" value={texto} onChange={(e) => { setTexto(e.target.value); setPagina(1); }} style={{ maxWidth: 360 }} />
        <span className="dica">{numero(lista.dados?.total)} registro(s)</span>
      </div>
      <Painel semPad>
        {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.itens.length ? <Vazio titulo="Nenhum registro com este filtro" /> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>#</th><th>Registro</th><th>Perfil</th><th>Caso de borda</th><th>Esperado</th><th>Situação</th><th>Id no destino</th></tr></thead>
            <tbody>{lista.dados.itens.map((r: any) => (
              <tr key={r.id} className={`clicavel ${aberto === r.id ? 'selecionada' : ''}`} onClick={() => setAberto(r.id)}>
                <td className="mono fraco">{r.indice}</td>
                <td>{r.rotulo}{r.cadastroId && <span className="selo destaque sem-ponto" style={{ marginLeft: 6 }}>cadastro</span>}{r.avisos.length > 0 && <span className="selo aviso sem-ponto" style={{ marginLeft: 6 }} title={r.avisos.join('\n')}>{r.avisos.length} aviso(s)</span>}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.perfil ?? '—'}</td>
                <td>{r.caso ? <span className="selo info sem-ponto mono">{r.caso}</span> : <span className="dica">—</span>}</td>
                <td className="mono nowrap" style={{ fontSize: 12 }}>{JSON.stringify(r.esperado.status)}{r.esperado.codigo ? ` ${r.esperado.codigo}` : ''}</td>
                <td><SeloRegistro status={r.status} resultado={r.resultado} />{r.obtido?.status && <span className="dica mono"> {r.obtido.status}</span>}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.idRemoto ?? <span className="dica">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {paginas > 1 && <div className="linha-flex"><button className="botao pequeno" disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>Anterior</button><span className="dica">Página {pagina} de {paginas}</span><button className="botao pequeno" disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)}>Próxima</button></div>}
      {aberto && <DetalheRegistro id={aberto} aoFechar={() => setAberto(null)} aoMudar={() => lista.recarregar(true)} />}
    </div>
  );
}

function DetalheRegistro({ id, aoFechar, aoMudar }: { id: string; aoFechar: () => void; aoMudar: () => void }) {
  const r = useCarregar(() => get(`/registros/${id}`), [id]);
  const [editando, setEditando] = useState<string | null>(null);
  const [req, setReq] = useState<number | null>(null);
  const acao = useAcao();
  const avisar = useAvisos();
  const d = r.dados;
  if (req !== null) return <DetalheRequisicao id={req} aoFechar={() => setReq(null)} aoTrocar={setReq} />;
  const salvar = async () => {
    let dados;
    try { dados = JSON.parse(editando!); } catch { alert('JSON inválido.'); return; }
    const n = await acao.executar(() => patch(`/registros/${id}`, { dados }), 'Registro atualizado.');
    if (n) { setEditando(null); r.recarregar(true); aoMudar(); }
  };
  return (
    <Gaveta titulo={d?.rotulo ?? 'Registro'} sub={d ? `${d.entidade} ${d.indice}${d.perfil ? ` · perfil ${d.perfil}` : ''}${d.caso ? ` · caso ${d.caso}` : ''}` : undefined} aoFechar={aoFechar}
      acoes={d && <>
        {d.status === 'gerado' && editando === null && <button className="botao pequeno" onClick={() => setEditando(JSON.stringify(d.dados, null, 2))}>Editar</button>}
        <button className="botao pequeno" onClick={async () => {
          const c = await acao.executar(() => post(`/registros/${id}/salvar-cadastro`, { etiquetas: [] }));
          if (c) {
            avisar(c.paisSalvos?.length ? `Salvo como cadastro mestre, junto com ${c.paisSalvos.map((p: any) => `${p.entidade} ${p.rotulo}`).join(', ')}, que a integração exige.` : 'Salvo como cadastro mestre.');
            aoMudar();
          }
        }}>Salvar como cadastro</button>
      </>}>
      {r.carregando && !d ? <Carregando /> : !d ? <CaixaErro erro={r.erro} /> : (
        <>
          <CaixaErro erro={acao.erro} />
          <div className="linha-flex"><SeloRegistro status={d.status} resultado={d.resultado} />{d.idRemoto && <span className="dica">id no destino <span className="mono">{d.idRemoto}</span></span>}</div>
          {d.avisos.length > 0 && <div className="alerta aviso"><div><strong>Avisos da geração</strong><ul>{d.avisos.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div></div>}
          {d.diferencas.length > 0 && <div className={`alerta ${d.resultado === 'ok' ? 'info' : 'aviso'}`}><div><strong>Diferenças para o gabarito</strong><ul>{d.diferencas.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul></div></div>}
          <div className="lado-a-lado">
            <div><div className="rotulo">Esperado no envio</div><Json valor={d.esperado} alturaMax={180} /></div>
            <div><div className="rotulo">Conferência depois do envio</div><Json valor={d.conferencia ?? 'sem conferência'} alturaMax={180} /></div>
          </div>
          <Painel titulo="Dados" acoes={editando !== null && <><button className="botao pequeno" onClick={() => setEditando(null)}>Cancelar</button><button className="botao pequeno primario" disabled={acao.ocupado} onClick={salvar}>Salvar</button></>}>
            {editando !== null ? <textarea rows={22} value={editando} onChange={(e) => setEditando(e.target.value)} /> : <Json valor={d.dados} alturaMax={520} />}
            {editando !== null && <p className="dica" style={{ marginTop: 6 }}>As regras do modelo rodam de novo ao salvar. A edição entra na trilha de auditoria.</p>}
          </Painel>
          <Painel titulo="Linha do tempo">
            {!d.linhaDoTempo.length ? <p className="dica">Ainda não enviado.</p> : (
              <ul className="tempo">{d.linhaDoTempo.map((t: any) => (
                <li key={t.id}><div className="linha-flex" style={{ gap: 8 }}>
                  <button className="botao fantasma pequeno mono" onClick={() => setReq(t.id)}>#{t.id}</button>
                  <span>{t.fase}</span><Metodo m={t.metodo} /><SeloStatusHttp status={t.status} />{t.codigoErro && <span className="mono dica">{t.codigoErro}</span>}
                  <span className="quando">{quando(t.criadoEm)} · {t.duracaoMs} ms{t.tentativa > 1 ? ` · tentativa ${t.tentativa}` : ''}</span>
                </div></li>
              ))}</ul>
            )}
          </Painel>
        </>
      )}
    </Gaveta>
  );
}

// ---------------------------------------------------------------- envio

function Envio({ execucao, ativa }: { execucao: any; ativa: boolean }) {
  const p = useCarregar(() => get(`/execucoes/${execucao.id}/painel`), [execucao.id], ativa ? 1500 : undefined);
  const d = p.dados;
  return (
    <div className="pilha">
      <div className="grade grade-4">
        <div className="painel numero"><div className="rot">Requisições</div><div className="val">{numero(d?.total)}</div><div className="det">{numero(d?.ultimoMinuto)} no último minuto</div></div>
        <div className="painel numero"><div className="rot">Tempo médio</div><div className="val">{d?.mediaMs ?? '—'}{d?.mediaMs ? <span style={{ fontSize: 14 }}> ms</span> : ''}</div><div className="det">por chamada</div></div>
        <div className="painel numero"><div className="rot">Por status</div><div className="val" style={{ fontSize: 15, marginTop: 6 }}>{Object.entries(d?.faixas ?? {}).map(([k, v]) => <span key={k} className={`selo sem-ponto ${k === '2xx' ? 'ok' : k === 'erro' || k === '5xx' ? 'erro' : 'aviso'}`} style={{ marginRight: 6 }}>{k} · {numero(v as number)}</span>)}</div></div>
        <div className="painel numero"><div className="rot">Limite do destino</div><div className="val">{d?.limite ? `${d.limite.restante}/${d.limite.limite}` : '—'}</div><div className="det">{d?.limite ? `reinicia em ${d.limite.reinicio} s` : 'sem cabeçalho RateLimit'}</div></div>
      </div>
      <div className="lado-a-lado">
        <Painel titulo="Por entidade" semPad>
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Entidade</th><th className="num">Total</th><th className="num">Pendentes</th><th className="num">Conformes</th><th className="num">Divergentes</th><th className="num">Erro / bloqueado</th></tr></thead>
            <tbody>{execucao.entidades.map((e: any) => (
              <tr key={e.entidade}><td className="mono">{e.entidade}</td><td className="num">{numero(e.total)}</td><td className="num">{numero((e.status.gerado ?? 0) + (e.status.enviando ?? 0))}</td>
                <td className="num">{numero(e.resultado.ok)}</td><td className="num">{numero(e.resultado.divergente)}</td><td className="num">{numero((e.resultado.erro ?? 0) + (e.resultado.bloqueado ?? 0))}</td></tr>
            ))}</tbody>
          </table></div>
        </Painel>
        <Painel titulo="Erros mais frequentes" semPad>
          {!d?.errosFrequentes?.length ? <Vazio titulo="Nenhum erro" /> : (
            <div className="tabela-wrap"><table className="tabela"><thead><tr><th>Status</th><th>Código</th><th className="num">Vezes</th></tr></thead>
              <tbody>{d.errosFrequentes.map((x: any, i: number) => <tr key={i}><td><SeloStatusHttp status={x.status} /></td><td className="mono">{x.codigo ?? '—'}</td><td className="num">{numero(x.n)}</td></tr>)}</tbody></table></div>
          )}
          <p className="dica" style={{ padding: '10px 12px' }}>Recusa esperada pelo gabarito (caso de borda) aparece aqui também e conta como conforme.</p>
        </Painel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- conferência

function Conferencia({ execucao }: { execucao: any }) {
  const [filtro, setFiltro] = useState('divergente');
  const lista = useCarregar(() => get(`/execucoes/${execucao.id}/registros?resultado=${filtro}&tamanho=200`), [filtro, execucao.ok, execucao.status]);
  const [aberto, setAberto] = useState<string | null>(null);
  return (
    <div className="pilha">
      <div className="grade grade-4">
        {[['ok', 'Conformes', 'ok'], ['divergente', 'Divergentes', 'aviso'], ['erro', 'Erros', 'erro'], ['bloqueado', 'Bloqueados', '']].map(([k, r, c]) => (
          <button key={k} className="painel numero" style={{ textAlign: 'left', cursor: 'pointer', outline: filtro === k ? '2px solid var(--destaque)' : undefined }} onClick={() => setFiltro(k)}>
            <div className="rot">{r}</div><div className="val">{numero(k === 'ok' ? execucao.ok : k === 'divergente' ? execucao.divergentes : k === 'erro' ? execucao.erros : execucao.bloqueados)}</div>
            <div className="det"><span className={`selo ${c}`}>{k === 'ok' ? 'como o gabarito' : k === 'bloqueado' ? 'pai sem id no destino' : 'ver lista'}</span></div>
          </button>
        ))}
      </div>
      <Painel titulo="Registros" semPad>
        {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.itens.length ? <Vazio titulo="Nenhum registro nesta situação" /> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Registro</th><th>Caso</th><th>Esperado</th><th>Obtido</th><th>Diferenças</th></tr></thead>
            <tbody>{lista.dados.itens.map((r: any) => (
              <tr key={r.id} className="clicavel" onClick={() => setAberto(r.id)}>
                <td>{r.rotulo}<div className="dica mono">{r.entidade} {r.indice}</div></td>
                <td>{r.caso ? <span className="selo info sem-ponto mono">{r.caso}</span> : '—'}</td>
                <td className="mono" style={{ fontSize: 12 }}>{JSON.stringify(r.esperado.status)}{r.esperado.codigo ? ` ${r.esperado.codigo}` : ''}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.obtido?.status ?? '—'}{r.obtido?.codigo ? ` ${r.obtido.codigo}` : ''}</td>
                <td style={{ fontSize: 12.5 }}>{r.diferencas.join(' ') || '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {aberto && <DetalheRegistro id={aberto} aoFechar={() => setAberto(null)} aoMudar={() => lista.recarregar(true)} />}
    </div>
  );
}

// ---------------------------------------------------------------- rastreabilidade

function Rastreabilidade({ execucao }: { execucao: any }) {
  const trilha = useCarregar(() => get(`/execucoes/${execucao.id}/trilha`), [execucao.id, execucao.status]);
  const [integ, setInteg] = useState<any>(null);
  const acao = useAcao();
  const verificar = async () => { const r = await acao.executar(() => get('/auditoria/integridade')); if (r) setInteg(r); };
  return (
    <div className="pilha">
      <CaixaErro erro={acao.erro} />
      <div className="lado-a-lado">
        <Painel titulo="O que produziu esta massa" acoes={<button className="botao pequeno primario" onClick={() => acao.executar(() => baixar(`/execucoes/${execucao.id}/rastreabilidade`), 'Pacote de evidências baixado.')}>Baixar evidências</button>}>
          <dl className="kv">
            <dt>Código</dt><dd className="mono">{execucao.codigo}</dd>
            <dt>Cenário</dt><dd>{execucao.cenarioNome}</dd>
            <dt>Semente</dt><dd className="mono">{execucao.semente}</dd>
            <dt>Data de referência</dt><dd>{execucao.dataReferencia}</dd>
            <dt>Pacote</dt><dd>{execucao.pacoteId} {execucao.pacoteVersao}</dd>
            <dt>Hash dos modelos</dt><dd className="mono" style={{ fontSize: 11.5 }}>{execucao.modelosHash ?? '—'}</dd>
            <dt>Gerada por</dt><dd>{execucao.criadoPor ?? '—'} · {quando(execucao.criadoEm)}</dd>
            <dt>Enviada por</dt><dd>{execucao.enviadoPor ?? '—'}{execucao.iniciadoEm ? ` · ${quando(execucao.iniciadoEm)}` : ''}</dd>
            <dt>Terminou</dt><dd>{quando(execucao.finalizadoEm)}</dd>
          </dl>
          <div className="rotulo" style={{ marginTop: 12 }}>Destino como estava na geração</div>
          <Json valor={execucao.destinoRetrato ?? '—'} alturaMax={220} />
          <p className="dica" style={{ marginTop: 8 }}>Cada chamada leva o cabeçalho de rastreio <span className="mono">MG-{execucao.codigo}-&lt;entidade&gt;-&lt;n&gt;-&lt;fase&gt;-&lt;tentativa&gt;</span>, para achar a chamada nos logs do destino.</p>
        </Painel>
        <Painel titulo="Integridade" acoes={<button className="botao pequeno" onClick={verificar}>Verificar agora</button>}>
          <p className="dica">A trilha de auditoria e as requisições são encadeadas por hash (SHA-256): cada linha guarda o hash da anterior. Uma linha alterada ou removida quebra a cadeia.</p>
          {integ && (
            <div className="pilha" style={{ marginTop: 10 }}>
              {(['auditoria', 'requisicoes'] as const).map((k) => (
                <div key={k} className={`alerta ${integ[k].ok ? 'ok' : 'erro'}`}><div><strong>{k === 'auditoria' ? 'Trilha de auditoria' : 'Requisições'}:</strong> {integ[k].ok ? `íntegra (${numero(integ[k].total)} linhas)` : `falha na linha #${integ[k].primeiraFalha.id} — ${integ[k].primeiraFalha.motivo}`}</div></div>
              ))}
              <span className="dica">Verificado em {quando(integ.verificadoEm)}</span>
            </div>
          )}
        </Painel>
      </div>
      <Painel titulo="Trilha da execução">
        {trilha.carregando && !trilha.dados ? <Carregando /> : !trilha.dados?.length ? <p className="dica">Nada registrado.</p> : (
          <ul className="tempo">{trilha.dados.map((t: any) => (
            <li key={t.id}><div><div><span className="selo sem-ponto mono" style={{ marginRight: 8 }}>{t.acao}</span>{t.resumo}</div><div className="quando">{quando(t.em)} · {t.usuario} · {t.maquina}</div></div></li>
          ))}</ul>
        )}
      </Painel>
    </div>
  );
}
