// corrigir-movimento FASE 4 — reimportacao. IMPORT_MODE=cego roda os MESMOS asserts contra o /upload antigo
// (INSERT cego) como controle negativo; CORRECAO_LIB aponta para copia sem a validacao de celula.
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require(process.env.CORRECAO_LIB || '../lib/envio-massa-correcao');
const { reimportar, faixaDia, celulaSemNumero } = lib;
const { buscarEmLotes } = require('../lib/hub-postgrest-lotes');

const INI = '2026-09-01T03:00:00-03:00';
const FIM = '2026-09-07T03:00:00-03:00';
const C1 = '11222333000181', C2 = '99888777000166';
const lin = (o = {}) => ({ cnpj_prestador: C1, valor: '100.00', gorjeta: null, mensagem1: undefined, uuid: 'u1', ...o });

// Banco em memoria: reproduz o contrato da RPC (guardas de nota/fechado/tenant).
function mundo(seed) {
  const banco = seed.map((r, i) => ({ id: i + 1, empresa: 6, valor: 100, gorjeta: null, mensagem1: 'm', nota_ok: '', fechado: false, uuid: null, ...r }));
  const c = { buscas: 0, rpc: 0, inserts: [], auditorias: 0, escritas: 0 };
  let nextId = 1000;
  const deps = {
    buscarExistentes: async ({ idEmp, cnpjs }) => {
      c.buscas += 1;
      assert.ok(cnpjs.every((x) => /^\d{14}$/.test(x)));
      return banco.filter((r) => r.empresa === idEmp && cnpjs.includes(r.cnpj_prestador));
    },
    corrigir: async ({ idEmp, movimentos, motivo }) => {
      c.rpc += 1; assert.ok(motivo);
      return movimentos.map((m) => {
        const r = banco.find((x) => x.id === m.id && x.empresa === idEmp);
        if (!r) return { movimento_id: m.id, desfecho: 'nao_encontrado' };
        if (r.fechado) return { movimento_id: m.id, desfecho: 'pulado_mov_fechado' };
        if (r.nota_ok) return { movimento_id: m.id, desfecho: 'pulado_nota_enviada' };
        if (r.valor === m.valor && r.gorjeta === (m.gorjeta ?? null)) return { movimento_id: m.id, desfecho: 'inalterado' };
        r.valor = m.valor; r.gorjeta = m.gorjeta ?? null; c.auditorias += 1; c.escritas += 1;
        return { movimento_id: m.id, desfecho: 'atualizado', msg_valor_antigo: false };
      });
    },
    inserir: async (rows) => { c.inserts.push(rows.length); c.escritas += rows.length; rows.forEach((r) => banco.push({ id: nextId++, empresa: 6, fechado: false, nota_ok: '', ...r, valor: Number(r.valor) })); },
  };
  return { banco, c, deps };
}
const base = (o) => ({ idEmp: 6, dtIni: INI, dtFim: FIM, motivo: 'planilha corrigida', ...o });

// Controle negativo: o /upload antigo = INSERT cego de todas as linhas.
const cego = async ({ linhas }, deps) => { await deps.inserir(linhas); return { status: 200, body: { success: true, inserted: linhas.length } }; };
const run = process.env.IMPORT_MODE === 'cego' ? cego : reimportar;

