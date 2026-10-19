import { useEffect, useMemo, useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { Cabecalho, CaixaErro, Campo, Carregando, Painel, SeloExecucao, Vazio, numero, relativo, useAcao, useCarregar } from '../ui.tsx';

export function Cenarios() {
  const { navegar } = useRota();
  const lista = useCarregar(() => get('/cenarios'));
  const pacotes = useCarregar(() => get('/pacotes'));
  const destinos = useCarregar(() => get('/destinos'));
  const acao = useAcao();
  const usar = async (pacoteId: string, cenarioId: string) => {
    const destino = destinos.dados?.find((d: any) => d.pacoteId === pacoteId);
    const c = await acao.executar(() => post('/cenarios/do-pacote', { pacoteId, cenarioId, destinoId: destino?.id }), 'Cenário criado.');
    if (c) navegar(`/cenarios/${c.id}`);
  };
  const novoEmBranco = async (pacoteId: string) => {
    const modelos = await get(`/modelos?pacote=${pacoteId}`);
    const destino = destinos.dados?.find((d: any) => d.pacoteId === pacoteId);
    const c = await acao.executar(() => post('/cenarios', { nome: 'Novo cenário', pacoteId, destinoId: destino?.id, definicao: { entidades: [{ entidade: modelos[0].nome, quantidade: 1 }] } }), 'Cenário criado.');
    if (c) navegar(`/cenarios/${c.id}`);
  };
  return (
    <div className="pagina">
      <Cabecalho titulo="Cenários" sub="O que a massa testa: quais entidades, quantas, em quais perfis, com quais cadastros e casos de borda. Mesmo cenário e mesma semente geram a mesma massa." />
      <CaixaErro erro={lista.erro ?? acao.erro} />
      <Painel titulo="Seus cenários" semPad>
        {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.length ? <Vazio titulo="Nenhum cenário">Comece por um cenário pronto do pacote, abaixo.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Cenário</th><th>Entidades</th><th>Destino</th><th>Última execução</th></tr></thead>
            <tbody>{lista.dados.map((c: any) => (
              <tr key={c.id} className="clicavel" onClick={() => navegar(`/cenarios/${c.id}`)}>
                <td><Link para={`/cenarios/${c.id}`}>{c.nome}</Link><div className="dica">{c.pacoteId} · alterado {relativo(c.atualizadoEm)}</div></td>
                <td style={{ fontSize: 12.5 }}>{c.definicao.entidades.map((e: any) => `${e.entidade} ${e.porPai ? `(${e.porPai.min}–${e.porPai.max} por ${e.porPai.relacao})` : `×${e.quantidade ?? 0}`}`).join(' · ')}</td>
                <td>{destinos.dados?.find((d: any) => d.id === c.destinoId)?.nome ?? <span className="dica">—</span>}</td>
                <td>{c.ultimaExecucao ? <><SeloExecucao status={c.ultimaExecucao.status} /> <span className="mono dica">{c.ultimaExecucao.codigo}</span></> : <span className="dica">Nunca</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {(pacotes.dados ?? []).map((p: any) => (
        <Painel key={p.id} titulo={`Cenários prontos — ${p.nome}`} acoes={<button className="botao pequeno" onClick={() => novoEmBranco(p.id)}>Cenário em branco</button>} semPad>
          <div className="tabela-wrap"><table className="tabela"><tbody>
            {p.cenarios.map((c: any) => <tr key={c.id}><td className="nowrap"><strong>{c.nome}</strong></td><td>{c.descricao}</td><td className="nowrap"><button className="botao pequeno primario" onClick={() => usar(p.id, c.id)}>Usar como base</button></td></tr>)}
          </tbody></table></div>
        </Painel>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- editor

function ordenar(modelos: Record<string, any>, nomes: string[]): string[] {
  const saida: string[] = [];
  const vis = new Set<string>();
  const v = (n: string) => {
    if (vis.has(n)) return;
    vis.add(n);
    for (const r of modelos[n]?.relacoes ?? []) if (!r.via && nomes.includes(r.entidade)) v(r.entidade);
    saida.push(n);
  };
  nomes.forEach(v);
  return saida;
}

export function CenarioEditor({ id }: { id: string }) {
  const { navegar } = useRota();
  const cen = useCarregar(() => get(`/cenarios/${id}`), [id]);
  const [c, setC] = useState<any>(null);
  useEffect(() => { if (cen.dados) setC(structuredClone(cen.dados)); }, [cen.dados]);
  const resumos = useCarregar(() => (cen.dados ? get(`/modelos?pacote=${cen.dados.pacoteId}`) : Promise.resolve([])), [cen.dados?.pacoteId]);
  const modelos = useCarregar(async () => {
    const r: Record<string, any> = {};
    for (const m of resumos.dados ?? []) r[m.nome] = (await get(`/modelos/${m.id}`)).definicao;
    return r;
  }, [resumos.dados]);
  const destinos = useCarregar(() => get('/destinos'));
  const cadastros = useCarregar(() => get('/cadastros'));
  const [semente, setSemente] = useState('');
  const [data, setData] = useState('');
  const acao = useAcao();

  const ms = modelos.dados ?? {};
  const destino = destinos.dados?.find((d: any) => d.id === c?.destinoId);
  const estimativa = useMemo(() => {
    if (!c) return null;
    const contagem: Record<string, number> = {};
    for (const n of ordenar(ms, c.definicao.entidades.map((e: any) => e.entidade))) {
      const e = c.definicao.entidades.find((x: any) => x.entidade === n);
      if (!e) continue;
      const cad = e.cadastros?.length ?? 0;
      if (e.porPai) {
        const rel = ms[n]?.relacoes?.find((r: any) => r.nome === e.porPai.relacao);
        const pais = contagem[rel?.entidade] ?? 0;
        contagem[n] = Math.round(pais * (Number(e.porPai.min) + Number(e.porPai.max)) / 2) + cad;
      } else contagem[n] = (Number(e.quantidade) || 0) + cad;
    }
    const total = Object.values(contagem).reduce((s, x) => s + x, 0);
    const conferencias = Object.entries(contagem).reduce((s, [n, x]) => s + (ms[n]?.conferencia ? x * 2 : 0), 0);
    const porMinuto = destino?.limites?.porMinuto ?? 600;
    return { contagem, total, requisicoes: total + conferencias, minutos: (total + conferencias) / porMinuto };
  }, [c, ms, destino]);

  if (cen.carregando && !cen.dados) return <div className="pagina"><Carregando /></div>;
  if (!c) return <div className="pagina"><CaixaErro erro={cen.erro} /></div>;
  const def = c.definicao;
  const usadas = new Set(def.entidades.map((e: any) => e.entidade));
  const setEnt = (i: number, p: any) => setC({ ...c, definicao: { ...def, entidades: def.entidades.map((e: any, j: number) => (j === i ? { ...e, ...p } : e)) } });
  const salvar = async () => {
    const r = await acao.executar(() => put(`/cenarios/${id}`, { nome: c.nome, pacoteId: c.pacoteId, destinoId: c.destinoId || null, definicao: def }), 'Cenário salvo.');
    if (r) cen.setDados(r);
    return r;
  };
  const gerar = async () => {
    if (!(await salvar())) return;
    const e = await acao.executar(() => post(`/cenarios/${id}/gerar`, { semente: semente.trim(), dataReferencia: data || undefined }), 'Massa gerada.');
    if (e) navegar(`/execucoes/${e.id}`);
  };
  const destinosDoPacote = (destinos.dados ?? []).filter((d: any) => d.pacoteId === c.pacoteId);
  const ordem = ordenar(ms, def.entidades.map((e: any) => e.entidade));
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para="/cenarios">Cenários</Link>}
        titulo={<input type="text" aria-label="Nome do cenário" value={c.nome} onChange={(e) => setC({ ...c, nome: e.target.value })} style={{ fontSize: 20, fontWeight: 650, border: 0, padding: 0, background: 'transparent', minWidth: 320 }} />}
        sub={`Pacote ${c.pacoteId}. Ajuste as seções e gere a massa: nada vai para o destino antes da pré-visualização.`}
        acoes={<>
          <button className="botao perigo" onClick={async () => { if (confirm('Remover o cenário? As execuções ficam.') && (await acao.executar(() => del(`/cenarios/${id}`), 'Cenário removido.')) !== undefined) navegar('/cenarios'); }}>Remover</button>
          <button className="botao" disabled={acao.ocupado} onClick={salvar}>Salvar</button>
          <button className="botao primario" disabled={acao.ocupado || !c.destinoId} onClick={gerar}>Gerar massa</button>
        </>}
      />
      <div className="passos" aria-label="Passos do assistente">
        {['Destino', 'Entidades', 'Perfis', 'Cadastros', 'Casos de borda', 'Ordem', 'Resumo'].map((p, i) => (
          <div key={p} className={`passo-item ${i === 0 ? (c.destinoId ? 'feito' : '') : 'feito'}`}><span className="bola">{i + 1}</span>{p}</div>
        ))}
      </div>
      <CaixaErro erro={acao.erro} />

      <Painel titulo="1 · Destino">
        <div className="grade grade-3">
          <Campo rotulo="Destino" ajuda="As variáveis do destino (como o comprador) entram na massa.">
            <select value={c.destinoId ?? ''} onChange={(e) => setC({ ...c, destinoId: e.target.value || null })}>
              <option value="">Escolha…</option>
              {destinosDoPacote.map((d: any) => <option key={d.id} value={d.id}>{d.nome}</option>)}
            </select>
          </Campo>
          <Campo rotulo="Semente" ajuda="Vazio: uma nova a cada geração. Repetir a semente repete a massa."><input type="text" inputMode="numeric" value={semente} onChange={(e) => setSemente(e.target.value.replace(/\D/g, ''))} placeholder={def.semente ? String(def.semente) : 'aleatória'} /></Campo>
          <Campo rotulo="Data de referência" ajuda="Datas da massa são relativas a ela. Vazio: hoje."><input type="date" value={data} onChange={(e) => setData(e.target.value)} /></Campo>
        </div>
        {!destinosDoPacote.length && <div className="alerta aviso" style={{ marginTop: 12 }}><div>Nenhum destino usa o pacote {c.pacoteId}. <Link para="/destinos/novo">Cadastre um destino</Link>.</div></div>}
        {destino && Object.entries(destino.variaveis).some(([, v]) => !v) && <div className="alerta aviso" style={{ marginTop: 12 }}><div>O destino tem variáveis vazias: {Object.entries(destino.variaveis).filter(([, v]) => !v).map(([k]) => k).join(', ')}. Preencha em <Link para={`/destinos/${destino.id}?aba=config`}>Configuração</Link>.</div></div>}
      </Painel>

      <Painel titulo="2 a 5 · Entidades, perfis, cadastros e casos de borda" acoes={
        <select value="" onChange={(e) => e.target.value && setC({ ...c, definicao: { ...def, entidades: [...def.entidades, { entidade: e.target.value, quantidade: 1 }] } })} aria-label="Adicionar entidade">
          <option value="">Adicionar entidade…</option>
          {(resumos.dados ?? []).filter((m: any) => !usadas.has(m.nome)).map((m: any) => <option key={m.nome} value={m.nome}>{m.rotulo}</option>)}
        </select>
      }>
        {modelos.carregando && !modelos.dados ? <Carregando /> : (
          <div className="pilha" style={{ gap: 18 }}>
            {def.entidades.map((e: any, i: number) => {
              const m = ms[e.entidade];
              if (!m) return <div key={e.entidade} className="alerta erro"><div>Modelo {e.entidade} não existe no pacote.</div></div>;
              const rels = (m.relacoes ?? []).filter((r: any) => !r.via);
              const cads = (cadastros.dados ?? []).filter((x: any) => x.entidade === e.entidade);
              return (
                <div key={e.entidade} className="painel" style={{ background: 'var(--superficie-2)' }}>
                  <div className="painel-cab"><h3>{m.rotulo} <span className="dica mono">{e.entidade}</span></h3>
                    <div className="acoes"><span className="selo sem-ponto">≈ {numero(estimativa?.contagem[e.entidade])} registros</span>
                      <button className="botao pequeno fantasma" onClick={() => setC({ ...c, definicao: { ...def, entidades: def.entidades.filter((_: any, j: number) => j !== i) } })}>Tirar</button></div></div>
                  <div className="painel-corpo pilha">
                    <div className="grade grade-4">
                      <Campo rotulo="Quantidade">
                        <select value={e.porPai ? 'pai' : 'fixa'} onChange={(x) => setEnt(i, x.target.value === 'pai' && rels[0] ? { porPai: { relacao: rels[0].nome, min: 1, max: 1 }, quantidade: undefined } : { porPai: undefined, quantidade: e.quantidade ?? 1 })}>
                          <option value="fixa">Número fixo</option>{rels.length > 0 && <option value="pai">Por registro pai</option>}
                        </select>
                      </Campo>
                      {e.porPai ? <>
                        <Campo rotulo="Pai"><select value={e.porPai.relacao} onChange={(x) => setEnt(i, { porPai: { ...e.porPai, relacao: x.target.value } })}>{rels.map((r: any) => <option key={r.nome} value={r.nome}>{r.nome} ({r.entidade})</option>)}</select></Campo>
                        <Campo rotulo="Mínimo por pai"><input type="number" min={0} value={e.porPai.min} onChange={(x) => setEnt(i, { porPai: { ...e.porPai, min: Number(x.target.value) } })} /></Campo>
                        <Campo rotulo="Máximo por pai"><input type="number" min={0} value={e.porPai.max} onChange={(x) => setEnt(i, { porPai: { ...e.porPai, max: Number(x.target.value) } })} /></Campo>
                      </> : <Campo rotulo="Registros"><input type="number" min={0} value={e.quantidade ?? 0} onChange={(x) => setEnt(i, { quantidade: Number(x.target.value) })} /></Campo>}
                    </div>
                    {(m.perfis ?? []).length > 0 && (
                      <div><div className="rotulo" style={{ marginBottom: 6 }}>Perfis (peso)</div><div className="grade grade-4">
                        {m.perfis.map((p: any) => (
                          <Campo key={p.nome} rotulo={p.rotulo ?? p.nome}><input type="number" min={0} value={e.perfis?.[p.nome] ?? p.peso} onChange={(x) => setEnt(i, { perfis: { ...Object.fromEntries(m.perfis.map((q: any) => [q.nome, e.perfis?.[q.nome] ?? q.peso])), [p.nome]: Number(x.target.value) } })} /></Campo>
                        ))}
                      </div></div>
                    )}
                    {(m.casos ?? []).length > 0 && (
                      <div><div className="rotulo" style={{ marginBottom: 6 }}>Casos de borda (quantos registros)</div><div className="grade grade-4">
                        {m.casos.map((k: any) => (
                          <Campo key={k.id} rotulo={k.rotulo} ajuda={`esperado ${JSON.stringify(k.esperado.status)}${k.esperado.codigo ? ` ${k.esperado.codigo}` : ''}`}>
                            <input type="number" min={0} value={e.casos?.[k.id] ?? 0} onChange={(x) => { const casos = { ...(e.casos ?? {}), [k.id]: Number(x.target.value) }; if (!casos[k.id]) delete casos[k.id]; setEnt(i, { casos }); }} />
                          </Campo>
                        ))}
                      </div></div>
                    )}
                    <div>
                      <div className="rotulo" style={{ marginBottom: 6 }}>Cadastros mestres a usar ({e.cadastros?.length ?? 0})</div>
                      {!cads.length ? <p className="dica">Nenhum cadastro salvo desta entidade. <Link para="/cadastros">Biblioteca de cadastros</Link></p> : (
                        <div className="chip-lista">{cads.map((x: any) => {
                          const marcado = e.cadastros?.includes(x.id);
                          const vinc = x.vinculos.find((v: any) => v.destinoId === c.destinoId);
                          return <label key={x.id} className="chip" style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!marcado} onChange={(ev) => setEnt(i, { cadastros: ev.target.checked ? [...(e.cadastros ?? []), x.id] : (e.cadastros ?? []).filter((y: string) => y !== x.id) })} />{x.rotulo}{vinc && <span className="selo destaque sem-ponto" title="Já existe no destino: será reaproveitado">no destino</span>}</label>;
                        })}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Painel>

      <div className="lado-a-lado">
        <Painel titulo="6 · Ordem de envio">
          <ol style={{ margin: 0, paddingLeft: 18 }}>{ordem.map((n) => <li key={n}>{ms[n]?.rotulo ?? n}{(ms[n]?.relacoes ?? []).filter((r: any) => !r.via).length > 0 && <span className="dica"> — depois de {(ms[n].relacoes).filter((r: any) => !r.via).map((r: any) => r.entidade).join(', ')}</span>}</li>)}</ol>
          <p className="dica" style={{ marginTop: 8 }}>Derivada das relações: cada pai vai antes dos filhos. Filhos só se ligam a pais sem caso de borda.</p>
        </Painel>
        <Painel titulo="7 · Resumo">
          {estimativa && <dl className="kv">
            <dt>Registros</dt><dd>≈ {numero(estimativa.total)}</dd>
            <dt>Requisições</dt><dd>≈ {numero(estimativa.requisicoes)} (envio e conferência)</dd>
            <dt>Duração</dt><dd>≈ {estimativa.minutos < 1 ? 'menos de 1 minuto' : `${Math.ceil(estimativa.minutos)} minuto(s)`} a {destino?.limites?.porMinuto ?? 600} req/min</dd>
            <dt>Destino</dt><dd>{destino?.nome ?? <span style={{ color: 'var(--aviso)' }}>escolha um destino</span>}</dd>
          </dl>}
        </Painel>
      </div>
    </div>
  );
}
