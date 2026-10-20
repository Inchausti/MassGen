// Componentes de interface compartilhados.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ErroApi } from './api.ts';
import { Link } from './rotas.tsx';

// ---------------------------------------------------------------- dados

export function useCarregar<T>(carregar: () => Promise<T>, deps: unknown[] = [], intervaloMs?: number) {
  const [dados, setDados] = useState<T | undefined>(undefined);
  const [erro, setErro] = useState<ErroApi | null>(null);
  const [carregando, setCarregando] = useState(true);
  const ref = useRef(carregar);
  ref.current = carregar;
  const recarregar = useCallback(async (silencioso = false) => {
    if (!silencioso) setCarregando(true);
    try {
      setDados(await ref.current());
      setErro(null);
    } catch (e) {
      setErro(e instanceof ErroApi ? e : new ErroApi(0, (e as Error).message));
    } finally {
      setCarregando(false);
    }
  }, []);
  useEffect(() => { recarregar(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!intervaloMs) return;
    const t = setInterval(() => recarregar(true), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs, recarregar]);
  return { dados, erro, carregando, recarregar, setDados };
}

// ---------------------------------------------------------------- avisos

interface Aviso { id: number; texto: string; tipo: 'ok' | 'erro' }
const ContextoAvisos = createContext<(texto: string, tipo?: 'ok' | 'erro') => void>(() => {});

export function ProvedorAvisos({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const avisar = useCallback((texto: string, tipo: 'ok' | 'erro' = 'ok') => {
    const id = Date.now() + Math.random();
    setAvisos((a) => [...a, { id, texto, tipo }]);
    setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), tipo === 'erro' ? 7000 : 3500);
  }, []);
  return (
    <ContextoAvisos.Provider value={avisar}>
      {children}
      <div className="avisos-flutuantes" role="status" aria-live="polite">
        {avisos.map((a) => <div key={a.id} className={`aviso-flutuante ${a.tipo}`}>{a.texto}</div>)}
      </div>
    </ContextoAvisos.Provider>
  );
}

export const useAvisos = () => useContext(ContextoAvisos);

// Executa uma ação com aviso de sucesso e, no erro, aviso com a mensagem do servidor.
export function useAcao() {
  const avisar = useAvisos();
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<ErroApi | null>(null);
  const executar = useCallback(async <T,>(fn: () => Promise<T>, sucesso?: string): Promise<T | undefined> => {
    setOcupado(true);
    setErro(null);
    try {
      const r = await fn();
      if (sucesso) avisar(sucesso);
      return r;
    } catch (e) {
      const err = e instanceof ErroApi ? e : new ErroApi(0, (e as Error).message);
      setErro(err);
      avisar(err.message, 'erro');
      return undefined;
    } finally {
      setOcupado(false);
    }
  }, [avisar]);
  return { executar, ocupado, erro, limparErro: () => setErro(null) };
}

// ---------------------------------------------------------------- blocos

export function Cabecalho({ titulo, sub, migalha, acoes }: { titulo: ReactNode; sub?: ReactNode; migalha?: ReactNode; acoes?: ReactNode }) {
  return (
    <div className="cabecalho">
      <div>
        {migalha && <div className="migalha">{migalha}</div>}
        <h1>{titulo}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {acoes && <div className="acoes">{acoes}</div>}
    </div>
  );
}

export function Painel({ titulo, acoes, children, semPad, className }: { titulo?: ReactNode; acoes?: ReactNode; children: ReactNode; semPad?: boolean; className?: string }) {
  return (
    <section className={`painel ${className ?? ''}`}>
      {(titulo || acoes) && <div className="painel-cab"><h2>{titulo}</h2>{acoes && <div className="acoes">{acoes}</div>}</div>}
      <div className={`painel-corpo ${semPad ? 'sem-pad' : ''}`}>{children}</div>
    </section>
  );
}

export function CaixaErro({ erro }: { erro: ErroApi | null | undefined }) {
  if (!erro) return null;
  const lista = Array.isArray(erro.detalhes) ? (erro.detalhes as string[]) : [];
  return (
    <div className="alerta erro" role="alert">
      <div>
        <strong>{erro.message}</strong>
        {lista.length > 0 && <ul>{lista.map((d, i) => <li key={i}>{d}</li>)}</ul>}
        {!lista.length && typeof erro.detalhes === 'string' && <div className="dica">{erro.detalhes}</div>}
      </div>
    </div>
  );
}

