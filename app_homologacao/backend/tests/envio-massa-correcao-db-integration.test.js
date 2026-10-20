// corrigir-movimento — integracao REAL: corrigirPelaTela (lib) + funcao hub_envio_massa_corrigir_valor (0116)
// no banco do hub-homolog (container hub_homolog_db, empresa QA 9001). Nao cobre a camada HTTP/URL do
// PostgREST (essa e coberta por criarDepsCorrecao com postgrestRequest falso). Pula se o container nao esta no ar.
'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { corrigirPelaTela } = require('../lib/envio-massa-correcao');
const { renderizarMensagem } = require('../lib/adiantamento-mensagem');

const DB = 'hub_homolog_db';
const psql = (sql) => execFileSync('docker', ['exec', '-i', DB, 'sh', '-c',
  'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], { input: sql, encoding: 'utf8' }).trim();
let disponivel = true;
try { psql("select 1 from pg_proc where proname='hub_envio_massa_corrigir_valor'") || (disponivel = false); } catch { disponivel = false; }

const MODELO = 'Ola {nome}: nota R$ {valor}, gorjeta R$ {gorjeta}, total R$ {total}.';
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

describe('corrigirPelaTela contra o banco real', { skip: !disponivel && 'hub_homolog_db indisponivel' }, () => {
  const ids = {};
  const dados = (v, g) => ({ nome: 'T-INT', valor: v, gorjeta: g, total: v + g });
  before(() => {
    const msg = renderizarMensagem(MODELO, dados(100, 5));
    const ins = (k, nota, emp) => {
      ids[k] = Number(psql(`INSERT INTO "EnvioMassa" (nome,valor,gorjeta,mensagem1,nota_ok,id_empresa,enviado,mov_fechado)
        VALUES ('T-INT',100,5,${q(msg)},${nota ? q(nota) : 'NULL'},${emp},'off',false) RETURNING id`).split('\n')[0]);
    };
    ins('hub', null, 9001); ins('comnota', 'N1', 9001); ins('outra', null, 9010);
  });
  after(() => {
    const l = Object.values(ids).join(',');
    psql(`SET session_replication_role=replica; DELETE FROM "Auditoria" WHERE recurso='EnvioMassa' AND recurso_id IN (${Object.values(ids).map(q).join(',')}); DELETE FROM "EnvioMassa" WHERE id IN (${l});`);
  });
  const deps = (hub = true) => ({
    lerMovimento: async (id, emp) => {
      const r = psql(`SELECT row_to_json(t) FROM (SELECT mensagem1,nome,valor::float8,gorjeta::float8 FROM "EnvioMassa" WHERE id=${Number(id)} AND id_empresa=${Number(emp)}) t`);
      return r ? JSON.parse(r) : null;
    },
    lerOrigemHub: async () => (hub ? { modelo: MODELO, periodoInicio: null, periodoFim: null } : null),
    corrigir: async ({ idEmp, movimentos, motivo, origem, usuarioId }) => JSON.parse(psql(
      `SELECT json_agg(t) FROM hub_envio_massa_corrigir_valor(${idEmp}, ${q(JSON.stringify(movimentos))}::jsonb, ${q(motivo)}, ${q(origem)}, ${usuarioId ?? 'NULL'}) t`)),
  });
  const valorNoBanco = (id) => Number(psql(`SELECT valor FROM "EnvioMassa" WHERE id=${id}`));

  test('movimento do hub: valor gravado e mensagem re-renderizada, lidos de volta do banco', async () => {
    const r = await corrigirPelaTela({ id: ids.hub, idEmp: 9001, body: { valor: '250,75', motivo: 'int' } }, deps());
    assert.equal(r.status, 200); assert.equal(r.body.mensagem_ajustada, true);
    assert.equal(valorNoBanco(ids.hub), 250.75);
    assert.equal(psql(`SELECT mensagem1 FROM "EnvioMassa" WHERE id=${ids.hub}`), renderizarMensagem(MODELO, dados(250.75, 5)));
  });
  test('nota ja anexada => 409 e valor intacto no banco', async () => {
    const r = await corrigirPelaTela({ id: ids.comnota, idEmp: 9001, body: { valor: 1, motivo: 'int' } }, deps());
    assert.equal(r.status, 409);
    assert.equal(valorNoBanco(ids.comnota), 100);
  });
  test('outro tenant => 404 e valor intacto', async () => {
    const r = await corrigirPelaTela({ id: ids.outra, idEmp: 9001, body: { valor: 1, motivo: 'int' } }, deps());
    assert.equal(r.status, 404);
    assert.equal(valorNoBanco(ids.outra), 100);
  });
});

// C6: a guarda SQL tem de concordar com notaAprovada (String.trim do JS): erro_validacao so com NBSP/\v/\f = SEM erro.
describe('guarda de nota enviada espelha o trim() do JS (0116)', { skip: !disponivel && 'hub_homolog_db indisponivel' }, () => {
  const criados = [];
  after(() => { if (criados.length) psql(`SET session_replication_role=replica; DELETE FROM "Auditoria" WHERE recurso='EnvioMassa' AND recurso_id IN (${criados.map(q).join(',')}); DELETE FROM "EnvioMassa" WHERE id IN (${criados.join(',')});`); });
  for (const [nome, ws] of [['NBSP', '\u00a0'], ['VT/FF', '\u000b\u000c'], ['BOM', '\ufeff']]) {
    test(`erro_validacao so com ${nome} => nota conta como enviada (pulado_nota_enviada)`, () => {
      const id = Number(psql(`INSERT INTO "EnvioMassa" (nome,valor,nota_ok,erro_validacao,id_empresa,enviado,mov_fechado)
        VALUES ('T-WS',10,'N1',${q(ws)},9001,'off',false) RETURNING id`).split('\n')[0]);
      criados.push(id);
      assert.equal(String(ws).trim(), '');
      const d = psql(`SELECT desfecho FROM hub_envio_massa_corrigir_valor(9001, ${q(JSON.stringify([{ id, valor: 11 }]))}::jsonb, 'int', 'tela', NULL)`).split('\n')[0];
      assert.equal(d, 'pulado_nota_enviada');
    });
  }
});

// C5: lerOrigemHub contra o PostgREST REAL do hub-homolog (RLS por claim de escopo, 0092). Usa uma trilha ja existente.
describe('lerOrigemHub com RLS real (PostgREST do hub-homolog)', () => {
  let trilha = null; let url = null; let segredo = null;
  try {
    trilha = psql('SELECT envio_massa_id || \',\' || id_empresa FROM "ApuracaoRepasseMovimento" LIMIT 1');
    const ip = execFileSync('docker', ['inspect', 'hub_homolog_postgrest', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'], { encoding: 'utf8' }).trim().split(' ')[0];
    segredo = execFileSync('docker', ['inspect', 'hub_homolog_postgrest', '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' })
      .split('\n').find((l) => l.startsWith('PGRST_JWT_SECRET=')).slice('PGRST_JWT_SECRET='.length);
    url = `http://${ip}:3000`;
  } catch { trilha = null; }
  test('devolve a trilha de um movimento do hub; o JWT legado (so role) nao enxerga nada', { skip: !trilha && 'sem trilha/postgrest no hub-homolog' }, async () => {
    const [mid, emp] = trilha.split(',');
    process.env.POSTGREST_URL = url; process.env.PGRST_JWT_SECRET = segredo;
    const { criarDepsCorrecao } = require('../lib/envio-massa-correcao');
    const origem = await criarDepsCorrecao(async () => { throw new Error('legado'); }).lerOrigemHub(mid, Number(emp));
    assert.ok(origem, 'lerOrigemHub devolveu null para movimento COM trilha');
    assert.ok(origem.periodoInicio && origem.periodoFim);
    const t = require('jsonwebtoken').sign({ role: 'authenticated' }, segredo, { expiresIn: '5m' });
    const r = await fetch(`${url}/ApuracaoRepasseMovimento?envio_massa_id=eq.${mid}&select=apuracao_id`, { headers: { Authorization: `Bearer ${t}` } });
    assert.deepEqual(await r.json(), []);
  });
});
