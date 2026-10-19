import { get } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { Cabecalho, CaixaErro, Carregando, Painel, SeloExecucao, Vazio, numero, quando, useCarregar } from '../ui.tsx';

export function Execucoes() {
  const { navegar } = useRota();
  const { dados, erro, carregando } = useCarregar(() => get('/execucoes'), [], 4000);
  return (
    <div className="pagina">
      <Cabecalho titulo="Execuções" sub="Cada geração de massa: o retrato do que a produziu, o envio, a conferência e a trilha." />
      <CaixaErro erro={erro} />
      <Painel semPad>
        {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo="Nenhuma execução">Gere a massa a partir de um <Link para="/cenarios">cenário</Link>.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Execução</th><th>Cenário</th><th>Destino</th><th>Situação</th><th className="num">Registros</th><th className="num">Conforme</th><th className="num">Divergentes</th><th>Gerada por</th></tr></thead>
            <tbody>{dados.map((e: any) => (
              <tr key={e.id} className="clicavel" onClick={() => navegar(`/execucoes/${e.id}`)}>
                <td><Link para={`/execucoes/${e.id}`}><span className="mono">{e.codigo}</span></Link><div className="dica">{quando(e.criadoEm)}</div></td>
                <td>{e.cenarioNome}<div className="dica">semente {e.semente} · ref. {e.dataReferencia}</div></td>
                <td>{e.destinoNome ?? '—'}</td>
                <td><SeloExecucao status={e.status} />{e.etapa && <div className="dica">{e.etapa}</div>}</td>
                <td className="num">{numero(e.total)}</td><td className="num">{numero(e.ok)}</td>
                <td className="num">{e.divergentes + e.erros + e.bloqueados ? <span style={{ color: 'var(--aviso)' }}>{numero(e.divergentes + e.erros + e.bloqueados)}</span> : '0'}</td>
                <td className="dica">{e.criadoPor ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
    </div>
  );
}
