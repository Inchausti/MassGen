// Histórico da nota (T-MG-02): cada evento que o IBS emulado planejou, disponibilizou, avisou e entregou para a
// operação desta nota, com o saldo dos sete campos do extrato e a linha exata que saiu no arquivo.
import { useState } from 'react';
import { baixar, get } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { useSessao } from '../sessao.tsx';
import { Cabecalho, CaixaErro, Carregando, Gaveta, Json, Painel, Vazio, quando, useAcao, useCarregar } from '../ui.tsx';
import { ROTULO_FINALIDADE, ROTULO_PAPEL_NOTA, SeloAviso, SeloEvento, diaBr, efeito, moeda } from './Pocs.tsx';

const origemEvento = (e: any) =>
  e.origem === 'roteiro' ? `Roteiro ${e.roteiro}` : `${e.origem === 'prerequisito' ? 'Pré-requisito do envio' : 'Envio'} nº ${e.envio?.numero ?? '—'}`;

function GavetaEvento({ e, campos, pocId, aoFechar }: { e: any; campos: any[]; pocId: string; aoFechar: () => void }) {
  const { navegar } = useRota();
  const a = e.arquivo;
  return (
    <Gaveta titulo={<><span className="mono">{e.tipo}</span> {e.mov}</>} sub={`${diaBr(e.dia)} · ${origemEvento(e)}${e.envio?.por ? ` · ${e.envio.por}` : ''}`} aoFechar={aoFechar}
      acoes={a && <button className="botao pequeno" onClick={() => navegar(`/pocs/${pocId}?aba=barramento`)}>Ver no barramento</button>}>
      <dl className="kv">
        <dt>Situação</dt><dd><SeloEvento situacao={e.situacao} />{e.forcado && <span className="selo erro sem-ponto">Forçado</span>}</dd>
        {e.motivo && <><dt>Motivo</dt><dd>{e.motivo}</dd></>}
        <dt>Valor</dt><dd>{moeda(e.valor)}</dd>
        <dt>Efeito</dt><dd>{efeito(e.valores, campos)}</dd>
        {e.lancamentoId && <><dt>Lançamento</dt><dd className="mono">{e.lancamentoId}</dd></>}
        {e.hash && <><dt>Hash acumulado</dt><dd className="mono quebra">{e.hash}</dd></>}
      </dl>
      {e.linha ? <><h3>Linha no extrato_cc</h3><Json valor={e.linha} /></> : <p className="dica">A linha do extrato nasce quando o relógio fecha o dia {diaBr(e.dia)}.</p>}
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
    </Gaveta>
  );
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
  const campos = catalogo.dados?.campos ?? dados.saldos.map((s: any) => ({ campo: s.campo, rotulo: s.rotulo }));
  const evento = dados.historico.find((e: any) => e.id === aberto);
  const contra = n.papel === 'fornecedor' ? n.destinatario : n.emitente;
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<><Link para="/pocs">POCs</Link> › <Link para={`/pocs/${pocId}`}>{poc.dados?.nome ?? 'POC'}</Link> › Notas</>}
        titulo={<>{n.rotulo} {n.papel && <span className={`selo sem-ponto ${n.papel === 'adquirente' ? 'info' : 'destaque'}`}>{ROTULO_PAPEL_NOTA[n.papel]}</span>}</>}
        sub={<>{contra?.nome ?? contra?.doc ?? '—'} · emitida em {quando(n.emissao)} · IBS {moeda(n.vIbs)}</>}
        acoes={<>
          <button className="botao" onClick={() => acao.executar(() => baixar(`/pocs/${pocId}/notas/${notaId}/xml`))}>Ver XML</button>
          {usuario.papel !== 'leitor' && n.situacao === 'aceita' && <button className="botao primario" onClick={() => navegar(`/pocs/${pocId}?aba=enviar&notas=${notaId}`)}>Enviar eventos</button>}
        </>}
      />
      <CaixaErro erro={acao.erro} />
      {n.situacao === 'fora' && <div className="alerta aviso"><div>Esta nota ficou de fora da POC: {n.motivo}.</div></div>}
      {op.id !== n.id && (
        <div className="alerta info"><div>Nota {ROTULO_FINALIDADE[n.finalidade]?.toLowerCase()} da <Link para={`/pocs/${pocId}/notas/${op.id}`}>{op.rotulo}</Link>. No IBS, os eventos ficam na operação da nota original; o histórico abaixo é o dela.</div></div>
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
            <dt>CBS</dt><dd>{moeda(n.vCbs)} <span className="dica">entra na etapa 2</span></dd>
            {op.operacaoId && <><dt>Operação no arquivo</dt><dd className="mono">{op.operacaoId}</dd></>}
            <dt>Arquivo importado</dt><dd className="mono quebra">{n.nomeArquivo ?? '—'}</dd>
          </dl>
        </Painel>
        <Painel titulo="Saldos da operação no extrato" semPad>
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Campo</th><th className="num">No barramento</th><th className="num">Com o planejado</th></tr></thead>
            <tbody>{dados.saldos.map((s: any) => (
              <tr key={s.campo}>
                <td><span className="mono">{s.campo}</span> <span className="dica">{s.rotulo}</span></td>
                <td className="num">{moeda(s.noEnte)}</td>
                <td className="num">{s.comPlanejado !== s.noEnte ? <strong>{moeda(s.comPlanejado)}</strong> : <span className="fraco">{moeda(s.comPlanejado)}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="painel-corpo dica">No barramento: o que já saiu em algum Delta. Com o planejado: depois dos eventos que o relógio ainda vai soltar.</div>
        </Painel>
      </div>
      {dados.relacionadas.length > 0 && (
        <Painel titulo="Notas ligadas a esta operação" semPad>
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Nota</th><th>Finalidade</th><th>Emissão</th><th className="num">IBS</th></tr></thead>
            <tbody>{dados.relacionadas.map((r: any) => (
              <tr key={r.id} className="clicavel" onClick={() => navegar(`/pocs/${pocId}/notas/${r.id}`)}>
                <td><Link para={`/pocs/${pocId}/notas/${r.id}`}>{r.rotulo}</Link><div className="dica mono quebra">{r.chave}</div></td>
                <td>{ROTULO_FINALIDADE[r.finalidade] ?? r.finalidade}</td>
                <td className="nowrap">{quando(r.emissao)}</td>
                <td className="num">{moeda(r.vIbs)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Painel>
      )}
      <Painel titulo="Histórico no IBS" semPad>
        {!dados.historico.length ? <Vazio titulo="Nenhum evento">Aplique um roteiro na aba Notas da POC ou envie eventos sob demanda.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Dia</th><th>Evento</th><th>Origem</th><th className="num">Valor</th><th>Efeito no extrato</th><th>Situação</th><th>Arquivo</th></tr></thead>
            <tbody>{dados.historico.map((e: any) => (
              <tr key={e.id} className="clicavel" onClick={() => setAberto(e.id)}>
                <td className="nowrap">{diaBr(e.dia)}</td>
                <td><span className="mono">{e.tipo}</span><div className="dica">{e.mov}</div></td>
                <td>{origemEvento(e)}{e.forcado && <div><span className="selo erro sem-ponto">Forçado</span></div>}</td>
                <td className="num">{moeda(e.valor)}</td>
                <td>{efeito(e.valores, campos)}</td>
                <td><SeloEvento situacao={e.situacao} />{e.motivo && e.situacao !== 'recebido' && <div className="dica">{e.motivo}</div>}</td>
                <td>{e.arquivo ? <><span className="mono">{e.arquivo.idArq}</span><div className="dica">{e.arquivo.downloads.total ? `baixado ${e.arquivo.downloads.total}×` : 'sem download'}</div></> : <span className="dica">—</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {dados.cabecalhoOperacao && (
        <Painel titulo="Cabeçalho da operação no arquivo">
          <p className="dica" style={{ marginBottom: 10 }}>Repete-se em cada parte quando a operação é fatiada; a lista de lançamentos vai embaixo dele (Anexo I).</p>
          <Json valor={dados.cabecalhoOperacao} />
        </Painel>
      )}
      {evento && <GavetaEvento e={evento} campos={campos} pocId={pocId} aoFechar={() => setAberto(null)} />}
    </div>
  );
}
