import { useState } from 'react';
import { get, patch, post } from '../api.ts';
import { Cabecalho, CaixaErro, Campo, Carregando, Modal, Painel, Vazio, copiar, quando, relativo, useAcao, useAvisos, useCarregar } from '../ui.tsx';
import { DESCRICAO_PAPEL, ROTULO_PAPEL, useSessao, type Papel } from '../sessao.tsx';

const SITUACAO: Record<string, [string, string]> = { ativo: ['Ativo', 'ok'], convidado: ['Convidado', 'info'], desativado: ['Desativado', ''] };
const TIPO_LINK: Record<string, string> = { convite: 'convite', redefinicao: 'redefinição de senha', primeiro_acesso: 'primeiro acesso' };

interface LinkGerado { email: string; nome: string | null; link: string; expiraEm: string; tipo: string }

export function Usuarios() {
  const { usuario: eu } = useSessao();
  const lista = useCarregar(() => get('/usuarios'));
  const [form, setForm] = useState({ email: '', nome: '', papel: 'operador' as Papel });
  const [link, setLink] = useState<LinkGerado | null>(null);
  const acao = useAcao();

  const preCadastrar = async () => {
    const r = await acao.executar(() => post('/usuarios', form), 'Usuário pré-cadastrado.');
    if (r) {
      setLink({ email: r.usuario.email, nome: r.usuario.nome, link: r.link, expiraEm: r.expiraEm, tipo: 'convite' });
      setForm({ email: '', nome: '', papel: 'operador' });
      lista.recarregar(true);
    }
  };
  const gerarLink = async (u: any) => {
    const r = await acao.executar(() => post(`/usuarios/${u.id}/link`));
    if (r) { setLink({ email: u.email, nome: u.nome, link: r.link, expiraEm: r.expiraEm, tipo: r.tipo }); lista.recarregar(true); }
  };
  const alterar = async (u: any, dados: Record<string, string>, msg: string) => {
    if ((await acao.executar(() => patch(`/usuarios/${u.id}`, dados), msg)) !== undefined) lista.recarregar(true);
  };

  return (
    <div className="pagina">
      <Cabecalho
        titulo="Usuários"
        sub="Quem acessa o MassGen. Os demais entram por pré-cadastro e convite: o link aparece uma vez, para você copiar e mandar à pessoa. Toda mudança fica na trilha de auditoria."
      />
      <CaixaErro erro={lista.erro ?? acao.erro} />
      <Painel titulo="Pré-cadastrar e convidar">
        <div className="grade grade-4">
          <Campo rotulo="E-mail"><input type="text" inputMode="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="nome@empresa.com.br" /></Campo>
          <Campo rotulo="Nome (opcional)"><input type="text" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} /></Campo>
          <Campo rotulo="Papel" ajuda={DESCRICAO_PAPEL[form.papel]}>
            <select value={form.papel} onChange={(e) => setForm({ ...form, papel: e.target.value as Papel })}>
              {(['operador', 'leitor', 'root'] as Papel[]).map((p) => <option key={p} value={p}>{ROTULO_PAPEL[p]}</option>)}
            </select>
          </Campo>
          <div className="campo" style={{ justifyContent: 'flex-start', paddingTop: 22 }}>
            <button className="botao primario" disabled={acao.ocupado || !form.email.includes('@')} onClick={preCadastrar}>Pré-cadastrar e gerar convite</button>
          </div>
        </div>
      </Painel>
      <Painel semPad titulo="Cadastrados">
        {lista.carregando && !lista.dados ? <Carregando /> : !lista.dados?.length ? <Vazio titulo="Nenhum usuário" /> : (
          <div className="tabela-wrap"><table className="tabela">
            <thead><tr><th>Usuário</th><th>Papel</th><th>Situação</th><th>Último acesso</th><th>Criado por</th><th></th></tr></thead>
            <tbody>{lista.dados.map((u: any) => {
              const [t, c] = SITUACAO[u.status] ?? [u.status, ''];
              const souEu = u.id === eu.id;
              return (
                <tr key={u.id}>
                  <td>{u.nome ?? <span className="dica">sem nome</span>}{souEu && <span className="selo destaque sem-ponto" style={{ marginLeft: 6 }}>você</span>}<div className="dica">{u.email}</div></td>
                  <td>
                    <select aria-label={`Papel de ${u.email}`} value={u.papel} disabled={u.status === 'desativado'} onChange={(e) => alterar(u, { papel: e.target.value }, 'Papel alterado. As sessões dessa pessoa foram encerradas.')} style={{ minWidth: 112, maxWidth: 140 }}>
                      {(['root', 'operador', 'leitor'] as Papel[]).map((p) => <option key={p} value={p}>{ROTULO_PAPEL[p]}</option>)}
                    </select>
                  </td>
                  <td><span className={`selo ${c}`}>{t}</span>{u.convitePendente && <div className="dica">link de {TIPO_LINK[u.convitePendente.tipo]} até {quando(u.convitePendente.expiraEm)}</div>}</td>
                  <td className="nowrap">{relativo(u.ultimoAcesso)}</td>
                  <td className="dica">{u.criadoPor}<div>{quando(u.criadoEm).slice(0, 10)}</div></td>
                  <td className="nowrap">
                    {u.status !== 'desativado' && <button className="botao pequeno" onClick={() => gerarLink(u)}>{u.status === 'convidado' ? 'Gerar convite' : 'Link de nova senha'}</button>}{' '}
                    {u.status === 'desativado'
                      ? <button className="botao pequeno" onClick={() => alterar(u, { status: 'ativo' }, 'Acesso reativado.')}>Reativar</button>
                      : !souEu && <button className="botao pequeno perigo" onClick={() => confirm(`Desativar o acesso de ${u.email}? As sessões abertas são encerradas na hora.`) && alterar(u, { status: 'desativado' }, 'Acesso desativado.')}>Desativar</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Painel>
      {link && <LinkModal link={link} aoFechar={() => setLink(null)} />}
    </div>
  );
}

function LinkModal({ link, aoFechar }: { link: LinkGerado; aoFechar: () => void }) {
  const avisar = useAvisos();
  const tipo = TIPO_LINK[link.tipo] ?? 'acesso';
  const corpo = `Olá${link.nome ? ` ${link.nome}` : ''},\n\n${link.tipo === 'redefinicao' ? 'Use o link abaixo para definir uma senha nova no MassGen' : 'Você foi convidado para o MassGen, o gerador de massa de dados. Use o link abaixo para criar o seu acesso'}:\n\n${link.link}\n\nO link vale até ${quando(link.expiraEm)} e só funciona uma vez.`;
  const mailto = `mailto:${encodeURIComponent(link.email)}?subject=${encodeURIComponent(link.tipo === 'redefinicao' ? 'MassGen: nova senha' : 'Convite para o MassGen')}&body=${encodeURIComponent(corpo)}`;
  return (
    <Modal titulo={`Link de ${tipo}`} aoFechar={aoFechar} rodape={<><a className="botao" href={mailto}>Abrir no e-mail</a><button className="botao primario" onClick={() => copiar(link.link, avisar, 'Link copiado.')}>Copiar link</button></>}>
      <p>Mande este link para <strong>{link.email}</strong>. Ele aparece só agora: o MassGen guarda apenas o hash. Vale até <strong>{quando(link.expiraEm)}</strong> e funciona uma vez.</p>
      <pre className="codigo" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{link.link}</pre>
      <p className="dica">Gerar outro link invalida este.</p>
    </Modal>
  );
}
