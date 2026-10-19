import { useState } from 'react';
import { get } from '../api.ts';
import { Link } from '../rotas.tsx';
import { Abas, Cabecalho, CaixaErro, Carregando, Gaveta, Json, Painel, Vazio, numero, quando, useAcao, useCarregar } from '../ui.tsx';
import { Monitor } from './Monitor.tsx';

export function Auditoria() {
  const [aba, setAba] = useState<'trilha' | 'requisicoes'>('trilha');
  const [acaoFiltro, setAcaoFiltro] = useState('');
  const [usuario, setUsuario] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [limite, setLimite] = useState(100);
  const acoes = useCarregar(() => get('/auditoria/acoes'));
  const q = new URLSearchParams({ limite: String(limite), ...(acaoFiltro ? { acao: acaoFiltro } : {}), ...(usuario ? { usuario } : {}), ...(de ? { de } : {}), ...(ate ? { ate } : {}) });
  const lista = useCarregar(() => get(`/auditoria?${q}`), [q.toString()]);
  const [aberto, setAberto] = useState<any>(null);
  const [integ, setInteg] = useState<any>(null);
  const acao = useAcao();
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Auditoria"
        sub="Quem fez o quê, quando, em que máquina e em quê. A trilha é só de inclusão e encadeada por hash, como as requisições: a verificação aponta a primeira linha alterada ou removida. Segredos nunca entram."
        acoes={<button className="botao primario" disabled={acao.ocupado} onClick={async () => { const r = await acao.executar(() => get('/auditoria/integridade')); if (r) setInteg(r); }}>Verificar integridade</button>}
      />
      <CaixaErro erro={lista.erro ?? acao.erro} />
      {integ && (
        <div className="grade grade-2">
          {(['auditoria', 'requisicoes'] as const).map((k) => (
            <div key={k} className={`alerta ${integ[k].ok ? 'ok' : 'erro'}`}><div><strong>{k === 'auditoria' ? 'Trilha de auditoria' : 'Requisições'}:</strong> {integ[k].ok ? `íntegra — ${numero(integ[k].total)} linhas conferidas` : `falha na linha #${integ[k].primeiraFalha.id}. ${integ[k].primeiraFalha.motivo}`}<div className="dica">Verificado em {quando(integ.verificadoEm)}</div></div></div>
          ))}
        </div>
      )}
      <Abas abas={[{ id: 'trilha', rotulo: 'Trilha de auditoria' }, { id: 'requisicoes', rotulo: 'Todas as requisições' }]} ativa={aba} aoMudar={setAba} />
      {aba === 'requisicoes' ? <Monitor /> : (
        <>
          <div className="linha-flex">
            <select value={acaoFiltro} onChange={(e) => setAcaoFiltro(e.target.value)} style={{ maxWidth: 240 }} aria-label="Ação"><option value="">Todas as ações</option>{(acoes.dados ?? []).map((a: string) => <option key={a}>{a}</option>)}</select>
            <input type="search" placeholder="Usuário" value={usuario} onChange={(e) => setUsuario(e.target.value)} style={{ maxWidth: 200 }} />
            <label className="dica">de <input type="date" value={de} onChange={(e) => setDe(e.target.value)} style={{ width: 150 }} /></label>
            <label className="dica">até <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} style={{ width: 150 }} /></label>
          </div>
          <Painel semPad>
            {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.length ? <Vazio titulo="Nada registrado com este filtro" /> : (
              <div className="tabela-wrap"><table className="tabela">
                <thead><tr><th>#</th><th>Quando</th><th>Ação</th><th>O que aconteceu</th><th>Quem</th><th>Máquina</th></tr></thead>
                <tbody>{lista.dados.map((a: any) => (
                  <tr key={a.id} className="clicavel" onClick={() => setAberto(a)}>
                    <td className="mono fraco">{a.id}</td>
                    <td className="nowrap" style={{ fontSize: 12.5 }}>{quando(a.em)}</td>
                    <td><span className="selo sem-ponto mono">{a.acao}</span></td>
                    <td>{a.resumo}{a.execucaoId && <div><Link para={`/execucoes/${a.execucaoId}?aba=rastreio`} className="dica">ver execução</Link></div>}</td>
                    <td style={{ fontSize: 12.5 }}>{a.usuario}</td>
                    <td className="dica">{a.maquina}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Painel>
          {(lista.dados?.length ?? 0) >= limite && <div><button className="botao" onClick={() => setLimite(limite + 200)}>Carregar mais</button></div>}
        </>
      )}
      {aberto && (
        <Gaveta titulo={aberto.resumo} sub={`#${aberto.id} · ${aberto.acao} · ${quando(aberto.em)}`} aoFechar={() => setAberto(null)}>
          <dl className="kv">
            <dt>Quem</dt><dd>{aberto.usuario}</dd>
            <dt>Máquina</dt><dd>{aberto.maquina}</dd>
            <dt>Alvo</dt><dd className="mono">{aberto.alvoTipo ?? '—'} {aberto.alvoId ?? ''}</dd>
            <dt>Execução</dt><dd>{aberto.execucaoId ? <Link para={`/execucoes/${aberto.execucaoId}?aba=rastreio`}>{aberto.execucaoId}</Link> : '—'}</dd>
            <dt>Hash</dt><dd className="mono" style={{ fontSize: 11.5 }}>{aberto.hash}</dd>
          </dl>
          <div><div className="rotulo">Detalhes</div><Json valor={aberto.detalhes} /></div>
        </Gaveta>
      )}
    </div>
  );
}
