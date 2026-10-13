/**
 * Testes — GET /motorista/notas-pendentes e POST /motorista/notas-pendentes/:id/validar
 * (nota-pendente-motorista F2). node --test tests/motorista-notas-pendentes-unit.test.js
 *
 * O mock do PostgREST INTERPRETA a query (cnpj, janela, nota_ok, id, limit): se a rota
 * deixar de filtrar, o resultado muda e o teste falha. Mock estático "passaria oco".
 */
'use strict';

process.env.JWT_SECRET = 'test-secret-key-for-jest-only-32chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-32chars-here!!';
process.env.NODE_ENV = 'test';
process.env.FASTAPI_VALIDATION_TOKEN = 'Bearer test-token';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Module = require('module');

const DIA = 24 * 60 * 60 * 1000;
let EnvioMassa = [];
let Empresa = [];
let trilha = []; // ApuracaoRepasseMovimento
let chamadasAxios = [];
let axiosImpl;
let patches = [];
let patchFalha = false;
let configCorte; // linha de AdiantamentoConfiguracao devolvida ao app; Error = leitura falha; [] = sem linha
let leiturasConfig = [];

// Lista de valores de um filtro in.(...), com ou sem aspas e URL-decodificada
const listaIn = (v) => decodeURIComponent(v).slice(4, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, ''));

