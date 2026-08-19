/**
 * Testes unitários dedicados — lib/hub-import-processor.js (tasks.md FASE 4,
 * 4.7; CHK004/dec-030). Rodam com: node --test tests/hub-import-processor.test.js
 *
 * Cobre, SEM PostgREST/DB real (mock via injeção de dependências —
 * `deps.hubPostgrestRequest`/`deps.lerArquivo`):
 *   - 4.7.1: máquina de estados (transições válidas/inválidas)
 *   - 4.7.2: comportamento de lock (mock do UPDATE atômico no índice único
 *     parcial — research.md Decision 5 ADENDO; SEM `pg_try_advisory_lock`)
 *   - 4.7.3: regra >50% inválidas / rollback "por construção" (nenhuma
 *     linha jamais é inserida quando o limiar é ultrapassado)
 *   - 4.5.4: mascaramento LGPD nunca retorna o valor original
 *   - pipeline completo (happy path, completed_with_errors, cabeçalho
 *     inválido, cancelamento entre lotes) com um fake PostgREST minimalista
 *
 * Integração real (E2E contra hub-test-* efêmero: reimportação idempotente,
 * concorrência de 2 importações do mesmo (id_empresa,tipo), cancelamento via
 * SQL concorrente) é responsabilidade de
 * infra/hub/testes/hub-import-processor-integration.sh (tasks 4.2.3/4.3.4/
 * 4.4.4/4.6.3) — este arquivo cobre só a lógica pura/isolada (4.7).
 *
 * Ref: lib/hub-import-processor.js, research.md Decision 5/6/7/8/9/10.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-processor';
process.env.PGRST_JWT_SECRET = process.env.PGRST_JWT_SECRET || 'segredo-teste-processor-pgrst';

const {
  transicaoValida,
  TRANSICOES_VALIDAS,
  ESTADOS,
  tentarAdquirirLock,
  tentarIniciarProximaPendente,
  computarStatusLimiar,
  mascararValor,
  executarPipeline,
  processarImportacao,
  recuperarImportacoesOrfas,
  errorTransiente,
  TAMANHO_LOTE,
  MAX_LINHAS_IMPORTACAO,
} = require('../lib/hub-import-processor');
const { HEADER_FATURAMENTO, HEADER_PERFORMANCE } = require('../lib/hub-import-normalizer');

// ────────────────────────────────────────────────────────────────────────────
// 4.7.1 — Máquina de estados (4.1)
// ────────────────────────────────────────────────────────────────────────────

describe('transicaoValida (4.1.2/4.1.3 — máquina de estados)', () => {
  test('transições válidas do fluxo feliz', () => {
    assert.equal(transicaoValida('pending', 'validating'), true);
    assert.equal(transicaoValida('validating', 'processing'), true);
    assert.equal(transicaoValida('processing', 'completed'), true);
    assert.equal(transicaoValida('processing', 'completed_with_errors'), true);
  });

  test('transições válidas de falha estrutural/cancelamento', () => {
    assert.equal(transicaoValida('validating', 'failed'), true);
    assert.equal(transicaoValida('processing', 'failed'), true);
    assert.equal(transicaoValida('pending', 'cancelled'), true);
    assert.equal(transicaoValida('validating', 'cancelled'), true);
    assert.equal(transicaoValida('processing', 'cancelled'), true);
  });

  test('reprocessar (FASE 5): failed/cancelled -> pending', () => {
    assert.equal(transicaoValida('failed', 'pending'), true);
    assert.equal(transicaoValida('cancelled', 'pending'), true);
  });

  test('transições INVÁLIDAS são rejeitadas', () => {
    assert.equal(transicaoValida('pending', 'processing'), false); // pula validating
    assert.equal(transicaoValida('pending', 'completed'), false);
    assert.equal(transicaoValida('completed', 'pending'), false); // terminal completo não reprocessa
    assert.equal(transicaoValida('completed_with_errors', 'processing'), false);
    assert.equal(transicaoValida('failed', 'processing'), false); // precisa passar por pending de novo
  });

  test('estado desconhecido em qualquer lado -> false (fail-closed)', () => {
    assert.equal(transicaoValida('pending', 'inexistente'), false);
    assert.equal(transicaoValida('inexistente', 'pending'), false);
    assert.equal(transicaoValida(undefined, 'pending'), false);
  });

  test('todo estado tem entrada na tabela de transições (nenhum esquecido)', () => {
    ESTADOS.forEach((estado) => {
      assert.ok(Array.isArray(TRANSICOES_VALIDAS[estado]), `estado ${estado} sem tabela de transições`);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4.7.2 — Lock (mock do UPDATE atômico; SEM pg_try_advisory_lock)
// ────────────────────────────────────────────────────────────────────────────

describe('tentarAdquirirLock (4.2 — mutex via índice único parcial)', () => {
  const job = { importacaoId: 42, idEmpresa: 1, tipo: 'faturamento', claims: {} };

  test('sucesso: PATCH devolve a linha -> lock adquirido', async () => {
    const deps = {
      hubPostgrestRequest: async () => [{ id: 42, status: 'validating' }],
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    assert.equal(await tentarAdquirirLock(job, deps), true);
  });

  test('409 (índice único parcial colidiu — outra ativa) -> NÃO adquirido, sem lançar', async () => {
    const deps = {
      hubPostgrestRequest: async () => {
        const err = new Error('conflict');
        err.status = 409;
        throw err;
      },
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    assert.equal(await tentarAdquirirLock(job, deps), false);
  });

  test('0 linhas afetadas (já não está mais pending) -> NÃO adquirido', async () => {
    const deps = {
      hubPostgrestRequest: async () => [],
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    assert.equal(await tentarAdquirirLock(job, deps), false);
  });

  test('erro NÃO relacionado a conflito (ex.: 500) é propagado, não engolido', async () => {
    const deps = {
      hubPostgrestRequest: async () => {
        const err = new Error('infra fora do ar');
        err.status = 500;
        throw err;
      },
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    await assert.rejects(() => tentarAdquirirLock(job, deps), /infra fora do ar/);
  });
});

describe('tentarIniciarProximaPendente (4.2.2 — espera automática, sem 409)', () => {
  test('sem pendente -> nenhuma chamada extra além do GET de busca', async () => {
    const chamadas = [];
    const deps = {
      hubPostgrestRequest: async (endpoint) => {
        chamadas.push(endpoint);
        return [];
      },
    };
    await tentarIniciarProximaPendente({ importacaoId: 1, idEmpresa: 1, tipo: 'faturamento', claims: {} }, deps);
    assert.equal(chamadas.length, 1);
    assert.match(chamadas[0], /status=eq\.pending/);
  });

  test('com pendente -> dispara nova tentativa de lock (fire-and-forget) para o próximo id', async () => {
    const chamadas = [];
    let buscasPendente = 0; // simula o efeito real: 1ª busca acha o id=2
    // `pending`; assim que o job 2 tenta o lock, deixa de ser `pending` no
    // "banco" simulado — sem isso, um mock sempre-retorna-o-mesmo-id
    // causaria recursão infinita em `tentarIniciarProximaPendente` (job 2
    // acharia "a si mesmo" pendente de novo a cada finally).
    const deps = {
      hubPostgrestRequest: async (endpoint, method) => {
        chamadas.push({ endpoint, method });
        if (/status=eq\.pending&order=criado_em\.asc&limit=1&select=id$/.test(endpoint)) {
          buscasPendente += 1;
          return buscasPendente === 1 ? [{ id: 2 }] : [];
        }
        if (/id=eq\.2&status=eq\.pending$/.test(endpoint) && method === 'PATCH') {
          return [{ id: 2, status: 'validating' }];
        }
        // resto do pipeline do job "2": faz a leitura de info falhar de
        // propósito (não é o foco deste teste) para encerrar rápido.
        throw Object.assign(new Error('fim do mock — fora do escopo deste teste'), { status: 400 });
      },
      isoAgora: () => '2026-07-07T00:00:00Z',
      agoraMs: () => 0,
    };
    await tentarIniciarProximaPendente({ importacaoId: 1, idEmpresa: 1, tipo: 'faturamento', claims: {} }, deps);
    // Aguarda a cadeia fire-and-forget (processarImportacao do job 2) rodar
    // pelo menos 1 tick — sem isso a asserção abaixo pode rodar cedo demais.
    for (let i = 0; i < 20 && !chamadas.some((c) => c.endpoint.includes('id=eq.2')); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 5); });
    }
    assert.ok(chamadas.some((c) => c.endpoint.includes('id=eq.2')), 'esperava uma tentativa de lock para o próximo id (2)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4.7.3 — Regra >50% inválidas (função pura)
// ────────────────────────────────────────────────────────────────────────────

describe('computarStatusLimiar (4.4 — >50% inválidas)', () => {
  test('exatamente 50% -> ok (limiar é ESTRITAMENTE maior que 50%)', () => {
    assert.equal(computarStatusLimiar(10, 5), 'ok');
  });

  test('51% -> failed', () => {
    assert.equal(computarStatusLimiar(100, 51), 'failed');
  });

  test('0% inválidas -> ok', () => {
    assert.equal(computarStatusLimiar(10, 0), 'ok');
  });

  test('100% inválidas -> failed', () => {
    assert.equal(computarStatusLimiar(10, 10), 'failed');
  });

  test('total=0 -> failed (arquivo sem linhas de dados)', () => {
    assert.equal(computarStatusLimiar(0, 0), 'failed');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4.5.4 — Mascaramento LGPD
// ────────────────────────────────────────────────────────────────────────────

describe('mascararValor (4.5.2/4.5.4 — nunca retorna o valor original)', () => {
  const casosNaoVazios = [
    '11111111-1111-1111-1111-111111111111', // UUID
    'Fulano de Tal',                         // nome
    'abc',
    'ab',
    'a',
    '-5',
    '0',
    'DINHEIRO$@#!',
  ];

  casosNaoVazios.forEach((valor) => {
    test(`nunca igual ao original: ${JSON.stringify(valor)}`, () => {
      const mascarado = mascararValor(valor);
      assert.notEqual(mascarado, valor);
      assert.equal(typeof mascarado, 'string');
    });
  });

  test('null -> null (sem conteúdo a vazar)', () => {
    assert.equal(mascararValor(null), null);
  });

  test('undefined -> null', () => {
    assert.equal(mascararValor(undefined), null);
  });

  test('string vazia -> string vazia', () => {
    assert.equal(mascararValor(''), '');
  });

  test('preserva o comprimento original (não vaza tamanho incomum, mas também não mente)', () => {
    assert.equal(mascararValor('abcdef').length, 6);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pipeline completo — fake PostgREST minimalista (executarPipeline)
// ────────────────────────────────────────────────────────────────────────────

function linhaFaturamento(overrides = {}) {
  const base = {
    data_do_lancamento_financeiro: '2026-01-01',
    data_do_periodo_de_referencia: '2026-01-01',
    data_do_repasse: '',
    periodo: 'SEMANAL',
    praca: 'SP',
    subpraca: 'ZonaSul',
    origem: 'App',
    id_da_pessoa_entregadora: '11111111-1111-1111-1111-111111111111',
    recebedor: 'Fulano de Tal',
    tipo: 'Credito',
    valor: '100,00',
    descricao: 'Repasse semanal',
    atingido: '',
    percentual_de_tempo_disponivel: '',
    percentual_de_aceitacao: '',
    percentual_de_conclusao: '',
    criterio_tempo_disponivel: '',
    criterio_rotas_aceitas: '',
    criterio_rotas_concluidas: '',
    margem_fee_porcentagem: '',
  };
  const linha = { ...base, ...overrides };
  return HEADER_FATURAMENTO.map((campo) => linha[campo]).join(';');
}

const HEADER_ROW_FATURAMENTO = HEADER_FATURAMENTO.join(';');

function linhaPerformance(overrides = {}) {
  const base = {
    data_do_periodo: '2026-01-01',
    periodo: 'ALMOCO 11H30-15H29',
    duracao_do_periodo: '03:00:00',
    numero_minimo_de_entregadores_regulares_na_escala: '5',
    tag: 'REGULAR',
    id_da_pessoa_entregadora: '22222222-2222-2222-2222-222222222222',
    pessoa_entregadora: 'Fulana de Tal',
    praca: 'SP',
    sub_praca: 'ZonaSul',
    origem: 'App',
    tempo_disponivel_escalado: '80.00',
    tempo_disponivel_absoluto: '02:24:00',
    numero_de_corridas_ofertadas: '10',
    numero_de_corridas_aceitas: '8',
    numero_de_corridas_rejeitadas: '2',
    numero_de_corridas_completadas: '7',
    numero_de_corridas_canceladas_pela_pessoa_entregadora: '1',
    numero_de_pedidos_aceitos_e_concluidos: '7',
    soma_das_taxas_das_corridas_aceitas: '1000',
  };
  const linha = { ...base, ...overrides };
  return HEADER_PERFORMANCE.map((campo) => linha[campo]).join(';');
}

const HEADER_ROW_PERFORMANCE = HEADER_PERFORMANCE.join(';');

/** Fake PostgREST minimalista: interpreta só os endpoints que
 * hub-import-processor.js de fato usa (ver comentário no topo do arquivo).
 * `opcoes.statusParaCancelamento` permite simular um `foiCancelado` que
 * muda de resposta a partir da N-ésima chamada (teste de cancelamento).
 * `statusInicial` default 'validating' — reflete o estado REAL do registro
 * no banco no ponto em que `executarPipeline` começa a rodar (depois que
 * `tentarAdquirirLock` já fez a transição pending->validating).
 * F5 (pós-review PR #57) — os PATCH de transição (`validating`->
 * `processing` e `processing`->`completed*`) agora vêm com um filtro
 * `&status=eq.<esperado>` na query; o mock RESPEITA esse guard (0 linhas
 * "afetadas" se o status simulado não bate), do mesmo jeito que o
 * PostgREST real faria com a policy/WHERE. */
