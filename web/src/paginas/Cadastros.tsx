import { useMemo, useState } from 'react';
import { del, get, post, put } from '../api.ts';
import { Link } from '../rotas.tsx';
import { Cabecalho, CaixaErro, Campo, Carregando, Gaveta, Painel, Vazio, quando, relativo, useAcao, useCarregar } from '../ui.tsx';

function obter(obj: any, caminho: string): unknown {
  return caminho.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
}
function definir(obj: any, caminho: string, valor: unknown): any {
  const novo = structuredClone(obj ?? {});
  const ps = caminho.split('.');
  let a = novo;
  for (let i = 0; i < ps.length - 1; i++) { if (typeof a[ps[i]] !== 'object' || a[ps[i]] === null) a[ps[i]] = {}; a = a[ps[i]]; }
  if (valor === '' || valor === undefined) delete a[ps[ps.length - 1]]; else a[ps[ps.length - 1]] = valor;
  return novo;
}

// Formulário montado a partir do modelo da entidade; listas e objetos vão como JSON.
function FormularioDados({ modelo, dados, aoMudar }: { modelo: any; dados: any; aoMudar: (d: any) => void }) {
  return (
    <div className="grade grade-2">
      {modelo.campos.map((c: any) => {
        const v = obter(dados, c.nome);
        const rotulo = `${c.nome}${c.obrigatorio ? ' *' : ''}`;
        if (c.tipo === 'lista' || (v !== null && typeof v === 'object')) {
          return (
            <div key={c.nome} style={{ gridColumn: '1 / -1' }}>
              <Campo rotulo={rotulo} ajuda="JSON">
                <textarea rows={6} defaultValue={v === undefined ? '' : JSON.stringify(v, null, 2)} onBlur={(e) => { try { aoMudar(definir(dados, c.nome, e.target.value ? JSON.parse(e.target.value) : undefined)); } catch { alert(`${c.nome}: JSON inválido.`); } }} />
              </Campo>
            </div>
          );
        }
        if (typeof v === 'boolean' || c.gerador?.tipo === 'booleano') {
          return <label key={c.nome} className="check"><input type="checkbox" checked={!!v} onChange={(e) => aoMudar(definir(dados, c.nome, e.target.checked))} /> {rotulo}</label>;
        }
        return (
          <Campo key={c.nome} rotulo={rotulo} ajuda={c.descricao}>
            <input type="text" value={v === undefined || v === null ? '' : String(v)} onChange={(e) => aoMudar(definir(dados, c.nome, typeof v === 'number' && e.target.value !== '' && !isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value))} />
          </Campo>
        );
      })}
    </div>
  );
}

function Etiquetas({ valor, aoMudar }: { valor: string[]; aoMudar: (v: string[]) => void }) {
  const [nova, setNova] = useState('');
  return (
    <div className="pilha" style={{ gap: 6 }}>
      <div className="chip-lista">{valor.map((e) => <span key={e} className="chip">{e}<button aria-label={`Remover ${e}`} onClick={() => aoMudar(valor.filter((x) => x !== e))}>×</button></span>)}</div>
      <div className="linha-flex"><input type="text" style={{ maxWidth: 220 }} placeholder="Nova etiqueta" value={nova} onChange={(e) => setNova(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && nova.trim()) { aoMudar([...new Set([...valor, nova.trim()])]); setNova(''); } }} /><span className="dica">Enter para incluir</span></div>
    </div>
  );
}

