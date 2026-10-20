import { useEffect, useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import {
  Abas, Cabecalho, CaixaErro, Campo, Carregando, Json, Metodo, Modal, Painel, Vazio, quando, relativo, useAcao, useCarregar, ROTULO_AMBIENTE, ROTULO_AUTH,
  SeloIntegracao, SeloPapel, VersaoBiblioteca,
} from '../ui.tsx';
import { FormDestino, type FormularioDestino } from './Destinos.tsx';
import { Divergencias, ImportarPostman } from './ImportarPostman.tsx';

type Aba = 'conexao' | 'config' | 'segredos' | 'estrutura' | 'importar' | 'historico';

export function DestinoDetalhe({ id }: { id: string }) {
  const { busca, navegar } = useRota();
  const [aba, setAba] = useState<Aba>((busca.get('aba') as Aba) || 'conexao');
  const d = useCarregar(() => get(`/destinos/${id}`), [id]);
  const pacotes = useCarregar(() => get('/pacotes'));
  const ambientes = useCarregar(() => get('/ambientes'));
  const mudarAba = (a: Aba) => { setAba(a); navegar(`/destinos/${id}?aba=${a}`, true); };
  if (d.carregando && !d.dados) return <div className="pagina"><Carregando /></div>;
  if (!d.dados) return <div className="pagina"><CaixaErro erro={d.erro} /></div>;
  const x = d.dados;
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<>{x.ambiente ? <><Link para={`/ambientes/${x.ambiente.id}`}>{x.ambiente.nome}</Link> / </> : null}<Link para="/destinos">Integrações</Link></>}
        titulo={<>{x.nome} <SeloPapel papel={x.papel} ente={x.ente} /> <SeloIntegracao status={x.status} /></>}
        sub={<><span className="mono">{x.baseUrl}</span> · {ROTULO_AMBIENTE[x.tipoAmbiente]} · {ROTULO_AUTH[x.autenticacao.tipo]}{x.pacote ? ` · pacote ${x.pacote.nome}` : ''}</>}
      />
      {x.status === 'aguardando_rota' && <div className="alerta aviso"><div><strong>Aguardando rota.</strong> O sistema testado ainda não expõe as rotas para receber os eventos de {x.ente ?? 'este ente'}. Quando a collection dessas rotas chegar, importe-a na aba <em>Importar do Postman</em> ou ligue uma versão da biblioteca.</div></div>}
      {!x.dominio.ok && <div className="alerta erro"><div><strong>Envio bloqueado pela trava de produção.</strong> {x.dominio.motivo}</div></div>}
      {x.segredosFaltando.length > 0 && <div className="alerta aviso"><div>Falta no cofre: <strong>{x.segredosFaltando.join(', ')}</strong>. <button className="botao pequeno" onClick={() => mudarAba('segredos')}>Preencher</button></div></div>}
      <Abas<Aba>
        abas={[{ id: 'conexao', rotulo: 'Conexão' }, { id: 'config', rotulo: 'Configuração' }, { id: 'segredos', rotulo: 'Segredos', contagem: x.segredos.length },
          { id: 'estrutura', rotulo: 'Estrutura de APIs' }, { id: 'importar', rotulo: 'Importar do Postman' }, { id: 'historico', rotulo: 'Histórico' }]}
        ativa={aba} aoMudar={mudarAba}
      />
      {aba === 'conexao' && <Conexao destino={x} aoTestar={() => d.recarregar(true)} />}
      {aba === 'config' && <Configuracao destino={x} pacotes={pacotes.dados ?? []} ambientes={ambientes.dados ?? []} aoSalvar={() => d.recarregar(true)} />}
      {aba === 'segredos' && <Segredos destino={x} aoMudar={(nd) => d.setDados(nd)} />}
      {aba === 'estrutura' && <Estrutura destinoId={id} temPacote={!!x.pacoteId} />}
      {aba === 'importar' && <ImportarPostman destinoId={id} pacotes={pacotes.dados ?? []} ambientes={ambientes.dados ?? []} aoConcluir={() => { d.recarregar(true); mudarAba('estrutura'); }} />}
      {aba === 'historico' && <Historico destinoId={id} />}
    </div>
  );
}