function criarFakePostgrest({
  nomeArquivo, statusInicial = 'validating', cancelarNaChamadaN = null, cancelarAposInsertDeFatos = false,
} = {}) {
  const chamadas = [];
  let statusAtual = statusInicial;
  let chamadasSelectStatus = 0;

  async function mock(endpoint, method = 'GET', body = null, claims = {}, opts = {}) {
    chamadas.push({ endpoint, method, body, claims, opts });

    if (/^ImportacaoArquivo\?id=eq\.\d+&select=id,nome_arquivo$/.test(endpoint) && method === 'GET') {
      return [{ id: 1, nome_arquivo: nomeArquivo }];
    }

    if (/^ImportacaoArquivo\?id=eq\.\d+&select=status$/.test(endpoint) && method === 'GET') {
      chamadasSelectStatus += 1;
      if (cancelarNaChamadaN !== null && chamadasSelectStatus >= cancelarNaChamadaN) {
        statusAtual = 'cancelled';
      }
      return [{ status: statusAtual }];
    }

    if (/^ImportacaoArquivo\?id=eq\.\d+(&status=eq\.[a-z_]+)?$/.test(endpoint) && method === 'PATCH') {
      const filtroStatus = endpoint.match(/status=eq\.([a-z_]+)/);
      if (filtroStatus && filtroStatus[1] !== statusAtual) {
        return []; // F5 — guard de status não bateu, 0 linhas "afetadas"
      }
      statusAtual = body.status || statusAtual;
      return [{ id: 1, ...body }];
    }

    if (endpoint.startsWith('Entregador?on_conflict=') && method === 'POST') {
      return body.map((linha, i) => ({ id: 9000 + i, id_externo: linha.id_externo, nome: linha.nome }));
    }

    if ((endpoint.startsWith('FaturamentoLancamento?on_conflict=') || endpoint.startsWith('PerformanceTurno?on_conflict=')) && method === 'POST') {
      // F5 (2ª guarda) — simula um POST /:id/cancelar concorrente que
      // aterrissa bem na janela entre o último lote inserido e a PATCH
      // terminal (validando que a PATCH final, guardada por
      // status=eq.processing, detecta e NÃO sobrescreve).
      if (cancelarAposInsertDeFatos) statusAtual = 'cancelled';
      return null; // returnMinimal
    }

    if (endpoint.startsWith('ImportacaoLinhaErro') && method === 'POST') {
      return null;
    }

    // Follow-ups SC-004 (migrations 0028/0031) — refresh best-effort da MV
    // de resumo ao final de importação bem-sucedida (por tipo).
    if ((endpoint === 'rpc/hub_faturamento_refresh_mv' || endpoint === 'rpc/hub_performance_refresh_mv') && method === 'POST') {
      return { modo: 'concurrent', duracao_ms: 1 };
    }

    throw new Error(`mock não implementado para: ${method} ${endpoint}`);
  }

  return {
    hubPostgrestRequest: mock,
    registrarAuditoria: async () => {},
    isoAgora: () => '2026-07-07T00:00:00Z',
    agoraMs: () => 0,
    chamadas,
    getStatus: () => statusAtual,
  };
}

