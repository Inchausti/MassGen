import { useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import {
  Cabecalho, CaixaErro, Campo, Carregando, Modal, Painel, Vazio, quando, useAcao, useCarregar, ROTULO_AMBIENTE, SeloIntegracao, SeloPapel, VersaoBiblioteca,
} from '../ui.tsx';

export function Ambientes() {
  const { dados, erro, carregando } = useCarregar(() => get('/ambientes'));
  const [novo, setNovo] = useState(false);
  const { navegar } = useRota();
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Ambientes"
        sub="Onde o teste acontece. Um ambiente reúne as integrações de um sistema — a API que ele expõe e as APIs dos entes que ele integra. Os dados mestre e os contextos de massa passam a pertencer ao ambiente nas próximas etapas."
        acoes={<button className="botao primario" onClick={() => setNovo(true)}>Novo ambiente</button>}
      />
      <CaixaErro erro={erro} />
      <Painel semPad>
        {carregando && !dados ? <Carregando /> : !dados?.length ? (
          <Vazio titulo="Nenhum ambiente">Crie um ambiente para o sistema que você vai testar, como <em>SplitHub — Sandbox</em>.</Vazio>
        ) : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Ambiente</th><th>Tipo</th><th>Pacote</th><th>Integrações</th></tr></thead>
            <tbody>
              {dados.map((a: any) => (
                <tr key={a.id}>
                  <td><Link para={`/ambientes/${a.id}`}>{a.nome}</Link>{a.sistema && <div className="dica">{a.sistema}</div>}</td>
                  <td>{ROTULO_AMBIENTE[a.tipo]}</td>
                  <td>{a.pacote?.nome ?? <span className="dica">—</span>}</td>
                  <td>
                    {!a.integracoes.length ? <span className="dica">Nenhuma</span> : (
                      <div className="pilha" style={{ gap: 4 }}>
                        {a.integracoes.map((i: any) => (
                          <div key={i.id} className="linha-flex" style={{ gap: 6 }}>
                            <Link para={`/destinos/${i.id}`}>{i.nome}</Link><SeloPapel papel={i.papel} ente={i.ente} /><SeloIntegracao status={i.status} />
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Painel>
      {novo && <FormAmbiente aoFechar={() => setNovo(false)} aoSalvar={(a) => { setNovo(false); navegar(`/ambientes/${a.id}`); }} />}
    </div>
  );
}

function FormAmbiente({ inicial, aoFechar, aoSalvar }: { inicial?: any; aoFechar: () => void; aoSalvar: (a: any) => void }) {
  const pacotes = useCarregar(() => get('/pacotes'));
  const [f, setF] = useState({
    nome: inicial?.nome ?? '', sistema: inicial?.sistema ?? '', tipo: inicial?.tipo ?? 'sandbox', pacoteId: inicial?.pacoteId ?? '', descricao: inicial?.descricao ?? '',
  });
  const acao = useAcao();
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const salvar = async () => {
    const corpo = { ...f, pacoteId: f.pacoteId || null };
    const r = await acao.executar(() => (inicial ? put(`/ambientes/${inicial.id}`, corpo) : post('/ambientes', corpo)), inicial ? 'Ambiente salvo.' : 'Ambiente criado.');
    if (r) aoSalvar(r);
  };
  return (
    <Modal
      titulo={inicial ? 'Editar ambiente' : 'Novo ambiente'}
      aoFechar={aoFechar}
      rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado || !f.nome.trim()} onClick={salvar}>{inicial ? 'Salvar' : 'Criar ambiente'}</button></>}
    >
      <CaixaErro erro={acao.erro} />
      <div className="pilha">
        <Campo rotulo="Nome"><input type="text" autoFocus value={f.nome} onChange={(e) => set({ nome: e.target.value })} placeholder="SplitHub — Sandbox" /></Campo>
        <div className="grade grade-2">
          <Campo rotulo="Sistema testado"><input type="text" value={f.sistema} onChange={(e) => set({ sistema: e.target.value })} placeholder="SplitHub" /></Campo>
          <Campo rotulo="Tipo" ajuda={inicial ? 'As integrações acompanham o tipo do ambiente.' : 'Produção não existe como opção.'}>
            <select value={f.tipo} onChange={(e) => set({ tipo: e.target.value })}>
              <option value="sandbox">Sandbox</option><option value="homologacao">Homologação</option><option value="desenvolvimento">Desenvolvimento</option>
            </select>
          </Campo>
        </div>
        <Campo rotulo="Pacote de domínio" ajuda="As integrações do ambiente usam este pacote, salvo se você escolher outro nelas.">
          <select value={f.pacoteId} onChange={(e) => set({ pacoteId: e.target.value })}>
            <option value="">Sem pacote</option>
            {(pacotes.dados ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.nome} {p.versao}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Descrição (opcional)"><textarea rows={2} value={f.descricao} onChange={(e) => set({ descricao: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}

export function AmbienteDetalhe({ id }: { id: string }) {
  const a = useCarregar(() => get(`/ambientes/${id}`), [id]);
  const [editar, setEditar] = useState(false);
  const [ligar, setLigar] = useState(false);
  const acao = useAcao();
  const { navegar } = useRota();
  if (a.carregando && !a.dados) return <div className="pagina"><Carregando /></div>;
  if (!a.dados) return <div className="pagina"><CaixaErro erro={a.erro} /></div>;
  const x = a.dados;
  const remover = async () => {
    if (!confirm(`Remover o ambiente ${x.nome}?`)) return;
    if ((await acao.executar(() => del(`/ambientes/${id}`), 'Ambiente removido.')) !== undefined) navegar('/ambientes');
  };
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para="/ambientes">Ambientes</Link>}
        titulo={x.nome}
        sub={<>{ROTULO_AMBIENTE[x.tipo]}{x.sistema ? ` · ${x.sistema}` : ''}{x.pacote ? ` · pacote ${x.pacote.nome}` : ''} · criado {quando(x.criadoEm).slice(0, 10)}{x.criadoPor ? ` por ${x.criadoPor}` : ''}</>}
        acoes={<>
          <button className="botao" onClick={() => setEditar(true)}>Editar</button>
          <button className="botao perigo" disabled={x.integracoes.length > 0} title={x.integracoes.length ? 'Remova ou mova as integrações antes' : undefined} onClick={remover}>Remover</button>
        </>}
      />
      <CaixaErro erro={acao.erro} />
      {x.descricao && <p style={{ marginBottom: 14 }}>{x.descricao}</p>}
      <Painel
        titulo={`Integrações (${x.integracoes.length})`}
        acoes={<>
          <button className="botao primario" onClick={() => setLigar(true)}>Ligar pela biblioteca</button>
          <Link para={`/destinos/novo?ambiente=${id}`} className="botao">Nova integração</Link>
        </>}
        semPad
      >
        {!x.integracoes.length ? (
          <Vazio titulo="Nenhuma integração">Ligue uma collection da biblioteca, importe do Postman ou cadastre à mão. Uma integração de ente emulado pode nascer sem rotas: ela fica aguardando as rotas do sistema testado.</Vazio>
        ) : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Integração</th><th>Papel</th><th>Situação</th><th>Collection</th><th>Environment</th><th className="num">Operações</th></tr></thead>
            <tbody>
              {x.integracoes.map((d: any) => (
                <tr key={d.id}>
                  <td><Link para={`/destinos/${d.id}`}>{d.nome}</Link><div className="dica mono quebra">{d.baseUrl}</div></td>
                  <td><SeloPapel papel={d.papel} ente={d.ente} /></td>
                  <td><SeloIntegracao status={d.status} /></td>
                  <td><VersaoBiblioteca v={d.colecao} /></td>
                  <td><VersaoBiblioteca v={d.environment} /></td>
                  <td className="num">{d.operacoes}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Painel>
      {editar && <FormAmbiente inicial={x} aoFechar={() => setEditar(false)} aoSalvar={() => { setEditar(false); a.recarregar(true); }} />}
      {ligar && <LigarIntegracao ambiente={x} aoFechar={() => setLigar(false)} aoLigar={(r) => navegar(`/destinos/${r.destinoId}`)} />}
    </div>
  );
}

function rotuloVersao(v: any): string {
  return `v${v.numero} · ${quando(v.importadoEm).slice(0, 10)}${v.importadoPor ? ` · ${v.importadoPor}` : ''}`;
}

function LigarIntegracao({ ambiente, aoFechar, aoLigar }: { ambiente: any; aoFechar: () => void; aoLigar: (r: any) => void }) {
  const bib = useCarregar(() => get('/biblioteca'));
  const [f, setF] = useState({ nome: '', papel: 'cliente', ente: '', colecaoId: '', colecaoVersaoId: '', environmentId: '', environmentVersaoId: '', baseUrl: '' });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const col = useCarregar(() => (f.colecaoId ? get(`/biblioteca/${f.colecaoId}`) : Promise.resolve(null)), [f.colecaoId]);
  const env = useCarregar(() => (f.environmentId ? get(`/biblioteca/${f.environmentId}`) : Promise.resolve(null)), [f.environmentId]);
  const acao = useAcao();
  const versaoCol = f.colecaoVersaoId || col.dados?.versoes?.[0]?.id || '';
  const versaoEnv = f.environmentId ? f.environmentVersaoId || env.dados?.versoes?.[0]?.id || '' : '';
  const colecoes = (bib.dados ?? []).filter((x: any) => x.tipo === 'collection');
  const environments = (bib.dados ?? []).filter((x: any) => x.tipo === 'environment');
  const baseDoEnv = env.dados?.versoes?.find((v: any) => v.id === versaoEnv)?.resumo?.baseUrl;
  const ligar = async () => {
    const r = await acao.executar(() => post(`/ambientes/${ambiente.id}/integracoes`, {
      nome: f.nome || undefined, papel: f.papel, ente: f.papel === 'emulador' ? f.ente : undefined, colecaoVersaoId: versaoCol,
      environmentVersaoId: versaoEnv || null, baseUrl: f.baseUrl || undefined,
    }), 'Integração ligada.');
    if (r) aoLigar(r);
  };
  return (
    <Modal
      titulo={`Ligar integração em ${ambiente.nome}`}
      aoFechar={aoFechar}
      rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado || !versaoCol || (f.papel === 'emulador' && !f.ente.trim())} onClick={ligar}>Ligar integração</button></>}
    >
      <CaixaErro erro={acao.erro} />
      {bib.carregando && !bib.dados ? <Carregando /> : !colecoes.length ? (
        <Vazio titulo="A biblioteca não tem collections">Importe a collection e o environment na <Link para="/biblioteca">biblioteca de APIs</Link> e volte aqui.</Vazio>
      ) : (
        <div className="pilha">
          <div className="grade grade-2">
            <Campo rotulo="Collection">
              <select value={f.colecaoId} onChange={(e) => set({ colecaoId: e.target.value, colecaoVersaoId: '' })}>
                <option value="">Escolha…</option>
                {colecoes.map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Versão da collection">
              <select value={versaoCol} disabled={!col.dados} onChange={(e) => set({ colecaoVersaoId: e.target.value })}>
                {(col.dados?.versoes ?? []).map((v: any) => <option key={v.id} value={v.id}>{rotuloVersao(v)}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Environment (opcional)" ajuda="Endereço, variáveis e credenciais. Os segredos vão do cofre da biblioteca para o da integração.">
              <select value={f.environmentId} onChange={(e) => set({ environmentId: e.target.value, environmentVersaoId: '' })}>
                <option value="">Sem environment</option>
                {environments.map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Versão do environment">
              <select value={versaoEnv} disabled={!env.dados} onChange={(e) => set({ environmentVersaoId: e.target.value })}>
                {(env.dados?.versoes ?? []).map((v: any) => <option key={v.id} value={v.id}>{rotuloVersao(v)}</option>)}
              </select>
            </Campo>
          </div>
          <div className="grade grade-2">
            <Campo rotulo="Nome da integração"><input type="text" value={f.nome} onChange={(e) => set({ nome: e.target.value })} placeholder={col.dados?.nome ?? 'O nome da collection'} /></Campo>
            <Campo rotulo="Papel" ajuda={f.papel === 'emulador' ? 'O app faz o papel deste ente e entrega os eventos dele nas rotas do sistema.' : 'O app chama a API do sistema testado, como um cliente.'}>
              <select value={f.papel} onChange={(e) => set({ papel: e.target.value })}>
                <option value="cliente">Cliente</option><option value="emulador">Ente emulado</option>
              </select>
            </Campo>
            {f.papel === 'emulador' && <Campo rotulo="Ente emulado"><input type="text" value={f.ente} onChange={(e) => set({ ente: e.target.value })} placeholder="Receita Federal" /></Campo>}
            <Campo rotulo="Endereço base (opcional)" ajuda="Vazio: o do environment."><input type="url" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={baseDoEnv ?? 'https://…'} /></Campo>
          </div>
        </div>
      )}
    </Modal>
  );
}
