// CT-e, NFC-e e NFS-e na POC (etapa seguinte da D-MG-10). Primeiro o leitor: o grupo de IBS e CBS de cada leiaute, o
// adquirente de cada modelo (destinatário, tomador), os cancelamentos e o motivo de cada documento que fica de fora.
// Depois, de ponta a ponta, com documentos fictícios de valores redondos e um SplitHub falso que baixa o que chega: o
// lote misto entra, o plano cobre primeiro o modelo que ainda não saiu em cada ente, o IBS traz a operação e o extrato
// de cada documento (a chave de 50 da NFS-e; sem adquirente na NFC-e ao consumidor) e a CBS traz a foto com o código
// do documento (55, 65, 57, 91). O painel fecha os quatro modelos pelos dois entes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lerDocumento } from '../server/emulacao/xml.ts';
import { lerZip } from '../server/emulacao/zip.ts';

const RAIZ = path.resolve(import.meta.dirname, '..');
const PORTA_APP = 13967;
const PORTA_SPLITHUB = 13968;
const API = `http://localhost:${PORTA_APP}/api`;
const IBS = `http://localhost:${PORTA_APP}/entes/ibs`;
const WEBHOOK = `http://localhost:${PORTA_SPLITHUB}/webhook/ibs`;
const RETORNO = `http://localhost:${PORTA_SPLITHUB}/retorno/cbs`;
const ROOT = 'root.poc@empresa.com.br';
const SENHA = 'senha-de-teste-123';
const dados = mkdtempSync(path.join(tmpdir(), 'massgen-modelos-'));
const processos: ChildProcess[] = [];
let splithub: Server;

// ---------------------------------------------------------------- o lote (fictício, valores redondos)

const CLIENTE = '12345678000190';
const FORNECEDOR = '98765432000110';
const COMPRADOR = '11222333000144';
const TRANSPORTADORA = '22333444000155';
const PRESTADOR = '33444555000166';
const CONSUMIDOR = '12345678909'; // CPF

