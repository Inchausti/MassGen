import { useEffect, useState } from 'react';
import { baixar, del, get, lerArquivoJson, post, put } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { Cabecalho, CaixaErro, Carregando, Metodo, Painel, Vazio, numero, quando, relativo, useAcao, useCarregar, SeloPapel } from '../ui.tsx';

const ROTULO_TIPO: Record<string, string> = { collection: 'Collection', environment: 'Environment' };

function conteudo(tipo: string, r: any): string {
  if (!r) return '—';
  if (tipo === 'collection') return `${numero(r.requisicoes)} requisições${r.pastas ? ` em ${r.pastas} pastas` : ''}${r.exemplos ? ` · ${r.exemplos} exemplos de resposta` : ''}`;
  return `${numero(r.variaveis)} variáveis${r.segredos?.length ? ` · ${r.segredos.length} no cofre` : ''}${r.segredosVazios?.length ? ` · ${r.segredosVazios.length} segredo(s) vazio(s)` : ''}`;
}

// Importa um ou mais arquivos: cada um vira um item novo, ou uma versão nova do item de mesmo tipo e nome.
async function importarArquivos(arquivos: File[], acao: ReturnType<typeof useAcao>, arquivoId?: string) {
  const saida: any[] = [];
  for (const f of arquivos) {
    const conteudo = await acao.executar(() => lerArquivoJson(f));
    if (conteudo === undefined) continue;
    const r = await acao.executar(() => post('/biblioteca', { conteudo, nomeArquivo: f.name, arquivoId }));
    if (r) saida.push({ origem: f.name, ...r });
  }
  return saida;
}

