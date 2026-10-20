import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.ts';

mkdirSync(config.dirDados, { recursive: true });

export const db = new DatabaseSync(path.join(config.dirDados, 'massgen.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Cada item é uma migração. A posição define a versão (PRAGMA user_version).
const MIGRACOES: string[] = [
  `
  CREATE TABLE pacotes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    versao TEXT NOT NULL,
    descricao TEXT,
    conteudo TEXT NOT NULL,
    embutido INTEGER NOT NULL DEFAULT 0,
    instalado_em TEXT NOT NULL
  );
  CREATE TABLE modelos (
    id TEXT PRIMARY KEY,
    pacote_id TEXT NOT NULL REFERENCES pacotes(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    definicao TEXT NOT NULL,
    alterado_localmente INTEGER NOT NULL DEFAULT 0,
    atualizado_em TEXT NOT NULL,
    UNIQUE (pacote_id, nome)
  );
  CREATE TABLE destinos (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    tipo_ambiente TEXT NOT NULL CHECK (tipo_ambiente IN ('sandbox', 'homologacao', 'desenvolvimento')),
    base_url TEXT NOT NULL,
    pacote_id TEXT REFERENCES pacotes(id) ON DELETE SET NULL,
    autenticacao TEXT NOT NULL DEFAULT '{"tipo":"nenhuma"}',
    limites TEXT NOT NULL DEFAULT '{}',
    idempotencia TEXT NOT NULL DEFAULT '{}',
    cabecalhos TEXT NOT NULL DEFAULT '{}',
    variaveis TEXT NOT NULL DEFAULT '{}',
    teste TEXT NOT NULL DEFAULT '{}',
    ativo INTEGER NOT NULL DEFAULT 1,
    ultimo_teste TEXT,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
  );
  CREATE TABLE destino_segredos (
    destino_id TEXT NOT NULL REFERENCES destinos(id) ON DELETE CASCADE,
    chave TEXT NOT NULL,
    iv BLOB NOT NULL,
    dado BLOB NOT NULL,
    tag BLOB NOT NULL,
    atualizado_em TEXT NOT NULL,
    PRIMARY KEY (destino_id, chave)
  );
  CREATE TABLE operacoes (
    id TEXT PRIMARY KEY,
    destino_id TEXT NOT NULL REFERENCES destinos(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    pasta TEXT,
    entidade TEXT,
    acao TEXT,
    metodo TEXT NOT NULL,
    rota TEXT NOT NULL,
    cabecalhos TEXT NOT NULL DEFAULT '{}',
    corpo TEXT,
    usar_corpo INTEGER NOT NULL DEFAULT 0,
    origem TEXT NOT NULL CHECK (origem IN ('importada', 'manual', 'pacote')),
    ordem INTEGER NOT NULL DEFAULT 0,
    atualizado_em TEXT NOT NULL
  );
  CREATE INDEX operacoes_destino ON operacoes (destino_id, entidade, acao);
  CREATE TABLE importacoes (
    id TEXT PRIMARY KEY,
    destino_id TEXT NOT NULL REFERENCES destinos(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL,
    resumo TEXT NOT NULL,
    criado_em TEXT NOT NULL
  );
  CREATE TABLE cadastros (
    id TEXT PRIMARY KEY,
    pacote_id TEXT REFERENCES pacotes(id) ON DELETE SET NULL,
    entidade TEXT NOT NULL,
    rotulo TEXT NOT NULL,
    dados TEXT NOT NULL,
    etiquetas TEXT NOT NULL DEFAULT '[]',
    versao INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
  );
  CREATE INDEX cadastros_entidade ON cadastros (entidade);
  CREATE TABLE cadastro_vinculos (
    cadastro_id TEXT NOT NULL REFERENCES cadastros(id) ON DELETE CASCADE,
    destino_id TEXT NOT NULL REFERENCES destinos(id) ON DELETE CASCADE,
    id_remoto TEXT NOT NULL,
    execucao_id TEXT,
    atualizado_em TEXT NOT NULL,
    PRIMARY KEY (cadastro_id, destino_id)
  );
  CREATE TABLE cenarios (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    pacote_id TEXT REFERENCES pacotes(id) ON DELETE SET NULL,
    destino_id TEXT REFERENCES destinos(id) ON DELETE SET NULL,
    definicao TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
  );
  CREATE TABLE execucoes (
    id TEXT PRIMARY KEY,
    codigo TEXT NOT NULL UNIQUE,
    cenario_id TEXT REFERENCES cenarios(id) ON DELETE SET NULL,
    cenario_nome TEXT NOT NULL,
    cenario TEXT NOT NULL,
    destino_id TEXT REFERENCES destinos(id) ON DELETE SET NULL,
    semente INTEGER NOT NULL,
    data_referencia TEXT NOT NULL,
    status TEXT NOT NULL,
    etapa TEXT,
    erro TEXT,
    criado_em TEXT NOT NULL,
    iniciado_em TEXT,
    finalizado_em TEXT
  );
  CREATE TABLE registros (
    id TEXT PRIMARY KEY,
    execucao_id TEXT NOT NULL REFERENCES execucoes(id) ON DELETE CASCADE,
    entidade TEXT NOT NULL,
    indice INTEGER NOT NULL,
    ordem INTEGER NOT NULL,
    rotulo TEXT,
    perfil TEXT,
    caso TEXT,
    cadastro_id TEXT,
    pais TEXT NOT NULL DEFAULT '{}',
    dados TEXT NOT NULL,
    esperado TEXT NOT NULL,
    conferencia TEXT,
    avisos TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    id_remoto TEXT,
    obtido TEXT,
    resultado TEXT,
    diferencas TEXT NOT NULL DEFAULT '[]',
    atualizado_em TEXT NOT NULL
  );
  CREATE INDEX registros_execucao ON registros (execucao_id, ordem, indice);
  CREATE TABLE requisicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    execucao_id TEXT REFERENCES execucoes(id) ON DELETE CASCADE,
    destino_id TEXT,
    registro_id TEXT,
    operacao_id TEXT,
    fase TEXT NOT NULL,
    entidade TEXT,
    metodo TEXT NOT NULL,
    url TEXT NOT NULL,
    status INTEGER,
    duracao_ms INTEGER,
    tentativa INTEGER NOT NULL DEFAULT 1,
    chave_idempotencia TEXT,
    req_cabecalhos TEXT,
    req_corpo TEXT,
    res_cabecalhos TEXT,
    res_corpo TEXT,
    erro TEXT,
    codigo_erro TEXT,
    resultado TEXT,
    criado_em TEXT NOT NULL
  );
  CREATE INDEX requisicoes_execucao ON requisicoes (execucao_id, id);
  CREATE INDEX requisicoes_registro ON requisicoes (registro_id);
  `,
  // 2 — rastreabilidade e auditoria
  `
  ALTER TABLE requisicoes ADD COLUMN usuario TEXT;
  ALTER TABLE requisicoes ADD COLUMN rastreio TEXT;
  ALTER TABLE requisicoes ADD COLUMN corpo_hash TEXT;
  ALTER TABLE requisicoes ADD COLUMN hash_anterior TEXT;
  ALTER TABLE requisicoes ADD COLUMN hash TEXT;
  CREATE INDEX requisicoes_rastreio ON requisicoes (rastreio);
  ALTER TABLE execucoes ADD COLUMN criado_por TEXT;
  ALTER TABLE execucoes ADD COLUMN enviado_por TEXT;
  ALTER TABLE execucoes ADD COLUMN pacote_id TEXT;
  ALTER TABLE execucoes ADD COLUMN pacote_versao TEXT;
  ALTER TABLE execucoes ADD COLUMN modelos_hash TEXT;
  ALTER TABLE execucoes ADD COLUMN destino_snapshot TEXT;
  ALTER TABLE destinos ADD COLUMN rastreio TEXT NOT NULL DEFAULT '{"cabecalho":"X-MassGen-Rastreio"}';
  CREATE TABLE auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    em TEXT NOT NULL,
    usuario TEXT NOT NULL,
    maquina TEXT NOT NULL,
    acao TEXT NOT NULL,
    alvo_tipo TEXT,
    alvo_id TEXT,
    execucao_id TEXT,
    resumo TEXT NOT NULL,
    detalhes TEXT NOT NULL DEFAULT '{}',
    hash_anterior TEXT,
    hash TEXT NOT NULL
  );
  CREATE INDEX auditoria_alvo ON auditoria (alvo_tipo, alvo_id);
  CREATE INDEX auditoria_execucao ON auditoria (execucao_id);
  `,
  // 3 — usuários, sessões e convites
  `
  CREATE TABLE usuarios (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nome TEXT,
    papel TEXT NOT NULL CHECK (papel IN ('root', 'operador', 'leitor')),
    status TEXT NOT NULL CHECK (status IN ('convidado', 'ativo', 'desativado')),
    senha_hash TEXT,
    criado_por TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    ultimo_acesso TEXT
  );
  CREATE TABLE sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    criada_em TEXT NOT NULL,
    expira_em TEXT NOT NULL,
    ultimo_uso TEXT,
    ip TEXT
  );
  CREATE INDEX sessoes_usuario ON sessoes (usuario_id);
  CREATE TABLE convites (
    token_hash TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('primeiro_acesso', 'convite', 'redefinicao')),
    criado_por TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    expira_em TEXT NOT NULL,
    usado_em TEXT
  );
  CREATE INDEX convites_usuario ON convites (usuario_id);
  `,
  // 4 — ambientes, biblioteca de APIs e papel da integração (v3.0, etapa 1)
  `
  CREATE TABLE ambientes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL UNIQUE,
    sistema TEXT,
    tipo TEXT NOT NULL CHECK (tipo IN ('sandbox', 'homologacao', 'desenvolvimento')),
    pacote_id TEXT REFERENCES pacotes(id) ON DELETE SET NULL,
    descricao TEXT,
    criado_por TEXT,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL
  );
  CREATE TABLE api_arquivos (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL CHECK (tipo IN ('collection', 'environment')),
    nome TEXT NOT NULL,
    descricao TEXT,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT NOT NULL,
    UNIQUE (tipo, nome)
  );
  CREATE TABLE api_versoes (
    id TEXT PRIMARY KEY,
    arquivo_id TEXT NOT NULL REFERENCES api_arquivos(id) ON DELETE CASCADE,
    numero INTEGER NOT NULL,
    nome_arquivo TEXT,
    conteudo TEXT NOT NULL,
    hash TEXT NOT NULL,
    resumo TEXT NOT NULL DEFAULT '{}',
    importado_por TEXT,
    importado_em TEXT NOT NULL,
    UNIQUE (arquivo_id, numero)
  );
  CREATE TABLE api_segredos (
    versao_id TEXT NOT NULL REFERENCES api_versoes(id) ON DELETE CASCADE,
    chave TEXT NOT NULL,
    iv BLOB NOT NULL,
    dado BLOB NOT NULL,
    tag BLOB NOT NULL,
    PRIMARY KEY (versao_id, chave)
  );
  ALTER TABLE destinos ADD COLUMN ambiente_id TEXT REFERENCES ambientes(id) ON DELETE SET NULL;
  ALTER TABLE destinos ADD COLUMN papel TEXT NOT NULL DEFAULT 'cliente';
  ALTER TABLE destinos ADD COLUMN ente TEXT;
  ALTER TABLE destinos ADD COLUMN colecao_versao_id TEXT REFERENCES api_versoes(id) ON DELETE SET NULL;
  ALTER TABLE destinos ADD COLUMN environment_versao_id TEXT REFERENCES api_versoes(id) ON DELETE SET NULL;
  CREATE INDEX destinos_ambiente ON destinos (ambiente_id);
  `,
];

function migrar(): void {
  const versao = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = versao; v < MIGRACOES.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRACOES[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
migrar();

type Param = SQLInputValue;

export function todos<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function um<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function executar(sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}

export function transacao<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const agora = (): string => new Date().toISOString();

export function novoId(prefixo: string): string {
  return `${prefixo}_${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
}

export function json<T>(texto: unknown, padrao: T): T {
  if (typeof texto !== 'string' || texto === '') return padrao;
  try {
    return JSON.parse(texto) as T;
  } catch {
    return padrao;
  }
}