function Conexao({ destino, aoTestar }: { destino: any; aoTestar: () => void }) {
  const acao = useAcao();
  const [teste, setTeste] = useState<any>(destino.ultimoTeste);
  const testar = async () => {
    const r = await acao.executar(() => post(`/destinos/${destino.id}/testar`));
    if (r) { setTeste(r); aoTestar(); }
  };
  return (
    <div className="lado-a-lado">
      <Painel titulo="Testar conexão" acoes={<button className="botao primario" disabled={acao.ocupado} onClick={testar}>{acao.ocupado ? 'Testando…' : 'Testar agora'}</button>}>
        {!teste ? <p className="dica">Confere o domínio, obtém o token (ou a credencial) e faz a chamada de teste configurada.</p> : (
          <div className="pilha">
            <div className="linha-flex"><span className={`selo ${teste.ok ? 'ok' : 'erro'}`}>{teste.ok ? 'Conexão ok' : 'Falhou'}</span><span className="dica">{quando(teste.em)}</span></div>
            <ul className="tempo">
              {teste.etapas.map((e: any, i: number) => (
                <li key={i}><div><strong>{e.nome}</strong> <span className={`selo ${e.ok ? 'ok' : 'erro'}`}>{e.ok ? 'ok' : 'falhou'}</span>{e.ms !== undefined && <span className="dica"> · {e.ms} ms</span>}<div className="dica quebra">{e.detalhe}</div></div></li>
              ))}
            </ul>
          </div>
        )}
      </Painel>
      <Painel titulo="Resumo">
        <dl className="kv">
          <dt>Endereço</dt><dd className="mono">{destino.baseUrl}</dd>
          <dt>Ambiente</dt><dd>{destino.ambiente ? <Link para={`/ambientes/${destino.ambiente.id}`}>{destino.ambiente.nome}</Link> : null} <span className="dica">{ROTULO_AMBIENTE[destino.tipoAmbiente]}</span></dd>
          <dt>Papel</dt><dd><SeloPapel papel={destino.papel} ente={destino.ente} /></dd>
          <dt>Collection</dt><dd><VersaoBiblioteca v={destino.colecao} /></dd>
          <dt>Environment</dt><dd><VersaoBiblioteca v={destino.environment} /></dd>
          <dt>Autenticação</dt><dd>{ROTULO_AUTH[destino.autenticacao.tipo]}{destino.autenticacao.tokenUrl ? ` · ${destino.autenticacao.tokenUrl}` : ''}</dd>
          <dt>Limite</dt><dd>{destino.limites.porMinuto ?? 600} req/min · {destino.limites.tentativas ?? 4} tentativas</dd>
          <dt>Idempotência</dt><dd>{destino.idempotencia.cabecalho || 'Sem'}</dd>
          <dt>Rastreio</dt><dd>{destino.rastreio?.cabecalho || 'Sem'}</dd>
          <dt>Variáveis</dt><dd>{Object.entries(destino.variaveis).map(([k, v]) => `${k} = ${v || '(vazio)'}`).join(' · ') || '—'}</dd>
          <dt>Situação</dt><dd>{destino.ativo ? 'Ativo' : 'Inativo'}</dd>
        </dl>
      </Painel>
    </div>
  );
}

function Configuracao({ destino, pacotes, ambientes, aoSalvar }: { destino: any; pacotes: any[]; ambientes: any[]; aoSalvar: () => void }) {
  const { navegar } = useRota();
  const inicial: FormularioDestino = {
    nome: destino.nome, tipoAmbiente: destino.tipoAmbiente, baseUrl: destino.baseUrl, pacoteId: destino.pacoteId, autenticacao: destino.autenticacao,
    ambienteId: destino.ambienteId, papel: destino.papel, ente: destino.ente,
    limites: destino.limites, idempotencia: destino.idempotencia, rastreio: destino.rastreio ?? {}, cabecalhos: destino.cabecalhos, variaveis: destino.variaveis,
    teste: destino.teste, ativo: destino.ativo,
  };
  const [form, setForm] = useState(inicial);
  const acao = useAcao();
  const salvar = async () => { if (await acao.executar(() => put(`/destinos/${destino.id}`, form), 'Integração salva.')) aoSalvar(); };
  const remover = async () => {
    if (!confirm(`Remover a integração ${destino.nome}? As operações e os segredos dela também saem. A trilha de auditoria fica.`)) return;
    if ((await acao.executar(() => del(`/destinos/${destino.id}`), 'Integração removida.')) !== undefined) navegar('/destinos');
  };
  return (
    <div className="pilha">
      <CaixaErro erro={acao.erro} />
      <FormDestino valor={form} aoMudar={setForm} pacotes={pacotes} ambientes={ambientes} novo={false} />
      <div className="acoes"><button className="botao primario" disabled={acao.ocupado} onClick={salvar}>Salvar</button><button className="botao" onClick={() => setForm(inicial)}>Desfazer</button><span className="espaco" /><button className="botao perigo" onClick={remover}>Remover integração</button></div>
    </div>
  );
}

