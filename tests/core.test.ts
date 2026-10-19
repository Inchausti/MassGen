import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Rng, distribuir } from '../server/core/rng.ts';
import { chaveValida, cnpjValido, cpfValido, gerarCnpj, gerarCpf, montarChave } from '../server/core/br.ts';
import { gerarMassa } from '../server/core/gerar.ts';
import { conferir } from '../server/core/conferir.ts';
import { validarCenario, validarModelo } from '../server/core/validar.ts';
import type { ModeloEntidade } from '../server/core/tipos.ts';

const pacote = JSON.parse(readFileSync(new URL('../packs/splithub.json', import.meta.url), 'utf8'));
const modelos: ModeloEntidade[] = pacote.modelos;
const variaveis = { buyer_cnpj: '11222333000181', buyer_name: 'Comprador Exemplo S.A.', buyer_state: 'SP' };

test('CNPJ, CPF e chave de acesso têm dígito verificador válido', () => {
  const rng = new Rng(42);
  for (let i = 0; i < 200; i++) {
    assert.ok(cnpjValido(gerarCnpj(rng, { prefixo: '9' })));
    assert.ok(cpfValido(gerarCpf(rng)));
  }
  assert.ok(cnpjValido('11222333000181'));
  assert.ok(!cnpjValido('12345678000100'));
  const chave = montarChave({ uf: 'SP', data: '2026-10-19', cnpj: '11222333000181', modelo: '55', serie: '1', numero: '10001' }, rng);
  assert.equal(chave.length, 44);
  assert.equal(chave.slice(0, 6), '352610');
  assert.ok(chaveValida(chave));
  const errada = montarChave({ uf: 'SP', data: '2026-10-19', cnpj: '11222333000181', modelo: '55', serie: '1', numero: '10001', codigo: '12345678' }, rng, true);
  assert.ok(!chaveValida(errada));
});

test('distribuir respeita os pesos com contagens exatas', () => {
  const r = distribuir(new Rng(1), 10, [{ valor: 'a', peso: 70 }, { valor: 'b', peso: 30 }]);
  assert.equal(r.filter((x) => x === 'a').length, 7);
  assert.equal(r.filter((x) => x === 'b').length, 3);
});

test('os modelos e cenários do pacote SplitHub são válidos', () => {
  for (const m of modelos) assert.deepEqual(validarModelo(m, modelos), [], m.nome);
  for (const c of pacote.cenarios) assert.deepEqual(validarCenario(c.definicao, modelos), [], c.nome);
});

test('C-01 gera fornecedor, contrato e documento coerentes', async () => {
  const c01 = pacote.cenarios.find((c: { id: string }) => c.id === 'c01');
  const { registros } = await gerarMassa({
    modelos, cenario: c01.definicao, semente: 7, dataReferencia: '2026-10-19', codigoExecucao: 'T01', variaveis,
  });
  assert.equal(registros.length, 3);
  const [forn, contr, doc] = registros;
  assert.equal(forn.entidade, 'fornecedor');
  assert.ok(cnpjValido(forn.dados.cnpj as string));
  assert.match(forn.dados.legal_name as string, /MASSA T01$/);
  assert.equal(contr.dados.supplier_cnpj, forn.dados.cnpj);
  assert.equal(contr.dados.payment_method, 'rad');
  assert.equal(contr.dados.start_date, '2026-09-19');
  assert.equal(contr.dados.end_date, '2027-10-19');
  assert.equal((doc.dados.emission as Record<string, unknown>).cnpj, forn.dados.cnpj);
  assert.equal(doc.dados.contract_id, '{{$remoto.contrato}}');
  assert.ok(chaveValida(doc.dados.access_key as string));
  const total = doc.dados.total as Record<string, string>;
  const itens = doc.dados.items as { total_value: string }[];
  assert.equal(Number(total.total_note_value), itens.reduce((s, i) => s + Number(i.total_value), 0));
  for (const r of registros) assert.deepEqual(r.avisos, [], r.rotulo);
  assert.deepEqual(doc.esperado, { status: 202 });
});

