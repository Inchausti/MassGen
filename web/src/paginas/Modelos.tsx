import { useMemo, useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { Abas, Cabecalho, CaixaErro, Campo, Carregando, Json, Painel, Vazio, relativo, useAcao, useCarregar } from '../ui.tsx';

export function Modelos() {
  const { busca, navegar } = useRota();
  const pacotes = useCarregar(() => get('/pacotes'));
  const pacote = busca.get('pacote') ?? '';
  const modelos = useCarregar(() => get(`/modelos${pacote ? `?pacote=${pacote}` : ''}`), [pacote]);
  const [novo, setNovo] = useState(false);
  const [nome, setNome] = useState('');
  const [pacoteNovo, setPacoteNovo] = useState('');
  const acao = useAcao();
  const criar = async () => {
    const definicao = { nome, rotulo: nome.charAt(0).toUpperCase() + nome.slice(1).replace(/_/g, ' '), campos: [{ nome: 'id_externo', gerador: { tipo: 'sequencia', prefixo: 'MASSA-{{ $exec.codigo }}-', digitos: 4 } }] };
    const m = await acao.executar(() => post('/modelos', { pacoteId: pacoteNovo || pacotes.dados?.[0]?.id, definicao }), 'Modelo criado.');
    if (m) navegar(`/modelos/${m.id}`);
  };
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Modelos de entidade"
        sub="O formato de cada coisa que a massa contém: campos, geradores, relações, perfis com proporção, regras e casos de borda com o resultado esperado."
        acoes={<>
          <select value={pacote} onChange={(e) => navegar(e.target.value ? `/modelos?pacote=${e.target.value}` : '/modelos')} aria-label="Filtrar por pacote">
            <option value="">Todos os pacotes</option>
            {(pacotes.dados ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.nome}</option>)}
          </select>
          <button className="botao primario" onClick={() => setNovo(!novo)}>Novo modelo</button>
        </>}
      />
      <CaixaErro erro={modelos.erro ?? acao.erro} />
      {novo && (
        <Painel titulo="Novo modelo">
          <div className="grade grade-3">
            <Campo rotulo="Nome técnico" ajuda="Minúsculas, números e _. Não muda depois."><input type="text" value={nome} onChange={(e) => setNome(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} placeholder="pedido" /></Campo>
            <Campo rotulo="Pacote"><select value={pacoteNovo} onChange={(e) => setPacoteNovo(e.target.value)}>{(pacotes.dados ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.nome}</option>)}</select></Campo>
            <div className="campo" style={{ justifyContent: 'flex-end' }}><button className="botao primario" disabled={!/^[a-z][a-z0-9_]*$/.test(nome) || acao.ocupado} onClick={criar}>Criar e editar</button></div>
          </div>
        </Painel>
      )}
      <Painel semPad>
        {modelos.carregando && !modelos.dados ? <Carregando /> : !modelos.dados?.length ? <Vazio titulo="Nenhum modelo" /> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Modelo</th><th>Pacote</th><th className="num">Campos</th><th>Relações</th><th className="num">Perfis</th><th className="num">Regras</th><th className="num">Casos</th><th>Situação</th></tr></thead>
            <tbody>{modelos.dados.map((m: any) => (
              <tr key={m.id} className="clicavel" onClick={() => navegar(`/modelos/${m.id}`)}>
                <td><Link para={`/modelos/${m.id}`}>{m.rotulo}</Link> <span className="dica mono">{m.nome}</span>{m.descricao && <div className="dica">{m.descricao}</div>}</td>
                <td>{m.pacoteId}</td>
                <td className="num">{m.campos}</td>
                <td className="mono" style={{ fontSize: 12 }}>{m.relacoes.join(', ') || '—'}</td>
                <td className="num">{m.perfis}</td><td className="num">{m.regras}</td><td className="num">{m.casos}</td>
                <td>{m.alterado ? <span className="selo aviso">Alterado no app</span> : <span className="selo">Do pacote</span>}<div className="dica">{relativo(m.atualizadoEm)}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
    </div>
  );
}

// ---------------------------------------------------------------- editor

const FUNCOES = [
  ['$dinheiro(n)', 'número para texto com 2 casas: "3200.00"'],
  ['$num(texto)', 'texto para número'],
  ['$somaDinheiro(lista)', 'soma valores e devolve com 2 casas'],
  ['$somaDias(data, n)', 'soma dias a uma data AAAA-MM-DD'],
  ['$data(dataHora)', 'só a data'],
  ['$pad(valor, n)', 'zeros à esquerda'],
  ['$digitos(texto)', 'só os dígitos'],
  ['$cnpjValido · $cpfValido · $chaveValida', 'confere o dígito verificador'],
  ['$var.nome', 'variável do destino'],
  ['$exec.codigo · $ref · $indice', 'código da execução, data de referência, posição do registro'],
  ['pai.campo', 'campo do registro pai, pelo nome da relação: fornecedor.cnpj'],
];

export function ModeloEditor({ id }: { id: string }) {
  const { navegar } = useRota();
  const m = useCarregar(() => get(`/modelos/${id}`), [id]);
  const catalogo = useCarregar(() => get('/catalogo/geradores'));
  const destinos = useCarregar(() => get('/destinos'));
  const [texto, setTexto] = useState<string | null>(null);
  const [aba, setAba] = useState<'campos' | 'exemplo' | 'geradores'>('campos');
  const [exemplo, setExemplo] = useState<any[] | null>(null);
  const [destinoId, setDestinoId] = useState('');
  const acao = useAcao();
  const atual = texto ?? (m.dados ? JSON.stringify(m.dados.definicao, null, 2) : '');
  const parse = useMemo(() => { try { return { def: JSON.parse(atual), erro: null }; } catch (e) { return { def: null, erro: (e as Error).message }; } }, [atual]);

  if (m.carregando && !m.dados) return <div className="pagina"><Carregando /></div>;
  if (!m.dados) return <div className="pagina"><CaixaErro erro={m.erro} /></div>;
  const def = parse.def;
  const alterado = texto !== null && texto !== JSON.stringify(m.dados.definicao, null, 2);

  const salvar = async () => {
    if (!def) return;
    const r = await acao.executar(() => put(`/modelos/${id}`, { definicao: def }), 'Modelo salvo.');
    if (r) { m.setDados(r); setTexto(null); }
  };
  const gerarExemplo = async () => {
    if (!def) return;
    const r = await acao.executar(() => post(`/modelos/${id}/exemplo`, { definicao: def, destinoId: destinoId || undefined, semente: Math.floor(Math.random() * 1e6) }));
    if (r) { setExemplo(r); setAba('exemplo'); }
  };

  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para={`/modelos?pacote=${m.dados.pacoteId}`}>Modelos</Link>}
        titulo={<>{m.dados.rotulo} <span className="dica mono" style={{ fontSize: 14 }}>{m.dados.nome}</span></>}
        sub={m.dados.descricao}
        acoes={<>
          {m.dados.alterado && m.dados.temOriginal && <button className="botao" onClick={async () => { if (confirm('Voltar o modelo à versão do pacote? As alterações feitas no app se perdem.')) { const r = await acao.executar(() => post(`/modelos/${id}/restaurar`), 'Modelo restaurado.'); if (r) { m.setDados(r); setTexto(null); } } }}>Restaurar do pacote</button>}
          <button className="botao perigo" onClick={async () => { if (confirm('Remover este modelo?') && (await acao.executar(() => del(`/modelos/${id}`), 'Modelo removido.')) !== undefined) navegar('/modelos'); }}>Remover</button>
          <button className="botao primario" disabled={!def || !alterado || acao.ocupado} onClick={salvar}>Salvar</button>
        </>}
      />
      <CaixaErro erro={acao.erro} />
      <div className="lado-a-lado">
        <Painel titulo="Definição (JSON)" acoes={<span className="dica">{parse.erro ? <span style={{ color: 'var(--erro)' }}>JSON inválido</span> : alterado ? 'Alterações não salvas' : 'Salvo'}</span>}>
          <div className="pilha">
            <textarea aria-label="Definição do modelo" rows={34} spellCheck={false} value={atual} onChange={(e) => setTexto(e.target.value)} style={{ minHeight: 520 }} />
            {parse.erro && <div className="erro-campo" style={{ color: 'var(--erro)', fontSize: 12 }}>{parse.erro}</div>}
            <div className="linha-flex">
              <select value={destinoId} onChange={(e) => setDestinoId(e.target.value)} style={{ maxWidth: 280 }} aria-label="Variáveis de qual destino">
                <option value="">Variáveis do pacote (exemplo)</option>
                {(destinos.dados ?? []).filter((d: any) => d.pacoteId === m.dados.pacoteId).map((d: any) => <option key={d.id} value={d.id}>Variáveis de {d.nome}</option>)}
              </select>
              <button className="botao" disabled={!def || acao.ocupado} onClick={gerarExemplo}>Gerar exemplo</button>
              <span className="dica">Gera 3 registros com o que está no editor, sem salvar.</span>
            </div>
          </div>
        </Painel>
        <div className="pilha">
          <Abas abas={[{ id: 'campos', rotulo: 'Estrutura' }, { id: 'exemplo', rotulo: 'Exemplo', contagem: exemplo?.length }, { id: 'geradores', rotulo: 'Geradores e funções' }]} ativa={aba} aoMudar={setAba} />
          {aba === 'campos' && (def ? <Estrutura def={def} /> : <p className="dica">Corrija o JSON para ver a estrutura.</p>)}
          {aba === 'exemplo' && (!exemplo ? <p className="dica">Clique em Gerar exemplo.</p> : exemplo.map((r, i) => (
            <Painel key={i} titulo={r.rotulo} acoes={<>{r.perfil && <span className="selo sem-ponto">{r.perfil}</span>}<span className="selo info sem-ponto">esperado {JSON.stringify(r.esperado.status)}</span></>}>
              {r.avisos.length > 0 && <div className="alerta aviso" style={{ marginBottom: 10 }}><div><ul style={{ margin: 0 }}>{r.avisos.map((a: string, j: number) => <li key={j}>{a}</li>)}</ul></div></div>}
              <Json valor={r.dados} alturaMax={360} />
            </Painel>
          )))}
          {aba === 'geradores' && (
            <div className="pilha">
              <Painel titulo="Geradores" semPad>
                <div className="tabela-wrap"><table className="tabela">
                  <thead><tr><th>Tipo</th><th>O que faz</th><th>Parâmetros</th></tr></thead>
                  <tbody>{(catalogo.dados ?? []).map((g: any) => (
                    <tr key={g.tipo}><td className="mono nowrap">{g.tipo}</td><td>{g.descricao}</td><td style={{ fontSize: 12 }}>{Object.entries(g.parametros).map(([k, v]) => <div key={k}><span className="mono">{k}</span>: {String(v)}</div>)}</td></tr>
                  ))}</tbody>
                </table></div>
              </Painel>
              <Painel titulo="Expressões (JSONata)" semPad>
                <div className="tabela-wrap"><table className="tabela"><tbody>
                  {FUNCOES.map(([f, d]) => <tr key={f}><td className="mono nowrap">{f}</td><td>{d}</td></tr>)}
                </tbody></table></div>
                <p className="dica" style={{ padding: '10px 12px' }}>Modelo de texto: <span className="mono">{'"Contrato {{ $exec.codigo }}"'}</span>. Os campos são gerados na ordem em que aparecem; um campo só usa os anteriores.</p>
              </Painel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function descreverGerador(g: any): string {
  if (!g) return '—';
  const { tipo, ...p } = g;
  const resumo = Object.entries(p).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
  return resumo ? `${tipo} — ${resumo}` : tipo;
}

function Estrutura({ def }: { def: any }) {
  return (
    <div className="pilha">
      <Painel titulo={`Campos (${def.campos?.length ?? 0})`} semPad>
        <div className="tabela-wrap"><table className="tabela">
          <thead><tr><th>Campo</th><th>Gerador</th><th></th></tr></thead>
          <tbody>{(def.campos ?? []).flatMap((c: any) => [
            <tr key={c.nome}><td className="mono nowrap">{c.nome}</td><td style={{ fontSize: 12 }} className="quebra">{c.tipo === 'lista' && c.itens ? `lista de ${c.itens.quantidade.min} a ${c.itens.quantidade.max} itens` : descreverGerador(c.gerador)}</td>
              <td className="nowrap">{c.obrigatorio && <span className="selo sem-ponto">obrigatório</span>} {c.unico && <span className="selo info sem-ponto">único</span>}</td></tr>,
            ...(c.tipo === 'lista' && c.itens ? c.itens.campos.map((ci: any) => (
              <tr key={`${c.nome}.${ci.nome}`}><td className="mono nowrap fraco">{c.nome}[].{ci.nome}</td><td style={{ fontSize: 12 }} className="quebra">{descreverGerador(ci.gerador)}</td><td /></tr>
            )) : []),
          ])}</tbody>
        </table></div>
      </Painel>
      {(def.relacoes?.length ?? 0) > 0 && <Painel titulo="Relações"><ul style={{ margin: 0, paddingLeft: 18 }}>{def.relacoes.map((r: any) => <li key={r.nome}><span className="mono">{r.nome}</span> → {r.entidade}{r.via ? ` (via ${r.via})` : r.modo ? ` · ${r.modo}` : ''}</li>)}</ul></Painel>}
      {(def.perfis?.length ?? 0) > 0 && <Painel titulo="Perfis"><ul style={{ margin: 0, paddingLeft: 18 }}>{def.perfis.map((p: any) => <li key={p.nome}><strong>{p.rotulo ?? p.nome}</strong> · peso {p.peso}{p.campos ? ` · muda ${Object.keys(p.campos).join(', ')}` : ''}</li>)}</ul></Painel>}
      {(def.regras?.length ?? 0) > 0 && <Painel titulo="Regras"><ul style={{ margin: 0, paddingLeft: 18 }}>{def.regras.map((r: any) => <li key={r.nome}><span className="mono">{r.expr}</span><div className="dica">{r.mensagem}</div></li>)}</ul></Painel>}
      {(def.casos?.length ?? 0) > 0 && (
        <Painel titulo="Casos de borda" semPad>
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Caso</th><th>Muda</th><th>Esperado</th></tr></thead>
            <tbody>{def.casos.map((c: any) => (
              <tr key={c.id}><td><strong>{c.rotulo}</strong><div className="dica mono">{c.id}{c.quebra ? ` · quebra ${c.quebra}` : ''}</div></td><td className="mono" style={{ fontSize: 12 }}>{Object.keys(c.campos ?? {}).join(', ')}</td>
                <td className="mono" style={{ fontSize: 12 }}>{JSON.stringify(c.esperado.status)}{c.esperado.codigo ? ` · ${c.esperado.codigo}` : ''}{c.conferencia ? ' · confere depois' : ''}</td></tr>
            ))}</tbody>
          </table></div>
        </Painel>
      )}
      <Painel titulo="Gabarito padrão"><span className="mono">{JSON.stringify(def.esperado ?? { status: [200, 299] })}</span>{def.conferencia && <div className="dica" style={{ marginTop: 6 }}>Depois do envio, consulta até {def.conferencia.tentativas ?? 1} vez(es) e confere {JSON.stringify(def.conferencia.esperado)}</div>}</Painel>
    </div>
  );
}