function Segredos({ destino, aoMudar }: { destino: any; aoMudar: (d: any) => void }) {
  const acao = useAcao();
  const [valores, setValores] = useState<Record<string, string>>({});
  const [novaChave, setNovaChave] = useState('');
  const exigidos: string[] = [...destino.segredosFaltando, ...destino.segredos.map((s: any) => s.chave)];
  const todas = [...new Set([...exigidos, ...(novaChave ? [] : [])])];
  const salvar = async (chave: string, valor: string | null) => {
    const r = await acao.executar(() => put(`/destinos/${destino.id}/segredos`, { chave, valor }), valor ? `Segredo ${chave} guardado no cofre.` : `Segredo ${chave} removido.`);
    if (r) { aoMudar(r); setValores((v) => ({ ...v, [chave]: '' })); }
  };
  return (
    <Painel titulo="Cofre do destino">
      <div className="pilha">
        <p className="dica">Guardados com AES-256-GCM e a chave mestra do app. O valor nunca volta para a tela, para os logs nem para as exportações. A trilha registra só que o segredo foi definido ou removido.</p>
        <CaixaErro erro={acao.erro} />
        <div className="tabela-wrap"><table className="tabela">
          <thead><tr><th>Segredo</th><th>Situação</th><th>Novo valor</th><th></th></tr></thead>
          <tbody>
            {todas.map((chave) => {
              const s = destino.segredos.find((x: any) => x.chave === chave);
              return (
                <tr key={chave}>
                  <td className="mono">{chave}</td>
                  <td>{s ? <span className="selo ok">Definido{s.final ? ` ${s.final}` : ''} · {relativo(s.atualizado_em)}</span> : <span className="selo aviso">Falta</span>}</td>
                  <td style={{ minWidth: 220 }}><input type="password" autoComplete="new-password" value={valores[chave] ?? ''} onChange={(e) => setValores({ ...valores, [chave]: e.target.value })} placeholder={s ? 'Trocar o valor' : 'Valor'} /></td>
                  <td className="nowrap">
                    <button className="botao pequeno primario" disabled={!valores[chave] || acao.ocupado} onClick={() => salvar(chave, valores[chave])}>Guardar</button>{' '}
                    {s && <button className="botao pequeno perigo" onClick={() => confirm(`Remover ${chave}?`) && salvar(chave, null)}>Remover</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="linha-flex">
          <input type="text" style={{ maxWidth: 260 }} placeholder="Outro segredo (nome)" value={novaChave} onChange={(e) => setNovaChave(e.target.value.trim())} />
          <input type="password" autoComplete="new-password" style={{ maxWidth: 260 }} placeholder="Valor" value={valores[novaChave] ?? ''} onChange={(e) => setValores({ ...valores, [novaChave]: e.target.value })} disabled={!novaChave} />
          <button className="botao" disabled={!novaChave || !valores[novaChave]} onClick={async () => { await salvar(novaChave, valores[novaChave]); setNovaChave(''); }}>Adicionar</button>
        </div>
      </div>
    </Painel>
  );
}

const ORIGEM: Record<string, [string, string]> = { importada: ['Importada', 'info'], manual: ['Manual', 'destaque'], pacote: ['Do pacote', ''] };

function Estrutura({ destinoId, temPacote }: { destinoId: string; temPacote: boolean }) {
  const ops = useCarregar(() => get(`/destinos/${destinoId}/operacoes`), [destinoId]);
  const div = useCarregar(() => get(`/destinos/${destinoId}/divergencias`), [destinoId]);
  const config = useCarregar(() => get('/config'));
  const [editando, setEditando] = useState<any>(null);
  const acao = useAcao();
  const recarregar = () => { ops.recarregar(true); div.recarregar(true); };
  const aplicarPadrao = async () => {
    const r = await acao.executar(() => post(`/destinos/${destinoId}/operacoes-padrao`));
    if (r) { recarregar(); }
  };
  return (
    <div className="pilha">
      <div className="alerta info"><div>Cada operação ligada a uma <strong>entidade</strong> e a uma <strong>ação</strong> é usada no envio: <span className="mono">criar</span> manda o registro; <span className="mono">consultar</span> faz a conferência. Na rota, <span className="mono">{'{{$id}}'}</span> é o id do registro no destino; <span className="mono">{'{{$var.nome}}'}</span>, uma variável do destino. Prioridade: manual, depois importada, depois a do pacote.</div></div>
      <CaixaErro erro={acao.erro} />
      <Painel titulo="Operações" semPad acoes={<>
        {temPacote && <button className="botao pequeno" onClick={aplicarPadrao}>Completar com o pacote</button>}
        <button className="botao pequeno primario" onClick={() => setEditando({ nome: '', metodo: 'POST', rota: '/', entidade: '', acao: '', cabecalhos: {}, corpo: '', usarCorpo: false })}>Nova operação</button>
      </>}>
        {ops.carregando && !ops.dados ? <Carregando /> : !ops.dados?.length ? <Vazio titulo="Nenhuma operação">Importe do Postman, complete com o pacote ou crie à mão.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Operação</th><th>Rota</th><th>Ligada a</th><th>Origem</th></tr></thead>
            <tbody>
              {ops.dados.map((o: any) => {
                const [t, c] = ORIGEM[o.origem];
                return (
                  <tr key={o.id} className="clicavel" onClick={() => setEditando(o)}>
                    <td>{o.nome}{o.pasta && <div className="dica">{o.pasta}</div>}</td>
                    <td className="quebra"><Metodo m={o.metodo} /> <span className="mono">{o.rota}</span></td>
                    <td>{o.entidade ? <span className="selo destaque sem-ponto mono">{o.entidade}.{o.acao}</span> : <span className="dica">—</span>}</td>
                    <td><span className={`selo ${c}`}>{t}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </Painel>
      {div.dados && <Divergencias lista={div.dados} />}
      {editando && <EditorOperacao destinoId={destinoId} op={editando} acoes={config.dados?.acoes ?? []} aoFechar={() => setEditando(null)} aoSalvar={() => { setEditando(null); recarregar(); }} />}
    </div>
  );
}

function EditorOperacao({ destinoId, op, acoes, aoFechar, aoSalvar }: { destinoId: string; op: any; acoes: string[]; aoFechar: () => void; aoSalvar: () => void }) {
  const [o, setO] = useState({ ...op, cabecalhosTexto: JSON.stringify(op.cabecalhos ?? {}, null, 2) });
  const acao = useAcao();
  const salvar = async () => {
    let cabecalhos: Record<string, string>;
    try { cabecalhos = JSON.parse(o.cabecalhosTexto || '{}'); } catch { alert('Os cabeçalhos precisam ser um JSON, como {"Accept": "application/json"}.'); return; }
    const corpo = { nome: o.nome, pasta: o.pasta, metodo: o.metodo, rota: o.rota, entidade: o.entidade || null, acao: o.acao || null, cabecalhos, corpo: o.corpo || null, usarCorpo: !!o.usarCorpo };
    const r = await acao.executar(() => (op.id ? put(`/operacoes/${op.id}`, corpo) : post(`/destinos/${destinoId}/operacoes`, corpo)), 'Operação salva.');
    if (r) aoSalvar();
  };
  const remover = async () => { if (confirm(`Remover a operação ${op.nome}?`) && (await acao.executar(() => del(`/operacoes/${op.id}`), 'Operação removida.')) !== undefined) aoSalvar(); };
  return (
    <Modal titulo={op.id ? 'Editar operação' : 'Nova operação'} aoFechar={aoFechar} rodape={<>
      {op.id && <button className="botao perigo" onClick={remover} style={{ marginRight: 'auto' }}>Remover</button>}
      <button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado} onClick={salvar}>Salvar</button>
    </>}>
      {op.id && op.origem !== 'manual' && <div className="alerta info"><div>Ao salvar, a operação passa a ser manual: uma importação seguinte não a sobrescreve.</div></div>}
      <CaixaErro erro={acao.erro} />
      <div className="grade grade-2">
        <Campo rotulo="Nome"><input type="text" value={o.nome} onChange={(e) => setO({ ...o, nome: e.target.value })} /></Campo>
        <Campo rotulo="Pasta"><input type="text" value={o.pasta ?? ''} onChange={(e) => setO({ ...o, pasta: e.target.value })} /></Campo>
        <Campo rotulo="Entidade" ajuda="Nome do modelo, ex.: fornecedor"><input type="text" value={o.entidade ?? ''} onChange={(e) => setO({ ...o, entidade: e.target.value })} /></Campo>
        <Campo rotulo="Ação"><select value={o.acao ?? ''} onChange={(e) => setO({ ...o, acao: e.target.value })}><option value="">Nenhuma</option>{acoes.map((a) => <option key={a}>{a}</option>)}</select></Campo>
      </div>
      <Campo rotulo="Método e rota" ajuda="Rota relativa ao endereço base. {{$id}} = id do registro no destino.">
        <div className="linha-flex" style={{ flexWrap: 'nowrap' }}>
          <select style={{ width: 110 }} value={o.metodo} onChange={(e) => setO({ ...o, metodo: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
          <input type="text" value={o.rota} onChange={(e) => setO({ ...o, rota: e.target.value })} className="mono" />
        </div>
      </Campo>
      <Campo rotulo="Cabeçalhos da operação (JSON)"><textarea rows={3} value={o.cabecalhosTexto} onChange={(e) => setO({ ...o, cabecalhosTexto: e.target.value })} /></Campo>
      <Campo rotulo="Corpo modelo" ajuda="Vindo da collection, serve para comparar com o modelo. Para enviar este corpo no lugar do registro, marque abaixo; use {{campo.do.registro}} e {{$var.nome}}.">
        <textarea rows={8} value={o.corpo ?? ''} onChange={(e) => setO({ ...o, corpo: e.target.value })} />
      </Campo>
      <label className="check"><input type="checkbox" checked={!!o.usarCorpo} onChange={(e) => setO({ ...o, usarCorpo: e.target.checked })} /> Enviar o corpo modelo (com os campos do registro) em vez do registro gerado</label>
    </Modal>
  );
}

function Historico({ destinoId }: { destinoId: string }) {
  const imps = useCarregar(() => get(`/destinos/${destinoId}/importacoes`), [destinoId]);
  const aud = useCarregar(() => get(`/auditoria?alvo=${destinoId}&limite=50`), [destinoId]);
  const [ver, setVer] = useState<any>(null);
  useEffect(() => setVer(null), [destinoId]);
  return (
    <div className="lado-a-lado">
      <Painel titulo="Trilha do destino">
        {!aud.dados?.length ? <p className="dica">Nada registrado.</p> : (
          <ul className="tempo">{aud.dados.map((a: any) => <li key={a.id}><div><div>{a.resumo}</div><div className="quando">{quando(a.em)} · {a.usuario}</div></div></li>)}</ul>
        )}
      </Painel>
      <Painel titulo="Importações">
        {!imps.dados?.length ? <p className="dica">Nenhuma importação.</p> : (
          <div className="pilha">
            {imps.dados.map((i: any) => (
              <div key={i.id}>
                <div className="linha-flex"><strong>{i.resumo.colecao}</strong><span className="dica">{quando(i.criadoEm)}</span><button className="botao pequeno" onClick={() => setVer(ver?.id === i.id ? null : i)}>Detalhes</button></div>
                <div className="dica">{i.resumo.operacoes} operações · {i.resumo.ligadas} ligadas · {i.resumo.segredos} segredos para o cofre</div>
                {ver?.id === i.id && <Json valor={i.resumo} alturaMax={260} />}
              </div>
            ))}
          </div>
        )}
      </Painel>
    </div>
  );
}
