/**
 * Testes unitários — lib/hub-motorista-vinculo-automatico.js (hub-motorista-360,
 * tasks.md 3.1.6/3.1.7/3.1.8). Rodam com:
 *   node --test tests/hub-motorista-vinculo-automatico.test.js
 *
 * `escolherCandidatoConfiavel` é PURA — testada sem I/O. `vincularAutomaticamente`
 * é a orquestração completa (I/O via `hubPostgrestRequest`/`registrarAuditoria`) —
 * testada aqui via os `deps` injetáveis (2º parâmetro), com um mock de PostgREST
 * em memória (mesma técnica de tests/motorista-integration.test.js), NUNCA contra
 * PostgREST/DB real (esse caminho fica para a integração Docker do hub, mesmo
 * padrão do resto do módulo — tests/hub-motoristas-similaridade.test.js).
 *
 * Ref: docs/specs/hub-motorista-360/contracts/vinculo-automatico.md,
 * spec.md FR-009..FR-011.
 */

'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMIAR_VINCULO_AUTOMATICO,
  escolherCandidatoConfiavel,
  vincularAutomaticamente,
} = require('../lib/hub-motorista-vinculo-automatico');

// scripts/backfill-vinculo-motorista.js só executa I/O real quando rodado
// diretamente (`require.main === module`) — importar aqui só traz a função
// pura/injetável `processarBackfill` (ver cabeçalho do script).
const { processarBackfill } = require('../scripts/backfill-vinculo-motorista');

