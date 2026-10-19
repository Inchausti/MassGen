import { get } from '../api.ts';
import { Link } from '../rotas.tsx';
import { Cabecalho, CaixaErro, Carregando, Painel as Bloco, SeloExecucao, Vazio, numero, relativo, useCarregar, ROTULO_AMBIENTE } from '../ui.tsx';

export function Painel() {
  const { dados, erro, carregando } = useCarregar(() => get('/painel'), [], 5000);
  if (carregando && !dados) return <div className="pagina"><Carregando /></div>;
  const d = dados ?? { destinos: [], pacotes: [], execucoes: [], auditoria: [], cenarios: 0, cadastros: 0 };
  const primeiro = !d.destinos.length;
  return (
    <div className="pagina">
      <Cabecalho titulo="Painel" sub="Destinos, execuções recentes e o que aconteceu por último na trilha de auditoria." />
      <CaixaErro erro={erro} />
      {primeiro && (
        <div className="alerta info">
          <div>
            <strong>Comece cadastrando um destino.</strong> Importe a collection e o environment do Postman ou preencha à mão.
            Para testar sem sandbox, rode <code>npm run mock</code> e aponte o destino para <code>http://localhost:8089</code>, com o pacote SplitHub.
            <div style={{ marginTop: 8 }}><Link para="/destinos/novo" className="botao primario pequeno">Cadastrar destino</Link></div>
          </div>
        </div>
      )}
      <div className="grade grade-4">
        <div className="painel numero"><div className="rot">Destinos</div><div className="val">{d.destinos.length}</div><div className="det">{d.destinos.filter((x: any) => x.ultimoTeste?.ok).length} com o último teste ok</div></div>
        <div className="painel numero"><div className="rot">Pacotes</div><div className="val">{d.pacotes.length}</div><div className="det">{d.pacotes.map((p: any) => `${p.nome} ${p.versao}`).join(' · ') || '—'}</div></div>
        <div className="painel numero"><div className="rot">Cenários</div><div className="val">{d.cenarios}</div><div className="det"><Link para="/cenarios">Montar cenário</Link></div></div>
        <div className="painel numero"><div className="rot">Cadastros mestres</div><div className="val">{d.cadastros}</div><div className="det"><Link para="/cadastros">Ver biblioteca</Link></div></div>
      </div>
      <div className="lado-a-lado">
        <Bloco titulo="Execuções recentes" acoes={<Link para="/execucoes" className="botao pequeno">Todas</Link>} semPad>
          {!d.execucoes.length ? <Vazio titulo="Nenhuma execução ainda">Gere a massa a partir de um cenário.</Vazio> : (
            <div className="tabela-wrap"><table className="tabela">
              <thead><tr><th>Execução</th><th>Destino</th><th>Situação</th><th className="num">Conforme</th></tr></thead>
              <tbody>
                {d.execucoes.map((e: any) => (
                  <tr key={e.id}>
                    <td><Link para={`/execucoes/${e.id}`}><span className="mono">{e.codigo}</span></Link><div className="dica">{e.cenarioNome} · {relativo(e.criadoEm)}</div></td>
                    <td>{e.destinoNome ?? '—'}</td>
                    <td><SeloExecucao status={e.status} /></td>
                    <td className="num">{numero(e.ok)} / {numero(e.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Bloco>
        <div className="pilha">
          <Bloco titulo="Destinos" acoes={<Link para="/destinos" className="botao pequeno">Gerenciar</Link>} semPad>
            {!d.destinos.length ? <Vazio titulo="Nenhum destino" /> : (
              <div className="tabela-wrap"><table className="tabela"><tbody>
                {d.destinos.map((x: any) => (
                  <tr key={x.id}>
                    <td><Link para={`/destinos/${x.id}`}>{x.nome}</Link><div className="dica mono quebra">{x.baseUrl}</div></td>
                    <td className="nowrap">{ROTULO_AMBIENTE[x.tipoAmbiente]}</td>
                    <td className="nowrap">{!x.ultimoTeste ? <span className="selo">Sem teste</span> : x.ultimoTeste.ok ? <span className="selo ok">Conexão ok</span> : <span className="selo erro">Falhou</span>}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </Bloco>
          <Bloco titulo="Última atividade" acoes={<Link para="/auditoria" className="botao pequeno">Auditoria</Link>}>
            {!d.auditoria.length ? <p className="dica">Nada registrado ainda.</p> : (
              <ul className="tempo">
                {d.auditoria.map((a: any) => (
                  <li key={a.id}><div><div>{a.resumo}</div><div className="quando">{relativo(a.em)} · {a.usuario}</div></div></li>
                ))}
              </ul>
            )}
          </Bloco>
        </div>
      </div>
    </div>
  );
}