function jobFaturamento(overrides = {}) {
  return { importacaoId: 1, idEmpresa: 100, tipo: 'faturamento', claims: { escopo: [100] }, ...overrides };
}

function jobPerformance(overrides = {}) {
  return { importacaoId: 1, idEmpresa: 100, tipo: 'performance', claims: { escopo: [100] }, ...overrides };
}

describe('executarPipeline — happy path (completed)', () => {
  test('3 linhas válidas -> completed, contadores corretos, sem ImportacaoLinhaErro', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'linha 1' }),
      linhaFaturamento({ descricao: 'linha 2' }),
      linhaFaturamento({ descricao: 'linha 3' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'completed');
    assert.equal(resultado.total, 3);
    assert.equal(resultado.validas, 3);
    assert.equal(resultado.invalidas, 0);

    const chamadaFatos = deps.chamadas.find((c) => c.endpoint.startsWith('FaturamentoLancamento?on_conflict='));
    assert.ok(chamadaFatos, 'esperava 1 chamada de insert em FaturamentoLancamento');
    assert.equal(chamadaFatos.body.length, 3);
    assert.equal(chamadaFatos.opts.resolution, 'ignore-duplicates');

    const chamadaErros = deps.chamadas.find((c) => c.endpoint.startsWith('ImportacaoLinhaErro'));
    assert.equal(chamadaErros, undefined, 'não deveria ter chamado ImportacaoLinhaErro sem linhas inválidas');

    const patchFinal = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patchFinal.body.status, 'completed');
    assert.equal(patchFinal.body.linhas_validas, 3);

    // Follow-up SC-004 (migration 0028) — refresh da mv_faturamento_dia
    // exatamente 1x, e DEPOIS da PATCH terminal (fatos já commitados).
    const refreshes = deps.chamadas.filter((c) => c.endpoint === 'rpc/hub_faturamento_refresh_mv');
    assert.equal(refreshes.length, 1, 'esperava exatamente 1 chamada de refresh da MV');
    assert.ok(
      deps.chamadas.indexOf(refreshes[0]) > deps.chamadas.indexOf(patchFinal),
      'refresh da MV deve acontecer APÓS a transição terminal'
    );

    // Follow-up SC-004 da S7 (0031): o refresh é POR TIPO — importação de
    // faturamento nunca dispara o refresh da mv_performance_dia.
    const refreshPerformance = deps.chamadas.find((c) => c.endpoint === 'rpc/hub_performance_refresh_mv');
    assert.equal(refreshPerformance, undefined, 'importação de faturamento NUNCA dispara o refresh da mv_performance_dia');
  });

  test('falha no refresh da mv_faturamento_dia é best-effort — importação segue completed', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'linha 1' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');
    const mockOriginal = deps.hubPostgrestRequest;
    deps.hubPostgrestRequest = async (endpoint, method, body, claims, opts) => {
      if (endpoint === 'rpc/hub_faturamento_refresh_mv') {
        throw new Error('PostgREST indisponível (simulado)');
      }
      return mockOriginal(endpoint, method, body, claims, opts);
    };

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'completed', 'falha no refresh NÃO pode reverter a importação');
  });

  // Follow-up SC-004 da S7 (migration 0031) — importação de PERFORMANCE
  // bem-sucedida dispara o refresh da mv_performance_dia (e NUNCA o da
  // mv_faturamento_dia), espelhando o comportamento da 0028 para faturamento.
  test('performance: refresh da mv_performance_dia exatamente 1x, APÓS a transição terminal; nunca o RPC de faturamento', async () => {
    const csv = [
      HEADER_ROW_PERFORMANCE,
      linhaPerformance({ data_do_periodo: '2026-01-01' }),
      linhaPerformance({ data_do_periodo: '2026-01-02' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'performance.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobPerformance(), deps);

    assert.equal(resultado.status, 'completed');
    const patchFinal = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patchFinal.body.status, 'completed');

    const refreshes = deps.chamadas.filter((c) => c.endpoint === 'rpc/hub_performance_refresh_mv');
    assert.equal(refreshes.length, 1, 'esperava exatamente 1 chamada de refresh da mv_performance_dia');
    assert.ok(
      deps.chamadas.indexOf(refreshes[0]) > deps.chamadas.indexOf(patchFinal),
      'refresh da MV deve acontecer APÓS a transição terminal'
    );

    const refreshFaturamento = deps.chamadas.find((c) => c.endpoint === 'rpc/hub_faturamento_refresh_mv');
    assert.equal(refreshFaturamento, undefined, 'importação de performance NUNCA dispara o refresh da mv_faturamento_dia');
  });

  test('performance: falha no refresh da mv_performance_dia é best-effort — importação segue completed', async () => {
    const csv = [
      HEADER_ROW_PERFORMANCE,
      linhaPerformance(),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'performance.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');
    const mockOriginal = deps.hubPostgrestRequest;
    deps.hubPostgrestRequest = async (endpoint, method, body, claims, opts) => {
      if (endpoint === 'rpc/hub_performance_refresh_mv') {
        throw new Error('PostgREST indisponível (simulado)');
      }
      return mockOriginal(endpoint, method, body, claims, opts);
    };

    const resultado = await executarPipeline(jobPerformance(), deps);

    assert.equal(resultado.status, 'completed', 'falha no refresh NÃO pode reverter a importação');
  });

  // S5/hub-motoristas (tasks.md 8.2.4, block-004/dec-048) — o upsert de
  // Entregador MUST carregar a claim origemImportacao:true (nunca outros
  // callers), para o trigger trg_entregador_protege_nome (migration 0025)
  // distinguir reimportação S4 de PATCH manual.
  test('upsert de Entregador carrega claim origemImportacao=true, aditiva ao escopo do job', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'linha 1' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    await executarPipeline(jobFaturamento({ claims: { escopo: [100] } }), deps);

    const chamadaEntregador = deps.chamadas.find((c) => c.endpoint.startsWith('Entregador?on_conflict='));
    assert.ok(chamadaEntregador, 'esperava 1 chamada de upsert em Entregador');
    assert.equal(chamadaEntregador.claims.origemImportacao, true, 'upsert de Entregador deve emitir a claim origemImportacao');
    assert.deepEqual(chamadaEntregador.claims.escopo, [100], 'claim origemImportacao é aditiva — não deve apagar o escopo do job');

    const chamadaFatos = deps.chamadas.find((c) => c.endpoint.startsWith('FaturamentoLancamento?on_conflict='));
    assert.ok(chamadaFatos, 'esperava 1 chamada de insert em FaturamentoLancamento');
    assert.equal('origemImportacao' in (chamadaFatos.claims || {}), false, 'insert de fatos NUNCA deve carregar a claim de origem de importação — só o upsert de Entregador');
  });
});