export function Carregando({ texto = 'Carregando…' }: { texto?: string }) {
  return <div className="vazio">{texto}</div>;
}

export function Vazio({ titulo, children }: { titulo: string; children?: ReactNode }) {
  return <div className="vazio"><h3>{titulo}</h3>{children}</div>;
}

export function Abas<T extends string>({ abas, ativa, aoMudar }: { abas: { id: T; rotulo: string; contagem?: number | string }[]; ativa: T; aoMudar: (id: T) => void }) {
  return (
    <div className="abas" role="tablist">
      {abas.map((a) => (
        <button key={a.id} role="tab" aria-selected={a.id === ativa} className={`aba ${a.id === ativa ? 'ativa' : ''}`} onClick={() => aoMudar(a.id)}>
          {a.rotulo}{a.contagem !== undefined && <span className="contagem">{a.contagem}</span>}
        </button>
      ))}
    </div>
  );
}

export function Campo({ rotulo, ajuda, erro, children }: { rotulo: string; ajuda?: ReactNode; erro?: string; children: ReactNode }) {
  return (
    <label className="campo">
      <span className="rotulo">{rotulo}</span>
      {children}
      {erro ? <span className="erro-campo">{erro}</span> : ajuda ? <span className="ajuda">{ajuda}</span> : null}
    </label>
  );
}

export function Gaveta({ titulo, sub, aoFechar, acoes, children }: { titulo: ReactNode; sub?: ReactNode; aoFechar: () => void; acoes?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && aoFechar();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [aoFechar]);
  return (
    <>
      <div className="veu" onClick={aoFechar} />
      <aside className="gaveta" role="dialog" aria-modal="true">
        <div className="gaveta-cab">
          <div><h2>{titulo}</h2>{sub && <div className="dica" style={{ marginTop: 4 }}>{sub}</div>}</div>
          <div className="acoes">{acoes}<button className="botao fantasma" onClick={aoFechar} aria-label="Fechar">✕</button></div>
        </div>
        <div className="gaveta-corpo">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ titulo, aoFechar, rodape, children }: { titulo: ReactNode; aoFechar: () => void; rodape?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && aoFechar();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [aoFechar]);
  return (
    <>
      <div className="veu" onClick={aoFechar} />
      <div className="modal" role="dialog" aria-modal="true">
        <div className="gaveta-cab"><h2>{titulo}</h2><button className="botao fantasma" onClick={aoFechar} aria-label="Fechar">✕</button></div>
        <div className="modal-corpo">{children}</div>
        {rodape && <div className="modal-rodape">{rodape}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- selos

const STATUS_EXECUCAO: Record<string, [string, string]> = {
  gerada: ['Gerada', 'info'], enviando: ['Enviando', 'destaque'], conferindo: ['Conferindo', 'destaque'], pausada: ['Pausada', 'aviso'],
  concluida: ['Concluída', 'ok'], cancelada: ['Cancelada', ''], interrompida: ['Interrompida', 'aviso'], erro: ['Erro', 'erro'],
};
export function SeloExecucao({ status }: { status: string }) {
  const [t, c] = STATUS_EXECUCAO[status] ?? [status, ''];
  return <span className={`selo ${c}`}>{t}</span>;
}

const RESULTADO: Record<string, [string, string]> = {
  ok: ['Conforme', 'ok'], divergente: ['Divergente', 'aviso'], bloqueado: ['Bloqueado', ''], erro: ['Erro', 'erro'],
};
const STATUS_REGISTRO: Record<string, [string, string]> = {
  gerado: ['Pendente', 'info'], reaproveitado: ['Reaproveitado', 'destaque'], enviando: ['Enviando', 'destaque'], enviado: ['Enviado', 'info'],
  conferido: ['Conferido', 'info'], bloqueado: ['Bloqueado', ''], erro: ['Erro', 'erro'],
};
export function SeloRegistro({ status, resultado }: { status: string; resultado: string | null }) {
  const [t, c] = resultado ? RESULTADO[resultado] ?? [resultado, ''] : STATUS_REGISTRO[status] ?? [status, ''];
  return <span className={`selo ${c}`}>{t}</span>;
}

export function SeloStatusHttp({ status }: { status: number | null | undefined }) {
  if (!status) return <span className="selo erro">sem resposta</span>;
  const c = status < 300 ? 'ok' : status === 429 ? 'aviso' : status < 500 ? 'aviso' : 'erro';
  return <span className={`selo sem-ponto ${c} mono`}>{status}</span>;
}

export function Metodo({ m }: { m: string }) {
  return <span className={`metodo ${m}`}>{m}</span>;
}

// ---------------------------------------------------------------- JSON

function realcar(json: string): ReactNode[] {
  const partes: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let ultimo = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(json))) {
    if (m.index > ultimo) partes.push(json.slice(ultimo, m.index));
    if (m[1]) {
      partes.push(<span key={i++} className={m[2] ? 'k' : 's'}>{m[1]}</span>);
      if (m[2]) partes.push(m[2]);
    } else if (m[3]) partes.push(<span key={i++} className="b">{m[3]}</span>);
    else partes.push(<span key={i++} className="n">{m[4]}</span>);
    ultimo = re.lastIndex;
  }
  partes.push(json.slice(ultimo));
  return partes;
}

export function Json({ valor, alturaMax }: { valor: unknown; alturaMax?: number }) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2) ?? 'undefined';
  return <pre className="codigo" style={alturaMax ? { maxHeight: alturaMax } : undefined}>{texto.length > 400000 ? texto : realcar(texto)}</pre>;
}