async function mockPostgrest(path, method = 'GET', body = null) {
  const [tabela, qs] = path.split('?');
  const p = new URLSearchParams(qs || '');
  if (method === 'PATCH') {
    patches.push({ path, body });
    if (patchFalha && body && 'regularizada_em' in body) throw new Error('PostgREST fora');
    // Interpreta o filtro, como o PostgREST: regularizada_em=is.null só atinge quem está nulo
    const alvo = EnvioMassa.find((r) => String(r.id) === p.get('id').replace(/^eq\./, ''));
    if (alvo && !(p.get('regularizada_em') === 'is.null' && alvo.regularizada_em != null)) Object.assign(alvo, body);
    return {};
  }
  if (tabela === 'Empresa') {
    const ids = listaIn(p.get('id')).map(String);
    return Empresa.filter((e) => ids.includes(String(e.id)));
  }
  assert.equal(tabela, 'EnvioMassa');
  let rows = [...EnvioMassa];
  if (p.get('cnpj_prestador')) rows = rows.filter((r) => listaIn(p.get('cnpj_prestador')).includes(r.cnpj_prestador));
  if (p.get('id')) rows = rows.filter((r) => String(r.id) === p.get('id').replace(/^eq\./, ''));
  if (p.get('created_at')) {
    const min = new Date(p.get('created_at').replace(/^gte\./, '')).getTime();
    rows = rows.filter((r) => new Date(r.created_at).getTime() >= min);
  }
  if (p.get('dt_inicial')) {
    const min = p.get('dt_inicial').replace(/^gte\./, '');
    rows = rows.filter((r) => r.dt_inicial != null && r.dt_inicial >= min);
  }
  if (p.get('or')) {
    // Interpreta o `or`: cada termo só vale se estiver NA query (sintaxe provada contra o PostgREST real)
    const or = p.get('or');
    const vazio = (v) => v == null || v === '';
    const comErro = or.includes('and(erro_validacao.not.is.null,erro_validacao.neq.)');
    rows = rows.filter((r) => vazio(r.nota_ok) || (comErro && !vazio(r.erro_validacao)));
  }
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (p.get('limit')) rows = rows.slice(0, Number(p.get('limit')));
  return rows;
}

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'axios') {
    return { post: async (url, payload) => { chamadasAxios.push({ url, payload }); return axiosImpl(url, payload); } };
  }
  if (request === './grupo') {
    // Grupo Movee = empresas 6 e 7 (7 é "filial"); 9 está fora
    return { mesmoGrupoQue: async (id) => [6, 7].includes(Number(id)) };
  }
  if (request === '../lib/hub-postgrest') {
    return {
      hubPostgrestRequest: async (endpoint, method, body, claims) => {
        if (endpoint.startsWith('AdiantamentoConfiguracao?')) {
          leiturasConfig.push({ endpoint, claims });
          if (configCorte instanceof Error) throw configCorte;
          return configCorte;
        }
        const ids = listaIn(endpoint.split('envio_massa_id=')[1]).map(String);
        return trilha.filter((t) => ids.includes(String(t.envio_massa_id)));
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const express = require('express');
const cookieParser = require('cookie-parser');
const { router, init } = require('../routes/motorista.js');
Module._load = originalLoad;
init({ postgrestRequest: mockPostgrest, generatePostgrestJWT: () => 'mock-jwt' });

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/motorista', router);

let server;
let baseUrl;
before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const token = (cnpjPrestador) =>
  jwt.sign({ cnpjPrestador, aud: 'motorista' }, process.env.JWT_SECRET, { expiresIn: '15m' });

function req(method, path, { cnpj = '11111111000100', multipart, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const dados = multipart ? multipart.body : body ? JSON.stringify(body) : undefined;
    const headers = { Cookie: `accessToken=${token(cnpj)}` };
    if (multipart) headers['Content-Type'] = multipart.contentType;
    if (body) headers['Content-Type'] = 'application/json';
    if (dados) headers['Content-Length'] = Buffer.byteLength(dados);
    const r = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json; try { json = JSON.parse(d); } catch { json = d; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    r.on('error', reject);
    if (dados) r.write(dados);
    r.end();
  });
}

const mov = (id, extra = {}) => ({
  id, cnpj_prestador: '11111111000100', id_empresa: 6, valor: 100 + id, created_at: new Date(Date.now() - DIA).toISOString(),
  nota_ok: null, erro_validacao: null, mov_fechado: true, dt_inicial: '2026-10-01', dt_final: '2026-10-07', cnpj_tomador: '99', ...extra,
});

beforeEach(() => {
  EnvioMassa = []; Empresa = [{ id: 6, nome_empresa: 'Movee Ltda' }, { id: 9, nome_empresa: 'Outra' }];
  configCorte = [{ notas_pendentes_corte_modo: 'data', notas_pendentes_corte_dias: 90, notas_pendentes_corte_data: '2026-07-20' }];
  leiturasConfig = [];
  trilha = []; chamadasAxios = []; patches = []; patchFalha = false; axiosImpl = async () => ({ data: [{}] });
});

describe('GET /motorista/notas-pendentes', () => {
  test('filtra pelo CNPJ da SESSÃO — CNPJ na query não muda o resultado', async () => {
    EnvioMassa = [mov(1), mov(2, { cnpj_prestador: '22222222000100' })];
    const r = await req('GET', '/motorista/notas-pendentes?cnpjPrestador=22222222000100&cnpj_prestador=22222222000100');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
  });

  test('casa também o CNPJ mascarado na EnvioMassa', async () => {
    EnvioMassa = [mov(1, { cnpj_prestador: '11.111.111/0001-00' })];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
  });

  test('created_at não filtra mais: movimento antigo de semana recente aparece', async () => {
    EnvioMassa = [mov(1, { created_at: new Date(Date.now() - 400 * DIA).toISOString() })];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
  });

  test('modo dias: só semanas dos últimos N dias (dt_inicial)', async () => {
    configCorte = [{ notas_pendentes_corte_modo: 'dias', notas_pendentes_corte_dias: 30, notas_pendentes_corte_data: '2026-07-20' }];
    const dia = (n) => new Date(Date.now() - n * DIA).toISOString().slice(0, 10);
    EnvioMassa = [mov(1, { dt_inicial: dia(10) }), mov(2, { dt_inicial: dia(60) }), mov(3, { dt_inicial: dia(29) })];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id).sort(), [1, 3]);
  });

  test('modo data: usa a data configurada (e lê escopo [6] pelo cliente do hub)', async () => {
    configCorte = [{ notas_pendentes_corte_modo: 'data', notas_pendentes_corte_dias: 90, notas_pendentes_corte_data: '2026-09-15' }];
    EnvioMassa = [mov(1, { dt_inicial: '2026-09-15 03:00:00' }), mov(2, { dt_inicial: '2026-09-08 03:00:00' })];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
    assert.deepEqual(leiturasConfig[0].claims, { escopo: [6] });
  });

  test('falha ao ler a config → padrão 2026-07-20, não bloqueia o motorista', async () => {
    configCorte = new Error('PostgREST fora');
    EnvioMassa = [mov(1, { dt_inicial: '2026-07-20 03:00:00' }), mov(2, { dt_inicial: '2026-07-13 03:00:00' })];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
  });

  test('config sem linha → padrão 2026-07-20', async () => {
    configCorte = [];
    EnvioMassa = [mov(1, { dt_inicial: '2026-07-20 03:00:00' }), mov(2, { dt_inicial: '2026-07-13 03:00:00' })];
    assert.deepEqual((await req('GET', '/motorista/notas-pendentes')).body.notas.map((n) => n.id), [1]);
  });

  test('corte 20/07/2026: semana anterior ou sem data não aparece', async () => {
    EnvioMassa = [mov(1, { dt_inicial: '2026-07-20 03:00:00' }), mov(2, { dt_inicial: '2026-07-13 03:00:00' }), mov(3, { dt_inicial: null }), mov(4, { dt_inicial: '1982-01-01' })];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
  });

  test('inclui aberto e fechado; exclui só a nota APROVADA (nota_ok cheio e erro vazio)', async () => {
    EnvioMassa = [
      mov(1, { mov_fechado: false }), mov(2, { mov_fechado: true }),
      mov(3, { nota_ok: 'https://x/3.xml' }), mov(4, { nota_ok: 'https://x/4.xml', erro_validacao: 'valid_valor' }),
      mov(5, { nota_ok: '' }), mov(6, { nota_ok: 'https://x/6.xml', erro_validacao: '' }),
    ];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id).sort(), [1, 2, 4, 5]);
  });

  test('nota REPROVADA (nota_ok e erro_validacao preenchidos) aparece; APROVADA não', async () => {
    EnvioMassa = [
      mov(1, { nota_ok: 'https://x/1.xml', erro_validacao: 'valid_valor' }),
      mov(2, { nota_ok: 'https://x/2.xml', erro_validacao: null }),
    ];
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body.notas.map((n) => n.id), [1]);
  });

  test('ordem created_at decrescente e teto de 50', async () => {
    EnvioMassa = Array.from({ length: 60 }, (_, i) => mov(i + 1, { created_at: new Date(Date.now() - (i + 1) * 60000).toISOString() }));
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.equal(r.body.notas.length, 50);
    assert.equal(r.body.notas[0].id, 1);
    assert.equal(r.body.notas[49].id, 50);
  });

  test('campos do item e tomador resolvido', async () => {
    EnvioMassa = [mov(1)];
    const [n] = (await req('GET', '/motorista/notas-pendentes')).body.notas;
    assert.deepEqual(Object.keys(n).sort(), ['cnpjTomador', 'criadoEm', 'dtFinal', 'dtInicial', 'id', 'origem', 'tomador', 'valor']);
    assert.equal(n.tomador, 'Movee Ltda');
  });

  test('item RECUSADO traz camposInvalidos traduzidos; item nunca enviado NÃO ganha a chave', async () => {
    EnvioMassa = [
      mov(1, { nota_ok: 'https://x/1.xml', erro_validacao: 'valid_cnpj, valid_valor' }),
      mov(2),
      mov(3, { nota_ok: 'https://x/3.xml', erro_validacao: '' }),
    ];
    const notas = (await req('GET', '/motorista/notas-pendentes')).body.notas;
    assert.deepEqual(notas.find((n) => n.id === 1).camposInvalidos, [
      { campo: 'valid_cnpj', mensagem: 'CNPJ do tomador está incorreto na nota.' },
      { campo: 'valid_valor', mensagem: 'Valor da nota não confere com o valor do movimento.' },
    ]);
    assert.ok(!('camposInvalidos' in notas.find((n) => n.id === 2)));
  });

  test("origem: 'MOVIMENTO' fora da trilha, 'REPASSE' dentro", async () => {
    EnvioMassa = [mov(1), mov(2)];
    trilha = [{ envio_massa_id: 2 }];
    const notas = (await req('GET', '/motorista/notas-pendentes')).body.notas;
    assert.equal(notas.find((n) => n.id === 1).origem, 'MOVIMENTO');
    assert.equal(notas.find((n) => n.id === 2).origem, 'REPASSE');
  });

  test('lista vazia → 200 com notas []', async () => {
    const r = await req('GET', '/motorista/notas-pendentes');
    assert.deepEqual(r.body, { notas: [] });
  });
});