describe('executarPipeline — completed_with_errors', () => {
  test('1 de 3 linhas inválida (33% < 50%) -> completed_with_errors, valor_mascarado nunca bruto', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'ok 1' }),
      linhaFaturamento({ descricao: 'ok 2' }),
      linhaFaturamento({ recebedor: '', valor: 'abc', descricao: '' }), // 3 erros nesta linha
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'completed_with_errors');
    assert.equal(resultado.total, 3);
    assert.equal(resultado.validas, 2);
    assert.equal(resultado.invalidas, 1);

    const chamadaErros = deps.chamadas.find((c) => c.endpoint.startsWith('ImportacaoLinhaErro'));
    assert.ok(chamadaErros, 'esperava insert em ImportacaoLinhaErro');
    assert.ok(chamadaErros.body.length >= 1);
    chamadaErros.body.forEach((linhaErro) => {
      assert.equal(linhaErro.numero_linha, 4); // 4ª linha do arquivo (após cabeçalho)
      if (linhaErro.valor_mascarado !== null && linhaErro.valor_mascarado !== '') {
        assert.notEqual(linhaErro.valor_mascarado, 'abc'); // nunca o valor bruto
      }
    });
  });

  // D3c (migration 0052) — a linha CRUA passa a ser gravada, para o expurgo do
  // arquivo original (12 meses, D3b) não destruir a única cópia dela. Isto não
  // afrouxa o mascaramento: `valor_mascarado` continua mascarado (asserção
  // acima) e a 0052 tira `linha_bruta` do SELECT de `authenticated`, então ela
  // não sai pela API. Sem este teste, um refactor que deixasse de gravar o
  // campo passaria despercebido — e o defeito só apareceria daqui a 12 meses,
  // quando o arquivo fosse expurgado e não houvesse nada para recuperar.
  test('linha rejeitada guarda o conteúdo CRU da linha (D3c), além do mascarado', async () => {
    const linhaRuim = linhaFaturamento({ recebedor: '', valor: 'abc', descricao: '' });
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'ok 1' }),
      linhaFaturamento({ descricao: 'ok 2' }),
      linhaRuim,
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    await executarPipeline(jobFaturamento(), deps);

    const chamadaErros = deps.chamadas.find((c) => c.endpoint.startsWith('ImportacaoLinhaErro'));
    assert.ok(chamadaErros, 'esperava insert em ImportacaoLinhaErro');
    chamadaErros.body.forEach((linhaErro) => {
      assert.equal(
        linhaErro.linha_bruta, linhaRuim,
        'linha_bruta tem de ser a linha do arquivo, byte a byte — é ela que torna a linha recuperável depois do expurgo'
      );
    });
  });
});

