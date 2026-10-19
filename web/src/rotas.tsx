// Roteador mínimo sobre a History API.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type MouseEvent } from 'react';

interface Rota { caminho: string; busca: URLSearchParams; navegar: (para: string, substituir?: boolean) => void }

const Contexto = createContext<Rota>({ caminho: '/', busca: new URLSearchParams(), navegar: () => {} });

export function ProvedorRota({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState({ caminho: location.pathname, busca: location.search });
  useEffect(() => {
    const aoVoltar = () => setLocal({ caminho: location.pathname, busca: location.search });
    addEventListener('popstate', aoVoltar);
    return () => removeEventListener('popstate', aoVoltar);
  }, []);
  const navegar = useCallback((para: string, substituir = false) => {
    if (substituir) history.replaceState(null, '', para);
    else history.pushState(null, '', para);
    setLocal({ caminho: location.pathname, busca: location.search });
    if (!substituir) window.scrollTo(0, 0);
  }, []);
  return <Contexto.Provider value={{ caminho: local.caminho, busca: new URLSearchParams(local.busca), navegar }}>{children}</Contexto.Provider>;
}

export const useRota = () => useContext(Contexto);

export function Link({ para, children, className, title }: { para: string; children: ReactNode; className?: string; title?: string }) {
  const { navegar } = useRota();
  const clicar = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navegar(para);
  };
  return <a href={para} onClick={clicar} className={className} title={title}>{children}</a>;
}

export function casar(padrao: string, caminho: string): Record<string, string> | null {
  const a = padrao.split('/').filter(Boolean);
  const b = caminho.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