// ---------------------------------------------------------------- formatos

export function quando(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relativo(iso?: string | null): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'agora há pouco';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return quando(iso).slice(0, 10);
}

export const numero = (n: number | null | undefined) => (n ?? 0).toLocaleString('pt-BR');

export const ROTULO_AMBIENTE: Record<string, string> = { sandbox: 'Sandbox', homologacao: 'Homologação', desenvolvimento: 'Desenvolvimento' };
export const ROTULO_AUTH: Record<string, string> = {
  nenhuma: 'Sem autenticação', chave_api: 'Chave de API', basic: 'Basic', bearer: 'Bearer fixo', oauth2_cc: 'OAuth 2.0 (client credentials)',
};

// ---------------------------------------------------------------- integrações (v3.0)

export const ROTULO_PAPEL_INTEGRACAO: Record<string, string> = { cliente: 'Cliente', emulador: 'Ente emulado' };

const STATUS_INTEGRACAO: Record<string, [string, string, string]> = {
  pronta: ['Pronta', 'ok', 'O último teste de conexão passou.'],
  sem_teste: ['Sem teste', 'info', 'Ainda não houve teste de conexão.'],
  falha: ['Com falha', 'erro', 'O último teste de conexão falhou.'],
  aguardando_rota: ['Aguardando rota', 'aviso', 'O sistema testado ainda não expõe as rotas para receber os eventos deste ente.'],
  inativa: ['Inativa', '', 'Não aceita envios.'],
};

export function SeloIntegracao({ status }: { status: string }) {
  const [t, c, d] = STATUS_INTEGRACAO[status] ?? [status, '', ''];
  return <span className={`selo ${c}`} title={d}>{t}</span>;
}

export function SeloPapel({ papel, ente }: { papel: string; ente?: string | null }) {
  if (papel !== 'emulador') return <span className="selo sem-ponto">Cliente</span>;
  return <span className="selo sem-ponto destaque" title="O app faz o papel deste ente e entrega os eventos dele nas rotas do sistema testado">Ente emulado{ente ? ` · ${ente}` : ''}</span>;
}

// Versão da biblioteca usada pela integração, com aviso quando há uma mais nova.
export function VersaoBiblioteca({ v }: { v: { arquivoId: string; nome: string; numero: number; ultima: number; desatualizada: boolean } | null }) {
  if (!v) return <span className="dica">—</span>;
  return (
    <span>
      <Link para={`/biblioteca/${v.arquivoId}`}>{v.nome}</Link> <span className="mono">v{v.numero}</span>
      {v.desatualizada && <span className="selo aviso sem-ponto" style={{ marginLeft: 6 }} title="Há uma versão mais nova na biblioteca">v{v.ultima} disponível</span>}
    </span>
  );
}

export function copiar(texto: string, avisar: (t: string) => void, rotulo = 'Copiado.'): void {
  navigator.clipboard?.writeText(texto).then(() => avisar(rotulo), () => avisar('Não foi possível copiar.'));
}