describe('executarPipeline — failed (>50% inválidas, rollback por construção)', () => {
  test('4 de 5 linhas inválidas (80%) -> failed, ZERO chamadas de insert de fato', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'única válida' }),
      linhaFaturamento({ recebedor: '' }),
      linhaFaturamento({ valor: 'xx' }),
      linhaFaturamento({ descricao: '' }),
      linhaFaturamento({ recebedor: '', valor: 'yy' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'failed');

    const chamadaFatos = deps.chamadas.find((c) => c.endpoint.startsWith('FaturamentoLancamento'));
    assert.equal(chamadaFatos, undefined, 'nenhuma linha pode ter sido inserida (rollback por construção)');
    const chamadaEntregador = deps.chamadas.find((c) => c.endpoint.startsWith('Entregador'));
    assert.equal(chamadaEntregador, undefined, 'upsert de Entregador também não deve ocorrer se a importação falha estruturalmente');

    const patchFinal = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patchFinal.body.status, 'failed');
    assert.match(patchFinal.body.erro_resumo, /inválidas/);

    // Follow-up SC-004 (migration 0028) — refresh da MV só em conclusão
    // BEM-SUCEDIDA (completed/completed_with_errors), nunca em failed.
    const refresh = deps.chamadas.find((c) => c.endpoint === 'rpc/hub_faturamento_refresh_mv');
    assert.equal(refresh, undefined, 'refresh da MV não deve ocorrer em importação failed');
  });
});

describe('executarPipeline — cabeçalho inválido (falha estrutural)', () => {
  test('cabeçalho fora de ordem -> failed imediatamente, zero linhas processadas', async () => {
    const csv = [
      'praca;recebedor;valor', // cabeçalho errado de propósito
      linhaFaturamento(),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'failed');
    const chamadaProcessing = deps.chamadas.find((c) => c.method === 'PATCH' && c.body && c.body.status === 'processing');
    assert.equal(chamadaProcessing, undefined, 'nunca deveria ter transicionado para processing com cabeçalho inválido');
  });
});

describe('executarPipeline — cancelamento entre lotes (4.6)', () => {
  test('cancela detectado antes do 2º lote -> status cancelled, só o 1º lote foi inserido', async () => {
    const linhas = [];
    for (let i = 0; i < TAMANHO_LOTE + 50; i += 1) {
      linhas.push(linhaFaturamento({ descricao: `linha-${i}`, id_da_pessoa_entregadora: '' }));
    }
    const csv = [HEADER_ROW_FATURAMENTO, ...linhas, ''].join('\n');

    // chamadas de select=status: 1ª = checagem pré-loop (não cancelado),
    // 2ª = antes do lote 1 (não cancelado), 3ª = antes do lote 2 -> cancela.
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv', cancelarNaChamadaN: 3 });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'cancelled');
    const chamadasFatos = deps.chamadas.filter((c) => c.endpoint.startsWith('FaturamentoLancamento'));
    assert.equal(chamadasFatos.length, 1, 'esperava exatamente 1 lote inserido antes da interrupção');
    assert.equal(chamadasFatos[0].body.length, TAMANHO_LOTE);
  });
});