function chaveDe(cnpj: string, modelo: string, numero: number): string {
  const base = `352611${cnpj}${modelo}001${String(numero).padStart(9, '0')}1${String(numero).padStart(8, '0')}`;
  let soma = 0;
  let peso = 2;
  for (let i = base.length - 1; i >= 0; i--) { soma += Number(base[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const dv = 11 - (soma % 11);
  return base + (dv >= 10 ? 0 : dv);
}

// NF-e e NFC-e: o mesmo leiaute; a NFC-e ao consumidor leva CPF ou nenhum destinatário.
interface Nfe { numero: number; mod?: '55' | '65'; emit: string; dest?: string; ibs: number; cbs: number; semGrupo?: boolean }
function nfe(o: Nfe) {
  const mod = o.mod ?? '55';
  const chave = chaveDe(o.emit, mod, o.numero);
  const dest = o.dest ? `<dest>${o.dest.length === 11 ? `<CPF>${o.dest}</CPF>` : `<CNPJ>${o.dest}</CNPJ>`}<xNome>Destinatário ${o.numero}</xNome></dest>` : '';
  const grupo = o.semGrupo ? '' : `<IBSCBSTot><vBCIBSCBS>10000.00</vBCIBSCBS><gIBS><gIBSUF><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSUF>${(o.ibs * 0.6).toFixed(2)}</vIBSUF></gIBSUF><gIBSMun><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vIBSMun>${(o.ibs * 0.4).toFixed(2)}</vIBSMun></gIBSMun><vIBS>${o.ibs.toFixed(2)}</vIBS></gIBS><gCBS><vDif>0.00</vDif><vDevTrib>0.00</vDevTrib><vCBS>${o.cbs.toFixed(2)}</vCBS></gCBS></IBSCBSTot>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00">
<ide><cUF>35</cUF><natOp>Venda</natOp><mod>${mod}</mod><serie>1</serie><nNF>${o.numero}</nNF><dhEmi>2026-11-01T10:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>1</tpAmb><finNFe>1</finNFe></ide>
<emit><CNPJ>${o.emit}</CNPJ><xNome>Emitente ${o.numero}</xNome></emit>${dest}
<total><ICMSTot><vNF>10000.00</vNF></ICMSTot>${grupo}</total></infNFe></NFe>
<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-11-01T10:00:05-03:00</dhRecbto><nProt>1352600000${o.numero}</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
  return { chave, xml, numero: o.numero };
}

// CT-e 4.00. toma: '0' a '3' vão em toma3 (remetente, expedidor, recebedor, destinatário); um CNPJ vai em toma4.
// O infDoc leva a NF-e transportada: o leitor precisa ler o CT-e, e não a NF-e de dentro dele.
interface Cte { numero: number; emit: string; rem: string; dest: string; toma: string; ibs: number; cbs: number; tp?: string; ref?: string; dia?: string; mod?: string; semTotal?: boolean }
function cte(o: Cte) {
  const mod = o.mod ?? '57';
  const chave = chaveDe(o.emit, mod, o.numero);
  const dia = o.dia ?? '2026-11-01';
  const toma = o.toma.length === 1 ? `<toma3><toma>${o.toma}</toma></toma3>` : `<toma4><toma>4</toma><CNPJ>${o.toma}</CNPJ><xNome>Tomador ${o.numero}</xNome></toma4>`;
  const vIbs = o.semTotal ? '' : `<vIBS>${o.ibs.toFixed(2)}</vIBS>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cteProc xmlns="http://www.portalfiscal.inf.br/cte" versao="4.00"><CTe><infCte Id="CTe${chave}" versao="4.00">
<ide><cUF>35</cUF><CFOP>5353</CFOP><natOp>Prestação de serviço de transporte</natOp><mod>${mod}</mod><serie>1</serie><nCT>${o.numero}</nCT><dhEmi>${dia}T10:00:00-03:00</dhEmi><tpAmb>1</tpAmb><tpCTe>${o.tp ?? '0'}</tpCTe>${toma}</ide>
<emit><CNPJ>${o.emit}</CNPJ><xNome>Transportadora ${o.numero}</xNome></emit>
<rem><CNPJ>${o.rem}</CNPJ><xNome>Remetente ${o.numero}</xNome></rem><dest><CNPJ>${o.dest}</CNPJ><xNome>Destinatário ${o.numero}</xNome></dest>
<vPrest><vTPrest>10000.00</vTPrest><vRec>10000.00</vRec></vPrest>
<imp><ICMS><ICMS00><CST>00</CST></ICMS00></ICMS><IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>10000.00</vBC><gIBSUF><pIBSUF>0.10</pIBSUF><vIBSUF>${(o.ibs * 0.6).toFixed(2)}</vIBSUF></gIBSUF><gIBSMun><pIBSMun>0.00</pIBSMun><vIBSMun>${(o.ibs * 0.4).toFixed(2)}</vIBSMun></gIBSMun>${vIbs}<gCBS><pCBS>0.90</pCBS><vCBS>${o.cbs.toFixed(2)}</vCBS></gCBS></gIBSCBS></IBSCBS><vTotDFe>${(10000 + o.ibs + o.cbs).toFixed(2)}</vTotDFe></imp>
<infCTeNorm><infCarga><vCarga>50000.00</vCarga></infCarga><infDoc><infNFe><chave>${chaveDe(FORNECEDOR, '55', 9999)}</chave></infNFe></infDoc></infCTeNorm>${o.ref ? `<infCteComp><chCTe>${o.ref}</chCTe></infCteComp>` : ''}
</infCte></CTe><protCTe versao="4.00"><infProt><tpAmb>1</tpAmb><chCTe>${chave}</chCTe><dhRecbto>${dia}T10:00:05-03:00</dhRecbto><nProt>1352600000${o.numero}</nProt><cStat>100</cStat></infProt></protCTe></cteProc>`;
  return { chave, xml, numero: o.numero };
}

function cancelamentoCte(chave: string, dia: string): string {
  return `<procEventoCTe xmlns="http://www.portalfiscal.inf.br/cte" versao="4.00"><eventoCTe versao="4.00"><infEvento Id="ID110111${chave}001"><cOrgao>35</cOrgao><tpAmb>1</tpAmb><CNPJ>${CLIENTE}</CNPJ><chCTe>${chave}</chCTe><dhEvento>${dia}T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><detEvento versaoEvento="4.00"><evCancCTe><descEvento>Cancelamento</descEvento><nProt>135260000000001</nProt><xJust>Frete refeito pelo cliente</xJust></evCancCTe></detEvento></infEvento></eventoCTe><retEventoCTe versao="4.00"><infEvento><tpAmb>1</tpAmb><cStat>135</cStat><chCTe>${chave}</chCTe><nProt>135260000000099</nProt></infEvento></retEventoCTe></procEventoCTe>`;
}

// NFS-e do padrão nacional: chave de 50 dígitos no Id (município, ambiente gerador, tipo de inscrição, CNPJ, número, AAMM,
// código e DV); o grupo IBSCBS da NFS-e é o calculado; a DPS de dentro traz a emissão, o ambiente e o tomador.
interface Nfse { numero: number; prest: string; toma: string; ibs: number; cbs: number; amb?: string; subst?: string; cStat?: string }
const chaveNfse = (cnpj: string, numero: number) => `3550308${'2'}${'2'}${cnpj}${String(numero).padStart(13, '0')}2611${String(numero).padStart(9, '0')}0`;
function nfse(o: Nfse) {
  const chave = chaveNfse(o.prest, o.numero);
  const subst = o.subst ? `<subst><chSubstda>${o.subst}</chSubstda><cMotivo>01</cMotivo></subst>` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS${chave}">
<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao><nNFSe>${o.numero}</nNFSe><cLocIncid>3550308</cLocIncid><ambGer>2</ambGer><tpEmis>1</tpEmis><procEmi>1</procEmi><cStat>${o.cStat ?? '100'}</cStat><dhProc>2026-11-01T10:00:05-03:00</dhProc><nDFSe>${o.numero}00</nDFSe>
<emit><CNPJ>${o.prest}</CNPJ><xNome>Prestador ${o.numero}</xNome></emit>
<valores><vBC>10000.00</vBC><vLiq>10000.00</vLiq></valores>
<IBSCBS><cLocalidadeIncid>3550308</cLocalidadeIncid><valores><vBC>10000.00</vBC><uf><pIBSUF>0.10</pIBSUF></uf><mun><pIBSMun>0.00</pIBSMun></mun><fed><pCBS>0.90</pCBS></fed></valores><totCIBS><vTotNF>${(10000 + o.ibs + o.cbs).toFixed(2)}</vTotNF><gIBS><vIBSTot>${o.ibs.toFixed(2)}</vIBSTot><gIBSUFTot><vDifUF>0.00</vDifUF><vIBSUF>${(o.ibs * 0.6).toFixed(2)}</vIBSUF></gIBSUFTot><gIBSMunTot><vDifMun>0.00</vDifMun><vIBSMun>${(o.ibs * 0.4).toFixed(2)}</vIBSMun></gIBSMunTot></gIBS><gCBS><vDifCBS>0.00</vDifCBS><vCBS>${o.cbs.toFixed(2)}</vCBS></gCBS></totCIBS></IBSCBS>
<DPS versao="1.00"><infDPS Id="DPS355030820${o.prest}00900${String(o.numero).padStart(15, '0')}"><tpAmb>${o.amb ?? '1'}</tpAmb><dhEmi>2026-11-01T10:00:00-03:00</dhEmi><verAplic>1.0</verAplic><serie>900</serie><nDPS>${o.numero}</nDPS><dCompet>2026-11-01</dCompet><tpEmit>1</tpEmit><cLocEmi>3550308</cLocEmi>${subst}
<prest><CNPJ>${o.prest}</CNPJ></prest><toma><CNPJ>${o.toma}</CNPJ><xNome>Tomador ${o.numero}</xNome></toma>
<serv><cServ><cTribNac>010101</cTribNac><xDescServ>Consultoria</xDescServ></cServ></serv><valores><vServPrest><vServ>10000.00</vServ></vServPrest></valores>
<IBSCBS><finNFSe>0</finNFSe><indFinal>0</indFinal><cIndOp>100301</cIndOp><indDest>0</indDest><valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS></infDPS></DPS>
</infNFSe></NFSe>`;
  return { chave, xml, numero: o.numero };
}

function pedidoCancelamentoNfse(chave: string, dia: string): string {
  return `<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infPedReg Id="PRE${chave}101101001"><tpAmb>1</tpAmb><verAplic>1.0</verAplic><dhEvento>${dia}T09:00:00-03:00</dhEvento><CNPJAutor>${CLIENTE}</CNPJAutor><chNFSe>${chave}</chNFSe><nPedRegEvento>1</nPedRegEvento><e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>1</cMotivo><xMotivo>Erro na emissão</xMotivo></e101101></infPedReg></pedRegEvento>`;
}
// O evento registrado: a Sefin Nacional embrulha o pedido no infEvento, com a data do processamento.
const cancelamentoNfse = (chave: string, dia: string) =>
  `<evento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infEvento Id="EVT${chave}101101001"><verAplic>1.0</verAplic><ambGer>2</ambGer><nSeqEvento>1</nSeqEvento><dhProc>${dia}T09:00:05-03:00</dhProc><nDFe>777</nDFe>${pedidoCancelamentoNfse(chave, dia).replace(/ xmlns="[^"]*"/, '')}</infEvento></evento>`;

// Aceitos: um de cada modelo e lado, o complemento de um CT-e e dois cancelamentos (CT-e e NFS-e).
const NFE_ENTRADA = nfe({ numero: 1001, emit: FORNECEDOR, dest: CLIENTE, ibs: 2000, cbs: 1000 });
const NFCE_SAIDA = nfe({ numero: 6501, mod: '65', emit: CLIENTE, dest: CONSUMIDOR, ibs: 200, cbs: 100 });
const CTE_ENTRADA = cte({ numero: 5701, emit: TRANSPORTADORA, rem: CLIENTE, dest: COMPRADOR, toma: '0', ibs: 400, cbs: 200 });
const CTE_SAIDA = cte({ numero: 5702, emit: CLIENTE, rem: FORNECEDOR, dest: COMPRADOR, toma: COMPRADOR, ibs: 400, cbs: 200 });
const CTE_COMPLEMENTO = cte({ numero: 5703, emit: TRANSPORTADORA, rem: CLIENTE, dest: COMPRADOR, toma: '0', ibs: 40, cbs: 20, tp: '1', ref: CTE_ENTRADA.chave, dia: '2026-11-02' });
const NFSE_ENTRADA = nfse({ numero: 9101, prest: PRESTADOR, toma: CLIENTE, ibs: 1000, cbs: 500 });
const NFSE_SAIDA = nfse({ numero: 9102, prest: CLIENTE, toma: COMPRADOR, ibs: 1000, cbs: 500 });
// De fora, cada um com o motivo.
const CTE_SUBSTITUTO = cte({ numero: 5704, emit: TRANSPORTADORA, rem: CLIENTE, dest: COMPRADOR, toma: '0', ibs: 400, cbs: 200, tp: '3' });
const CTE_OUTRO_TOMADOR = cte({ numero: 5705, emit: TRANSPORTADORA, rem: CLIENTE, dest: COMPRADOR, toma: '3', ibs: 400, cbs: 200 });
const CTE_OS = cte({ numero: 6701, emit: TRANSPORTADORA, rem: CLIENTE, dest: COMPRADOR, toma: '0', ibs: 400, cbs: 200, mod: '67' });
const NFSE_SUBSTITUTA = nfse({ numero: 9103, prest: PRESTADOR, toma: CLIENTE, ibs: 1000, cbs: 500, subst: chaveNfse(PRESTADOR, 9001), cStat: '101' });
const NFSE_HOMOLOGACAO = nfse({ numero: 9104, prest: PRESTADOR, toma: CLIENTE, ibs: 1000, cbs: 500, amb: '2' });
const NFCE_SEM_GRUPO = nfe({ numero: 6502, mod: '65', emit: CLIENTE, ibs: 200, cbs: 100, semGrupo: true });

// ---------------------------------------------------------------- leitor

test('leitor: CT-e (tomador, complemento, IBSCBS em imp), NFC-e ao consumidor e NFS-e (chave de 50, grupo calculado)', () => {
  const c = lerDocumento(CTE_ENTRADA.xml);
  assert.equal(c.tipo, 'nota', 'o CT-e não vira a NF-e que ele transporta');
  if (c.tipo !== 'nota') return;
  assert.deepEqual([c.nota.chave, c.nota.modelo, c.nota.numero, c.nota.emitCnpj, c.nota.destDoc], [CTE_ENTRADA.chave, '57', '5701', TRANSPORTADORA, CLIENTE], 'toma3 = 0: o tomador é o remetente');
  assert.deepEqual([c.nota.vIbs, c.nota.vIbsUf, c.nota.vIbsMun, c.nota.vCbs], [400, 240, 160, 200]);
  assert.equal(c.nota.restricao, undefined);
  const s = lerDocumento(CTE_SAIDA.xml);
  assert.equal(s.tipo === 'nota' && s.nota.destDoc, COMPRADOR, 'toma4: o tomador vem com o CNPJ');
  const comp = lerDocumento(CTE_COMPLEMENTO.xml);
  assert.ok(comp.tipo === 'nota' && comp.nota.finalidade === 'complementar' && comp.nota.refChaves[0] === CTE_ENTRADA.chave);
  // Sem o vIBS, o total é a soma da UF com o município.
  const semTotal = lerDocumento(cte({ numero: 5799, emit: TRANSPORTADORA, rem: CLIENTE, dest: COMPRADOR, toma: '0', ibs: 400, cbs: 200, semTotal: true }).xml);
  assert.equal(semTotal.tipo === 'nota' && semTotal.nota.vIbs, 400);
  const substituto = lerDocumento(CTE_SUBSTITUTO.xml);
  assert.match(substituto.tipo === 'nota' ? substituto.nota.restricao ?? '' : '', /^CT-e de substituição \(tpCTe 3\)/);

  const nfc = lerDocumento(NFCE_SAIDA.xml);
  assert.ok(nfc.tipo === 'nota');
  if (nfc.tipo !== 'nota') return;
  assert.deepEqual([nfc.nota.modelo, nfc.nota.destDoc, nfc.nota.vIbs, nfc.nota.vCbs], ['65', CONSUMIDOR, 200, 100]);

  const n = lerDocumento(NFSE_ENTRADA.xml);
  assert.ok(n.tipo === 'nota');
  if (n.tipo !== 'nota') return;
  assert.equal(n.nota.chave.length, 50);
  assert.deepEqual([n.nota.modelo, n.nota.numero, n.nota.emitCnpj, n.nota.destDoc, n.nota.autorizacao], ['91', '9101', PRESTADOR, CLIENTE, '2026-11-01T10:00:05-03:00']);
  assert.deepEqual([n.nota.vIbs, n.nota.vIbsUf, n.nota.vIbsMun, n.nota.vCbs], [1000, 600, 400, 500], 'os valores vêm do grupo da NFS-e, não da DPS');
  const sub = lerDocumento(NFSE_SUBSTITUTA.xml);
  assert.match(sub.tipo === 'nota' ? sub.nota.restricao ?? '' : '', /^NFS-e de substituição/);
});

test('leitor: os cancelamentos do CT-e e da NFS-e; o pedido solto, a DPS e o evento que não é cancelamento ficam de fora', () => {
  const c = lerDocumento(cancelamentoCte(CTE_SAIDA.chave, '2026-11-03'));
  assert.deepEqual(c.tipo === 'cancelamento' && [c.cancelamento.chave, c.cancelamento.autorizado, c.cancelamento.protocolo], [CTE_SAIDA.chave, true, '135260000000099']);
  const n = lerDocumento(cancelamentoNfse(NFSE_SAIDA.chave, '2026-11-03'));
  assert.deepEqual(n.tipo === 'cancelamento' && [n.cancelamento.chave, n.cancelamento.autorizado, n.cancelamento.quando], [NFSE_SAIDA.chave, true, '2026-11-03T09:00:00-03:00']);
  const p = lerDocumento(pedidoCancelamentoNfse(NFSE_SAIDA.chave, '2026-11-03'));
  assert.ok(p.tipo === 'cancelamento' && !p.cancelamento.autorizado && /sem o registro da Sefin Nacional/.test(p.cancelamento.recusa ?? ''));
  const outro = lerDocumento(cancelamentoNfse(NFSE_SAIDA.chave, '2026-11-03').replace(/e101101/g, 'e202201'));
  assert.deepEqual(outro, { tipo: 'outro', motivo: 'Evento e202201 da NFS-e: só o cancelamento (e101101) gera eventos na POC.' });
  const ct = lerDocumento(cancelamentoCte(CTE_SAIDA.chave, '2026-11-03').replace(/110111/g, '610110'));
  assert.deepEqual(ct, { tipo: 'outro', motivo: 'Evento 610110 do CT-e: só o cancelamento (110111) gera eventos na POC.' });
  const dps = lerDocumento(/<DPS[\s\S]*<\/DPS>/.exec(NFSE_ENTRADA.xml)![0]);
  assert.match(dps.tipo === 'outro' ? dps.motivo : '', /^DPS sem a NFS-e/);
  assert.deepEqual(lerDocumento('<nada/>'), { tipo: 'outro', motivo: 'O arquivo não é NF-e, NFC-e, CT-e nem NFS-e, nem o cancelamento de um deles.' });
});

// ---------------------------------------------------------------- o SplitHub falso

const arquivosIbs: any[] = [];
const arquivosCbs: any[] = [];
let ocupado = 0;
let cookie = '';
let pocId = '';
let credIbs = { clientId: '', clientSecret: '' };
const notas: Record<string, any> = {};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const doIbs = () => ({ clientid: credIbs.clientId, clientsecret: credIbs.clientSecret });

function subir(arquivo: string, env: Record<string, string>, pronto: RegExp): Promise<{ saida: () => string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [arquivo], { cwd: RAIZ, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    processos.push(p);
    let saida = '';
    const ok = (b: Buffer) => { saida += b; if (pronto.test(saida)) resolve({ saida: () => saida }); };
    p.stdout!.on('data', ok);
    p.stderr!.on('data', (b) => { saida += b; });
    p.on('exit', (c) => reject(new Error(`${arquivo} saiu com ${c}: ${saida}`)));
    setTimeout(() => reject(new Error(`${arquivo} não subiu: ${saida}`)), 15000);
  });
}

async function chamar(metodo: string, url: string, op: { corpo?: unknown; cabecalhos?: Record<string, string> } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(cookie && url.startsWith(API) ? { cookie } : {}), ...op.cabecalhos },
    body: op.corpo === undefined ? undefined : JSON.stringify(op.corpo),
  });
  const texto = await r.text();
  let corpo: any;
  try { corpo = texto ? JSON.parse(texto) : undefined; } catch { corpo = texto; }
  return { status: r.status, corpo };
}