export function Cadastros() {
  const [entidade, setEntidade] = useState('');
  const [buscaTexto, setBuscaTexto] = useState('');
  const [etiqueta, setEtiqueta] = useState('');
  const modelos = useCarregar(() => get('/modelos'));
  const etiquetas = useCarregar(() => get('/cadastros-etiquetas'));
  const lista = useCarregar(() => get(`/cadastros?${new URLSearchParams({ ...(entidade ? { entidade } : {}), ...(buscaTexto ? { busca: buscaTexto } : {}), ...(etiqueta ? { etiqueta } : {}) })}`), [entidade, buscaTexto, etiqueta]);
  const [aberto, setAberto] = useState<any>(null);
  const entidades = useMemo(() => [...new Map((modelos.dados ?? []).map((m: any) => [m.nome, m])).values()], [modelos.dados]);
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Cadastros mestres"
        sub="Registros salvos de qualquer entidade — empresas, contratos e o que mais o pacote tiver. Viram matriz nos cenários e guardam o id que receberam em cada destino, para não criar de novo."
        acoes={<button className="botao primario" onClick={() => setAberto({ novo: true, entidade: entidade || (entidades[0] as any)?.nome, dados: {}, etiquetas: [] })}>Novo cadastro</button>}
      />
      <div className="linha-flex">
        <select value={entidade} onChange={(e) => setEntidade(e.target.value)} style={{ maxWidth: 220 }} aria-label="Entidade"><option value="">Todas as entidades</option>{entidades.map((m: any) => <option key={m.nome} value={m.nome}>{m.rotulo}</option>)}</select>
        <input type="search" placeholder="Buscar por rótulo ou conteúdo" value={buscaTexto} onChange={(e) => setBuscaTexto(e.target.value)} style={{ maxWidth: 320 }} />
        <select value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} style={{ maxWidth: 200 }} aria-label="Etiqueta"><option value="">Qualquer etiqueta</option>{(etiquetas.dados ?? []).map((e: string) => <option key={e}>{e}</option>)}</select>
      </div>
      <CaixaErro erro={lista.erro} />
      <Painel semPad>
        {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.length ? <Vazio titulo="Nenhum cadastro">Cadastre à mão ou salve um registro da massa gerada, na execução.</Vazio> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Cadastro</th><th>Entidade</th><th>Etiquetas</th><th>Nos destinos</th><th className="num">Versão</th><th>Atualizado</th></tr></thead>
            <tbody>{lista.dados.map((c: any) => (
              <tr key={c.id} className="clicavel" onClick={() => setAberto(c)}>
                <td>{c.rotulo}</td><td className="mono">{c.entidade}</td>
                <td><div className="chip-lista">{c.etiquetas.map((e: string) => <span key={e} className="chip">{e}</span>)}</div></td>
                <td>{c.vinculos.length ? c.vinculos.map((v: any) => <div key={v.destinoId} className="dica"><strong>{v.destino ?? v.destinoId}</strong> · <span className="mono">{v.idRemoto}</span></div>) : <span className="dica">Ainda não enviado</span>}</td>
                <td className="num">{c.versao}</td><td className="nowrap">{relativo(c.atualizadoEm)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Painel>
      {aberto && <EditorCadastro inicial={aberto} entidades={entidades} aoFechar={() => setAberto(null)} aoSalvar={() => { setAberto(null); lista.recarregar(true); etiquetas.recarregar(true); }} />}
    </div>
  );
}

function EditorCadastro({ inicial, entidades, aoFechar, aoSalvar }: { inicial: any; entidades: any[]; aoFechar: () => void; aoSalvar: () => void }) {
  const [c, setC] = useState(inicial);
  const [comoJson, setComoJson] = useState(false);
  const [texto, setTexto] = useState(JSON.stringify(inicial.dados ?? {}, null, 2));
  const modeloResumo = entidades.find((m: any) => m.nome === c.entidade);
  const modelo = useCarregar(() => (modeloResumo ? get(`/modelos/${modeloResumo.id}`) : Promise.resolve(null)), [modeloResumo?.id]);
  const acao = useAcao();
  const dados = comoJson ? (() => { try { return JSON.parse(texto); } catch { return null; } })() : c.dados;
  const preencherExemplo = async () => {
    if (!modeloResumo) return;
    const r = await acao.executar(() => post(`/modelos/${modeloResumo.id}/exemplo`, { semente: Math.floor(Math.random() * 1e6) }));
    if (r?.[0]) { setC({ ...c, dados: r[0].dados }); setTexto(JSON.stringify(r[0].dados, null, 2)); }
  };
  const salvar = async () => {
    if (!dados) { alert('O JSON dos dados está inválido.'); return; }
    const corpo = { entidade: c.entidade, pacoteId: modeloResumo?.pacoteId, rotulo: c.rotulo, dados, etiquetas: c.etiquetas };
    const r = await acao.executar(() => (c.novo ? post('/cadastros', corpo) : put(`/cadastros/${c.id}`, corpo)), 'Cadastro salvo.');
    if (r) aoSalvar();
  };
  return (
    <Gaveta titulo={c.novo ? 'Novo cadastro' : c.rotulo} sub={c.novo ? 'Preencha à mão ou parta de um exemplo gerado.' : `${c.entidade} · versão ${c.versao} · criado ${quando(c.criadoEm)}`} aoFechar={aoFechar}
      acoes={<>{!c.novo && <button className="botao perigo pequeno" onClick={async () => { if (confirm('Remover este cadastro?') && (await acao.executar(() => del(`/cadastros/${c.id}`), 'Cadastro removido.')) !== undefined) aoSalvar(); }}>Remover</button>}<button className="botao primario pequeno" disabled={acao.ocupado} onClick={salvar}>Salvar</button></>}>
      <CaixaErro erro={acao.erro} />
      <div className="grade grade-2">
        <Campo rotulo="Entidade">{c.novo ? <select value={c.entidade} onChange={(e) => setC({ ...c, entidade: e.target.value, dados: {} })}>{entidades.map((m: any) => <option key={m.nome} value={m.nome}>{m.rotulo}</option>)}</select> : <input type="text" value={c.entidade} disabled />}</Campo>
        <Campo rotulo="Rótulo" ajuda="Vazio: usa o rótulo do modelo."><input type="text" value={c.rotulo ?? ''} onChange={(e) => setC({ ...c, rotulo: e.target.value })} /></Campo>
      </div>
      <Campo rotulo="Etiquetas"><Etiquetas valor={c.etiquetas ?? []} aoMudar={(v) => setC({ ...c, etiquetas: v })} /></Campo>
      <div className="linha-flex">
        <h3>Dados</h3><span className="espaco" />
        <button className="botao pequeno" onClick={preencherExemplo}>Preencher com exemplo</button>
        <label className="check"><input type="checkbox" checked={comoJson} onChange={(e) => { if (e.target.checked) setTexto(JSON.stringify(c.dados ?? {}, null, 2)); else if (dados) setC({ ...c, dados }); setComoJson(e.target.checked); }} /> Editar como JSON</label>
      </div>
      {comoJson ? <textarea rows={18} value={texto} onChange={(e) => setTexto(e.target.value)} /> : modelo.dados ? <FormularioDados modelo={modelo.dados.definicao} dados={c.dados} aoMudar={(d) => setC({ ...c, dados: d })} /> : <Carregando />}
      {!c.novo && (
        <Painel titulo="Vínculos com destinos">
          {!c.vinculos?.length ? <p className="dica">Ainda não foi criado em nenhum destino. Use o cadastro num cenário e envie.</p> : (
            <ul className="tempo">{c.vinculos.map((v: any) => (
              <li key={v.destinoId}><div className="linha-flex"><div><strong>{v.destino ?? v.destinoId}</strong> · <span className="mono">{v.idRemoto}</span><div className="quando">{quando(v.atualizadoEm)}</div></div><span className="espaco" />
                <button className="botao pequeno" onClick={async () => { if (confirm('Desfazer o vínculo? No próximo uso, o cadastro é criado de novo no destino.')) { const r = await acao.executar(() => del(`/cadastros/${c.id}/vinculos/${v.destinoId}`), 'Vínculo removido.'); if (r) setC({ ...c, vinculos: r.vinculos }); } }}>Desvincular</button></div></li>
            ))}</ul>
          )}
          <p className="dica" style={{ marginTop: 8 }}>Ver também: <Link para="/auditoria">trilha de auditoria</Link>.</p>
        </Painel>
      )}
    </Gaveta>
  );
}