describe('4.2 reimportacao', () => {
  test('reimportar nao cresce o total (0 duplicatas) e atualiza o valor', async () => {
    const w = mundo([{ cnpj_prestador: C1 }, { cnpj_prestador: C2 }]);
    const r = await run(base({ linhas: [lin({ valor: '150.00' }), lin({ cnpj_prestador: C2, valor: '90.00', uuid: 'u2' })] }), w.deps);
    assert.equal(r.status, 200);
    assert.equal(w.banco.length, 2);
    assert.equal(r.body.resumo.atualizados, 2);
    assert.equal(w.banco[0].valor, 150);
  });
  test('2a importacao identica = 0 alteracoes e 0 auditorias', async () => {
    const w = mundo([{ cnpj_prestador: C1 }]);
    const L = [lin({ valor: '150.00' })];
    await run(base({ linhas: L }), w.deps);
    const aud = w.c.auditorias;
    const r = await run(base({ linhas: L }), w.deps);
    assert.equal(r.body.resumo.inalterados, 1);
    assert.equal(w.c.auditorias, aud);
  });
  test('novas criadas + existentes atualizadas; sem uuid => sem_identificador; soma == total', async () => {
    const w = mundo([{ cnpj_prestador: C1 }]);
    const r = await run(base({ linhas: [lin({ valor: '1.00' }), lin({ cnpj_prestador: '00000000000191', uuid: 'n1' }), lin({ cnpj_prestador: '00000000000272', uuid: '' })] }), w.deps);
    const s = r.body.resumo;
    assert.deepEqual([s.atualizados, s.criados, s.sem_identificador, s.total_linhas], [1, 1, 1, 3]);
    assert.equal(w.banco.length, 3);
  });
  test('nota enviada e fechado: pulados e contados exatamente, valor preservado', async () => {
    const w = mundo([{ cnpj_prestador: C1, nota_ok: 'x' }, { cnpj_prestador: C2, fechado: true }]);
    const r = await run(base({ linhas: [lin({ valor: '9.00' }), lin({ cnpj_prestador: C2, valor: '9.00', uuid: 'u2' })] }), w.deps);
    assert.equal(r.body.resumo.pulados_nota_enviada, 1);
    assert.equal(r.body.resumo.pulados_mov_fechado, 1);
    assert.equal(r.body.pulados.length, 2);
    assert.equal(w.banco[0].valor, 100);
  });
  test('ambigua: lista, aplica o resto, nao escolhe', async () => {
    const w = mundo([{ cnpj_prestador: C1 }, { cnpj_prestador: C1 }, { cnpj_prestador: C2 }]);
    const r = await run(base({ linhas: [lin({ uuid: '' }), lin({ cnpj_prestador: C2, valor: '7.00', uuid: '' })] }), w.deps);
    assert.equal(r.body.resumo.ambiguos, 1); assert.equal(r.body.ambiguos[0].linha, 2);
    assert.equal(r.body.resumo.atualizados, 1);
    assert.equal(w.banco[0].valor, 100);
  });
  test('uuid inexistente cai no fallback', async () => {
    const w = mundo([{ cnpj_prestador: C1, uuid: 'velho' }]);
    const r = await run(base({ linhas: [lin({ uuid: 'outro', valor: '5.00' })] }), w.deps);
    assert.equal(r.body.resumo.atualizados, 1); assert.equal(w.banco.length, 1);
  });
  test('sem motivo e lote alteraria => 400 e NENHUMA escrita (nem das linhas novas)', async () => {
    const w = mundo([{ cnpj_prestador: C1 }]);
    const r = await run(base({ motivo: '  ', linhas: [lin({ valor: '5.00' }), lin({ cnpj_prestador: '00000000000191' })] }), w.deps);
    assert.equal(r.status, 400); assert.equal(w.c.escritas, 0);
  });
  test('sem motivo mas nada seria alterado => segue', async () => {
    const w = mundo([{ cnpj_prestador: C1 }]);
    const r = await run(base({ motivo: undefined, linhas: [lin({ valor: '100.00' })] }), w.deps);
    assert.equal(r.status, 200);
  });
  test('isolamento: movimento da empresa B nao e alterado por lote da A', async () => {
    const w = mundo([{ cnpj_prestador: C1, empresa: 7, uuid: 'u1' }]);
    const r = await run(base({ linhas: [lin({ valor: '1.00' })] }), w.deps);
    assert.equal(w.banco.find((x) => x.empresa === 7).valor, 100);
    assert.equal(r.body.resumo.criados, 1);
  });
  test('falha no meio: 500 com parcial, nunca sucesso total', async () => {
    const w = mundo([{ cnpj_prestador: C1 }]);
    w.deps.inserir = async () => { throw new Error('boom'); };
    const r = await run(base({ linhas: [lin({ valor: '5.00' }), lin({ cnpj_prestador: '00000000000191' })] }), w.deps);
    assert.equal(r.status, 500); assert.equal(r.body.success, false);
    assert.equal(r.body.parcial.atualizacoes_confirmadas, 1); assert.equal(r.body.parcial.linhas_novas_criadas, false);
  });
  test('desempenho: 980 linhas, sem consulta por linha, bem abaixo de 10 s', async () => {
    const cn = (i) => String(10000000000000 + i);
    const w = mundo(Array.from({ length: 980 }, (_, i) => ({ cnpj_prestador: cn(i) })));
    const t = Date.now();
    const r = await run(base({ linhas: Array.from({ length: 980 }, (_, i) => lin({ cnpj_prestador: cn(i), valor: '5.00', uuid: `u${i}` })) }), w.deps);
    const ms = Date.now() - t;
    console.log(`4.2.3 980 linhas: buscas=${w.c.buscas} rpc=${w.c.rpc} ms=${ms}`);
    assert.equal(r.body.resumo.atualizados, 980);
    assert.ok(w.c.rpc <= 5 && w.c.buscas === 1); assert.ok(ms < 10000);
  });
});