async function api<T = any>(metodo: string, rota: string, corpo?: unknown): Promise<T> {
  const r = await chamar(metodo, API + rota, { corpo });
  if (r.status >= 400) throw new Error(`${metodo} ${rota} → ${r.status}: ${JSON.stringify(r.corpo)}`);
  return r.corpo as T;
}

// Responde 2xx e baixa o que veio: o arquivo do IBS pela credencial, o JSON da CBS pelo link.
function subirSplitHub(): Promise<void> {
  splithub = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'HEAD') { res.writeHead(u.pathname === '/retorno/cbs' ? 200 : 404).end(); return; }
    let texto = '';
    for await (const c of req) texto += c;
    const corpo = JSON.parse(texto);
    ocupado++;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"recebido":true}');
    try {
      if (u.pathname === '/webhook/ibs') {
        for (const a of corpo.arquivos) {
          const r = await fetch(`${IBS}/v1/aassist/arquivo/${a.nomeArq}`, { headers: doIbs() });
          if (r.status !== 200) continue;
          const [json] = lerZip(Buffer.from(await r.arrayBuffer()));
          arquivosIbs.push(JSON.parse(json.dados.toString('utf8')));
        }
      } else if (u.pathname === '/retorno/cbs' && corpo.urlAssinada) {
        const r = await fetch(corpo.urlAssinada);
        if (r.status === 200) arquivosCbs.push(await r.json());
      }
    } finally {
      ocupado--;
    }
  });
  return new Promise((r) => splithub.listen(PORTA_SPLITHUB, r));
}

