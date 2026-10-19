import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './estilos.css';
import { ProvedorRota, Link, useRota, casar } from './rotas.tsx';
import { ProvedorAvisos, Modal } from './ui.tsx';
import { definirUsuarioLocal, get, usuarioLocal } from './api.ts';
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
};

const NAV: { para: string; rotulo: string; icone: ReactNode; grupo: string }[] = [
  { para: '/', rotulo: 'Painel', icone: ICONES.painel, grupo: '' },
  { para: '/destinos', rotulo: 'Destinos', icone: ICONES.destinos, grupo: 'Configurar' },
  { para: '/pacotes', rotulo: 'Pacotes', icone: ICONES.pacotes, grupo: 'Configurar' },
  { para: '/modelos', rotulo: 'Modelos', icone: ICONES.modelos, grupo: 'Configurar' },
  { para: '/cadastros', rotulo: 'Cadastros', icone: ICONES.cadastros, grupo: 'Configurar' },
  { para: '/cenarios', rotulo: 'Cenários', icone: ICONES.cenarios, grupo: 'Executar' },
  { para: '/execucoes', rotulo: 'Execuções', icone: ICONES.execucoes, grupo: 'Executar' },
  { para: '/auditoria', rotulo: 'Auditoria', icone: ICONES.auditoria, grupo: 'Controlar' },
];

const PAGINAS: { padrao: string; render: (p: Record<string, string>) => ReactNode }[] = [
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
];

type Tema = 'sistema' | 'claro' | 'escuro';

function lerTema(): Tema {
  try { return (localStorage.getItem('massgen.tema') as Tema) || 'sistema'; } catch { return 'sistema'; }
}

interface Identidade { usuario: string; origem: 'cloudflare-access' | 'interface' | 'sistema' }

// Atrás do Cloudflare Access, quem entra na trilha é o e-mail autenticado: o nome digitado não vale e não é pedido.
function Operador() {
  const [identidade, setIdentidade] = useState<Identidade | null>(null);
  const [nome, setNome] = useState(usuarioLocal());
  const [editando, setEditando] = useState(false);
  const [rascunho, setRascunho] = useState(nome);
  useEffect(() => {
    get<{ usuario: Identidade }>('/config')
      .then((c) => {
        setIdentidade(c.usuario);
        if (c.usuario.origem !== 'cloudflare-access' && !usuarioLocal()) setEditando(true);
      })
      .catch(() => { if (!usuarioLocal()) setEditando(true); });
  }, []);
  const salvar = () => {
    definirUsuarioLocal(rascunho);
    setNome(rascunho.trim());
    setEditando(false);
  };
  if (identidade?.origem === 'cloudflare-access') {
    return (
      <div className="operador" title="Identificado pelo Cloudflare Access: este e-mail entra na trilha de auditoria">
        👤 <span>{identidade.usuario}</span>
      </div>
    );
  }
  return (
    <>
      <button className="botao fantasma pequeno" style={{ justifyContent: 'flex-start' }} onClick={() => { setRascunho(nome); setEditando(true); }} title="Quem aparece na trilha de auditoria">
        👤 {nome || 'Informar operador'}
      </button>
      {editando && (
        <Modal
          titulo="Quem está usando o MassGen?"
          aoFechar={() => setEditando(false)}
          rodape={<><button className="botao" onClick={() => setEditando(false)}>Depois</button><button className="botao primario" disabled={!rascunho.trim()} onClick={salvar}>Salvar</button></>}
        >
          <p>O nome entra na trilha de auditoria de cada ação e de cada envio, junto com o usuário do sistema e a máquina.</p>
          <div className="campo">
            <label htmlFor="operador">Seu nome</label>
            <input id="operador" type="text" autoFocus value={rascunho} onChange={(e) => setRascunho(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rascunho.trim() && salvar()} />
          </div>
        </Modal>
      )}
    </>
  );
}

function Lateral() {
  const { caminho } = useRota();
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
      {NAV.map((n) => {
        const titulo = n.grupo && n.grupo !== grupo ? <div className="nav-titulo">{(grupo = n.grupo)}</div> : null;
        return (
          <div key={n.para} style={{ display: 'contents' }}>
            {titulo}
            <Link para={n.para} className={`nav-item ${ativo(n.para) ? 'ativo' : ''}`}>{n.icone}{n.rotulo}</Link>
          </div>
        );
      })}
      <div className="lateral-rodape">
        <Operador />
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
  for (const p of PAGINAS) {
    const params = casar(p.padrao, caminho);
    if (params) return <>{p.render(params)}</>;
  }
  return <div className="pagina"><h1>Página não encontrada</h1><p><Link para="/">Voltar ao painel</Link></p></div>;
}

function App() {
  return (
    <ProvedorRota>
      <ProvedorAvisos>
        <div className="app">
          <Lateral />
          <main className="conteudo"><Conteudo /></main>
        </div>
      </ProvedorAvisos>
    </ProvedorRota>
  );
}

createRoot(document.getElementById('raiz')!).render(<StrictMode><App /></StrictMode>);