test('mesma semente, mesma massa', async () => {
  const c05 = pacote.cenarios.find((c: { id: string }) => c.id === 'c05');
  const a = await gerarMassa({ modelos, cenario: c05.definicao, semente: 99, dataReferencia: '2026-10-19', codigoExecucao: 'X', variaveis });
  const b = await gerarMassa({ modelos, cenario: c05.definicao, semente: 99, dataReferencia: '2026-10-19', codigoExecucao: 'X', variaveis });
  assert.deepEqual(a.registros, b.registros);
  const c = await gerarMassa({ modelos, cenario: c05.definicao, semente: 100, dataReferencia: '2026-10-19', codigoExecucao: 'X', variaveis });
  assert.notDeepEqual(a.registros.map((r) => r.dados), c.registros.map((r) => r.dados));
});

test('C-05 aplica os casos de borda com o gabarito de cada um', async () => {
  const c05 = pacote.cenarios.find((c: { id: string }) => c.id === 'c05');
  const { registros } = await gerarMassa({ modelos, cenario: c05.definicao, semente: 5, dataReferencia: '2026-10-19', codigoExecucao: 'T05', variaveis });
  const docs = registros.filter((r) => r.entidade === 'documento');
  const caso = (id: string) => docs.find((r) => r.caso === id)!;
  assert.equal(caso('contrato_inexistente').dados.contract_id, 'ctr_inexistente_massgen');
  assert.deepEqual(caso('contrato_inexistente').esperado, { status: 422, codigo: 'contract_not_found' });
  const normal = docs.find((r) => !r.caso)!;
  assert.equal(caso('chave_repetida').dados.access_key, docs.find((r) => !r.caso)!.dados.access_key);
  assert.ok(!chaveValida(caso('chave_dv_invalido').dados.access_key as string));
  assert.equal(caso('sem_itens').dados.items, undefined);
  assert.ok(normal.conferencia);
  const contratos = registros.filter((r) => r.entidade === 'contrato');
  assert.equal(contratos.length, 3, 'só fornecedores sem caso recebem contrato');
  const forn = registros.filter((r) => r.entidade === 'fornecedor');
  assert.equal(forn.find((r) => r.caso === 'cnpj_repetido')!.dados.cnpj, forn.find((r) => !r.caso)!.dados.cnpj);
  assert.equal(forn.find((r) => r.caso === 'sem_razao_social')!.dados.legal_name, undefined);
});

test('NFCom troca os itens pelo perfil', async () => {
  const { registros } = await gerarMassa({
    modelos,
    cenario: { entidades: [
      { entidade: 'fornecedor', quantidade: 1 },
      { entidade: 'contrato', quantidade: 1 },
      { entidade: 'documento', quantidade: 2, perfis: { nfe_com_contrato: 0, nfe_sem_contrato: 0, nfcom: 100, parametros_proprios: 0 } },
    ] },
    semente: 3, dataReferencia: '2026-10-19', codigoExecucao: 'NF', variaveis,
  });
  const doc = registros.find((r) => r.entidade === 'documento')!;
  assert.equal(doc.dados.model, '62');
  assert.match(doc.dados.competence_date as string, /^2026-\d{2}-01$/);
  const item = (doc.dados.items as Record<string, unknown>[])[0];
  assert.equal(item.unit, 'month');
  assert.equal(item.ncm, undefined);
  assert.equal(item.service_type, 'mobile_telephony');
  assert.ok((doc.dados.total as Record<string, unknown>).services_value);
  assert.equal((doc.dados.total as Record<string, unknown>).products_value, undefined);
  assert.deepEqual(doc.avisos, []);
});

test('conferir compara status, código e asserções', () => {
  assert.ok(conferir({ status: 201 }, 201, {}).ok);
  assert.ok(!conferir({ status: 201 }, 409, {}).ok);
  assert.ok(conferir({ status: [400, 499] }, 422, {}).ok);
  assert.ok(conferir({ status: 422, codigo: 'contract_not_found' }, 422, { error: 'contract_not_found' }).ok);
  const r = conferir({ status: 200, assercoes: [{ caminho: 'failure.code', igual: 'recipient_not_registered' }] }, 200, { failure: { code: 'x' } });
  assert.ok(!r.ok);
  assert.equal(r.diferencas.length, 1);
});
