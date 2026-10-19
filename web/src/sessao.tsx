// Sessão do usuário logado, disponível para toda a interface.
import { createContext, useContext } from 'react';

export type Papel = 'root' | 'operador' | 'leitor';

export interface UsuarioSessao {
  id: string;
  email: string;
  nome: string | null;
  papel: Papel;
  status: string;
  origem: 'sessao' | 'cloudflare-access';
}

export interface Sessao {
  usuario: UsuarioSessao;
  sair: () => Promise<void>;
  recarregar: () => Promise<void>;
}

export const ContextoSessao = createContext<Sessao | null>(null);

export function useSessao(): Sessao {
  const s = useContext(ContextoSessao);
  if (!s) throw new Error('useSessao fora do app logado.');
  return s;
}

export const ROTULO_PAPEL: Record<Papel, string> = { root: 'Root', operador: 'Operador', leitor: 'Leitor' };
export const DESCRICAO_PAPEL: Record<Papel, string> = {
  root: 'Faz tudo, inclusive gerenciar usuários.',
  operador: 'Configura destinos, modelos e cenários, e envia massa.',
  leitor: 'Só consulta: não altera nada nem envia.',
};
