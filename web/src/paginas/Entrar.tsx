import { useState, type FormEvent, type ReactNode } from 'react';
import { get, post } from '../api.ts';
import { CaixaErro, Campo, Carregando, quando, useAcao, useCarregar } from '../ui.tsx';

function Moldura({ titulo, sub, children }: { titulo: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="porta">
      <div className="porta-cartao">
        <div className="marca" style={{ padding: 0 }}>
          <div className="marca-logo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--sobre-destaque)" strokeWidth="2.6" strokeLinejoin="round" aria-hidden="true"><path d="M5 18V6l7 6 7-6v12" /></svg></div>
          <div><div className="marca-nome">MassGen</div><div className="marca-sub">Gerador de massa de dados</div></div>
        </div>
        <div>
          <h1>{titulo}</h1>
          {sub && <p className="sub" style={{ marginTop: 6, color: 'var(--tinta-2)' }}>{sub}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Entrar({ aoEntrar, aviso }: { aoEntrar: () => void; aviso?: string | null }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const acao = useAcao();
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if ((await acao.executar(() => post('/sessao', { email, senha }))) !== undefined) aoEntrar();
  };
  return (
    <Moldura titulo="Entrar" sub="Use o e-mail e a senha que você definiu no convite.">
      {aviso && <div className="alerta aviso"><div>{aviso}</div></div>}
      <CaixaErro erro={acao.erro} />
      <form className="pilha" onSubmit={enviar}>
        <Campo rotulo="E-mail"><input type="text" inputMode="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Campo>
        <Campo rotulo="Senha"><input type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} /></Campo>
        <button className="botao primario" type="submit" disabled={acao.ocupado || !email || !senha} style={{ justifyContent: 'center' }}>{acao.ocupado ? 'Entrando…' : 'Entrar'}</button>
      </form>
      <p className="dica">Ainda não tem acesso, ou esqueceu a senha? Peça a um root um link de convite ou de redefinição.</p>
    </Moldura>
  );
}

const TITULOS: Record<string, string> = { primeiro_acesso: 'Primeiro acesso', convite: 'Aceitar o convite', redefinicao: 'Definir uma senha nova' };

export function AceitarConvite({ token, aoEntrar }: { token: string; aoEntrar: () => void }) {
  const c = useCarregar(() => get(`/convites/${encodeURIComponent(token)}`), [token]);
  const [nome, setNome] = useState<string | null>(null);
  const [senha, setSenha] = useState('');
  const [confirma, setConfirma] = useState('');
  const acao = useAcao();
  if (c.carregando && !c.dados) return <Moldura titulo="Convite"><Carregando /></Moldura>;
  if (!c.dados) {
    return (
      <Moldura titulo="Link indisponível">
        <CaixaErro erro={c.erro} />
        <a className="botao" href="/" style={{ justifyContent: 'center' }}>Ir para a tela de entrada</a>
      </Moldura>
    );
  }
  const d = c.dados;
  const nomeAtual = nome ?? d.nome ?? '';
  const diferentes = confirma.length > 0 && confirma !== senha;
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (diferentes) return;
    if ((await acao.executar(() => post(`/convites/${encodeURIComponent(token)}`, { nome: nomeAtual, senha }))) !== undefined) aoEntrar();
  };
  return (
    <Moldura titulo={TITULOS[d.tipo] ?? 'Convite'} sub={<>Para <strong>{d.email}</strong>. O link vale até {quando(d.expiraEm)} e só funciona uma vez.</>}>
      <CaixaErro erro={acao.erro} />
      <form className="pilha" onSubmit={enviar}>
        {d.tipo !== 'redefinicao' && <Campo rotulo="Seu nome"><input type="text" autoComplete="name" value={nomeAtual} onChange={(e) => setNome(e.target.value)} /></Campo>}
        <Campo rotulo="Senha" ajuda="Pelo menos 10 caracteres."><input type="password" autoComplete="new-password" autoFocus value={senha} onChange={(e) => setSenha(e.target.value)} /></Campo>
        <Campo rotulo="Repita a senha" erro={diferentes ? 'As senhas não são iguais.' : undefined}><input type="password" autoComplete="new-password" value={confirma} onChange={(e) => setConfirma(e.target.value)} /></Campo>
        <button className="botao primario" type="submit" disabled={acao.ocupado || senha.length < 10 || diferentes || !confirma} style={{ justifyContent: 'center' }}>
          {d.tipo === 'redefinicao' ? 'Salvar a senha e entrar' : 'Criar acesso e entrar'}
        </button>
      </form>
    </Moldura>
  );
}

export function SemAcesso({ mensagem }: { mensagem: string }) {
  return (
    <Moldura titulo="Sem acesso ao MassGen" sub="Você entrou pelo Cloudflare, mas o seu e-mail ainda não tem acesso ao app.">
      <div className="alerta aviso"><div>{mensagem}</div></div>
    </Moldura>
  );
}
