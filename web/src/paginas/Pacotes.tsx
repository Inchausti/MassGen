import { useState } from 'react';
import { baixar, del, get, lerArquivoJson, post } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import { Cabecalho, CaixaErro, Carregando, Painel, Vazio, quando, useAcao, useCarregar } from '../ui.tsx';

export function Pacotes() {
  const { dados, erro, carregando, recarregar } = useCarregar(() => get('/pacotes'));
  const destinos = useCarregar(() => get('/destinos'));
  const acao = useAcao();
  const { navegar } = useRota();
  const [sobrescrever, setSobrescrever] = useState(false);
  const instalar = async (arq?: File) => {
    if (!arq) return;
    const conteudo = await acao.executar(() => lerArquivoJson(arq));
    if (conteudo && (await acao.executar(() => post('/pacotes', { conteudo, sobrescrever }), 'Pacote instalado.'))) recarregar(true);
  };
  const usar = async (pacoteId: string, cenarioId: string) => {
    const destino = destinos.dados?.find((d: any) => d.pacoteId === pacoteId);
    const c = await acao.executar(() => post('/cenarios/do-pacote', { pacoteId, cenarioId, destinoId: destino?.id }), 'Cenário criado.');
    if (c) navegar(`/cenarios/${c.id}`);
  };
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Pacotes de domínio"
        sub="Tudo o que é específico de um sistema fica num pacote: modelos de entidade, regras, casos de borda, estrutura de APIs padrão e cenários prontos. O núcleo do app não conhece nenhum domínio."
        acoes={<>
          <label className="check"><input type="checkbox" checked={sobrescrever} onChange={(e) => setSobrescrever(e.target.checked)} /> Sobrescrever modelos alterados</label>
          <label className="botao primario" style={{ cursor: 'pointer' }}>Instalar pacote (JSON)<input type="file" accept=".json" hidden onChange={(e) => { instalar(e.target.files?.[0]); e.target.value = ''; }} /></label>
        </>}
      />
      <CaixaErro erro={erro ?? acao.erro} />
      {carregando && !dados ? <Carregando /> : !dados?.length ? <Vazio titulo="Nenhum pacote instalado" /> : dados.map((p: any) => (
        <Painel key={p.id} titulo={<>{p.nome} <span className="selo sem-ponto">{p.versao}</span>{p.embutido && <span className="selo info sem-ponto" style={{ marginLeft: 6 }}>Embutido</span>}</>}
          acoes={<>
            <button className="botao pequeno" onClick={() => acao.executar(() => baixar(`/pacotes/${p.id}/exportar`))}>Exportar</button>
            <button className="botao pequeno perigo" onClick={async () => { if (confirm(`Remover o pacote ${p.nome}? Modelos e cenários prontos dele saem.`) && (await acao.executar(() => del(`/pacotes/${p.id}`), 'Pacote removido.')) !== undefined) recarregar(true); }}>Remover</button>
          </>}>
          <div className="pilha">
            {p.descricao && <p>{p.descricao}</p>}
            <dl className="kv">
              <dt>Contrato</dt><dd>{p.contrato ?? '—'}</dd>
              <dt>Modelos</dt><dd>{p.modelos.map((m: any) => <Link key={m.nome} para={`/modelos?pacote=${p.id}`} className="chip" title={m.nome}>{m.rotulo}</Link>)}</dd>
              <dt>Operações padrão</dt><dd>{p.operacoes}</dd>
              <dt>Sempre bloqueados</dt><dd className="mono">{p.dominiosProducao.join(', ') || '—'}</dd>
              <dt>Instalado</dt><dd>{quando(p.instaladoEm)}</dd>
            </dl>
            {p.cenarios.length > 0 && (
              <div className="tabela-wrap"><table className="tabela">
                <thead><tr><th>Cenário pronto</th><th>O que gera</th><th></th></tr></thead>
                <tbody>{p.cenarios.map((c: any) => (
                  <tr key={c.id}><td className="nowrap"><strong>{c.nome}</strong></td><td>{c.descricao}</td><td className="nowrap"><button className="botao pequeno" onClick={() => usar(p.id, c.id)}>Usar como base</button></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
        </Painel>
      ))}
    </div>
  );
}