async function calmo(): Promise<void> {
  let quietos = 0;
  for (let i = 0; i < 200 && quietos < 6; i++) {
    await esperar(100);
    quietos = ocupado === 0 ? quietos + 1 : 0;
  }
}

const cobertura = () => api('GET', `/pocs/${pocId}/cobertura`);
const operacoes = () => arquivosIbs.flatMap((a) => a.header.operacoes);
const fotos = () => arquivosCbs.flatMap((a) => a.apuracao.flatMap((g: any) => [...(g.debitos ?? []), ...(g.creditos ?? [])]));

before(async () => {
  await subirSplitHub();
  const app = await subir('server/main.ts', {
    PORT: String(PORTA_APP), MASSGEN_DATA_DIR: dados, ALLOWED_DESTINATION_DOMAINS: 'localhost', MASSGEN_HOST: '', MASSGEN_CONFIAR_CLOUDFLARE_ACCESS: 'false',
    MASSGEN_ROOTS: ROOT, MASSGEN_URL_PUBLICA: `http://localhost:${PORTA_APP}`, MASSGEN_COOKIE_SEGURO: 'false', MASSGEN_AVISO_ESPERAS_MS: '50,50',
  }, /MassGen no ar/);
  let link = '';
  for (let i = 0; i < 50 && !link; i++) {
    link = /Primeiro acesso de root\.poc@empresa\.com\.br: (\S+)/.exec(app.saida())?.[1] ?? '';
    if (!link) await esperar(100);
  }
  const r = await fetch(`${API}/convites/${link.split('/convite/')[1]}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nome: 'Root', senha: SENHA }) });
  cookie = r.headers.getSetCookie().find((c) => c.startsWith('massgen_sessao='))!.split(';')[0];
});

after(() => {
  for (const p of processos) p.kill();
  splithub?.close();
  rmSync(dados, { recursive: true, force: true });
});

// ---------------------------------------------------------------- ponta a ponta

test('importação: o lote misto entra com o papel de cada modelo; o que fica de fora diz por quê', async () => {
  const r = await api('POST', '/pocs', { nome: 'POC Modelos', cnpj: CLIENTE, competencia: '2026-11' });
  pocId = r.poc.id;
  credIbs = r.credenciais.find((c: any) => c.ente === 'ibs');
  const docs = [NFE_ENTRADA, NFCE_SAIDA, CTE_ENTRADA, CTE_SAIDA, CTE_COMPLEMENTO, NFSE_ENTRADA, NFSE_SAIDA,
    CTE_SUBSTITUTO, CTE_OUTRO_TOMADOR, CTE_OS, NFSE_SUBSTITUTA, NFSE_HOMOLOGACAO, NFCE_SEM_GRUPO];
  const imp = await api('POST', `/pocs/${pocId}/notas`, {
    arquivos: docs.map((d) => ({ nome: `${d.numero}.xml`, conteudo: d.xml })).concat([
      { nome: 'cancela-cte.xml', conteudo: cancelamentoCte(CTE_SAIDA.chave, '2026-11-03') },
      { nome: 'cancela-nfse.xml', conteudo: cancelamentoNfse(NFSE_SAIDA.chave, '2026-11-03') },
      { nome: 'pedido-solto.xml', conteudo: pedidoCancelamentoNfse(NFSE_ENTRADA.chave, '2026-11-03') },
    ]),
  });
  assert.equal(imp.aceitas, 7);
  assert.equal(imp.fora, 6);
  assert.equal(imp.cancelamentos, 2);
  assert.equal(imp.ligadas, 1, 'o complemento do CT-e se liga ao original');
  const motivo = (numero: number) => imp.itens.find((i: any) => i.arquivo === `${numero}.xml`).motivo;
  assert.match(motivo(5704), /^CT-e de substituição \(tpCTe 3\): os entes ainda não dizem/);
  assert.equal(motivo(5705), 'o CNPJ raiz 12345678 não está no CT-e como emitente nem como tomador');
  assert.equal(motivo(6701), 'CT-e OS: por ora, entram NF-e, NFC-e, CT-e e NFS-e (D-MG-10)');
  assert.match(motivo(9103), /^NFS-e de substituição: os entes ainda não dizem/);
  assert.equal(motivo(9104), 'NFS-e de homologação');
  assert.equal(motivo(6502), 'a NFC-e não tem o grupo de IBS e CBS');
  assert.match(imp.itens.find((i: any) => i.arquivo === 'pedido-solto.xml').motivo, /sem o registro da Sefin Nacional/);

  for (const n of await api<any[]>('GET', `/pocs/${pocId}/notas`)) notas[n.numero] = n;
  assert.deepEqual(
    [1001, 6501, 5701, 5702, 9101, 9102].map((n) => [notas[n].rotulo, notas[n].papel]),
    [['NF-e 1.001', 'adquirente'], ['NFC-e 6.501', 'fornecedor'], ['CT-e 5.701', 'adquirente'], ['CT-e 5.702', 'fornecedor'], ['NFS-e 9.101', 'adquirente'], ['NFS-e 9.102', 'fornecedor']],
  );
  assert.ok(notas[5702].canceladaEm && notas[9102].canceladaEm, 'os dois cancelamentos marcam o documento');
  assert.equal(notas[5703].origemId, notas[5701].id);

  const hab = await chamar('POST', `${IBS}/v1/aassist/habilitar`, { cabecalhos: doIbs(), corpo: { queroHabilitar: 'HAB', webhookUrl: WEBHOOK, tokenContrib: 'token-do-splithub' } });
  assert.equal(hab.status, 200);
  await api('PUT', `/pocs/${pocId}/cbs/url-retorno`, { urlRetorno: RETORNO });
});

test('painel: os modelos do lote à parte da meta dos 59; o XML que falta vale para qualquer modelo', async () => {
  const c = await cobertura();
  assert.equal(c.meta, 50, 'os modelos não mudam a meta dos tipos');
  assert.deepEqual(c.modelos.map((m: any) => [m.sigla, m.aceitas, m.fora, m.naMeta]),
    [['NF-e', 1, 0, true], ['NFC-e', 1, 1, true], ['CT-e', 3, 2, true], ['NFS-e', 2, 2, true], ['CT-e OS', 0, 1, false]]);
  assert.deepEqual(c.porEnte.modelos, { meta: 4, recebidos: 0 });
  assert.equal(c.modelos[0].ibs.situacao, 'sem nota no plano');
  assert.equal(c.modelos.find((m: any) => m.sigla === 'CT-e OS').ibs.situacao, 'só documentos de fora');
  // Sem nota de devolução: só a NF-e devolve. O complemento de saída pode vir de uma NF-e ou de um CT-e.
  const xmls = c.faltam.map((f: any) => f.xml);
  assert.ok(xmls.includes('uma NF-e de devolução de uma nota de entrada'), JSON.stringify(xmls));
  assert.ok(xmls.some((x: string) => x.includes('uma NF-e ou um CT-e complementar de uma nota de saída')), JSON.stringify(xmls));
});

test('plano: cobre primeiro o modelo que ainda não saiu em cada ente; os quatro modelos chegam ao SplitHub pelos dois entes', async () => {
  const previa = await api('POST', `/pocs/${pocId}/plano/previa`, {});
  const novos = previa.envios.flatMap((e: any) => e.notas.flatMap((n: any) => n.novos));
  for (const m of ['NF-e', 'NFC-e', 'CT-e', 'NFS-e']) for (const ente of ['no IBS', 'na CBS']) assert.ok(novos.includes(`${m} ${ente}`), `${m} ${ente}: ${JSON.stringify(novos)}`);
  const plano = await api('POST', `/pocs/${pocId}/plano`, {});
  assert.equal(plano.notas, 6, 'cada documento que abre operação ganha um roteiro');
  for (let i = 0; i < 20; i++) {
    const c = await cobertura();
    if (!c.proximos.ibs && !c.proximos.cbs) break;
    await api('POST', `/pocs/${pocId}/relogio/fechar`, {});
    await calmo();
  }
  const c = await cobertura();
  assert.deepEqual(c.porEnte.modelos, { meta: 4, recebidos: 4 }, JSON.stringify(c.modelos.map((m: any) => [m.sigla, m.ibs.situacao, m.cbs.situacao])));
  assert.ok(c.modelos.filter((m: any) => m.naMeta).every((m: any) => m.coberto && m.ibs.situacao === 'coberto' && m.cbs.situacao === 'coberto'));
});

test('IBS: a operação e o extrato de cada modelo; a NFS-e com a chave de 50 e a NFC-e ao consumidor sem adquirente', async () => {
  const op = (chave: string) => operacoes().find((o: any) => o.CHAVE_ACESSO === chave);
  // A NFS-e de saída levou o modelo ao IBS (RT-F6, com o cancelamento); a de entrada, que já não acrescentava modelo, foi
  // para um roteiro da CBS.
  const nfs = op(NFSE_SAIDA.chave);
  assert.ok(nfs, 'a NFS-e de saída saiu no IBS');
  assert.equal(nfs.CHAVE_ACESSO.length, 50);
  assert.deepEqual([nfs.CNPJ_FORNECEDOR, nfs.CNPJ_ADQUIRENTE, nfs.DTH_AUTORIZACAO], ['12345678', '11222333', '2026-11-01 10:00:05.000 -03:00'], 'na NFS-e, o fornecedor é o prestador e o adquirente, o tomador');
  assert.equal(nfs.extrato_cc.lista[0].MOV, 'Fornecimento');
  assert.equal(nfs.extrato_cc.lista[0].DEBITO_EM_ABERTO, 1000);
  assert.ok(operacoes().filter((o: any) => o.CHAVE_ACESSO === NFSE_SAIDA.chave).flatMap((o: any) => o.extrato_cc.lista).some((l: any) => l.MOV === 'Cancelamento - Estorno de Debito em aberto'), 'o cancelamento registrado da NFS-e chega ao extrato');
  const nfc = op(NFCE_SAIDA.chave);
  assert.equal(nfc.CNPJ_FORNECEDOR, '12345678');
  assert.equal('CNPJ_ADQUIRENTE' in nfc, false, 'consumidor com CPF: o campo não vem (0-1 no Anexo I)');
  assert.equal(nfc.extrato_cc.lista[0].DEBITO_EM_ABERTO, 200);
  const ct = op(CTE_ENTRADA.chave);
  assert.deepEqual([ct.CNPJ_FORNECEDOR, ct.CNPJ_ADQUIRENTE], ['22333444', '12345678'], 'no CT-e, o adquirente é o tomador');
  // O complemento do CT-e entra na operação do original, como na NF-e.
  assert.ok(operacoes().filter((o: any) => o.CHAVE_ACESSO === CTE_ENTRADA.chave).flatMap((o: any) => o.extrato_cc.lista).some((l: any) => l.MOV === 'Complemento de Aquisicao' && l.CREDITO_A_PROPRIAR === 40));
  assert.equal(op(CTE_COMPLEMENTO.chave), undefined, 'o complemento não abre operação');
  assert.ok(op(CTE_SAIDA.chave) && op(NFE_ENTRADA.chave));
});

test('CBS: o documento de cada modelo, com o código da tabela A.9 na foto', async () => {
  const foto = (chave: string) => fotos().filter((f: any) => f.chave === chave).pop();
  assert.deepEqual([NFE_ENTRADA, NFCE_SAIDA, CTE_ENTRADA, CTE_SAIDA, NFSE_ENTRADA, NFSE_SAIDA].map((d) => foto(d.chave)?.documento), [55, 65, 57, 57, 91, 91]);
  assert.equal(foto(NFSE_ENTRADA.chave).chave.length, 50, 'a chave da NFS-e cabe no string(50)');
  assert.equal(foto(NFSE_ENTRADA.chave).cbs.apurado, 500);
  assert.equal(foto(NFCE_SAIDA.chave).cbs.apurado, 100);
  assert.equal(foto(CTE_ENTRADA.chave).cbs.apurado, 200);
  // O complemento do CT-e é um documento próprio na CBS.
  const nota = await api('GET', `/pocs/${pocId}/notas/${notas[5701].id}`);
  assert.equal(nota.nota.rotulo, 'CT-e 5.701');
  assert.deepEqual(nota.relacionadas.map((r: any) => r.rotulo), ['CT-e 5.703']);
});

test('collections: as decisões sobre os modelos ficam declaradas nos dois entes', async () => {
  const ibs = await api('GET', `/pocs/${pocId}/collection`);
  assert.match(ibs.info.description, /CHAVE_ACESSO da NFS-e: o Anexo I dá C\(44\)/);
  const cbs = await api('GET', `/pocs/${pocId}/collection?ente=cbs`);
  assert.match(cbs.info.description, /A NFS-e não tem modelo no leiaute: vai 91/);
});
