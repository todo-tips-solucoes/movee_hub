// test/aviso-valor-silencioso.test.js
//
// Desde a migration 0054, um `valor` de faturamento que venha como texto é
// gravado como 0 e a importação termina `completed`. O total do período fica
// SUBESTIMADO e nenhuma tela acusa — o único sinal é o registro em
// ImportacaoLinhaErro. Estes testes travam o aviso que transforma esse silêncio
// em e-mail + linha de log, e garantem que ele nunca derruba uma rodada boa.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { finalizarExecucao } = require('../src/log-execucao');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

describe('consultarErrosImportacao (hub-client)', () => {
  const { criarClienteHub } = require('../src/hub-client');

  // O login valida `entidade_ativa` decodificando o JWT do cookie — o token
  // precisa carregar a claim, como em test/hub-client.test.js.
  const fakeJwt = (payload) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256' })}.${b64(payload)}.assinatura-fake`;
  };

  function clienteCom(getResp, { getThrows = false } = {}) {
    const axiosFake = {
      post: async (url, body) => (String(url).includes('/me/entidade')
        ? { status: 200, data: { entidade_ativa: body.empresa_id },
            headers: { 'set-cookie': [`hub_accessToken=${fakeJwt({ sub: 1, entidade_ativa: body.empresa_id })}; HttpOnly`] } }
        : { status: 200, data: {},
            headers: { 'set-cookie': [`hub_accessToken=${fakeJwt({ sub: 1 })}; HttpOnly`] } }),
      get: async () => { if (getThrows) throw new Error('ECONNRESET'); return getResp; },
    };
    return criarClienteHub({ baseURL: 'https://x', idEmpresaEsperado: 6, axiosInstance: axiosFake });
  }

  test('extrai .items da resposta paginada do hub', async () => {
    const c = clienteCom({ status: 200, data: { items: [{ campo: 'valor', motivo: 'texto em campo numérico — gravado como 0', numeroLinha: 7 }], total: 1 } });
    await c.login('a@b.c', 'x');
    const erros = await c.consultarErrosImportacao(10);
    assert.equal(erros.length, 1);
    assert.equal(erros[0].campo, 'valor');
  });

  // A propriedade que importa: consultar rastro é diagnóstico, não operação.
  test('falha na consulta devolve [] — nunca derruba a importação', async () => {
    const c = clienteCom({ status: 500, data: {} });
    await c.login('a@b.c', 'x');
    assert.deepEqual(await c.consultarErrosImportacao(10), []);
  });

  test('exceção de rede também devolve []', async () => {
    const c = clienteCom(null, { getThrows: true });
    await c.login('a@b.c', 'x');
    assert.deepEqual(await c.consultarErrosImportacao(10), []);
  });
});

describe('log de execução carrega os avisos', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aviso-')), 'log.jsonl');

  test('aviso aparece no log MESMO com resultado=sucesso', () => {
    const caminho = tmp();
    const linha = finalizarExecucao({
      execucaoId: 'exec-1',
      resultado: 'sucesso',
      relatorios: [],
      tentativasTotais: 1,
      caminhoLog: caminho,
      avisos: [{ tipo: 'FINANCE', importacao_id: 12, campo: 'valor', linhas_afetadas: 3, numeros_de_linha: [7, 9, 40], impacto: 'valor gravado como 0 — total do periodo subestimado' }],
    });
    assert.equal(linha.resultado, 'sucesso', 'o aviso NÃO transforma sucesso em falha');
    assert.equal(linha.avisos.length, 1);
    assert.equal(linha.avisos[0].linhas_afetadas, 3);
    // e foi de fato para o disco
    const gravado = fs.readFileSync(caminho, 'utf8').trim().split('\n').pop();
    assert.match(gravado, /"avisos"/);
  });

  test('sem avisos, a chave nem aparece (não polui o log)', () => {
    const linha = finalizarExecucao({
      execucaoId: 'exec-2', resultado: 'sucesso', relatorios: [], tentativasTotais: 1, caminhoLog: tmp(),
    });
    assert.equal(linha.avisos, undefined);
  });
});
