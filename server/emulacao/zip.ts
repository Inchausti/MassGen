// ZIP mínimo, sem dependência: lê o lote de XMLs que o cliente entrega e monta o arquivo que o Comitê Gestor emulado serve.
// O MOC v1.10 nomeia os arquivos do Processamento Diário com .zip; dentro vai o JSON do Anexo I.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface EntradaZip { nome: string; dados: Buffer }

// Data e hora no formato do DOS, a partir de "AAAA-MM-DD HH:MM:SS". Data fixa deixa o arquivo igual a cada download.
function dataDos(quando: string): { hora: number; data: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(quando);
  if (!m) return { hora: 0, data: (1 << 5) | 1 };
  const [a, me, d, h, mi, s] = m.slice(1).map(Number);
  return { hora: (h << 11) | (mi << 5) | Math.floor(s / 2), data: ((Math.max(1980, a) - 1980) << 9) | (me << 5) | d };
}

export function criarZip(entradas: EntradaZip[], quando = '1980-01-01 00:00:00'): Buffer {
  const { hora, data } = dataDos(quando);
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const comprimido = deflateRawSync(e.dados);
    const crc = crc32(e.dados) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nome em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(e.dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nome, comprimido);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(e.dados.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);
    deslocamento += 30 + nome.length + comprimido.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, diretorio, fim]);
}

export const ehZip = (b: Buffer) => b.length >= 4 && b.readUInt32LE(0) === 0x04034b50;

// Lê pelo diretório central, que traz os tamanhos mesmo quando o arquivo usa descritor de dados.
export function lerZip(b: Buffer, limiteBytes = 200 * 1024 * 1024): EntradaZip[] {
  let fim = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error('O arquivo compactado está corrompido: falta o diretório do ZIP.');
  const total = b.readUInt16LE(fim + 10);
  let p = b.readUInt32LE(fim + 16);
  const saida: EntradaZip[] = [];
  let lidos = 0;
  for (let n = 0; n < total; n++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('O arquivo compactado está corrompido.');
    const metodo = b.readUInt16LE(p + 10);
    const tamanho = b.readUInt32LE(p + 20);
    const tamNome = b.readUInt16LE(p + 28);
    const tamExtra = b.readUInt16LE(p + 30);
    const tamComent = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const nome = b.subarray(p + 46, p + 46 + tamNome).toString('utf8');
    p += 46 + tamNome + tamExtra + tamComent;
    if (nome.endsWith('/')) continue;
    const inicio = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const bruto = b.subarray(inicio, inicio + tamanho);
    if (metodo !== 0 && metodo !== 8) throw new Error(`${nome}: compressão não suportada (método ${metodo}). Use ZIP comum.`);
    const dados = metodo === 8 ? inflateRawSync(bruto) : Buffer.from(bruto);
    lidos += dados.length;
    if (lidos > limiteBytes) throw new Error('O arquivo compactado passa de 200 MB descompactado.');
    saida.push({ nome, dados });
  }
  return saida;
}
