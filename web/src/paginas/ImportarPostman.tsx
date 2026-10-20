import { useState } from 'react';
import { lerArquivoJson, post } from '../api.ts';
import { CaixaErro, Campo, Metodo, Painel, useAcao, ROTULO_AUTH } from '../ui.tsx';

const SITUACAO: Record<string, [string, string]> = { nova: ['Nova', 'ok'], alterada: ['Alterada', 'aviso'], mantida: ['Mantida', ''], token: ['Token', 'info'] };

// Importa collection + environment do Postman: prévia (nada é salvo) e depois aplicação.
// Ao aplicar, os dois arquivos também vão para a biblioteca de APIs, com versão, e a integração fica ligada a elas.
export function ImportarPostman({ destinoId, pacotes, ambientes = [], ambienteInicial, aoConcluir }: {
  destinoId?: string; pacotes: any[]; ambientes?: any[]; ambienteInicial?: string | null; aoConcluir: (destinoId: string) => void;
}) {
  const [colecao, setColecao] = useState<{ nome: string; json: unknown } | null>(null);
  const [ambiente, setAmbiente] = useState<{ nome: string; json: unknown } | null>(null);
  const [pacoteId, setPacoteId] = useState<string>(pacotes[0]?.id ?? '');
  const [nome, setNome] = useState('');
  const [tipoAmbiente, setTipoAmbiente] = useState('sandbox');
  const [baseUrl, setBaseUrl] = useState('');
  const [ambienteId, setAmbienteId] = useState<string>(ambienteInicial ?? '');
  const [papel, setPapel] = useState('cliente');
  const [ente, setEnte] = useState('');
  const amb = ambientes.find((a) => a.id === ambienteId);
  const [previa, setPrevia] = useState<any>(null);
  const [resultado, setResultado] = useState<any>(null);
  const acao = useAcao();

  const ler = async (arq: File | undefined, set: (v: { nome: string; json: unknown } | null) => void) => {
    setPrevia(null);
    if (!arq) return set(null);
    const json = await acao.executar(() => lerArquivoJson(arq));
    if (json !== undefined) set({ nome: arq.name, json });
  };

  const verPrevia = async () => {
    const p = await acao.executar(() => post('/importacao/postman/previa', { colecao: colecao?.json, ambiente: ambiente?.json, destinoId, pacoteId: destinoId ? undefined : pacoteId || undefined }));
    if (p) { setPrevia(p); if (!nome) setNome(p.leitura.nomeColecao); }
  };

  const aplicar = async () => {
    const r = await acao.executar(
      () => post('/importacao/postman/aplicar', {
        colecao: colecao?.json, ambiente: ambiente?.json, destinoId, pacoteId: destinoId ? undefined : pacoteId || undefined, nome, tipoAmbiente: amb?.tipo ?? tipoAmbiente,
        baseUrl: baseUrl || undefined, nomeColecao: colecao?.nome, nomeAmbiente: ambiente?.nome,
        ...(destinoId ? {} : { ambienteId: ambienteId || undefined, papel, ente: papel === 'emulador' ? ente : undefined }),
      }),
      'Importação aplicada.',
    );
    if (r) setResultado(r);
  };

  if (resultado) {
    return (
      <Painel titulo="Importação aplicada">
        <div className="pilha">
          <p>{resultado.resumo.operacoes} operações importadas, {resultado.resumo.ligadas} ligadas a entidades{resultado.resumo.doPacote ? `, ${resultado.resumo.doPacote} completadas pelo pacote` : ''}. {resultado.resumo.segredos} segredo(s) foram para o cofre.</p>
          {resultado.biblioteca && <p className="dica">Na biblioteca de APIs: collection v{resultado.biblioteca.colecao.numero}{resultado.biblioteca.colecao.nova ? ' (nova)' : ' (sem mudança)'}{resultado.biblioteca.environment ? ` · environment v${resultado.biblioteca.environment.numero}${resultado.biblioteca.environment.nova ? ' (nova)' : ' (sem mudança)'}` : ''}.</p>}
          {resultado.resumo.segredosVazios.length > 0 && <div className="alerta aviso"><div>O environment trouxe vazios: <strong>{resultado.resumo.segredosVazios.join(', ')}</strong>. Preencha na aba Segredos do destino.</div></div>}
          <Divergencias lista={resultado.divergencias} />
          <div><button className="botao primario" onClick={() => aoConcluir(resultado.destinoId)}>Abrir a integração</button></div>
        </div>
      </Painel>
    );
  }

  const l = previa?.leitura;
  return (
    <div className="pilha" style={{ gap: 16 }}>
      <CaixaErro erro={acao.erro} />
      <Painel titulo="Arquivos do Postman">
        <div className="grade grade-2">
          <Campo rotulo="Collection (obrigatória)" ajuda={colecao ? `Lido: ${colecao.nome}` : 'Exportada do Postman no formato v2.1.'}>
            <input type="file" accept=".json,application/json" onChange={(e) => ler(e.target.files?.[0], setColecao)} />
          </Campo>
          <Campo rotulo="Environment (opcional)" ajuda={ambiente ? `Lido: ${ambiente.nome}` : 'Traz o endereço base, as variáveis e as credenciais. É guardado na biblioteca sem os valores secretos, que vão para o cofre.'}>
            <input type="file" accept=".json,application/json" onChange={(e) => ler(e.target.files?.[0], setAmbiente)} />
          </Campo>
          {!destinoId && <Campo rotulo="Pacote de domínio" ajuda="As requisições são ligadas às entidades do pacote.">
            <select value={pacoteId} onChange={(e) => { setPacoteId(e.target.value); setPrevia(null); }}>
              <option value="">Sem pacote</option>
              {pacotes.map((p) => <option key={p.id} value={p.id}>{p.nome} {p.versao}</option>)}
            </select>
          </Campo>}
        </div>
        <div className="acoes" style={{ marginTop: 14 }}><button className="botao primario" disabled={!colecao || acao.ocupado} onClick={verPrevia}>Ver o que vai entrar</button></div>
      </Painel>

      {previa && (
        <>
          <Painel titulo={`Prévia — ${l.nomeColecao}`}>
            <div className="pilha">
              <dl className="kv">
                <dt>Autenticação</dt><dd>{l.autenticacao ? `${ROTULO_AUTH[l.autenticacao.tipo]}${l.autenticacao.tokenUrl ? ` · token em ${l.autenticacao.tokenUrl}` : ''}` : 'Não identificada — ajuste no destino'}</dd>
                <dt>Endereço base</dt><dd className="mono">{l.baseUrl ?? '—'}{previa.dominio && !previa.dominio.ok && <div className="erro-campo" style={{ color: 'var(--erro)' }}>{previa.dominio.motivo}</div>}</dd>
                <dt>Variáveis mantidas</dt><dd>{Object.keys(l.variaveis).length ? Object.entries(l.variaveis).map(([k, v]) => `${k} = ${v}`).join(' · ') : '—'}</dd>
                <dt>Para o cofre</dt><dd>{l.segredos.length ? l.segredos.join(', ') : '—'}{l.segredosVazios.length > 0 && <span className="dica"> · vazios, a preencher: {l.segredosVazios.join(', ')}</span>}</dd>
                <dt>Descartadas</dt><dd>{l.descartadas.length ? `${l.descartadas.length} variáveis de execução (token, ids gravados por script)` : '—'}</dd>
              </dl>
              {l.avisos.map((a: string, i: number) => <div key={i} className="alerta info"><div>{a}</div></div>)}
              {previa.removidas.length > 0 && <div className="alerta aviso"><div>Saem as operações importadas antes que não estão nesta collection: {previa.removidas.join(', ')}. As operações editadas à mão ficam.</div></div>}
            </div>
          </Painel>
          <Painel titulo={`Operações (${previa.operacoes.length})`} semPad>
            <div className="tabela-wrap"><table className="tabela">
              <thead><tr><th>Situação</th><th>Operação</th><th>Rota</th><th>Ligada a</th></tr></thead>
              <tbody>
                {previa.operacoes.map((o: any, i: number) => {
                  const [t, c] = SITUACAO[o.situacao];
                  return (
                    <tr key={i}>
                      <td><span className={`selo ${c}`}>{t}</span></td>
                      <td>{o.nome}<div className="dica">{o.pasta}</div></td>
                      <td className="quebra"><Metodo m={o.metodo} /> <span className="mono">{o.rota}</span></td>
                      <td>{o.entidade ? <span className="selo destaque sem-ponto mono">{o.entidade}.{o.acao}</span> : <span className="dica">{o.situacao === 'token' ? 'Autenticação' : 'Sem ligação'}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </Painel>
          {previa.semRequisicao.length > 0 && (
            <div className="alerta info"><div><strong>Operações do pacote sem requisição na collection</strong> — usam a rota do pacote, marcada como tal (D-09):
              <ul>{previa.semRequisicao.map((s: any) => <li key={`${s.entidade}.${s.acao}`}><span className="mono">{s.entidade}.{s.acao}</span> · {s.rota}</li>)}</ul></div></div>
          )}
          {!destinoId && (
            <Painel titulo="Integração">
              <div className="grade grade-3">
                <Campo rotulo="Nome"><input type="text" value={nome} onChange={(e) => setNome(e.target.value)} /></Campo>
                <Campo rotulo="Ambiente" ajuda={amb ? 'O tipo vem do ambiente.' : 'Sem escolha, vai para o ambiente do pacote e do tipo.'}>
                  <select value={ambienteId} onChange={(e) => setAmbienteId(e.target.value)}>
                    <option value="">Escolher pelo pacote e pelo tipo</option>
                    {ambientes.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
                  </select>
                </Campo>
                {!amb && <Campo rotulo="Tipo de ambiente"><select value={tipoAmbiente} onChange={(e) => setTipoAmbiente(e.target.value)}><option value="sandbox">Sandbox</option><option value="homologacao">Homologação</option><option value="desenvolvimento">Desenvolvimento</option></select></Campo>}
                <Campo rotulo="Papel">
                  <select value={papel} onChange={(e) => setPapel(e.target.value)}><option value="cliente">Cliente</option><option value="emulador">Ente emulado</option></select>
                </Campo>
                {papel === 'emulador' && <Campo rotulo="Ente emulado"><input type="text" value={ente} onChange={(e) => setEnte(e.target.value)} placeholder="Receita Federal" /></Campo>}
                <Campo rotulo="Endereço base" ajuda="Deixe vazio para usar o do environment."><input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={l.baseUrl ?? 'https://…'} /></Campo>
              </div>
            </Painel>
          )}
          <div className="acoes"><button className="botao primario" disabled={acao.ocupado || (!destinoId && papel === 'emulador' && !ente.trim())} onClick={aplicar}>{destinoId ? 'Aplicar sobre esta integração' : 'Criar integração com esta importação'}</button></div>
        </>
      )}
    </div>
  );
}

export function Divergencias({ lista }: { lista: any[] }) {
  if (!lista?.length) return <div className="alerta ok"><div>A estrutura importada bate com os modelos: nenhuma divergência de campos.</div></div>;
  return (
    <div className="alerta aviso">
      <div>
        <strong>Divergências entre o corpo da collection e o modelo</strong>
        <ul>
          {lista.map((d) => (
            <li key={d.operacao}>
              <strong>{d.operacao}</strong> ({d.entidade}):
              {d.foraDoModelo.length > 0 && <> fora do modelo — <span className="mono">{d.foraDoModelo.join(', ')}</span>.</>}
              {d.ausentesNoCorpo.length > 0 && <> obrigatórios do modelo ausentes no corpo — <span className="mono">{d.ausentesNoCorpo.join(', ')}</span>.</>}
            </li>
          ))}
        </ul>
        <div className="dica" style={{ marginTop: 6 }}>O app envia o corpo gerado pelo modelo. A divergência mostra onde a collection e o contrato do pacote não batem.</div>
      </div>
    </div>
  );
}
