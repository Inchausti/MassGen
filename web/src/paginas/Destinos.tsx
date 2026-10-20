import { useEffect, useState } from 'react';
import { get, post } from '../api.ts';
import { Link, useRota } from '../rotas.tsx';
import {
  Abas, Cabecalho, CaixaErro, Campo, Carregando, Painel, Vazio, useAcao, useCarregar, ROTULO_AMBIENTE, ROTULO_AUTH, SeloIntegracao, SeloPapel,
} from '../ui.tsx';
import { ImportarPostman } from './ImportarPostman.tsx';

export function Destinos() {
  const { dados, erro, carregando } = useCarregar(() => get('/destinos'));
  return (
    <div className="pagina">
      <Cabecalho
        titulo="Integrações"
        sub="As APIs de cada ambiente. No papel de cliente, o app envia a massa para a API do sistema testado; no de ente emulado, faz o papel de um terceiro que o sistema integra. Cada integração tem endereço, credencial no cofre, limites e a estrutura de APIs. Só domínios da lista permitida e nunca produção."
        acoes={<Link para="/destinos/novo" className="botao primario">Nova integração</Link>}
      />
      <CaixaErro erro={erro} />
      <Painel semPad>
        {carregando && !dados ? <Carregando /> : !dados?.length ? (
          <Vazio titulo="Nenhuma integração cadastrada">Importe a collection do Postman, ligue uma da biblioteca ou preencha à mão. <Link para="/destinos/novo">Cadastrar integração</Link></Vazio>
        ) : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Integração</th><th>Ambiente</th><th>Papel</th><th>Situação</th><th>Autenticação</th><th className="num">Operações</th><th>Credencial</th></tr></thead>
            <tbody>
              {dados.map((d: any) => (
                <tr key={d.id}>
                  <td><Link para={`/destinos/${d.id}`}>{d.nome}</Link>{!d.ativo && <span className="selo" style={{ marginLeft: 8 }}>Inativo</span>}<div className="dica mono quebra">{d.baseUrl}</div></td>
                  <td>{d.ambiente ? <Link para={`/ambientes/${d.ambiente.id}`}>{d.ambiente.nome}</Link> : ROTULO_AMBIENTE[d.tipoAmbiente]}</td>
                  <td><SeloPapel papel={d.papel} ente={d.ente} /></td>
                  <td><SeloIntegracao status={d.status} /></td>
                  <td>{ROTULO_AUTH[d.autenticacao.tipo] ?? d.autenticacao.tipo}</td>
                  <td className="num">{d.operacoes}</td>
                  <td>{d.segredos.length ? <span className="selo ok">{d.segredos.length} no cofre</span> : d.autenticacao.tipo === 'nenhuma' ? <span className="dica">—</span> : <span className="selo aviso">Falta</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Painel>
    </div>
  );
}

// ---------------------------------------------------------------- formulário

export interface FormularioDestino {
  nome: string; tipoAmbiente: string; baseUrl: string; pacoteId: string | null;
  ambienteId: string | null; papel: string; ente: string | null;
  autenticacao: { tipo: string; cabecalho?: string; usuario?: string; tokenUrl?: string; formato?: string; escopo?: string };
  limites: { porMinuto?: number; tentativas?: number; timeoutMs?: number };
  idempotencia: { cabecalho?: string };
  rastreio: { cabecalho?: string };
  cabecalhos: Record<string, string>;
  variaveis: Record<string, string>;
  teste: { metodo?: string; rota?: string };
  ativo?: boolean;
}

export const DESTINO_VAZIO: FormularioDestino = {
  nome: '', tipoAmbiente: 'sandbox', baseUrl: '', pacoteId: null, ambienteId: null, papel: 'cliente', ente: '', autenticacao: { tipo: 'nenhuma' }, limites: { porMinuto: 600, tentativas: 4, timeoutMs: 30000 },
  idempotencia: { cabecalho: '' }, rastreio: { cabecalho: 'X-MassGen-Rastreio' }, cabecalhos: { 'Content-Type': 'application/json' }, variaveis: {}, teste: { metodo: 'GET', rota: '' },
};

function ChaveValor({ valor, aoMudar, rotuloChave = 'Nome', rotuloValor = 'Valor' }: { valor: Record<string, string>; aoMudar: (v: Record<string, string>) => void; rotuloChave?: string; rotuloValor?: string }) {
  const [linhas, setLinhas] = useState<[string, string][]>(Object.entries(valor));
  useEffect(() => { setLinhas(Object.entries(valor)); }, [JSON.stringify(valor)]); // eslint-disable-line react-hooks/exhaustive-deps
  const publicar = (ls: [string, string][]) => { setLinhas(ls); aoMudar(Object.fromEntries(ls.filter(([k]) => k.trim()))); };
  return (
    <div className="pilha" style={{ gap: 6 }}>
      {linhas.map(([k, v], i) => (
        <div key={i} className="linha-flex" style={{ flexWrap: 'nowrap' }}>
          <input type="text" aria-label={rotuloChave} placeholder={rotuloChave} value={k} onChange={(e) => publicar(linhas.map((l, j) => (j === i ? [e.target.value, l[1]] : l)))} />
          <input type="text" aria-label={rotuloValor} placeholder={rotuloValor} value={v} onChange={(e) => publicar(linhas.map((l, j) => (j === i ? [l[0], e.target.value] : l)))} />
          <button className="botao fantasma pequeno" aria-label="Remover" onClick={() => publicar(linhas.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <div><button className="botao pequeno" onClick={() => setLinhas([...linhas, ['', '']])}>Adicionar</button></div>
    </div>
  );
}

export function FormDestino({ valor, aoMudar, pacotes, ambientes, novo }: { valor: FormularioDestino; aoMudar: (v: FormularioDestino) => void; pacotes: any[]; ambientes: any[]; novo: boolean }) {
  const set = (p: Partial<FormularioDestino>) => aoMudar({ ...valor, ...p });
  const amb = ambientes.find((x) => x.id === valor.ambienteId);
  const a = valor.autenticacao;
  const escolherPacote = (id: string) => {
    const pac = pacotes.find((p) => p.id === id);
    const padrao = pac?.destinoPadrao;
    if (novo && padrao) {
      aoMudar({
        ...valor, pacoteId: id || null,
        autenticacao: padrao.autenticacao ?? valor.autenticacao, limites: { ...valor.limites, ...(padrao.limites ?? {}) },
        idempotencia: padrao.idempotencia ?? valor.idempotencia, cabecalhos: padrao.cabecalhos ?? valor.cabecalhos,
        variaveis: { ...(padrao.variaveis ?? {}), ...valor.variaveis }, teste: padrao.teste ?? valor.teste,
      });
    } else set({ pacoteId: id || null });
  };
  return (
    <div className="pilha" style={{ gap: 18 }}>
      <Painel titulo="Identificação">
        <div className="grade grade-2">
          <Campo rotulo="Nome"><input type="text" value={valor.nome} onChange={(e) => set({ nome: e.target.value })} placeholder="SplitHub API v1" /></Campo>
          <Campo rotulo="Ambiente" ajuda={amb ? `${ROTULO_AMBIENTE[amb.tipo]}: o tipo vem do ambiente.` : 'Sem escolha, vai para o ambiente do pacote e do tipo.'}>
            <select value={valor.ambienteId ?? ''} onChange={(e) => {
              const a = ambientes.find((x) => x.id === e.target.value);
              set({ ambienteId: e.target.value || null, ...(a ? { tipoAmbiente: a.tipo, ...(novo && a.pacoteId && !valor.pacoteId ? { pacoteId: a.pacoteId } : {}) } : {}) });
            }}>
              <option value="">Escolher pelo pacote e pelo tipo</option>
              {ambientes.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
            </select>
          </Campo>
          {!amb && <Campo rotulo="Tipo de ambiente" ajuda="Produção não existe como opção.">
            <select value={valor.tipoAmbiente} onChange={(e) => set({ tipoAmbiente: e.target.value })}>
              <option value="sandbox">Sandbox</option><option value="homologacao">Homologação</option><option value="desenvolvimento">Desenvolvimento</option>
            </select>
          </Campo>}
          <Campo rotulo="Papel" ajuda={valor.papel === 'emulador' ? 'O app faz o papel de um ente que o sistema integra e entrega os eventos dele nas rotas do sistema.' : 'O app chama a API do sistema testado, como um cliente.'}>
            <select value={valor.papel} onChange={(e) => set({ papel: e.target.value })}>
              <option value="cliente">Cliente</option><option value="emulador">Ente emulado</option>
            </select>
          </Campo>
          {valor.papel === 'emulador' && <Campo rotulo="Ente emulado" ajuda="Quem o app representa, como Receita Federal ou Comitê Gestor do IBS."><input type="text" value={valor.ente ?? ''} onChange={(e) => set({ ente: e.target.value })} placeholder="Receita Federal" /></Campo>}
          <Campo rotulo="Endereço base" ajuda="Precisa estar em ALLOWED_DESTINATION_DOMAINS, no .env."><input type="url" value={valor.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://sandbox.exemplo.com" /></Campo>
          <Campo rotulo="Pacote de domínio" ajuda="Define os modelos, a estrutura padrão e os cenários prontos.">
            <select value={valor.pacoteId ?? ''} onChange={(e) => escolherPacote(e.target.value)}>
              <option value="">Sem pacote</option>
              {pacotes.map((p) => <option key={p.id} value={p.id}>{p.nome} {p.versao}</option>)}
            </select>
          </Campo>
          {!novo && <label className="check"><input type="checkbox" checked={valor.ativo !== false} onChange={(e) => set({ ativo: e.target.checked })} /> Integração ativa (aceita envios)</label>}
        </div>
      </Painel>
      <Painel titulo="Autenticação">
        <div className="grade grade-2">
          <Campo rotulo="Tipo" ajuda="As credenciais ficam no cofre, na aba Segredos.">
            <select value={a.tipo} onChange={(e) => set({ autenticacao: { tipo: e.target.value } })}>
              {Object.entries(ROTULO_AUTH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Campo>
          {a.tipo === 'chave_api' && <Campo rotulo="Cabeçalho da chave"><input type="text" value={a.cabecalho ?? ''} onChange={(e) => set({ autenticacao: { ...a, cabecalho: e.target.value } })} placeholder="X-API-Key" /></Campo>}
          {a.tipo === 'basic' && <Campo rotulo="Usuário"><input type="text" value={a.usuario ?? ''} onChange={(e) => set({ autenticacao: { ...a, usuario: e.target.value } })} /></Campo>}
          {a.tipo === 'oauth2_cc' && <>
            <Campo rotulo="Endereço do token" ajuda="Rota relativa ao endereço base ou URL completa."><input type="text" value={a.tokenUrl ?? ''} onChange={(e) => set({ autenticacao: { ...a, tokenUrl: e.target.value } })} placeholder="/oauth/token" /></Campo>
            <Campo rotulo="Formato do pedido de token">
              <select value={a.formato ?? 'json'} onChange={(e) => set({ autenticacao: { ...a, formato: e.target.value } })}>
                <option value="json">JSON</option><option value="form">Formulário (x-www-form-urlencoded)</option>
              </select>
            </Campo>
            <Campo rotulo="Escopo (opcional)"><input type="text" value={a.escopo ?? ''} onChange={(e) => set({ autenticacao: { ...a, escopo: e.target.value } })} /></Campo>
          </>}
        </div>
      </Painel>
      <Painel titulo="Envio e rastreio">
        <div className="grade grade-3">
          <Campo rotulo="Requisições por minuto" ajuda="Fique abaixo do limite da API."><input type="number" min={1} value={valor.limites.porMinuto ?? ''} onChange={(e) => set({ limites: { ...valor.limites, porMinuto: Number(e.target.value) || undefined } })} /></Campo>
          <Campo rotulo="Tentativas por chamada" ajuda="429, 5xx e falha de rede."><input type="number" min={1} max={10} value={valor.limites.tentativas ?? ''} onChange={(e) => set({ limites: { ...valor.limites, tentativas: Number(e.target.value) || undefined } })} /></Campo>
          <Campo rotulo="Tempo limite (ms)"><input type="number" min={1000} step={1000} value={valor.limites.timeoutMs ?? ''} onChange={(e) => set({ limites: { ...valor.limites, timeoutMs: Number(e.target.value) || undefined } })} /></Campo>
          <Campo rotulo="Cabeçalho de idempotência" ajuda="Vazio: sem idempotência. A chave vem da execução e do registro."><input type="text" value={valor.idempotencia.cabecalho ?? ''} onChange={(e) => set({ idempotencia: { cabecalho: e.target.value } })} placeholder="Idempotency-Key" /></Campo>
          <Campo rotulo="Cabeçalho de rastreio" ajuda="Leva o código MG-… de cada chamada. Vazio: não envia."><input type="text" value={valor.rastreio.cabecalho ?? ''} onChange={(e) => set({ rastreio: { cabecalho: e.target.value } })} placeholder="X-MassGen-Rastreio" /></Campo>
          <Campo rotulo="Chamada de teste" ajuda="Usada em Testar conexão.">
            <div className="linha-flex" style={{ flexWrap: 'nowrap' }}>
              <select style={{ width: 90 }} value={valor.teste.metodo ?? 'GET'} onChange={(e) => set({ teste: { ...valor.teste, metodo: e.target.value } })}><option>GET</option><option>HEAD</option></select>
              <input type="text" value={valor.teste.rota ?? ''} onChange={(e) => set({ teste: { ...valor.teste, rota: e.target.value } })} placeholder="/v1/recurso?page_size=1" />
            </div>
          </Campo>
        </div>
      </Painel>
      <div className="lado-a-lado">
        <Painel titulo="Variáveis da integração"><p className="dica" style={{ marginBottom: 10 }}>Valores que a massa usa, como o CNPJ do comprador. Nos modelos: gerador "variável" ou <code>$var.nome</code>.</p><ChaveValor valor={valor.variaveis} aoMudar={(v) => set({ variaveis: v })} /></Painel>
        <Painel titulo="Cabeçalhos fixos"><p className="dica" style={{ marginBottom: 10 }}>Vão em toda chamada. Autenticação e idempotência são acrescentadas pelo app.</p><ChaveValor valor={valor.cabecalhos} aoMudar={(v) => set({ cabecalhos: v })} rotuloChave="Cabeçalho" /></Painel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- novo destino

export function NovoDestino() {
  const { navegar, busca } = useRota();
  const [modo, setModo] = useState<'importar' | 'manual'>(busca.get('modo') === 'manual' ? 'manual' : 'importar');
  const pacotes = useCarregar(() => get('/pacotes'));
  const ambientes = useCarregar(() => get('/ambientes'));
  const ambienteInicial = busca.get('ambiente');
  const [form, setForm] = useState<FormularioDestino>({ ...DESTINO_VAZIO, ambienteId: ambienteInicial });
  useEffect(() => {
    const a = (ambientes.dados ?? []).find((x: any) => x.id === form.ambienteId);
    if (a) setForm((f) => ({ ...f, tipoAmbiente: a.tipo, pacoteId: f.pacoteId ?? a.pacoteId ?? null }));
  }, [ambientes.dados]); // eslint-disable-line react-hooks/exhaustive-deps
  const acao = useAcao();
  const criar = async () => {
    const corpo = { ...form, pacoteId: form.pacoteId || null, ambienteId: form.ambienteId || undefined, ente: form.papel === 'emulador' ? form.ente : null };
    const d = await acao.executar(() => post('/destinos', corpo), 'Integração criada.');
    if (d) navegar(`/destinos/${d.id}?aba=${d.papel === 'emulador' ? 'conexao' : 'segredos'}`);
  };
  return (
    <div className="pagina">
      <Cabecalho migalha={<Link para="/destinos">Integrações</Link>} titulo="Nova integração" sub="Importe do Postman ou preencha à mão. Os arquivos importados vão para a biblioteca de APIs. Os dois caminhos se combinam: dá para ajustar à mão o que veio da importação e importar depois sobre uma integração preenchida. Para um ente emulado cujas rotas o sistema ainda não expõe, preencha à mão: a integração fica aguardando rota." />
      <Abas abas={[{ id: 'importar', rotulo: 'Importar do Postman' }, { id: 'manual', rotulo: 'Preencher à mão' }]} ativa={modo} aoMudar={setModo} />
      {modo === 'importar' ? (
        <ImportarPostman pacotes={pacotes.dados ?? []} ambientes={ambientes.dados ?? []} ambienteInicial={ambienteInicial} aoConcluir={(id) => navegar(`/destinos/${id}?aba=estrutura`)} />
      ) : (
        <>
          <CaixaErro erro={acao.erro} />
          <FormDestino valor={form} aoMudar={setForm} pacotes={pacotes.dados ?? []} ambientes={ambientes.dados ?? []} novo />
          <div className="acoes"><button className="botao primario" disabled={acao.ocupado || !form.nome || !form.baseUrl || (form.papel === 'emulador' && !form.ente)} onClick={criar}>Criar integração</button><Link para="/destinos" className="botao">Cancelar</Link></div>
        </>
      )}
    </div>
  );
}
