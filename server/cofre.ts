// Cofre de segredos: AES-256-GCM com a chave mestra do app.
// A chave vem de MASSGEN_MASTER_KEY ou de data/master.key, criada no primeiro uso.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { agora, executar, todos, um } from './db.ts';

function carregarChave(): Buffer {
  if (config.chaveMestra) {
    const k = Buffer.from(config.chaveMestra, 'base64');
    if (k.length !== 32) throw new Error('MASSGEN_MASTER_KEY precisa ter 32 bytes em base64 (openssl rand -base64 32).');
    return k;
  }
  const arquivo = path.join(config.dirDados, 'master.key');
  if (!existsSync(arquivo)) writeFileSync(arquivo, randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(readFileSync(arquivo, 'utf8').trim(), 'base64');
}

const chave = carregarChave();

export function cifrar(texto: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const dado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return { iv, dado, tag: c.getAuthTag() };
}

export function decifrar(iv: Uint8Array, dado: Uint8Array, tag: Uint8Array): string {
  const d = createDecipheriv('aes-256-gcm', chave, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(dado), d.final()]).toString('utf8');
}

export function salvarSegredo(destinoId: string, nome: string, valor: string): void {
  const { iv, dado, tag } = cifrar(valor);
  executar(
    `INSERT INTO destino_segredos (destino_id, chave, iv, dado, tag, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (destino_id, chave) DO UPDATE SET iv = excluded.iv, dado = excluded.dado, tag = excluded.tag, atualizado_em = excluded.atualizado_em`,
    destinoId, nome, iv, dado, tag, agora(),
  );
}

export function removerSegredo(destinoId: string, nome: string): void {
  executar('DELETE FROM destino_segredos WHERE destino_id = ? AND chave = ?', destinoId, nome);
}

export function lerSegredo(destinoId: string, nome: string): string | undefined {
  const r = um<{ iv: Uint8Array; dado: Uint8Array; tag: Uint8Array }>(
    'SELECT iv, dado, tag FROM destino_segredos WHERE destino_id = ? AND chave = ?', destinoId, nome);
  return r ? decifrar(r.iv, r.dado, r.tag) : undefined;
}

// Segredos de uma versão de environment da biblioteca: o arquivo guardado fica sem o valor, que mora aqui.
export function salvarSegredoVersao(versaoId: string, nome: string, valor: string): void {
  const { iv, dado, tag } = cifrar(valor);
  executar('INSERT OR REPLACE INTO api_segredos (versao_id, chave, iv, dado, tag) VALUES (?, ?, ?, ?, ?)', versaoId, nome, iv, dado, tag);
}

export function segredosDaVersao(versaoId: string): Record<string, string> {
  const saida: Record<string, string> = {};
  for (const r of todos<{ chave: string; iv: Uint8Array; dado: Uint8Array; tag: Uint8Array }>('SELECT chave, iv, dado, tag FROM api_segredos WHERE versao_id = ?', versaoId)) {
    saida[r.chave] = decifrar(r.iv, r.dado, r.tag);
  }
  return saida;
}

// O que a tela pode ver de um segredo: só que existe. Identificadores (…_id) mostram os 4 últimos caracteres.
export function resumoSegredos(destinoId: string) {
  return todos<{ chave: string; atualizado_em: string }>(
    'SELECT chave, atualizado_em FROM destino_segredos WHERE destino_id = ? ORDER BY chave', destinoId,
  ).map((s) => {
    let final: string | undefined;
    if (/(^|_)id$/i.test(s.chave)) {
      const v = lerSegredo(destinoId, s.chave) ?? '';
      final = v.length > 4 ? `…${v.slice(-4)}` : undefined;
    }
    return { chave: s.chave, definido: true, final, atualizado_em: s.atualizado_em };
  });
}