// ────────────────────────────────────────────────────────────────────────────
// escolherCandidatoConfiavel — regra de decisão PURA (FR-009)
// ────────────────────────────────────────────────────────────────────────────
describe('escolherCandidatoConfiavel (regra de decisão, FR-009)', () => {
  test('LIMIAR_VINCULO_AUTOMATICO = 0.9 (contracts/vinculo-automatico.md — mais estrito que o piso 0.3 de sugestão)', () => {
    assert.equal(LIMIAR_VINCULO_AUTOMATICO, 0.9);
  });

  test('3.1.6 — exatamente 1 candidato >= 0.9 → vincula (retorna o candidato)', () => {
    const candidatos = [{ entregadorId: 10, nome: 'Fulano', idEmpresa: 6, similaridade: 0.95 }];
    const escolhido = escolherCandidatoConfiavel(candidatos);
    assert.deepEqual(escolhido, candidatos[0]);
  });

  test('3.1.7 — 2+ candidatos >= 0.9 → NÃO vincula (retorna null, ambíguo)', () => {
    const candidatos = [
      { entregadorId: 10, nome: 'Fulano da Silva', idEmpresa: 6, similaridade: 0.95 },
      { entregadorId: 11, nome: 'Fulano da Silva Jr', idEmpresa: 6, similaridade: 0.91 },
    ];
    assert.equal(escolherCandidatoConfiavel(candidatos), null);
  });

  test('3.1.7 — nenhum candidato acima do limiar → NÃO vincula (retorna null)', () => {
    const candidatos = [{ entregadorId: 10, nome: 'Beltrano', idEmpresa: 6, similaridade: 0.5 }];
    assert.equal(escolherCandidatoConfiavel(candidatos), null);
  });

  test('lista vazia → null (sem candidato nenhum)', () => {
    assert.equal(escolherCandidatoConfiavel([]), null);
  });

  test('exatamente no limiar (0.9) conta como confiável (>=, não >)', () => {
    const candidatos = [{ entregadorId: 10, nome: 'Fulano', idEmpresa: 6, similaridade: 0.9 }];
    assert.deepEqual(escolherCandidatoConfiavel(candidatos), candidatos[0]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// vincularAutomaticamente — orquestração completa via mock em memória
// ────────────────────────────────────────────────────────────────────────────
describe('vincularAutomaticamente (orquestração, via deps injetados)', () => {
  let DB;
  let auditoriasRegistradas;
  let chamadasRpc;

  beforeEach(() => {
    DB = {
      ContaMotorista: [],
      EmpresaGrupoMovee: [{ id_empresa: 6 }],
      Entregador: [],
    };
    auditoriasRegistradas = [];
    chamadasRpc = [];
  });

  function fakeRegistrarAuditoria(evento) {
    auditoriasRegistradas.push(evento);
    return Promise.resolve({ ok: true });
  }

  /** Mock mínimo de hubPostgrestRequest cobrindo só o que este módulo chama. */
  function fakeHubPostgrestRequest(path, method = 'GET', body = null) {
    if (path.startsWith('ContaMotorista')) {
      if (method === 'GET') {
        const params = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
        const cnpj = decodeURIComponent(params.cnpj_prestador.replace(/^eq\./, ''));
        return Promise.resolve(DB.ContaMotorista.filter((c) => c.cnpj_prestador === cnpj));
      }
      if (method === 'POST') {
        const nova = { id: DB.ContaMotorista.length + 1, ...body };
        DB.ContaMotorista.push(nova);
        return Promise.resolve([nova]);
      }
    }
    if (path.startsWith('EmpresaGrupoMovee')) {
      return Promise.resolve(DB.EmpresaGrupoMovee);
    }
    if (path.startsWith('Entregador')) {
      if (method === 'GET') {
        const params = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
        let rows = [...DB.Entregador];
        if (params.motorista_id) {
          const val = params.motorista_id.replace(/^eq\./, '');
          rows = rows.filter((r) => String(r.motorista_id) === val);
        }
        return Promise.resolve(rows);
      }
      if (method === 'PATCH') {
        const params = Object.fromEntries(new URLSearchParams(path.split('?')[1]));
        const idAlvo = params.id.replace(/^eq\./, '');
        for (const row of DB.Entregador) {
          if (String(row.id) === idAlvo) Object.assign(row, body);
        }
        return Promise.resolve(null);
      }
    }
    if (path === 'rpc/hub_motoristas_candidatos_por_conta') {
      chamadasRpc.push(body);
      return Promise.resolve(DB._candidatosRpc || []);
    }
    throw new Error(`fakeHubPostgrestRequest: caminho não coberto pelo mock: ${method} ${path}`);
  }

  const deps = () => ({
    hubPostgrestRequest: fakeHubPostgrestRequest,
    registrarAuditoria: fakeRegistrarAuditoria,
  });

  test('3.1.1 — cria ContaMotorista quando não existe (find-or-create)', async () => {
    DB._candidatosRpc = [];
    await vincularAutomaticamente({ cnpjPrestador: '11222333000199', nome: 'Motorista Novo' }, deps());
    assert.equal(DB.ContaMotorista.length, 1);
    assert.equal(DB.ContaMotorista[0].cnpj_prestador, '11222333000199');
    assert.equal(DB.ContaMotorista[0].ativo, true);
  });

  test('3.1.1 — reusa ContaMotorista existente (não cria segunda) e não sobrescreve nome', async () => {
    DB.ContaMotorista.push({ id: 1, cnpj_prestador: '11222333000199', nome: 'Nome Original', ativo: true });
    DB._candidatosRpc = [];
    await vincularAutomaticamente({ cnpjPrestador: '11222333000199', nome: 'Nome Novo Informado' }, deps());
    assert.equal(DB.ContaMotorista.length, 1);
    assert.equal(DB.ContaMotorista[0].nome, 'Nome Original');
  });

  test('3.1.6 — happy path: exatamente 1 candidato >= 0.9 vincula automaticamente, sem ação do gestor', async () => {
    DB.Entregador.push({ id: 100, nome: 'Fulano da Silva', id_empresa: 6, motorista_id: null });
    DB._candidatosRpc = [
      { entregador_id: 100, nome: 'Fulano da Silva', id_empresa: 6, similaridade: 0.95 },
    ];

    const resultado = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano da Silva' }, deps()
    );

    assert.equal(resultado.status, 'vinculado');
    assert.equal(resultado.entregadorId, 100);
    assert.equal(DB.Entregador[0].motorista_id, DB.ContaMotorista[0].id);
  });

  test('3.1.6 — vínculo automático audita motorista.vinculado_automaticamente SEM usuarioId', async () => {
    DB.Entregador.push({ id: 100, nome: 'Fulano', id_empresa: 6, motorista_id: null });
    DB._candidatosRpc = [{ entregador_id: 100, nome: 'Fulano', id_empresa: 6, similaridade: 0.99 }];

    await vincularAutomaticamente({ cnpjPrestador: '11222333000199', nome: 'Fulano' }, deps());

    assert.equal(auditoriasRegistradas.length, 1);
    const evento = auditoriasRegistradas[0];
    assert.equal(evento.acao, 'motorista.vinculado_automaticamente');
    assert.equal(evento.recurso, 'Entregador');
    assert.equal(evento.recursoId, 100);
    assert.equal('usuarioId' in evento, false);
    assert.equal(evento.detalhes.similaridade, 0.99);
  });

  test('3.1.7 — Acceptance Scenario 3: 2+ candidatos >= 0.9 NÃO vincula (fica ambíguo, sem PATCH nem auditoria)', async () => {
    DB.Entregador.push(
      { id: 100, nome: 'Fulano da Silva', id_empresa: 6, motorista_id: null },
      { id: 101, nome: 'Fulano da Silva Jr', id_empresa: 6, motorista_id: null }
    );
    DB._candidatosRpc = [
      { entregador_id: 100, nome: 'Fulano da Silva', id_empresa: 6, similaridade: 0.95 },
      { entregador_id: 101, nome: 'Fulano da Silva Jr', id_empresa: 6, similaridade: 0.92 },
    ];

    const resultado = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano da Silva' }, deps()
    );

    assert.equal(resultado.status, 'ambiguo');
    assert.equal(DB.Entregador[0].motorista_id, null);
    assert.equal(DB.Entregador[1].motorista_id, null);
    assert.equal(auditoriasRegistradas.length, 0);
  });

  test('3.1.7 — nenhum candidato >= 0.9 → sem_candidato, não vincula', async () => {
    DB.Entregador.push({ id: 100, nome: 'Zebra Distante', id_empresa: 6, motorista_id: null });
    DB._candidatosRpc = [{ entregador_id: 100, nome: 'Zebra Distante', id_empresa: 6, similaridade: 0.4 }];

    const resultado = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano da Silva' }, deps()
    );

    assert.equal(resultado.status, 'sem_candidato');
    assert.equal(DB.Entregador[0].motorista_id, null);
  });

  test('3.1.3/3.1.8 — idempotência: já vinculado a esta conta → não chama a RPC, não duplica, não re-audita', async () => {
    DB.ContaMotorista.push({ id: 1, cnpj_prestador: '11222333000199', nome: 'Fulano', ativo: true });
    DB.Entregador.push({ id: 100, nome: 'Fulano', id_empresa: 6, motorista_id: 1 });
    DB._candidatosRpc = [{ entregador_id: 999, nome: 'Outro', id_empresa: 6, similaridade: 0.99 }];

    const resultado = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano' }, deps()
    );

    assert.equal(resultado.status, 'ja_vinculado');
    assert.equal(resultado.entregadorId, 100);
    assert.equal(chamadasRpc.length, 0, 'RPC de similaridade não deveria ter sido chamada — idempotência curta-circuita antes');
    assert.equal(auditoriasRegistradas.length, 0);
  });

  test('3.1.8 — cadastro repetido (2ª chamada) não cria segundo vínculo nem sobrescreve o existente', async () => {
    DB.Entregador.push({ id: 100, nome: 'Fulano da Silva', id_empresa: 6, motorista_id: null });
    DB._candidatosRpc = [{ entregador_id: 100, nome: 'Fulano da Silva', id_empresa: 6, similaridade: 0.95 }];

    const primeira = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano da Silva' }, deps()
    );
    assert.equal(primeira.status, 'vinculado');
    assert.equal(auditoriasRegistradas.length, 1);

    // 2ª chamada (ex.: motorista tentou se cadastrar de novo) — mesmo se a
    // RPC ainda devolvesse candidatos, a checagem de idempotência já
    // encontra o vínculo e para antes.
    const segunda = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano da Silva' }, deps()
    );
    assert.equal(segunda.status, 'ja_vinculado');
    assert.equal(DB.ContaMotorista.length, 1, 'não deveria criar uma segunda ContaMotorista');
    assert.equal(auditoriasRegistradas.length, 1, 'não deveria auditar de novo');
  });

  test('grupo Movee vazio (allowlist não seedada) → sem_grupo_elegivel, nunca lança', async () => {
    DB.EmpresaGrupoMovee = [];
    DB._candidatosRpc = [];

    const resultado = await vincularAutomaticamente(
      { cnpjPrestador: '11222333000199', nome: 'Fulano' }, deps()
    );

    assert.equal(resultado.status, 'sem_grupo_elegivel');
    assert.equal(chamadasRpc.length, 0);
  });

  test('falha de I/O (ex.: PostgREST fora do ar) REJEITA a Promise — caller MUST envolver em try/catch (contrato)', async () => {
    const depsComFalha = {
      hubPostgrestRequest: () => { throw new Error('PostgREST indisponível (simulado)'); },
      registrarAuditoria: fakeRegistrarAuditoria,
    };
    await assert.rejects(
      () => vincularAutomaticamente({ cnpjPrestador: '11222333000199', nome: 'Fulano' }, depsComFalha),
      /PostgREST indisponível/
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// processarBackfill (scripts/backfill-vinculo-motorista.js) — laço de
// agregação do backfill retroativo (FR-012, tasks.md 3.2.2/3.2.4/3.2.5)
// ────────────────────────────────────────────────────────────────────────────
describe('processarBackfill (script de backfill — FR-012)', () => {
  test('3.2.2 — relatório final: totalProcessados, totalVinculados, totalAmbiguos', async () => {
    const motoristas = [
      { cnpj_prestador: '11111111000101', nome: 'Motorista A' }, // vincula
      { cnpj_prestador: '22222222000102', nome: 'Motorista B' }, // ambíguo
      { cnpj_prestador: '33333333000103', nome: 'Motorista C' }, // já vinculado antes
    ];
    const vincularFake = async ({ cnpjPrestador }) => {
      if (cnpjPrestador === '11111111000101') return { status: 'vinculado', contaMotoristaId: 1, entregadorId: 10, similaridade: 0.95 };
      if (cnpjPrestador === '22222222000102') return { status: 'ambiguo', contaMotoristaId: 2 };
      return { status: 'ja_vinculado', contaMotoristaId: 3, entregadorId: 30 };
    };

    const relatorio = await processarBackfill(motoristas, vincularFake);

    assert.deepEqual(relatorio, { totalProcessados: 3, totalVinculados: 1, totalAmbiguos: 1 });
  });

  // tasks.md 3.2.5 — "motorista com credencial ativa e candidato único >= 0.9
  // aparece em totalVinculados (caso relatado do briefing)". O CNPJ/nome real
  // do caso do briefing NUNCA entra em artefato versionado (regra dura desta
  // onda — já houve vazamento) — fixture 100% sintética, o que importa é o
  // FORMATO da asserção (aparece em totalVinculados), não o dado real.
  test('3.2.5 — motorista com credencial ativa e candidato único >= 0.9 (fixture sintética) aparece em totalVinculados', async () => {
    const motoristas = [{ cnpj_prestador: '99988877000166', nome: 'Fixture Sintética' }];
    const vincularFake = async () => ({ status: 'vinculado', contaMotoristaId: 42, entregadorId: 420, similaridade: 0.93 });

    const relatorio = await processarBackfill(motoristas, vincularFake);

    assert.equal(relatorio.totalProcessados, 1);
    assert.equal(relatorio.totalVinculados, 1);
    assert.equal(relatorio.totalAmbiguos, 0);
  });

  test('3.2.4 — idempotência: reexecutar é no-op (2ª rodada não soma a totalVinculados de novo)', async () => {
    // Simula o estado real: na 1ª rodada a conta ainda não estava vinculada
    // (vincula); na 2ª rodada (reexecução do script) a MESMA função real já
    // encontraria o vínculo existente e retornaria 'ja_vinculado' — aqui
    // simulado por um fake com estado, sem precisar de PostgREST real.
    const jaProcessados = new Set();
    const vincularComEstado = async ({ cnpjPrestador }) => {
      if (jaProcessados.has(cnpjPrestador)) {
        return { status: 'ja_vinculado', contaMotoristaId: 1, entregadorId: 10 };
      }
      jaProcessados.add(cnpjPrestador);
      return { status: 'vinculado', contaMotoristaId: 1, entregadorId: 10, similaridade: 0.95 };
    };
    const motoristas = [{ cnpj_prestador: '11111111000101', nome: 'Motorista A' }];

    const primeiraRodada = await processarBackfill(motoristas, vincularComEstado);
    assert.deepEqual(primeiraRodada, { totalProcessados: 1, totalVinculados: 1, totalAmbiguos: 0 });

    const segundaRodada = await processarBackfill(motoristas, vincularComEstado);
    assert.deepEqual(segundaRodada, { totalProcessados: 1, totalVinculados: 0, totalAmbiguos: 0 });
  });

  test('falha ao processar 1 motorista (ex.: RLS/rede pontual) não derruba o backfill — conta em totalAmbiguos, resto continua', async () => {
    const motoristas = [
      { cnpj_prestador: '11111111000101', nome: 'Motorista A' },
      { cnpj_prestador: '22222222000102', nome: 'Motorista B' },
    ];
    const vincularComFalhaPontual = async ({ cnpjPrestador }) => {
      if (cnpjPrestador === '11111111000101') throw new Error('falha pontual simulada');
      return { status: 'vinculado', contaMotoristaId: 2, entregadorId: 20, similaridade: 0.9 };
    };

    const relatorio = await processarBackfill(motoristas, vincularComFalhaPontual);

    assert.deepEqual(relatorio, { totalProcessados: 2, totalVinculados: 1, totalAmbiguos: 1 });
  });

  test('cnpj_prestador vazio/ausente é contado em totalProcessados mas pulado (nunca lança)', async () => {
    const motoristas = [{ cnpj_prestador: '', nome: 'Sem CNPJ válido' }];
    const relatorio = await processarBackfill(motoristas, async () => {
      throw new Error('não deveria ser chamado — cnpj vazio deve pular antes');
    });
    assert.deepEqual(relatorio, { totalProcessados: 1, totalVinculados: 0, totalAmbiguos: 0 });
  });
});