function ResultadoImportacao({ itens }: { itens: any[] }) {
  if (!itens.length) return null;
  return (
    <div className="alerta ok">
      <div>
        <strong>Importação concluída</strong>
        <ul>
          {itens.map((r, i) => (
            <li key={i}>
              <span className="mono">{r.origem}</span>: {r.nova
                ? <>{ROTULO_TIPO[r.arquivo.tipo]} <Link para={`/biblioteca/${r.arquivo.id}`}>{r.arquivo.nome}</Link> guardado como v{r.versao.numero}.</>
                : <>igual ao que já estava — <Link para={`/biblioteca/${r.arquivo.id}`}>{r.arquivo.nome}</Link> continua na v{r.versao.numero}.</>}
              {r.versao.resumo?.segredos?.length > 0 && <span className="dica"> Segredos no cofre: {r.versao.resumo.segredos.join(', ')}.</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Biblioteca() {
  const { dados, erro, carregando, recarregar } = useCarregar(() => get('/biblioteca'));
  const acao = useAcao();
  const [resultado, setResultado] = useState<any[]>([]);
  const importar = async (lista: FileList | null) => {
    if (!lista?.length) return;
    setResultado(await importarArquivos(Array.from(lista), acao));
    recarregar(true);
  };
  const tabela = (tipo: string) => {
    const itens = (dados ?? []).filter((x: any) => x.tipo === tipo);
    if (!itens.length) return <Vazio titulo={`Nenhum ${ROTULO_TIPO[tipo].toLowerCase()}`}>Use <em>Importar arquivos</em>: o app reconhece sozinho se é collection ou environment.</Vazio>;
    return (
      <div className="tabela-wrap"><table className="tabela">
        <thead><tr><th>Nome</th><th>Versão atual</th><th>Conteúdo</th><th>Importado</th><th>Usado por</th></tr></thead>
        <tbody>
          {itens.map((x: any) => (
            <tr key={x.id}>
              <td><Link para={`/biblioteca/${x.id}`}>{x.nome}</Link></td>
              <td className="mono">v{x.ultima?.numero ?? '—'}{x.versoes > 1 && <span className="dica"> de {x.versoes}</span>}</td>
              <td>{conteudo(tipo, x.ultima?.resumo)}</td>
              <td>{relativo(x.ultima?.importadoEm)}{x.ultima?.importadoPor && <div className="dica">{x.ultima.importadoPor}</div>}</td>
              <td>{x.integracoes.length ? x.integracoes.map((i: any) => <div key={i.id}><Link para={`/destinos/${i.id}`}>{i.nome}</Link></div>) : <span className="dica">Nenhuma integração</span>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    );
  };
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Biblioteca de APIs"
        sub="Collections e environments do Postman, de qualquer sistema, guardados como arquivo original e com versão. Os valores secretos do environment vão para o cofre e o arquivo fica sem eles; tokens de execução não são guardados."
        acoes={<label className="botao primario" style={{ cursor: 'pointer' }}>Importar arquivos<input type="file" accept=".json,application/json" multiple hidden onChange={(e) => { importar(e.target.files); e.target.value = ''; }} /></label>}
      />
      <CaixaErro erro={erro ?? acao.erro} />
      <ResultadoImportacao itens={resultado} />
      {carregando && !dados ? <Carregando /> : (
        <div className="pilha" style={{ gap: 16 }}>
          <Painel titulo="Collections" semPad>{tabela('collection')}</Painel>
          <Painel titulo="Environments" semPad>{tabela('environment')}</Painel>
        </div>
      )}
    </div>
  );
}

export function BibliotecaDetalhe({ id }: { id: string }) {
  const a = useCarregar(() => get(`/biblioteca/${id}`), [id]);
  const acao = useAcao();
  const { navegar } = useRota();
  const [resultado, setResultado] = useState<any[]>([]);
  const [de, setDe] = useState('');
  const [para, setPara] = useState('');
  const [cmp, setCmp] = useState<any>(null);
  const versoes: any[] = a.dados?.versoes ?? [];
  useEffect(() => {
    if (versoes.length >= 2) { setPara(versoes[0].id); setDe(versoes[1].id); }
    setCmp(null);
  }, [a.dados?.versoes?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (a.carregando && !a.dados) return <div className="pagina"><Carregando /></div>;
  if (!a.dados) return <div className="pagina"><CaixaErro erro={a.erro} /></div>;
  const x = a.dados;
  const atual = versoes[0];
  const emUso = versoes.some((v) => v.integracoes.length > 0);
  const novaVersao = async (lista: FileList | null) => {
    if (!lista?.length) return;
    setResultado(await importarArquivos(Array.from(lista).slice(0, 1), acao, id));
    a.recarregar(true);
  };
  const comparar = async () => {
    const r = await acao.executar(() => get(`/biblioteca/comparar?de=${de}&para=${para}`));
    if (r) setCmp(r);
  };
  const passarParaAtual = async (destinoId: string) => {
    const corpo = x.tipo === 'collection' ? { colecaoVersaoId: atual.id } : { environmentVersaoId: atual.id };
    if ((await acao.executar(() => put(`/destinos/${destinoId}/versoes`, corpo), `Integração passou para a v${atual.numero}.`)) !== undefined) a.recarregar(true);
  };
  const remover = async () => {
    if (!confirm(`Remover ${x.nome} e todas as versões da biblioteca?`)) return;
    if ((await acao.executar(() => del(`/biblioteca/${id}`), 'Removido da biblioteca.')) !== undefined) navegar('/biblioteca');
  };
  return (
    <div className="pagina">
      <Cabecalho
        migalha={<Link para="/biblioteca">Biblioteca de APIs</Link>}
        titulo={x.nome}
        sub={`${ROTULO_TIPO[x.tipo]} · ${versoes.length} ${versoes.length === 1 ? 'versão' : 'versões'} · atualizado ${relativo(x.atualizadoEm)}`}
        acoes={<>
          <label className="botao primario" style={{ cursor: 'pointer' }}>Importar versão nova<input type="file" accept=".json,application/json" hidden onChange={(e) => { novaVersao(e.target.files); e.target.value = ''; }} /></label>
          {atual && <button className="botao" onClick={() => acao.executar(() => baixar(`/biblioteca/versoes/${atual.id}/arquivo`))}>Baixar a atual</button>}
          <button className="botao perigo" disabled={emUso} title={emUso ? 'Há integrações usando este item' : undefined} onClick={remover}>Remover</button>
        </>}
      />
      <CaixaErro erro={acao.erro} />
      <ResultadoImportacao itens={resultado} />
      {x.tipo === 'environment' && <div className="alerta info"><div>O arquivo baixado vem sem os valores secretos. Eles ficam no cofre da versão e vão direto para o cofre da integração que usar o environment.</div></div>}
      <Painel titulo="Versões" semPad>
        <div className="tabela-wrap"><table className="tabela">
          <thead><tr><th>Versão</th><th>Importado</th><th>Conteúdo</th><th>Hash</th><th>Usado por</th><th></th></tr></thead>
          <tbody>
            {versoes.map((v) => (
              <tr key={v.id}>
                <td className="mono">v{v.numero}{v === atual && <span className="selo ok sem-ponto" style={{ marginLeft: 6 }}>Atual</span>}</td>
                <td>{quando(v.importadoEm)}<div className="dica">{v.importadoPor ?? '—'}{v.nomeArquivo ? ` · ${v.nomeArquivo}` : ''}</div></td>
                <td>{conteudo(x.tipo, v.resumo)}</td>
                <td className="mono" title={v.hash}>{v.hash.slice(0, 12)}</td>
                <td>
                  {!v.integracoes.length ? <span className="dica">—</span> : v.integracoes.map((i: any) => (
                    <div key={i.id} className="linha-flex" style={{ gap: 6, marginBottom: 4 }}>
                      <Link para={`/destinos/${i.id}`}>{i.nome}</Link><SeloPapel papel={i.papel} />{i.ambiente && <span className="dica">{i.ambiente}</span>}
                      {v !== atual && <button className="botao pequeno" disabled={acao.ocupado} onClick={() => passarParaAtual(i.id)}>Passar para a v{atual.numero}</button>}
                    </div>
                  ))}
                </td>
                <td><button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/biblioteca/versoes/${v.id}/arquivo`))}>Baixar</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Painel>
      {versoes.length >= 2 && (
        <Painel titulo="Comparar versões" acoes={<button className="botao" disabled={!de || !para || de === para || acao.ocupado} onClick={comparar}>Comparar</button>}>
          <div className="linha-flex" style={{ gap: 8, marginBottom: cmp ? 14 : 0 }}>
            <span className="dica">De</span>
            <select value={de} onChange={(e) => { setDe(e.target.value); setCmp(null); }} style={{ width: 'auto' }}>{versoes.map((v) => <option key={v.id} value={v.id}>v{v.numero}</option>)}</select>
            <span className="dica">para</span>
            <select value={para} onChange={(e) => { setPara(e.target.value); setCmp(null); }} style={{ width: 'auto' }}>{versoes.map((v) => <option key={v.id} value={v.id}>v{v.numero}</option>)}</select>
          </div>
          {cmp && <Diferencas cmp={cmp} />}
        </Painel>
      )}
    </div>
  );
}

function Diferencas({ cmp }: { cmp: any }) {
  const nada = !cmp.novas.length && !cmp.removidas.length && !cmp.alteradas.length;
  if (nada) return <div className="alerta ok"><div>Nada mudou entre a v{cmp.de.numero} e a v{cmp.para.numero}.</div></div>;
  const req = (r: any) => <><Metodo m={r.metodo} /> <span className="mono">{r.rota}</span> — {r.nome}{r.pasta && <span className="dica"> · {r.pasta}</span>}</>;
  return (
    <div className="pilha">
      <p className="dica">Da v{cmp.de.numero} para a v{cmp.para.numero}: {cmp.novas.length} {cmp.tipo === 'collection' ? 'requisição(ões)' : 'variável(is)'} nova(s), {cmp.removidas.length} removida(s), {cmp.alteradas.length} alterada(s), {cmp.iguais} igual(is).</p>
      {cmp.novas.length > 0 && <div><strong>Novas</strong><ul>{cmp.novas.map((r: any, i: number) => <li key={i}>{cmp.tipo === 'collection' ? req(r) : <><span className="mono">{r.chave}</span>{r.segredo ? ' (segredo, no cofre)' : ` = ${r.valor ?? ''}`}</>}</li>)}</ul></div>}
      {cmp.removidas.length > 0 && <div><strong>Removidas</strong><ul>{cmp.removidas.map((r: any, i: number) => <li key={i}>{cmp.tipo === 'collection' ? req(r) : <span className="mono">{r.chave}</span>}</li>)}</ul></div>}
      {cmp.alteradas.length > 0 && (
        <div><strong>Alteradas</strong><ul>{cmp.alteradas.map((r: any, i: number) => (
          <li key={i}>
            {cmp.tipo === 'collection'
              ? <>{r.nome} — mudou {r.mudou.join(', ')}{r.mudou.includes('rota') || r.mudou.includes('método') ? <span className="dica"> · {r.de.metodo} {r.de.rota} → {r.para.metodo} {r.para.rota}</span> : null}</>
              : <><span className="mono">{r.chave}</span>{r.segredo ? ' — valor secreto alterado' : <span className="dica"> · {String(r.de ?? '')} → {String(r.para ?? '')}</span>}</>}
          </li>
        ))}</ul></div>
      )}
    </div>
  );
}
