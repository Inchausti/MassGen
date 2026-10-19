import { StrictMode, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './estilos.css';
import { ProvedorRota, Link, useRota, casar } from './rotas.tsx';
import { CaixaErro, Campo, Carregando, Modal, ProvedorAvisos, useAcao } from './ui.tsx';
import { EVENTO_SESSAO, del, get, post } from './api.ts';
import { ContextoSessao, ROTULO_PAPEL, useSessao, type UsuarioSessao } from './sessao.tsx';
import { AceitarConvite, Entrar, SemAcesso } from './paginas/Entrar.tsx';
import { Painel } from './paginas/Painel.tsx';
import { Destinos, NovoDestino } from './paginas/Destinos.tsx';
import { DestinoDetalhe } from './paginas/Destino.tsx';
import { Modelos, ModeloEditor } from './paginas/Modelos.tsx';
import { Pacotes } from './paginas/Pacotes.tsx';
import { Cadastros } from './paginas/Cadastros.tsx';
import { Cenarios, CenarioEditor } from './paginas/Cenarios.tsx';
import { Execucoes } from './paginas/Execucoes.tsx';
import { ExecucaoDetalhe } from './paginas/Execucao.tsx';
import { Auditoria } from './paginas/Auditoria.tsx';
import { Usuarios } from './paginas/Usuarios.tsx';

const I = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICONES = {
  painel: I('M3 13h8V3H3zM13 21h8v-8h-8zM13 3v6h8V3zM3 21h8v-4H3z'),
  destinos: I('M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'),
  modelos: I('M4 6h16M4 12h10M4 18h7M17 15l3 3-3 3'),
  pacotes: I('M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8'),
  cadastros: I('M4 4h16v16H4zM8 9h8M8 13h8M8 17h5'),
  cenarios: I('M5 3v18M5 5h12l-2 4 2 4H5'),
  execucoes: I('M5 3l14 9-14 9V3z'),
  auditoria: I('M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4zM9 12l2 2 4-4'),
  usuarios: I('M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a7 7 0 0 1 14 0v1M16 3.5a4 4 0 0 1 0 7M22 21v-1a7 7 0 0 0-4-6.3'),
};

const NAV: { para: string; rotulo: string; icone: ReactNode; grupo: string; soRoot?: boolean }[] = [
  { para: '/', rotulo: 'Painel', icone: ICONES.painel, grupo: '' },
  { para: '/destinos', rotulo: 'Destinos', icone: ICONES.destinos, grupo: 'Configurar' },
  { para: '/pacotes', rotulo: 'Pacotes', icone: ICONES.pacotes, grupo: 'Configurar' },
  { para: '/modelos', rotulo: 'Modelos', icone: ICONES.modelos, grupo: 'Configurar' },
  { para: '/cadastros', rotulo: 'Cadastros', icone: ICONES.cadastros, grupo: 'Configurar' },
  { para: '/cenarios', rotulo: 'Cenários', icone: ICONES.cenarios, grupo: 'Executar' },
  { para: '/execucoes', rotulo: 'Execuções', icone: ICONES.execucoes, grupo: 'Executar' },
  { para: '/auditoria', rotulo: 'Auditoria', icone: ICONES.auditoria, grupo: 'Controlar' },
  { para: '/usuarios', rotulo: 'Usuários', icone: ICONES.usuarios, grupo: 'Controlar', soRoot: true },
];

const PAGINAS: { padrao: string; render: (p: Record<string, string>) => ReactNode; soRoot?: boolean }[] = [
  { padrao: '/', render: () => <Painel /> },
  { padrao: '/destinos', render: () => <Destinos /> },
  { padrao: '/destinos/novo', render: () => <NovoDestino /> },
  { padrao: '/destinos/:id', render: (p) => <DestinoDetalhe id={p.id} /> },
  { padrao: '/pacotes', render: () => <Pacotes /> },
  { padrao: '/modelos', render: () => <Modelos /> },
  { padrao: '/modelos/:id', render: (p) => <ModeloEditor id={p.id} /> },
  { padrao: '/cadastros', render: () => <Cadastros /> },
  { padrao: '/cenarios', render: () => <Cenarios /> },
  { padrao: '/cenarios/:id', render: (p) => <CenarioEditor id={p.id} /> },
  { padrao: '/execucoes', render: () => <Execucoes /> },
  { padrao: '/execucoes/:id', render: (p) => <ExecucaoDetalhe id={p.id} /> },
  { padrao: '/auditoria', render: () => <Auditoria /> },
  { padrao: '/usuarios', render: () => <Usuarios />, soRoot: true },
];

type Tema = 'sistema' | 'claro' | 'escuro';

function lerTema(): Tema {
  try { return (localStorage.getItem('massgen.tema') as Tema) || 'sistema'; } catch { return 'sistema'; }
}

function TrocarSenha({ aoFechar }: { aoFechar: () => void }) {
  const { usuario } = useSessao();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const acao = useAcao();
  const diferentes = confirma.length > 0 && confirma !== nova;
  const salvar = async (e?: FormEvent) => {
    e?.preventDefault();
    if (diferentes || nova.length < 10) return;
    if ((await acao.executar(() => post('/sessao/senha', { atual, nova }), 'Senha trocada. As outras sessões abertas foram encerradas.')) !== undefined) aoFechar();
  };
  return (
    <Modal
      titulo="Trocar a senha"
      aoFechar={aoFechar}
      rodape={<><button className="botao" onClick={aoFechar}>Cancelar</button><button className="botao primario" disabled={acao.ocupado || nova.length < 10 || diferentes || !confirma} onClick={() => salvar()}>Salvar</button></>}
    >
      <CaixaErro erro={acao.erro} />
      <form className="pilha" onSubmit={salvar}>
        <input type="text" autoComplete="username" value={usuario.email} readOnly hidden />
        <Campo rotulo="Senha atual"><input type="password" autoComplete="current-password" autoFocus value={atual} onChange={(e) => setAtual(e.target.value)} /></Campo>
        <Campo rotulo="Senha nova" ajuda="Pelo menos 10 caracteres."><input type="password" autoComplete="new-password" value={nova} onChange={(e) => setNova(e.target.value)} /></Campo>
        <Campo rotulo="Repita a senha nova" erro={diferentes ? 'As senhas não são iguais.' : undefined}><input type="password" autoComplete="new-password" value={confirma} onChange={(e) => setConfirma(e.target.value)} /></Campo>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// Quem está logado, com o papel. Pelo Cloudflare Access não há "Sair": a identidade vem do Access, não do cookie do app.
function UsuarioLogado() {
  const { usuario, sair } = useSessao();
  const [trocando, setTrocando] = useState(false);
  const viaAccess = usuario.origem === 'cloudflare-access';
  return (
    <div className="usuario-bloco">
      <div className="usuario-id" title={viaAccess ? 'Identificado pelo Cloudflare Access' : 'Este e-mail entra na trilha de auditoria'}>
        <span className="usuario-nome">{usuario.nome || usuario.email}</span>
        {usuario.nome && <span className="usuario-email">{usuario.email}</span>}
        <span className={`selo sem-ponto ${usuario.papel === 'root' ? 'destaque' : usuario.papel === 'leitor' ? 'info' : ''}`}>{ROTULO_PAPEL[usuario.papel]}{viaAccess ? ' · Access' : ''}</span>
      </div>
      {!viaAccess && (
        <div className="linha-flex" style={{ gap: 4 }}>
          <button className="botao fantasma pequeno" onClick={() => setTrocando(true)}>Trocar senha</button>
          <button className="botao fantasma pequeno" onClick={sair}>Sair</button>
        </div>
      )}
      {trocando && <TrocarSenha aoFechar={() => setTrocando(false)} />}
    </div>
  );
}

function Lateral() {
  const { caminho } = useRota();
  const { usuario } = useSessao();
  const [tema, setTema] = useState<Tema>(lerTema());
  useEffect(() => {
    if (tema === 'sistema') delete document.documentElement.dataset.tema;
    else document.documentElement.dataset.tema = tema;
    try { localStorage.setItem('massgen.tema', tema); } catch { /* sem armazenamento */ }
  }, [tema]);
  const ativo = (para: string) => (para === '/' ? caminho === '/' : caminho === para || caminho.startsWith(`${para}/`));
  let grupo = '';
  return (
    <nav className="lateral" aria-label="Navegação principal">
      <div className="marca">
        <div className="marca-logo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--sobre-destaque)" strokeWidth="2.6" strokeLinejoin="round" aria-hidden="true"><path d="M5 18V6l7 6 7-6v12" /></svg></div>
        <div><div className="marca-nome">MassGen</div><div className="marca-sub">Gerador de massa de dados</div></div>
      </div>
      {NAV.filter((n) => !n.soRoot || usuario.papel === 'root').map((n) => {
        const titulo = n.grupo && n.grupo !== grupo ? <div className="nav-titulo">{(grupo = n.grupo)}</div> : null;
        return (
          <div key={n.para} style={{ display: 'contents' }}>
            {titulo}
            <Link para={n.para} className={`nav-item ${ativo(n.para) ? 'ativo' : ''}`}>{n.icone}{n.rotulo}</Link>
          </div>
        );
      })}
      <div className="lateral-rodape">
        <UsuarioLogado />
        <select aria-label="Tema" value={tema} onChange={(e) => setTema(e.target.value as Tema)} style={{ fontSize: 12 }}>
          <option value="sistema">Tema do sistema</option>
          <option value="claro">Tema claro</option>
          <option value="escuro">Tema escuro</option>
        </select>
      </div>
    </nav>
  );
}

function Conteudo() {
  const { caminho } = useRota();
  const { usuario } = useSessao();
  const leitor = usuario.papel === 'leitor' && (
    <div className="pagina" style={{ marginBottom: 18 }}>
      <div className="alerta info"><div>Seu papel é <strong>leitor</strong>: você consulta tudo, mas não altera nada nem envia massa. Para mudar, fale com um root.</div></div>
    </div>
  );
  for (const p of PAGINAS) {
    const params = casar(p.padrao, caminho);
    if (!params) continue;
    if (p.soRoot && usuario.papel !== 'root') break;
    return <>{leitor}{p.render(params)}</>;
  }
  return <div className="pagina"><h1>Página não encontrada</h1><p><Link para="/">Voltar ao painel</Link></p></div>;
}

interface EstadoSessao { usuario: UsuarioSessao | null; bloqueio: string | null }

// Decide entre o aceite de convite, a tela de entrada e o app. Qualquer 401 da API volta para a entrada.
function Portao() {
  const { caminho, navegar } = useRota();
  const [estado, setEstado] = useState<EstadoSessao | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const carregar = useCallback(async () => {
    try {
      const s = await get<EstadoSessao>('/sessao');
      setEstado({ usuario: s.usuario, bloqueio: s.bloqueio ?? null });
    } catch {
      setEstado({ usuario: null, bloqueio: null });
    }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);
  useEffect(() => {
    const encerrada = () => {
      setAviso('Sua sessão terminou. Entre de novo para continuar.');
      setEstado({ usuario: null, bloqueio: null });
    };
    window.addEventListener(EVENTO_SESSAO, encerrada);
    return () => window.removeEventListener(EVENTO_SESSAO, encerrada);
  }, []);
  const sair = useCallback(async () => {
    try { await del('/sessao'); } catch { /* o cookie some de qualquer jeito */ }
    setAviso(null);
    setEstado({ usuario: null, bloqueio: null });
    navegar('/', true);
  }, [navegar]);
  const entrou = useCallback(() => { setAviso(null); carregar(); }, [carregar]);

  const convite = casar('/convite/:token', caminho);
  if (convite) return <AceitarConvite token={convite.token} aoEntrar={() => { navegar('/', true); entrou(); }} />;
  if (!estado) return <div className="porta"><Carregando /></div>;
  if (!estado.usuario) return estado.bloqueio ? <SemAcesso mensagem={estado.bloqueio} /> : <Entrar aoEntrar={entrou} aviso={aviso} />;
  return (
    <ContextoSessao.Provider value={{ usuario: estado.usuario, sair, recarregar: carregar }}>
      <div className="app">
        <Lateral />
        <main className="conteudo"><Conteudo /></main>
      </div>
    </ContextoSessao.Provider>
  );
}

function App() {
  return (
    <ProvedorRota>
      <ProvedorAvisos>
        <Portao />
      </ProvedorAvisos>
    </ProvedorRota>
  );
}

createRoot(document.getElementById('raiz')!).render(<StrictMode><App /></StrictMode>);