describe('celula invalida na borda (#REF!)', () => {
  for (const v of ['#REF!', '#VALOR!', 'N/A', 'abc', 'x', 'null', 'undefined']) {
    test(`"${v}" => invalida`, () => assert.equal(celulaSemNumero(v), true));
  }
  for (const v of ['', '  ', '-', 'R$ -', null, undefined, '10,5', 'R$ 22,00', 5, 0]) {
    test(`${JSON.stringify(v)} => nao e "sem numero"`, () => assert.equal(celulaSemNumero(v), false));
  }
  test('server.js valida valor E gorjeta com celulaSemNumero antes de parsear', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    assert.match(src, /celulaSemNumero\(row\.valor\) \? NaN : toNumberBR\(row\.valor\)/);
    assert.match(src, /celulaSemNumero\(row\.gorjeta\)/);
  });
});

describe('4.1.2 faixa e lotes', () => {
  test('faixa do dia no mesmo offset, dia seguinte exclusivo', () => {
    assert.deepEqual(faixaDia(INI), { ini: '2026-09-01T00:00:00-03:00', fim: '2026-09-02T00:00:00-03:00' });
    assert.equal(faixaDia('2026-12-31T03:00:00-03:00').fim, '2027-01-01T00:00:00-03:00');
    assert.throws(() => faixaDia('x'));
  });
  test('buscarEmLotes: fetcher injetado, lotes de 100, sem quebrar default', async () => {
    const urls = [];
    const ids = Array.from({ length: 250 }, (_, i) => String(10000000000000 + i));
    const r = await buscarEmLotes('EnvioMassa?id_empresa=eq.6', ids, { campoId: 'cnpj_prestador', fetcher: async (u) => { urls.push(u); return [{ ok: 1 }]; } });
    assert.equal(urls.length, 3); assert.equal(r.length, 3);
    assert.ok(urls[0].includes('&cnpj_prestador=in.('));
  });
  test('SEC-2: valor nao-CNPJ nunca chega a consulta', async () => {
    let visto;
    await reimportar(base({ linhas: [lin({ cnpj_prestador: "1);drop" })] }), { buscarExistentes: async (a) => { visto = a.cnpjs; return []; }, corrigir: async () => [], inserir: async () => {} });
    assert.deepEqual(visto, []);
  });
});

describe('4.1.3 CHK021 sem range', () => {
  test('server.js recusa 400 sem dt_inicial/dt_final ANTES de ler arquivo/consultar/escrever', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
    const rota = src.slice(src.indexOf("app.post('/upload'"));
    const iVal = rota.indexOf('dt_inicial é obrigatório');
    assert.ok(iVal > 0);
    for (const marca of ['xlsx.readFile', 'reimportar(', "postgrestRequest('EnvioMassa'"]) assert.ok(rota.indexOf(marca) > iVal, marca);
    assert.match(rota.slice(Math.max(0, iVal - 200), iVal + 120), /status\(400\)/);
  });
});
