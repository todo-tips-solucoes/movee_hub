/**
 * Testes unitários — hub-fundacoes RBAC/perfil (FASE 4, tasks 4.1.5/4.2.5)
 * Rodam com: node --test tests/hub-rbac-unit.test.js
 *
 * Mesma convenção de tests/hub-auth-unit.test.js: mantemos CÓPIAS LOCAIS da
 * lógica pura extraída de lib/hub-rbac-cache.js e
 * middleware/hub-require-permission.js (em vez de `require` dos módulos
 * reais, que dependem de jsonwebtoken/express — indisponíveis fora do
 * container Dockerfile.hub). As cópias abaixo não têm efeito colateral de
 * rede: o "loader" (equivalente a `carregarPermissoesDoBanco`, que na
 * implementação real chama hubPostgrestRequest) é injetado como função,
 * permitindo simular sucesso/erro/latência sem PostgREST real.
 *
 * Cobre:
 *   - montarUniaoDePermissoes: união de grants sem herança/negação (Decision 5,
 *     FR-009) — papel global vs papel de entidade contribuem igualmente.
 *   - cache TTL 60s + invalidação ativa (Decision 7, SC-004).
 *   - fail-closed: erro do loader -> Set vazio, NUNCA cacheado (Decision 13).
 *   - avaliarPermissao: decisão 401/403/ok do middleware (fail-closed
 *     explícito no caminho de erro).
 *   - filtrarModulosPorPermissao: GET /me só expõe módulo cruzado com alguma
 *     permissão efetiva (contracts/rbac-me.md §GET /me).
 *
 * Integração real (PostgREST + Auditoria + troca de entidade) fica em
 * infra/hub/testes/hub-rbac-integration.sh (task 4.2.5/4.3.4 — integração).
 *
 * Ref: contracts/rbac-me.md, research.md Decisions 5/7/13, tasks.md 4.1.5/4.2.5.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: montarUniaoDePermissoes (espelho da 2ª metade de
// carregarPermissoesDoBanco em lib/hub-rbac-cache.js)
// ──────────────────────────────────────────────────────────────────────────────

function montarUniaoDePermissoes(linhasPapelPermissao) {
  const codigos = new Set();
  for (const linha of linhasPapelPermissao || []) {
    if (linha && linha.permissao && linha.permissao.codigo) {
      codigos.add(linha.permissao.codigo);
    }
  }
  return codigos;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: permissões efetivas POR ENTIDADE (correção pós-review PR #55,
// achado #1). Espelha carregarPermissoesDoBanco(usuarioId, empresaId): restringe
// os vínculos à entidade ANTES de unir as permissões. `vinculos` = lista de
// { empresa_id, permissoes: [codigo,...] } (o join Papel->PapelPermissao já
// resolvido, como o loader real faz em 2 queries).
// ──────────────────────────────────────────────────────────────────────────────

function unirPermissoes(vinculos, empresaId /* opcional: restringe */) {
  const codigos = new Set();
  for (const v of vinculos || []) {
    if (empresaId !== undefined && empresaId !== null && v.empresa_id !== empresaId) continue;
    for (const c of v.permissoes || []) codigos.add(c);
  }
  return codigos;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: invalidação coerente flat + por-entidade (espelho de
// invalidarUsuario em lib/hub-rbac-cache.js: apaga `id` e todo `id:*`).
// ──────────────────────────────────────────────────────────────────────────────

function invalidarCoerente(cache, usuarioId) {
  const flat = String(usuarioId);
  cache.delete(flat);
  const prefixo = `${flat}:`;
  for (const chave of [...cache.keys()]) {
    if (chave.startsWith(prefixo)) cache.delete(chave);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: cache TTL + invalidação + fail-closed não-cacheado (espelho de
// lib/hub-rbac-cache.js, com loader e relógio injetáveis para teste)
// ──────────────────────────────────────────────────────────────────────────────

function criarCacheRbac(ttlMs, loader) {
  const cache = new Map();

  async function obterPermissoesEfetivas(usuarioId, agora = Date.now()) {
    const chave = String(usuarioId);
    const entrada = cache.get(chave);
    if (entrada && entrada.expiraEm > agora) {
      return entrada.permissoes;
    }

    let permissoes;
    try {
      permissoes = await loader(usuarioId);
    } catch (_e) {
      // Decision 13 — fail-closed: erro NUNCA vira permissão nem é cacheado.
      return new Set();
    }

    cache.set(chave, { permissoes, expiraEm: agora + ttlMs });
    return permissoes;
  }

  function invalidarUsuario(usuarioId) {
    cache.delete(String(usuarioId));
  }

  return { obterPermissoesEfetivas, invalidarUsuario, _cache: cache };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: avaliarPermissao (espelho da decisão de
// middleware/hub-require-permission.js, sem depender de jwt/express)
// ──────────────────────────────────────────────────────────────────────────────

function avaliarPermissao(usuarioId, permissoes, codigoPermissao) {
  if (!usuarioId) return { status: 401, erro: 'NAO_AUTENTICADO' };
  if (!permissoes || !permissoes.has(codigoPermissao)) {
    return { status: 403, erro: 'PERMISSAO_NEGADA' };
  }
  return { status: 200, erro: null };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cópia local: filtrarModulosPorPermissao (espelho do bloco de GET /me em
// routes/hub-me.js que cruza ModuloEntidade.ativo com as permissões efetivas)
// ──────────────────────────────────────────────────────────────────────────────

function filtrarModulosPorPermissao(modulosAtivosDaEntidade, permissoesEfetivas) {
  const prefixosComPermissao = new Set([...permissoesEfetivas].map((codigo) => codigo.split('.')[0]));
  return modulosAtivosDaEntidade
    .filter((m) => m && m.ativo && prefixosComPermissao.has(m.codigo))
    .sort((a, b) => a.ordem - b.ordem);
}

// ──────────────────────────────────────────────────────────────────────────────
// montarUniaoDePermissoes — Decision 5 (união, sem herança/negação)
// ──────────────────────────────────────────────────────────────────────────────

describe('montarUniaoDePermissoes', () => {
  test('sem grants -> Set vazio', () => {
    const s = montarUniaoDePermissoes([]);
    assert.equal(s.size, 0);
  });

  test('un único papel -> permissões desse papel', () => {
    const s = montarUniaoDePermissoes([
      { permissao: { codigo: 'motoristas.consultar' } },
      { permissao: { codigo: 'motoristas.listar' } },
    ]);
    assert.deepEqual([...s].sort(), ['motoristas.consultar', 'motoristas.listar']);
  });

  test('papel global + papel de entidade -> UNIÃO (sem herança/negação, FR-009)', () => {
    // Simula 2 UsuarioEntidade ativos: um papel global (ex.: admin_plataforma
    // restrito a uma permissão neste teste) + um papel de entidade (ex.:
    // operador) — ambos contribuem igualmente para o Set final, sem qualquer
    // um "vencer" ou anular o outro.
    const linhasPapelGlobal = [{ permissao: { codigo: 'admin.gerenciar' } }];
    const linhasPapelEntidade = [
      { permissao: { codigo: 'motoristas.consultar' } },
      { permissao: { codigo: 'envio_massa.enviar' } },
    ];
    const uniao = montarUniaoDePermissoes([...linhasPapelGlobal, ...linhasPapelEntidade]);
    assert.deepEqual(
      [...uniao].sort(),
      ['admin.gerenciar', 'envio_massa.enviar', 'motoristas.consultar'].sort()
    );
  });

  test('permissão repetida em papéis diferentes -> deduplicada (Set)', () => {
    const s = montarUniaoDePermissoes([
      { permissao: { codigo: 'dashboard.consultar' } },
      { permissao: { codigo: 'dashboard.consultar' } },
    ]);
    assert.equal(s.size, 1);
  });

  test('linhas malformadas (sem permissao/codigo) são ignoradas, não quebram', () => {
    const s = montarUniaoDePermissoes([null, {}, { permissao: null }, { permissao: {} }]);
    assert.equal(s.size, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// cache TTL + invalidação (Decision 7, SC-004)
// ──────────────────────────────────────────────────────────────────────────────

describe('permissões por entidade (#1 — gate de auditoria contra entidade ativa)', () => {
  // Usuário admin na empresa B (tem auditoria.consultar) + leitura na empresa A
  // (NÃO tem auditoria.consultar). Cenário exato do achado de segurança.
  const A = 910003;
  const B = 910002;
  const vinculos = [
    { empresa_id: A, permissoes: ['dashboard.consultar', 'motoristas.consultar'] }, // leitura em A
    { empresa_id: B, permissoes: ['dashboard.consultar', 'auditoria.consultar', 'usuarios.gerenciar'] }, // admin em B
  ];

  test('união FLAT enxerga auditoria.consultar (vem de B) — por isso NÃO serve de gate por-tenant', () => {
    const flat = unirPermissoes(vinculos);
    assert.equal(flat.has('auditoria.consultar'), true);
  });

  test('POR ENTIDADE A: auditoria.consultar AUSENTE (só leitura em A) -> gate nega (403)', () => {
    const permsA = unirPermissoes(vinculos, A);
    assert.equal(permsA.has('auditoria.consultar'), false);
  });

  test('POR ENTIDADE B: auditoria.consultar PRESENTE -> gate permite', () => {
    const permsB = unirPermissoes(vinculos, B);
    assert.equal(permsB.has('auditoria.consultar'), true);
  });

  test('entidade sem vínculo -> Set vazio (nega por construção)', () => {
    const permsX = unirPermissoes(vinculos, 999999);
    assert.equal(permsX.size, 0);
  });
});

describe('invalidação coerente flat + por-entidade (#1)', () => {
  test('invalidarUsuario apaga a entrada flat E todas as `id:*` do usuário, sem tocar outros', () => {
    const cache = new Map();
    cache.set('42', { permissoes: new Set(), expiraEm: 9e15 });
    cache.set('42:910002', { permissoes: new Set(), expiraEm: 9e15 });
    cache.set('42:910003', { permissoes: new Set(), expiraEm: 9e15 });
    cache.set('7', { permissoes: new Set(), expiraEm: 9e15 });
    cache.set('7:910002', { permissoes: new Set(), expiraEm: 9e15 });

    invalidarCoerente(cache, '42');

    assert.equal(cache.has('42'), false);
    assert.equal(cache.has('42:910002'), false);
    assert.equal(cache.has('42:910003'), false);
    assert.equal(cache.has('7'), true, 'outro usuário intacto');
    assert.equal(cache.has('7:910002'), true, 'entrada por-entidade de outro usuário intacta');
  });
});

describe('cache RBAC — TTL + invalidação', () => {
  test('cache-miss chama o loader; hit subsequente dentro do TTL não chama de novo', async () => {
    let chamadas = 0;
    const loader = async () => {
      chamadas += 1;
      return new Set(['motoristas.consultar']);
    };
    const cache = criarCacheRbac(60_000, loader);

    const t0 = 1_000_000;
    const p1 = await cache.obterPermissoesEfetivas('42', t0);
    const p2 = await cache.obterPermissoesEfetivas('42', t0 + 30_000); // dentro do TTL

    assert.equal(chamadas, 1, 'loader deve ser chamado só na 1ª vez (cache hit na 2ª)');
    assert.equal(p1, p2, 'mesma referência de Set — veio do cache');
  });

  test('expiração natural do TTL (60s): após expirar, recarrega do loader', async () => {
    let chamadas = 0;
    const loader = async () => {
      chamadas += 1;
      return new Set([`versao-${chamadas}`]);
    };
    const cache = criarCacheRbac(60_000, loader);

    const t0 = 1_000_000;
    await cache.obterPermissoesEfetivas('7', t0);
    await cache.obterPermissoesEfetivas('7', t0 + 60_001); // 1ms após expirar (SC-004 pior caso)

    assert.equal(chamadas, 2, 'após TTL expirado, deve recarregar');
  });

  test('invalidarUsuario força reload mesmo dentro do TTL (SC-004: reflete em <=60s)', async () => {
    let chamadas = 0;
    const loader = async () => {
      chamadas += 1;
      return new Set([`versao-${chamadas}`]);
    };
    const cache = criarCacheRbac(60_000, loader);

    const t0 = 1_000_000;
    await cache.obterPermissoesEfetivas('99', t0);
    cache.invalidarUsuario('99'); // ex.: admin mudou o papel/vínculo 1ms depois
    const p2 = await cache.obterPermissoesEfetivas('99', t0 + 1);

    assert.equal(chamadas, 2, 'invalidação ativa deve forçar reload imediato, sem esperar o TTL');
    assert.deepEqual([...p2], ['versao-2']);
  });

  test('invalidação é isolada por usuário (não afeta cache de outro usuarioId)', async () => {
    const chamadasPorUsuario = {};
    const loader = async (usuarioId) => {
      chamadasPorUsuario[usuarioId] = (chamadasPorUsuario[usuarioId] || 0) + 1;
      return new Set([`u${usuarioId}-v${chamadasPorUsuario[usuarioId]}`]);
    };
    const cache = criarCacheRbac(60_000, loader);
    const t0 = 1_000_000;

    await cache.obterPermissoesEfetivas('1', t0);
    await cache.obterPermissoesEfetivas('2', t0);
    cache.invalidarUsuario('1');
    await cache.obterPermissoesEfetivas('1', t0 + 1);
    await cache.obterPermissoesEfetivas('2', t0 + 1); // ainda dentro do TTL, não invalidado

    assert.equal(chamadasPorUsuario['1'], 2, 'usuario 1 invalidado -> recarregou');
    assert.equal(chamadasPorUsuario['2'], 1, 'usuario 2 intacto -> não recarregou');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// fail-closed: erro do loader nunca vira permissão, e nunca é cacheado
// (Decision 13 — achado owasp-security)
// ──────────────────────────────────────────────────────────────────────────────

describe('cache RBAC — fail-closed (Decision 13)', () => {
  test('erro do loader -> Set vazio (nega tudo), não lança', async () => {
    const loader = async () => {
      throw new Error('PostgREST indisponível (simulado)');
    };
    const cache = criarCacheRbac(60_000, loader);

    const permissoes = await cache.obterPermissoesEfetivas('1', 1_000_000);
    assert.equal(permissoes.size, 0);
  });

  test('resultado de erro NÃO é cacheado: falha transitória se recupera na próxima chamada', async () => {
    let tentativa = 0;
    const loader = async () => {
      tentativa += 1;
      if (tentativa === 1) throw new Error('falha transitória simulada');
      return new Set(['motoristas.consultar']);
    };
    const cache = criarCacheRbac(60_000, loader);
    const t0 = 1_000_000;

    const p1 = await cache.obterPermissoesEfetivas('1', t0);
    assert.equal(p1.size, 0, '1ª chamada falha -> vazio');

    // Mesmo dentro da janela de TTL que uma entrada de SUCESSO teria, a
    // próxima chamada DEVE tentar de novo, porque a falha não foi cacheada.
    const p2 = await cache.obterPermissoesEfetivas('1', t0 + 1);
    assert.equal(tentativa, 2, 'deve ter tentado novamente (não usou cache de erro)');
    assert.equal(p2.has('motoristas.consultar'), true, '2ª tentativa teve sucesso e reflete de imediato');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// avaliarPermissao — decisão do middleware (401/403/ok), fail-closed explícito
// ──────────────────────────────────────────────────────────────────────────────

describe('avaliarPermissao (requirePermission)', () => {
  test('sem usuarioId (sem accessToken válido) -> 401 NAO_AUTENTICADO', () => {
    const r = avaliarPermissao(null, new Set(['qualquer.coisa']), 'motoristas.consultar');
    assert.equal(r.status, 401);
    assert.equal(r.erro, 'NAO_AUTENTICADO');
  });

  test('autenticado mas sem o grant específico -> 403 PERMISSAO_NEGADA', () => {
    const r = avaliarPermissao('1', new Set(['motoristas.consultar']), 'motoristas.excluir');
    assert.equal(r.status, 403);
    assert.equal(r.erro, 'PERMISSAO_NEGADA');
  });

  test('autenticado com o grant (via papel global OU de entidade) -> ok', () => {
    const r = avaliarPermissao('1', new Set(['motoristas.consultar', 'admin.gerenciar']), 'motoristas.consultar');
    assert.equal(r.status, 200);
    assert.equal(r.erro, null);
  });

  test('Set de permissões vazio (fail-closed do cache em erro) -> sempre 403, nunca ok', () => {
    const r = avaliarPermissao('1', new Set(), 'dashboard.consultar');
    assert.equal(r.status, 403);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// filtrarModulosPorPermissao — GET /me cruza ModuloEntidade com permissões
// ──────────────────────────────────────────────────────────────────────────────

describe('filtrarModulosPorPermissao (GET /me)', () => {
  const modulos = [
    { codigo: 'dashboard', nome: 'Painel Geral', ordem: 10, ativo: true },
    { codigo: 'faturamento', nome: 'Faturamento', ordem: 30, ativo: true },
    { codigo: 'auditoria', nome: 'Auditoria', ordem: 80, ativo: true },
  ];

  test('só inclui módulo se houver ao menos 1 permissão desse módulo', () => {
    const permissoes = new Set(['dashboard.consultar']);
    const r = filtrarModulosPorPermissao(modulos, permissoes);
    assert.deepEqual(r.map((m) => m.codigo), ['dashboard']);
  });

  test('sem nenhuma permissão -> lista vazia mesmo com módulos ativos na entidade', () => {
    const r = filtrarModulosPorPermissao(modulos, new Set());
    assert.deepEqual(r, []);
  });

  test('módulo inativo na entidade nunca aparece, mesmo com permissão', () => {
    const modulosComInativo = [...modulos, { codigo: 'admin', nome: 'Administração', ordem: 90, ativo: false }];
    const r = filtrarModulosPorPermissao(modulosComInativo, new Set(['admin.gerenciar']));
    assert.equal(r.some((m) => m.codigo === 'admin'), false);
  });

  test('resultado ordenado por `ordem`', () => {
    const permissoes = new Set(['auditoria.consultar', 'dashboard.consultar', 'faturamento.consultar']);
    const r = filtrarModulosPorPermissao(modulos, permissoes);
    assert.deepEqual(r.map((m) => m.codigo), ['dashboard', 'faturamento', 'auditoria']);
  });
});
