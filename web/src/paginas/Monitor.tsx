import { useState } from 'react';
import { get, post } from '../api.ts';
import { CaixaErro, Carregando, Gaveta, Json, Metodo, Painel, SeloRegistro, SeloStatusHttp, Vazio, copiar, quando, useAcao, useAvisos, useCarregar } from '../ui.tsx';

const FASES: Record<string, string> = { envio: 'Envio', conferencia: 'Conferência', token: 'Token', teste: 'Teste', reenvio: 'Reenvio' };

// Lista de requisições com filtros e o detalhe de cada uma. Atualiza sozinha enquanto há envio.
export function Monitor({ execucaoId, ativo }: { execucaoId?: string; ativo?: boolean }) {
  const [fase, setFase] = useState('');
  const [faixa, setFaixa] = useState('');
  const [entidade, setEntidade] = useState('');
  const [texto, setTexto] = useState('');
  const [limite, setLimite] = useState(100);
  const [aberta, setAberta] = useState<number | null>(null);
  const q = new URLSearchParams({ limite: String(limite), ...(execucaoId ? { execucao: execucaoId } : {}), ...(fase ? { fase } : {}), ...(faixa ? { faixa } : {}), ...(entidade ? { entidade } : {}), ...(texto ? { busca: texto } : {}) });
  const lista = useCarregar(() => get(`/requisicoes?${q}`), [q.toString()], ativo ? 1500 : undefined);
  return (
    <div className="pilha">
      <div className="linha-flex">
        <select value={fase} onChange={(e) => setFase(e.target.value)} style={{ maxWidth: 160 }} aria-label="Fase"><option value="">Todas as fases</option>{Object.entries(FASES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={faixa} onChange={(e) => setFaixa(e.target.value)} style={{ maxWidth: 160 }} aria-label="Status"><option value="">Todo status</option><option value="2xx">2xx</option><option value="4xx">4xx</option><option value="429">429</option><option value="5xx">5xx</option><option value="erro">Sem resposta</option></select>
        <input type="search" placeholder="Entidade" value={entidade} onChange={(e) => setEntidade(e.target.value.trim())} style={{ maxWidth: 140 }} />
        <input type="search" placeholder="Buscar na URL, nos corpos ou no registro" value={texto} onChange={(e) => setTexto(e.target.value)} style={{ maxWidth: 320 }} />
        {ativo && <span className="selo destaque">Ao vivo</span>}
      </div>
      <CaixaErro erro={lista.erro} />
      <Painel semPad>
        {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.length ? <Vazio titulo="Nenhuma requisição" /> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>#</th><th>Quando</th><th>Fase</th><th>Chamada</th><th>Status</th><th className="num">ms</th><th>Registro</th><th>Resultado</th></tr></thead>
            <tbody>{lista.dados.map((r: any) => (
              <tr key={r.id} className={`clicavel ${aberta === r.id ? 'selecionada' : ''}`} onClick={() => setAberta(r.id)}>
                <td className="mono fraco">{r.id}</td>
                <td className="nowrap" style={{ fontSize: 12 }}>{quando(r.criadoEm).slice(11)}</td>
                <td className="nowrap">{FASES[r.fase] ?? r.fase}{r.tentativa > 1 && <span className="selo aviso sem-ponto" style={{ marginLeft: 6 }}>tent. {r.tentativa}</span>}</td>
                <td className="quebra" style={{ maxWidth: 420 }}><Metodo m={r.metodo} /> <span className="mono" style={{ fontSize: 12 }}>{r.url.replace(/^https?:\/\/[^/]+/, '')}</span></td>
                <td><SeloStatusHttp status={r.status} />{r.codigoErro && <div className="dica mono">{r.codigoErro}</div>}</td>
                <td className="num">{r.duracaoMs}</td>
                <td style={{ fontSize: 12.5 }}>{r.registroRotulo ?? <span className="dica">—</span>}{r.registroCaso && <div className="dica mono">caso {r.registroCaso}</div>}</td>
                <td>{r.resultado === 'ok' ? <span className="selo ok">Conforme</span> : r.resultado === 'divergente' ? <span className="selo aviso">Divergente</span> : r.resultado === 'erro' ? <span className="selo erro">Erro</span> : <span className="dica">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {(lista.dados?.length ?? 0) >= limite && <div><button className="botao" onClick={() => setLimite(limite + 200)}>Carregar mais</button></div>}
      {aberta !== null && <DetalheRequisicao id={aberta} aoFechar={() => setAberta(null)} aoTrocar={setAberta} />}
    </div>
  );
}

function curl(r: any): string {
  const cab = Object.entries(r.requisicao.cabecalhos as Record<string, string>)
    .map(([k, v]) => (/^authorization$/i.test(k) ? `-H '${k}: Bearer $TOKEN'` : /••••/.test(v) ? `-H '${k}: $SEGREDO'` : `-H '${k}: ${v.replace(/'/g, "'\\''")}'`));
  const corpo = r.requisicao.corpo !== null && r.requisicao.corpo !== undefined ? `--data '${JSON.stringify(r.requisicao.corpo).replace(/'/g, "'\\''")}'` : '';
  return [`curl -X ${r.metodo} '${r.url}'`, ...cab, corpo].filter(Boolean).join(' \\\n  ');
}

export function DetalheRequisicao({ id, aoFechar, aoTrocar }: { id: number; aoFechar: () => void; aoTrocar?: (id: number) => void }) {
  const r = useCarregar(() => get(`/requisicoes/${id}`), [id]);
  const acao = useAcao();
  const avisar = useAvisos();
  const reenviar = async (novaChave: boolean) => {
    const msg = novaChave ? 'Reenviar com uma chave de idempotência nova? O destino trata como uma chamada nova.' : 'Reenviar com a mesma chave? O destino deve devolver a mesma resposta, sem duplicar.';
    if (!confirm(msg)) return;
    const n = await acao.executar(() => post(`/requisicoes/${id}/reenviar`, { novaChave }), 'Registro reenviado: veja a nova requisição.');
    if (n && aoTrocar) aoTrocar(n.id);
  };
  const d = r.dados;
  return (
    <Gaveta
      titulo={d ? <><Metodo m={d.metodo} /> <span className="mono" style={{ fontSize: 14 }}>{d.url.replace(/^https?:\/\/[^/]+/, '')}</span></> : 'Requisição'}
      sub={d ? `#${d.id} · ${FASES[d.fase] ?? d.fase} · ${quando(d.criadoEm)} · ${d.usuario ?? ''}` : undefined}
      aoFechar={aoFechar}
      acoes={d && <>
        <button className="botao pequeno" onClick={() => copiar(curl(d), avisar, 'curl copiado, sem o token.')}>Copiar curl</button>
        {d.registro && ['envio', 'reenvio'].includes(d.fase) && <>
          <button className="botao pequeno" disabled={acao.ocupado} onClick={() => reenviar(false)}>Reenviar</button>
          <button className="botao pequeno" disabled={acao.ocupado} onClick={() => reenviar(true)}>Reenviar com chave nova</button>
        </>}
      </>}
    >
      {r.carregando && !d ? <Carregando /> : !d ? <CaixaErro erro={r.erro} /> : (
        <>
          <CaixaErro erro={acao.erro} />
          <div className="linha-flex"><SeloStatusHttp status={d.status} /><span className="dica">{d.duracaoMs} ms · tentativa {d.tentativa}</span>{d.codigoErro && <span className="selo aviso sem-ponto mono">{d.codigoErro}</span>}{d.erro && <span className="selo erro">{d.erro}</span>}</div>
          <Painel titulo="Rastreio">
            <dl className="kv">
              <dt>Código de rastreio</dt><dd className="mono">{d.rastreio ?? '—'} {d.rastreio && <button className="botao fantasma pequeno" onClick={() => copiar(d.rastreio, avisar)}>copiar</button>}</dd>
              <dt>Chave de idempotência</dt><dd className="mono">{d.chaveIdempotencia ?? '—'}</dd>
              <dt>Disparado por</dt><dd>{d.usuario ?? '—'}</dd>
              <dt>Hash do corpo enviado</dt><dd className="mono" style={{ fontSize: 11.5 }}>{d.corpoHash ?? '—'}</dd>
              <dt>Hash da linha</dt><dd className="mono" style={{ fontSize: 11.5 }}>{d.hash ?? '—'}</dd>
            </dl>
          </Painel>
          {d.registro && (
            <Painel titulo={<>Registro: {d.registro.rotulo}</>} acoes={<SeloRegistro status={d.registro.status} resultado={d.registro.resultado} />}>
              <div className="lado-a-lado">
                <div><div className="rotulo">Esperado</div><Json valor={d.registro.esperado} alturaMax={160} />{d.registro.conferencia && <><div className="rotulo" style={{ marginTop: 8 }}>Conferência</div><Json valor={d.registro.conferencia.esperado} alturaMax={160} /></>}</div>
                <div><div className="rotulo">Obtido</div><Json valor={d.registro.obtido ?? 'ainda nada'} alturaMax={160} />
                  {d.registro.diferencas?.length > 0 && <div className="alerta aviso" style={{ marginTop: 8 }}><div><ul style={{ margin: 0 }}>{d.registro.diferencas.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div></div>}</div>
              </div>
              {d.registro.idRemoto && <p className="dica" style={{ marginTop: 8 }}>Id no destino: <span className="mono">{d.registro.idRemoto}</span></p>}
            </Painel>
          )}
          <Painel titulo="Enviado"><div className="pilha"><Json valor={d.requisicao.cabecalhos} alturaMax={200} />{d.requisicao.corpo !== null && <Json valor={d.requisicao.corpo} alturaMax={420} />}</div></Painel>
          <Painel titulo="Recebido"><div className="pilha"><Json valor={d.resposta.cabecalhos} alturaMax={200} />{d.resposta.corpo !== null && <Json valor={d.resposta.corpo} alturaMax={420} />}</div></Painel>
        </>
      )}
    </Gaveta>
  );
}

