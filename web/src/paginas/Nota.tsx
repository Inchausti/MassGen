// Histórico da nota (T-MG-02): cada evento que os entes emulados planejaram, disponibilizaram, avisaram e entregaram
// para esta nota. No IBS, a operação, com o saldo dos sete campos do extrato e a linha exata que saiu no arquivo; na
// CBS, o documento, com os saldos da foto e a foto como ficou depois de cada evento.
import { useState } from 'react';
import { baixar, get } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { useSessao } from '../sessao.tsx';
import { Cabecalho, CaixaErro, Carregando, Gaveta, Json, Painel, Vazio, quando, useAcao, useCarregar } from '../ui.tsx';
import { ROTULO_FINALIDADE, ROTULO_PAPEL_NOTA, SeloAviso, SeloEnte, SeloEvento, diaBr, efeitoDoItem, moeda } from './Pocs.tsx';

const origemEvento = (e: any) =>
  e.origem === 'roteiro' ? `Roteiro ${e.roteiro}` : `${e.origem === 'prerequisito' ? 'Pré-requisito do envio' : 'Envio'} nº ${e.envio?.numero ?? '—'}`;

function GavetaEvento({ e, catalogo, pocId, aoFechar }: { e: any; catalogo: any; pocId: string; aoFechar: () => void }) {
  const { navegar } = useRota();
  const a = e.arquivo;
  const cbs = e.ente === 'cbs';
  return (
    <Gaveta titulo={<><SeloEnte ente={e.ente} /> <span className="mono">{e.tipo}</span> {e.mov}</>} sub={`${diaBr(e.dia)} · ${origemEvento(e)}${e.envio?.por ? ` · ${e.envio.por}` : ''}`} aoFechar={aoFechar}
      acoes={(a || e.tiquetes?.length) && <button className="botao pequeno" onClick={() => navegar(`/pocs/${pocId}?aba=barramento`)}>Ver no barramento</button>}>
      <dl className="kv">
        <dt>Situação</dt><dd><SeloEvento situacao={e.situacao} />{e.forcado && <span className="selo erro sem-ponto">Forçado</span>}</dd>
        {e.motivo && <><dt>Motivo</dt><dd>{e.motivo}</dd></>}
        <dt>Valor</dt><dd>{moeda(e.valor)}</dd>
        <dt>Efeito</dt><dd>{efeitoDoItem(e, catalogo)}</dd>
        {cbs && <><dt>Documento</dt><dd>{e.documento.rotulo}{e.endpoint && <span className="dica mono"> · /{e.endpoint}</span>}</dd></>}
        {cbs && e.atualizacao && <><dt>atualizacao</dt><dd className="mono">{e.atualizacao}</dd></>}
        {e.lancamentoId && <><dt>Lançamento</dt><dd className="mono">{e.lancamentoId}</dd></>}
        {e.hash && <><dt>Hash acumulado</dt><dd className="mono quebra">{e.hash}</dd></>}
      </dl>
      {cbs ? (e.foto
        ? <><h3>{e.endpoint === 'debitos' || e.endpoint === 'creditos' ? `Foto em /${e.endpoint} depois deste evento` : `Registro em /${e.endpoint}`}</h3><Json valor={e.foto} /></>
        : <p className="dica">A foto muda quando o relógio fechar o dia {diaBr(e.dia)}.</p>)
        : e.linha ? <><h3>Linha no extrato_cc</h3><Json valor={e.linha} /></> : <p className="dica">A linha do extrato nasce quando o relógio fecha o dia {diaBr(e.dia)}.</p>}
      {a && <>
        <h3>Arquivo</h3>
        <dl className="kv">
          <dt>Nome</dt><dd className="mono quebra">{a.nome}</dd>
          <dt>idArq</dt><dd className="mono">{a.idArq}</dd>
          {a.solicitacao && <><dt>Solicitação</dt><dd><span className="mono">{a.solicitacao.idSolic}</span> · {a.solicitacao.tipo} · {a.solicitacao.situacao}</dd></>}
          <dt>Aviso</dt><dd><SeloAviso a={a.aviso} />{a.aviso?.erro && <div className="dica">{a.aviso.erro}</div>}</dd>
          <dt>Download</dt><dd>{a.downloads.total ? `${a.downloads.total}× · primeiro ${quando(a.downloads.primeiro)}${a.downloads.total > 1 ? ` · último ${quando(a.downloads.ultimo)}` : ''}` : 'O SplitHub ainda não baixou.'}</dd>
        </dl>
      </>}
      {cbs && <>
        <h3>Tíquetes que levaram este evento</h3>
        {!e.tiquetes.length ? <p className="dica">Nenhum ainda. Sem urlRetorno validada, o evento espera a coleta por pedido do SplitHub.</p> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Tíquete</th><th>Origem</th><th>Aviso</th><th>Link</th></tr></thead>
            <tbody>{e.tiquetes.map((t: any) => (
              <tr key={t.id}>
                <td className="mono">{t.tiquete.slice(0, 8)}…</td>
                <td>{t.origem === 'pedido' ? 'Pedido' : 'Sem pedido'}</td>
                <td><SeloAviso a={t.aviso} /></td>
                <td>{t.downloads ? `baixado ${t.downloads}×` : t.expirado ? <span className="selo aviso sem-ponto">vencido</span> : <span className="dica">até {quando(t.expiraEm)}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </>}
    </Gaveta>
  );
}

function TabelaSaldos({ saldos, rodape }: { saldos: any[]; rodape: string }) {
  return <>
    <div className="tabela-wrap"><table className="tabela">
      <thead><tr><th>Campo</th><th className="num">No barramento</th><th className="num">Com o planejado</th></tr></thead>
      <tbody>{saldos.map((s: any) => (
        <tr key={s.campo}>
          <td><span className="mono">{s.campo}</span> <span className="dica">{s.rotulo}{s.derivado ? ' · calculado' : ''}</span></td>
          <td className="num">{moeda(s.noEnte)}</td>
          <td className="num">{s.comPlanejado !== s.noEnte ? <strong>{moeda(s.comPlanejado)}</strong> : <span className="fraco">{moeda(s.comPlanejado)}</span>}</td>
        </tr>
      ))}</tbody>
    </table></div>
    <div className="painel-corpo dica">{rodape}</div>
  </>;
}

export function NotaDetalhe({ pocId, notaId }: { pocId: string; notaId: string }) {
  const { navegar } = useRota();
  const { usuario } = useSessao();
  const acao = useAcao();
  const poc = useCarregar(() => get(`/pocs/${pocId}`), [pocId]);
  const catalogo = useCarregar(() => get('/catalogo/eventos'), []);
  const { dados, erro } = useCarregar(() => get(`/pocs/${pocId}/notas/${notaId}`), [pocId, notaId], 5000);
  const [aberto, setAberto] = useState<string | null>(null);
  if (!dados) return <div className="pagina">{erro ? <CaixaErro erro={erro} /> : <Carregando />}</div>;
  const n = dados.nota;
  const op = dados.operacao;
  const cat = catalogo.dados ?? { campos: dados.saldos.map((s: any) => ({ campo: s.campo, rotulo: s.rotulo })), camposCbs: [] };
  const evento = dados.historico.find((e: any) => e.id === aberto);
  const contra = n.papel === 'fornecedor' ? n.destinatario : n.emitente;
  // Com o planejado, só mostra os campos que mexem: a foto da CBS tem quinze, e a maioria fica em zero.
  const comValor = (saldos: any[]) => saldos.filter((s) => s.noEnte || s.comPlanejado || s.derivado);
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<><Link para="/pocs">POCs</Link> › <Link para={`/pocs/${pocId}`}>{poc.dados?.nome ?? 'POC'}</Link> › Notas</>}
        titulo={<>{n.rotulo} {n.papel && <span className={`selo sem-ponto ${n.papel === 'adquirente' ? 'info' : 'destaque'}`}>{ROTULO_PAPEL_NOTA[n.papel]}</span>}</>}
        sub={<>{contra?.nome ?? contra?.doc ?? '—'} · emitida em {quando(n.emissao)} · IBS {moeda(n.vIbs)} · CBS {moeda(n.vCbs)}</>}
        acoes={<>
          <button className="botao" onClick={() => acao.executar(() => baixar(`/pocs/${pocId}/notas/${notaId}/xml`))}>Ver XML</button>
          {usuario.papel !== 'leitor' && n.situacao === 'aceita' && <button className="botao primario" onClick={() => navegar(`/pocs/${pocId}?aba=enviar&notas=${notaId}`)}>Enviar eventos</button>}
        </>}
      />
      <CaixaErro erro={acao.erro} />
      {n.situacao === 'fora' && <div className="alerta aviso"><div>Esta nota ficou de fora da POC: {n.motivo}.</div></div>}
      {op.id !== n.id && (
        <div className="alerta info"><div>Nota {ROTULO_FINALIDADE[n.finalidade]?.toLowerCase()} da <Link para={`/pocs/${pocId}/notas/${op.id}`}>{op.rotulo}</Link>. No IBS, os eventos ficam na operação da nota original; na CBS, esta nota é um documento próprio, e só o ajuste (E-CBS-D07) muda a foto da original.</div></div>
      )}
      <div className="lado-a-lado">
        <Painel titulo="Nota">
          <dl className="kv">
            <dt>Chave</dt><dd className="mono">{n.chave}</dd>
            <dt>Série e número</dt><dd>{n.serie ?? '—'} · {n.numero ?? '—'}</dd>
            <dt>Finalidade</dt><dd>{ROTULO_FINALIDADE[n.finalidade] ?? n.finalidade}{n.canceladaEm && <> · <span className="selo erro sem-ponto">Cancelada em {quando(n.canceladaEm)}</span></>}</dd>
            <dt>Autorização</dt><dd>{quando(n.autorizacao)}</dd>
            <dt>Emitente</dt><dd>{n.emitente.nome ?? '—'} <span className="dica mono">{n.emitente.doc}</span></dd>
            <dt>Destinatário</dt><dd>{n.destinatario.nome ?? '—'} <span className="dica mono">{n.destinatario.doc}</span></dd>
            <dt>IBS</dt><dd>{moeda(n.vIbs)} <span className="dica">UF {moeda(n.vIbsUf)} · município {moeda(n.vIbsMun)}</span></dd>
            <dt>CBS</dt><dd>{moeda(n.vCbs)}</dd>
            {op.operacaoId && <><dt>Operação no arquivo</dt><dd className="mono">{op.operacaoId}</dd></>}
            <dt>Arquivo importado</dt><dd className="mono quebra">{n.nomeArquivo ?? '—'}</dd>
          </dl>
        </Painel>
        <Painel titulo="IBS · saldos da operação no extrato" semPad>
          <TabelaSaldos saldos={dados.saldos} rodape="No barramento: o que já saiu em algum Delta. Com o planejado: depois dos eventos que o relógio ainda vai soltar." />
        </Painel>
      </div>
      {dados.documentosCbs.map((d: any) => (
        <Painel key={d.id} titulo={<>CBS · saldos da foto {d.id === n.id ? 'deste documento' : <>de <Link para={`/pocs/${pocId}/notas/${d.id}`}>{d.rotulo}</Link></>}</>} semPad>
          <TabelaSaldos saldos={comValor(d.saldos)} rodape="Os campos da foto que têm valor e os três que ela traz calculados (saldo devedor, a apropriar e saldo credor). No barramento: o que a Receita Federal emulada já publicou." />
        </Painel>
      ))}
      {dados.relacionadas.length > 0 && (
        <Painel titulo="Notas ligadas a esta operação" semPad>
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Nota</th><th>Finalidade</th><th>Emissão</th><th className="num">IBS · CBS</th></tr></thead>
            <tbody>{dados.relacionadas.map((r: any) => (
              <tr key={r.id} className="clicavel" onClick={() => navegar(`/pocs/${pocId}/notas/${r.id}`)}>
                <td><Link para={`/pocs/${pocId}/notas/${r.id}`}>{r.rotulo}</Link><div className="dica mono quebra">{r.chave}</div></td>
                <td>{ROTULO_FINALIDADE[r.finalidade] ?? r.finalidade}</td>
                <td className="nowrap">{quando(r.emissao)}</td>
                <td className="num">{moeda(r.vIbs)}<div className="dica">CBS {moeda(r.vCbs)}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        </Painel>
      )}
      <Painel titulo="Histórico nos dois entes" semPad>
        {!dados.historico.length ? <Vazio titulo="Nenhum evento">Aplique um roteiro na aba Notas da POC ou envie eventos sob demanda.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Dia</th><th>Ente</th><th>Evento</th><th>Origem</th><th className="num">Valor</th><th>Efeito</th><th>Situação</th><th>Arquivo</th></tr></thead>
            <tbody>{dados.historico.map((e: any) => {
              const tiq = e.tiquetes?.at(-1);
              return (
                <tr key={e.id} className="clicavel" onClick={() => setAberto(e.id)}>
                  <td className="nowrap">{diaBr(e.dia)}</td>
                  <td><SeloEnte ente={e.ente} />{e.ente === 'cbs' && e.documento.id !== n.id && <div className="dica">{e.documento.rotulo}</div>}</td>
                  <td><span className="mono">{e.tipo}</span><div className="dica">{e.mov}</div></td>
                  <td>{origemEvento(e)}{e.forcado && <div><span className="selo erro sem-ponto">Forçado</span></div>}</td>
                  <td className="num">{moeda(e.valor)}</td>
                  <td>{efeitoDoItem(e, cat)}</td>
                  <td><SeloEvento situacao={e.situacao} />{e.motivo && e.situacao !== 'recebido' && <div className="dica">{e.motivo}</div>}</td>
                  <td>{e.arquivo ? <><span className="mono">{e.arquivo.idArq}</span><div className="dica">{e.arquivo.downloads.total ? `baixado ${e.arquivo.downloads.total}×` : 'sem download'}</div></>
                    : tiq ? <><span className="mono">{tiq.tiquete.slice(0, 8)}…</span><div className="dica">{e.tiquetes.length > 1 ? `${e.tiquetes.length} tíquetes · ` : ''}{tiq.downloads ? `baixado ${tiq.downloads}×` : 'sem download'}</div></>
                    : <span className="dica">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Painel>
      {dados.cabecalhoOperacao && (
        <Painel titulo="IBS · cabeçalho da operação no arquivo">
          <p className="dica" style={{ marginBottom: 10 }}>Repete-se em cada parte quando a operação é fatiada; a lista de lançamentos vai embaixo dele (Anexo I).</p>
          <Json valor={dados.cabecalhoOperacao} />
        </Painel>
      )}
      {evento && <GavetaEvento e={evento} catalogo={cat} pocId={pocId} aoFechar={() => setAberto(null)} />}
    </div>
  );
}