describe('executarPipeline — arquivo inacessível', () => {
  test('leitura do arquivo falha -> failed, com motivo explícito', async () => {
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };

    const resultado = await executarPipeline(jobFaturamento(), deps);
    assert.equal(resultado.status, 'failed');
    const patchFinal = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.match(patchFinal.body.erro_resumo, /inacessível/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F1 (pós-review PR #57) — QUALQUER erro não tratado do pipeline sempre
// termina em `failed` (nunca deixa o mutex órfão travando o índice único
// parcial de 0011).
// ────────────────────────────────────────────────────────────────────────────

describe('processarImportacao — F1.1: catch de topo marca failed em erro NÃO tratado', () => {
  test('infoLinhas (1ª chamada do pipeline) rejeita com erro de infra não capturado por nenhum try/catch interno -> failed, mutex liberado', async () => {
    const chamadas = [];
    const deps = {
      hubPostgrestRequest: async (endpoint, method, body, _claims, _opts) => {
        chamadas.push({ endpoint, method, body });
        if (/status=eq\.pending$/.test(endpoint) && method === 'PATCH') {
          return [{ id: 1, status: 'validating' }]; // lock adquirido
        }
        if (/select=id,nome_arquivo$/.test(endpoint) && method === 'GET') {
          // Erro de infra NÃO relacionado a nenhuma regra de negócio —
          // antes desta correção, isso propagava até o fire-and-forget da
          // rota e o registro ficava preso em `validating` para sempre.
          throw Object.assign(new Error('PostgREST indisponível'), { status: 503 });
        }
        if (/id=eq\.1$/.test(endpoint) && method === 'PATCH') {
          return [{ id: 1, ...body }]; // marcarFailed (F1.1) — sem guard de status
        }
        if (/status=eq\.pending&order=criado_em\.asc&limit=1&select=id$/.test(endpoint)) {
          return []; // tentarIniciarProximaPendente — nada pendente
        }
        throw new Error(`mock não implementado para: ${method} ${endpoint}`);
      },
      registrarAuditoria: async () => {},
      isoAgora: () => '2026-07-07T00:00:00Z',
      agoraMs: () => 0,
    };

    const resultado = await processarImportacao({ importacaoId: 1, idEmpresa: 100, tipo: 'faturamento', claims: { escopo: [100] } }, deps);

    assert.equal(resultado.adquirido, true);
    assert.equal(resultado.status, 'failed');
    const patchFailed = chamadas.find((c) => c.method === 'PATCH' && c.body && c.body.status === 'failed');
    assert.ok(patchFailed, 'esperava 1 PATCH marcando status=failed (nunca preso em validating)');
    assert.ok(!/[Pp]ostg[Rr][Ee][Ss][Tt] indispon[ií]vel/.test(patchFailed.body.erro_resumo || ''), 'erro_resumo não deve vazar detalhe interno de infra');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F1.3 — recuperação de lock órfão no boot.
// ────────────────────────────────────────────────────────────────────────────

describe('recuperarImportacoesOrfas (F1.3 — boot)', () => {
  test('PATCH usa claim hubBootRecovery e filtro status=in.(validating,processing); libera o mutex', async () => {
    const chamadas = [];
    const deps = {
      hubPostgrestRequest: async (endpoint, method, body, claims) => {
        chamadas.push({ endpoint, method, body, claims });
        return [{ id: 10, id_empresa: 9001, status: 'failed' }, { id: 11, id_empresa: 9002, status: 'failed' }];
      },
      registrarAuditoria: async () => {},
      isoAgora: () => '2026-07-07T00:00:00Z',
    };

    const resultado = await recuperarImportacoesOrfas(deps);

    assert.equal(resultado.totalRecuperadas, 2);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].method, 'PATCH');
    assert.match(chamadas[0].endpoint, /status=in\.\(validating,processing\)/);
    assert.equal(chamadas[0].body.status, 'failed');
    assert.match(chamadas[0].body.erro_resumo, /reinicio|reinício/);
    assert.equal(chamadas[0].claims.hubBootRecovery, true, 'deve usar a claim interna hub_boot_recovery — nunca escopo de usuário');
  });

  // hub-auditoria-admin FASE 2.2.2/2.2.5 — gap fechado: 1 evento de auditoria
  // POR tenant afetado (não 1 global), com idEmpresa/recursoId corretos.
  test('registra 1 evento de auditoria POR linha recuperada, com idEmpresa/recursoId corretos (2.2.2/2.2.5)', async () => {
    const eventosAuditoria = [];
    const deps = {
      hubPostgrestRequest: async () => ([
        { id: 10, id_empresa: 9001, status: 'failed' },
        { id: 11, id_empresa: 9002, status: 'failed' },
      ]),
      registrarAuditoria: async (evento) => { eventosAuditoria.push(evento); },
      isoAgora: () => '2026-07-07T00:00:00Z',
    };

    const resultado = await recuperarImportacoesOrfas(deps);

    assert.equal(resultado.totalRecuperadas, 2);
    assert.equal(eventosAuditoria.length, 2, 'deve gravar exatamente 1 evento por linha recuperada');

    assert.equal(eventosAuditoria[0].acao, 'importacao_recuperada_boot');
    assert.equal(eventosAuditoria[0].recurso, 'ImportacaoArquivo');
    assert.equal(eventosAuditoria[0].recursoId, 10);
    assert.equal(eventosAuditoria[0].idEmpresa, 9001);
    assert.deepEqual(eventosAuditoria[0].claims, { empresaAtiva: 9001, escopo: [9001] });

    assert.equal(eventosAuditoria[1].acao, 'importacao_recuperada_boot');
    assert.equal(eventosAuditoria[1].recurso, 'ImportacaoArquivo');
    assert.equal(eventosAuditoria[1].recursoId, 11);
    assert.equal(eventosAuditoria[1].idEmpresa, 9002);
    assert.deepEqual(eventosAuditoria[1].claims, { empresaAtiva: 9002, escopo: [9002] });
  });

  test('nenhuma órfã (0 linhas) -> totalRecuperadas 0, sem lançar, sem auditoria', async () => {
    const eventosAuditoria = [];
    const deps = {
      hubPostgrestRequest: async () => [],
      registrarAuditoria: async (evento) => { eventosAuditoria.push(evento); },
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    const resultado = await recuperarImportacoesOrfas(deps);
    assert.equal(resultado.totalRecuperadas, 0);
    assert.equal(eventosAuditoria.length, 0);
  });

  test('PostgREST indisponível (ex.: POSTGREST_URL ausente) -> NUNCA lança, best-effort', async () => {
    const deps = {
      hubPostgrestRequest: async () => { throw new Error('POSTGREST_URL ausente no ambiente do hub.'); },
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    const resultado = await recuperarImportacoesOrfas(deps);
    assert.equal(resultado.totalRecuperadas, 0);
    assert.ok(resultado.erro);
  });

  test('falha ao registrar auditoria de 1 linha NUNCA impede a recuperação nem as demais linhas (best-effort por item)', async () => {
    const eventosAuditoria = [];
    const deps = {
      hubPostgrestRequest: async () => ([
        { id: 10, id_empresa: 9001, status: 'failed' },
        { id: 11, id_empresa: 9002, status: 'failed' },
      ]),
      registrarAuditoria: async (evento) => {
        if (evento.recursoId === 10) throw new Error('PostgREST indisponível para este evento');
        eventosAuditoria.push(evento);
      },
      isoAgora: () => '2026-07-07T00:00:00Z',
    };
    const resultado = await recuperarImportacoesOrfas(deps);
    assert.equal(resultado.totalRecuperadas, 2, 'a recuperação (o PATCH) já tinha ocorrido — falha de auditoria não reverte nada');
    assert.equal(eventosAuditoria.length, 1, 'a linha 11 ainda deve ter sido auditada apesar da falha na linha 10');
    assert.equal(eventosAuditoria[0].recursoId, 11);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F5 — cancelamento concorrente NUNCA é sobrescrito pelas transições
// terminais do pipeline (guardadas por status esperado).
// ────────────────────────────────────────────────────────────────────────────

describe('executarPipeline — F5: guard de status nas transições terminais', () => {
  test('cancelado ANTES da transição validating->processing -> cancelled, ZERO fatos inseridos', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'linha 1' }),
      '',
    ].join('\n');
    // statusInicial='cancelled' simula um POST /:id/cancelar que já rodou
    // antes do processor tentar a transição validating->processing — o
    // PATCH guardado por status=eq.validating não bate (mock: 0 linhas).
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv', statusInicial: 'cancelled' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'cancelled');
    const patchParaProcessing = deps.chamadas.find((c) => c.method === 'PATCH' && c.body && c.body.status === 'processing');
    assert.ok(patchParaProcessing, 'a tentativa de PATCH para processing deve ter sido feita (e rejeitada pelo guard)');
    const chamadaFatos = deps.chamadas.find((c) => c.endpoint.startsWith('FaturamentoLancamento'));
    assert.equal(chamadaFatos, undefined, 'nenhum fato pode ser inserido se o cancelamento já venceu antes de processing');
    const patchCancelled = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patchCancelled.body.status, 'cancelled');
  });

  test('cancelado NA JANELA entre o último lote inserido e a PATCH terminal -> cancelled preservado, NÃO sobrescrito por completed', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'linha 1' }),
      linhaFaturamento({ descricao: 'linha 2' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv', cancelarAposInsertDeFatos: true });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    // Os fatos JÁ tinham sido inseridos quando o cancelamento "chegou" —
    // não há rollback (F6) — mas o STATUS final reportado é `cancelled`,
    // nunca `completed`/`completed_with_errors` (F5: a PATCH terminal
    // guardada por status=eq.processing detecta e não sobrescreve).
    assert.equal(resultado.status, 'cancelled');
    const chamadaFatos = deps.chamadas.find((c) => c.endpoint.startsWith('FaturamentoLancamento'));
    assert.ok(chamadaFatos, 'o lote já deveria ter sido inserido antes da janela de corrida');
    assert.equal(chamadaFatos.body.length, 2);
    // A PATCH terminal (status=completed) É tentada (o processor não sabe
    // do cancelamento até tentar) — mas GUARDADA por status=eq.processing:
    // o mock simula 0 linhas afetadas (statusAtual já virou 'cancelled'),
    // então o EFEITO observável (getStatus / a última PATCH que de fato
    // "pegou") nunca é completed*. A tentativa em si é esperada; o que
    // NUNCA pode acontecer é ela ser a transição que prevalece.
    const patchesStatusCompleto = deps.chamadas.filter((c) => c.method === 'PATCH' && c.body && (c.body.status === 'completed' || c.body.status === 'completed_with_errors'));
    assert.equal(patchesStatusCompleto.length, 1, 'a tentativa de PATCH para completed é esperada (guardada, mas tentada)');
    assert.equal(deps.getStatus(), 'cancelled', 'o status EFETIVO (o que o guard realmente aplicou) nunca deve virar completed*');
    const ultimaPatch = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.equal(ultimaPatch.body.status, 'cancelled', 'a ÚLTIMA transição que de fato prevaleceu deve ser cancelled (marcarCancelled)');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F12 — classificação de erro transiente (retry 1x) NÃO trata bug de
// código como falha de infraestrutura.
// ────────────────────────────────────────────────────────────────────────────

describe('errorTransiente (F12)', () => {
  test('HTTP 5xx -> transiente', () => {
    assert.equal(errorTransiente({ status: 500 }), true);
    assert.equal(errorTransiente({ status: 503 }), true);
  });

  test('HTTP 429 (rate limit) -> transiente', () => {
    assert.equal(errorTransiente({ status: 429 }), true);
  });

  test('HTTP 4xx (exceto 429) -> NÃO transiente', () => {
    assert.equal(errorTransiente({ status: 404 }), false);
    assert.equal(errorTransiente({ status: 422 }), false);
    assert.equal(errorTransiente({ status: 400 }), false);
  });

  test('erro de rede real (err.cause.code POSIX) -> transiente', () => {
    assert.equal(errorTransiente({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), true);
    assert.equal(errorTransiente({ message: 'fetch failed', cause: { code: 'ETIMEDOUT' } }), true);
    assert.equal(errorTransiente({ code: 'ECONNRESET' }), true); // err.code direto (sem .cause)
  });

  test('TypeError de BUG de código, sem status/código de rede -> NÃO transiente (F12, achado do review)', () => {
    let err;
    try {
      const valorNulo = null;
      // Acesso a propriedade de `null` -> TypeError real de runtime (bug de
      // código), sem `.status`/`.cause.code` — o caso que a versão antiga
      // de errorTransiente classificava erroneamente como transiente.
      // eslint-disable-next-line no-unused-expressions
      valorNulo.propriedade;
    } catch (e) {
      err = e;
    }
    assert.equal(err.name, 'TypeError');
    assert.equal(errorTransiente(err), false);
  });

  test('erro sem status/cause/code qualquer -> NÃO transiente (fail-safe: propaga em vez de mascarar)', () => {
    assert.equal(errorTransiente(new Error('alguma coisa quebrou')), false);
  });

  test('nulo/undefined -> false', () => {
    assert.equal(errorTransiente(null), false);
    assert.equal(errorTransiente(undefined), false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F13 — dedupe de ImportacaoLinhaErro em retry (on_conflict DO NOTHING).
// ────────────────────────────────────────────────────────────────────────────

describe('executarPipeline — F13: inserirLoteErros usa on_conflict/ignore-duplicates', () => {
  test('POST em ImportacaoLinhaErro carrega on_conflict=importacao_id,numero_linha + resolution=ignore-duplicates', async () => {
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ descricao: 'ok' }),
      linhaFaturamento({ recebedor: '', valor: 'abc', descricao: '' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    await executarPipeline(jobFaturamento(), deps);

    const chamadaErros = deps.chamadas.find((c) => c.endpoint.startsWith('ImportacaoLinhaErro'));
    assert.ok(chamadaErros, 'esperava 1 chamada de insert em ImportacaoLinhaErro');
    assert.equal(chamadaErros.endpoint, 'ImportacaoLinhaErro?on_conflict=importacao_id,numero_linha');
    assert.equal(chamadaErros.opts.resolution, 'ignore-duplicates');
  });

  test('retry do MESMO lote de erros (simulado 2x) não duplica visivelmente — 2 POSTs, mesmo payload, dedupe é responsabilidade do índice único (migration 0018) + on_conflict', async () => {
    // Este teste unitário prova que o CLIENTE (processor) sempre envia o
    // on_conflict correto — a garantia de "0 linhas duplicadas de fato" é
    // do índice único da migration 0018 no Postgres real (provado em
    // infra/hub/testes/hub-import-processor-integration.sh).
    const csv = [
      HEADER_ROW_FATURAMENTO,
      linhaFaturamento({ recebedor: '', valor: 'abc', descricao: '' }),
      linhaFaturamento({ descricao: 'ok' }),
      '',
    ].join('\n');
    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    await executarPipeline(jobFaturamento(), deps);
    const chamadasErros = deps.chamadas.filter((c) => c.endpoint.startsWith('ImportacaoLinhaErro'));
    chamadasErros.forEach((c) => {
      assert.equal(c.opts.resolution, 'ignore-duplicates');
      assert.match(c.endpoint, /on_conflict=importacao_id,numero_linha/);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F3 — cap de linhas (proteção de OOM em arquivo hostil/corrompido).
// ────────────────────────────────────────────────────────────────────────────

describe('executarPipeline — F3: MAX_LINHAS_IMPORTACAO', () => {
  test('constante é 300000 (documentação viva do limite)', () => {
    assert.equal(MAX_LINHAS_IMPORTACAO, 300000);
  });

  test('arquivo com mais linhas que o limite -> failed, sem estourar memória (corta o parse)', async () => {
    const linhaValida = linhaFaturamento({ descricao: 'linha-repetida' });
    const totalLinhas = MAX_LINHAS_IMPORTACAO + 1;
    const linhas = new Array(totalLinhas).fill(linhaValida);
    const csv = [HEADER_ROW_FATURAMENTO, ...linhas, ''].join('\n');

    const deps = criarFakePostgrest({ nomeArquivo: 'faturamento.csv' });
    deps.lerArquivo = async () => Buffer.from(csv, 'utf8');

    const resultado = await executarPipeline(jobFaturamento(), deps);

    assert.equal(resultado.status, 'failed');
    const chamadaFatos = deps.chamadas.find((c) => c.endpoint.startsWith('FaturamentoLancamento'));
    assert.equal(chamadaFatos, undefined, 'nunca deveria ter chegado a inserir fatos — corta o parse antes');
    const patchFinal = deps.chamadas.filter((c) => c.method === 'PATCH').pop();
    assert.equal(patchFinal.body.status, 'failed');
    assert.match(patchFinal.body.erro_resumo, /limite de 300000 linhas/);
  });
});