describe('POST /motorista/notas-pendentes/:id/validar', () => {
  const XML = (cnpj) => `<?xml version="1.0"?><CompNfse><prest><CNPJ>${cnpj}</CNPJ></prest></CompNfse>`;
  const mp = (xml) => {
    const b = 'BND';
    return { body: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="n.xml"\r\nContent-Type: text/xml\r\n\r\n${xml}\r\n--${b}--\r\n`, contentType: `multipart/form-data; boundary=${b}` };
  };
  // Simula o efeito colateral da FastAPI: grava o resultado no registro
  const fastapiGrava = (id) => async (url, payload) => {
    const row = EnvioMassa.find((m) => m.id === id);
    row.nota_ok = 'https://fake/nota.xml'; row.erro_validacao = '';
    return { data: [{}] };
  };

  test('pendência de OUTRO CNPJ → 404 e a FastAPI nem é chamada', async () => {
    EnvioMassa = [mov(7, { cnpj_prestador: '22222222000100' })];
    const r = await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) });
    assert.equal(r.status, 404);
    assert.equal(chamadasAxios.length, 0);
  });

  test('movimento anterior ao corte de 20/07/2026 → 404 e a FastAPI nem é chamada', async () => {
    EnvioMassa = [mov(7, { dt_inicial: '2026-07-13 03:00:00' }), mov(8, { dt_inicial: null })];
    assert.equal((await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) })).status, 404);
    assert.equal((await req('POST', '/motorista/notas-pendentes/8/validar', { multipart: mp(XML('11111111000100')) })).status, 404);
    assert.equal(chamadasAxios.length, 0);
  });

  test('POST respeita o corte configurado (data mais recente recusa o que o padrão aceitaria)', async () => {
    configCorte = [{ notas_pendentes_corte_modo: 'data', notas_pendentes_corte_dias: 90, notas_pendentes_corte_data: '2026-09-15' }];
    EnvioMassa = [mov(7, { dt_inicial: '2026-08-03 03:00:00' })];
    assert.equal((await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) })).status, 404);
    assert.equal(chamadasAxios.length, 0);
  });

  test('id inexistente ou não numérico → 404', async () => {
    EnvioMassa = [mov(7)];
    assert.equal((await req('POST', '/motorista/notas-pendentes/999/validar', { multipart: mp(XML('11111111000100')) })).status, 404);
    assert.equal((await req('POST', '/motorista/notas-pendentes/abc/validar', { multipart: mp(XML('11111111000100')) })).status, 404);
  });

  test('passa id_movimento à FastAPI (grupo Movee → não-nexus, id_empresa=6)', async () => {
    EnvioMassa = [mov(7, { id_empresa: 7 })]; // filial: pega pelo grupo, não por === 6
    axiosImpl = fastapiGrava(7);
    const r = await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11.111.111/0001-00')) });
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
    const c = chamadasAxios[0];
    assert.match(c.url, /fastapihomologacao\.todo-tips/);
    const p = new URLSearchParams(c.payload);
    assert.equal(p.get('id_movimento'), '7');
    assert.equal(p.get('id_empresa'), '6');
  });

  test('empresa fora do grupo → nexus, também com id_movimento', async () => {
    EnvioMassa = [mov(8, { id_empresa: 9 })];
    axiosImpl = fastapiGrava(8);
    await req('POST', '/motorista/notas-pendentes/8/validar', { multipart: mp(XML('11111111000100')) });
    assert.match(chamadasAxios[0].url, /nexus/);
    assert.equal(new URLSearchParams(chamadasAxios[0].payload).get('id_movimento'), '8');
  });

  test('XML com CNPJ diferente do logado → 400, sem chamar a FastAPI', async () => {
    EnvioMassa = [mov(7)];
    const r = await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('33333333000100')) });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /não pertence ao seu CNPJ/);
    assert.equal(chamadasAxios.length, 0);
  });

  test('nota já aprovada → 409; reprovada pode reenviar', async () => {
    EnvioMassa = [mov(7, { nota_ok: 'u', erro_validacao: '' }), mov(8, { nota_ok: 'u', erro_validacao: 'valid_valor' })];
    assert.equal((await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) })).status, 409);
    axiosImpl = fastapiGrava(8);
    assert.equal((await req('POST', '/motorista/notas-pendentes/8/validar', { multipart: mp(XML('11111111000100')) })).status, 200);
  });

  test('reprovada devolve camposInvalidos; 4xx com detail → 422; timeout → 502', async () => {
    EnvioMassa = [mov(7)];
    axiosImpl = async () => { EnvioMassa[0].nota_ok = 'u'; EnvioMassa[0].erro_validacao = 'valid_valor'; return { data: [{}] }; };
    const r = await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) });
    assert.equal(r.body.valid, false);
    assert.equal(r.body.camposInvalidos[0].campo, 'valid_valor');

    EnvioMassa = [mov(7)];
    axiosImpl = async () => { throw Object.assign(new Error('x'), { response: { status: 404, data: { detail: 'Nenhum motorista ativo' } } }); };
    assert.equal((await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) })).status, 422);
    axiosImpl = async () => { throw new Error('timeout'); };
    assert.equal((await req('POST', '/motorista/notas-pendentes/7/validar', { multipart: mp(XML('11111111000100')) })).status, 502);
  });
  describe('marca regularizada_em (movimento fechado)', () => {
    const envia = (id) => req('POST', `/motorista/notas-pendentes/${id}/validar`, { multipart: mp(XML('11111111000100')) });

    test('movimento FECHADO + validação ok → grava regularizada_em', async () => {
      EnvioMassa = [mov(7, { mov_fechado: true })];
      axiosImpl = fastapiGrava(7);
      assert.equal((await envia(7)).status, 200);
      assert.ok(EnvioMassa[0].regularizada_em, 'deveria ter gravado a marca');
    });

    test('movimento ABERTO + validação ok → NÃO grava', async () => {
      EnvioMassa = [mov(7, { mov_fechado: false })];
      axiosImpl = fastapiGrava(7);
      assert.equal((await envia(7)).status, 200);
      assert.equal(EnvioMassa[0].regularizada_em, undefined);
      assert.equal(patches.filter((x) => 'regularizada_em' in x.body).length, 0);
    });

    test('regularizada_em já preenchido → não sobrescreve', async () => {
      const antes = '2026-10-01T10:00:00.000Z';
      EnvioMassa = [mov(7, { mov_fechado: true, nota_ok: 'u', erro_validacao: 'valid_valor', regularizada_em: antes })];
      axiosImpl = fastapiGrava(7);
      assert.equal((await envia(7)).status, 200);
      assert.equal(EnvioMassa[0].regularizada_em, antes);
    });

    test('falha ao gravar a marca → a resposta continua de sucesso', async () => {
      EnvioMassa = [mov(7, { mov_fechado: true })];
      axiosImpl = fastapiGrava(7);
      patchFalha = true;
      const r = await envia(7);
      assert.equal(r.status, 200);
      assert.equal(r.body.valid, true);
    });

    test('validação reprovada em movimento fechado → não grava a marca', async () => {
      EnvioMassa = [mov(7, { mov_fechado: true })];
      axiosImpl = async () => { EnvioMassa[0].nota_ok = 'u'; EnvioMassa[0].erro_validacao = 'valid_valor'; return { data: [{}] }; };
      await envia(7);
      assert.equal(EnvioMassa[0].regularizada_em, undefined);
    });
  });
});


describe('chave MOTORISTA_NOTAS_PENDENTES', () => {
  const ORIG = process.env.MOTORISTA_NOTAS_PENDENTES;
  const restaura = () => { if (ORIG === undefined) delete process.env.MOTORISTA_NOTAS_PENDENTES; else process.env.MOTORISTA_NOTAS_PENDENTES = ORIG; };
  const XML = '<?xml version="1.0"?><CompNfse><prest><CNPJ>11111111000100</CNPJ></prest></CompNfse>';
  const upload = () => {
    const b = '----x';
    return { contentType: `multipart/form-data; boundary=${b}`,
      body: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="n.xml"\r\nContent-Type: text/xml\r\n\r\n${XML}\r\n--${b}--\r\n` };
  };

  test('ausente = LIGADO: lista normalmente', async () => {
    delete process.env.MOTORISTA_NOTAS_PENDENTES;
    EnvioMassa = [mov(1)];
    try { assert.deepEqual((await req('GET', '/motorista/notas-pendentes')).body.notas.map((n) => n.id), [1]); } finally { restaura(); }
  });

  for (const v of ['false', 'off', '0', 'FALSE']) {
    test(`${v}: listagem devolve 200 com lista vazia`, async () => {
      process.env.MOTORISTA_NOTAS_PENDENTES = v;
      EnvioMassa = [mov(1)];
      try {
        const r = await req('GET', '/motorista/notas-pendentes');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { notas: [] });
      } finally { restaura(); }
    });
  }

  test('desligada: envio recusa com 503 e não chama a FastAPI', async () => {
    process.env.MOTORISTA_NOTAS_PENDENTES = 'false';
    EnvioMassa = [mov(1)];
    try {
      const r = await req('POST', '/motorista/notas-pendentes/1/validar', { multipart: upload() });
      assert.equal(r.status, 503);
      assert.match(r.body.error, /indispon/);
      assert.equal(chamadasAxios.length, 0);
    } finally { restaura(); }
  });

  test('ligada explicitamente (true): envio segue o fluxo normal', async () => {
    process.env.MOTORISTA_NOTAS_PENDENTES = 'true';
    EnvioMassa = [mov(1)];
    axiosImpl = async () => { EnvioMassa[0].nota_ok = 'https://fake/nota.xml'; EnvioMassa[0].erro_validacao = ''; return { data: [{}] }; };
    try {
      const r = await req('POST', '/motorista/notas-pendentes/1/validar', { multipart: upload() });
      assert.equal(r.status, 200);
      assert.equal(chamadasAxios.length, 1);
    } finally { restaura(); }
  });
});
