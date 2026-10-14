#!/usr/bin/env bash
# Prova da 0113 no hub-homolog: as ações "Já foi pago" / "Desfazer" / "Apagar nota"
# (routes/hub-validacao-xml.js) contra o PostgREST e o banco REAIS — RLS, grants,
# colunas jsonb, filtros de escopo e auditoria. Só a sessão (cookie) e o RBAC são
# simulados: o router roda num node:20 dentro da rede do hub-homolog.
# Dados efêmeros ids 9113xxx, apagados no fim (KEEP=1 mantém). A Auditoria é
# imutável (trigger): os eventos ficam; a checagem olha só os desta rodada.
# Uso: infra/hub/testes/hub-retidos-acoes.sh
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"; ENV=/var/lib/hub_secrets/.env.hub.homolog
SECRET="$(grep '^PGRST_JWT_SECRET=' $ENV | cut -d= -f2-)"
P() { docker exec -i hub_homolog_db psql -v ON_ERROR_STOP=1 -U hub_homolog -d hub_homolog "$@"; }
cleanup() { P -q -c "DELETE FROM \"EnvioMassa\" WHERE id BETWEEN 9113000 AND 9113099;"; }
INICIO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ -n "${KEEP:-}" ] || trap cleanup EXIT; cleanup
P -q <<'SQL'
INSERT INTO "EnvioMassa"(id,id_empresa,nome,cnpj_prestador,valor,dt_inicial,dt_final,mov_fechado,nota_ok,erro_validacao,numnota,data_emissao,"dataEnvio",regularizada_em,conciliada_em,conciliada_origem) VALUES
 (9113001,9001,'Retido A','91130000000001',100,'2026-09-07 03:00+00','2026-09-13 03:00+00',true,'https://x/a.xml','',14,'2026-09-15','2026-10-12T10:00:00Z',now(),NULL,NULL),
 (9113002,9010,'Outro tenant','91130000000002',100,'2026-09-07 03:00+00','2026-09-13 03:00+00',true,'https://x/b.xml','',15,'2026-09-15','2026-10-12T10:00:00Z',now(),NULL,NULL),
 (9113003,9001,'Conciliado UNECONT','91130000000003',100,'2026-09-07 03:00+00','2026-09-13 03:00+00',true,'UNECONT:abc',NULL,16,'2026-09-15',NULL,now(),now(),'UNECONT:abc'),
 (9113004,9001,'Aberto','91130000000004',100,'2026-10-05 03:00+00','2026-10-11 03:00+00',false,'https://x/d.xml','',17,'2026-10-12',NULL,now(),NULL,NULL);
SQL
cat > /tmp/hub-retidos-acoes-$$.js <<'JS'
process.env.JWT_SECRET = 'segredo-driver-retidos';
const assert = require('node:assert/strict');
const Module = require('module');
const B = process.env.RAIZ + '/app_homologacao/backend';
const orig = Module._load;
Module._load = function (r) {
  if (r === '../lib/hub-rbac-cache') return {
    obterPermissoesEfetivas: async () => new Set(['validacao_xml.validar', 'adiantamentos.pagamento_confirmar']),
    obterPermissoesEfetivasPorEntidade: async () => new Set(['validacao_xml.validar', 'adiantamentos.pagamento_confirmar']),
    obterModulosAtivosPorEntidade: async () => new Set(['validacao_xml']),
    usuarioEhAdminPlataforma: async () => false,
  };
  if (r === './grupo') return { mesmoGrupoQue: async () => false };
  return orig.apply(this, arguments);
};
const express = require(B + '/node_modules/express');
const cookieParser = require(B + '/node_modules/cookie-parser');
const jwt = require(B + '/node_modules/jsonwebtoken');
const { router } = require(B + '/routes/hub-validacao-xml.js');
Module._load = orig;
const app = express(); app.use(cookieParser()); app.use('/v', router);
const ck = 'hub_accessToken=' + jwt.sign({ sub: 328, entidade_ativa: 9001 }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
let fail = 0;
const caso = async (nome, fn) => { try { await fn(); console.log('PASS', nome); } catch (e) { fail++; console.log('FAIL', nome, '-', e.message); } };
(async () => {
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/v/regularizadas`;
  const call = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { Cookie: ck, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, b: await r.json() }; };
  const { hubPostgrestRequest } = require(B + '/lib/hub-postgrest');
  const ler = async (id) => (await hubPostgrestRequest(`EnvioMassa?id=eq.${id}&select=*`, 'GET', null, { usuarioId: 328, empresaAtiva: 9001, escopo: [9001, 9010] }))[0];

  // O GET (que já existia) não filtra mov_fechado; regularizada_em só nasce em fechado.
  await caso('GET lista só o escopo (não o outro tenant)', async () => {
    const r = await call('GET', ''); assert.equal(r.s, 200);
    const ids = r.b.itens.map((i) => i.id).filter((i) => i >= 9113000 && i < 9113100).sort();
    assert.deepEqual(ids, [9113001, 9113003, 9113004]);
  });
  await caso('Já foi pago grava conciliada_em/MANUAL/pago_manual no banco', async () => {
    const r = await call('POST', '/9113001/ja-pago', { referencia: 'UneCont NF 14' }); assert.equal(r.s, 200, JSON.stringify(r.b));
    const row = await ler(9113001);
    assert.ok(row.conciliada_em); assert.equal(row.conciliada_origem, 'MANUAL'); assert.equal(row.pago_manual.referencia, 'UneCont NF 14');
  });
  await caso('Apagar nota de item marcado como pago -> 409, nada muda', async () => {
    const r = await call('POST', '/9113001/apagar-nota', { motivo: 'x' }); assert.equal(r.s, 409);
    assert.equal((await ler(9113001)).nota_ok, 'https://x/a.xml');
  });
  await caso('Desfazer limpa as 3 colunas', async () => {
    const r = await call('DELETE', '/9113001/ja-pago'); assert.equal(r.s, 200, JSON.stringify(r.b));
    const row = await ler(9113001); assert.equal(row.conciliada_em, null); assert.equal(row.conciliada_origem, null); assert.equal(row.pago_manual, null);
  });
  await caso('Apagar nota limpa as 6 colunas e guarda o anterior em nota_apagada', async () => {
    const r = await call('POST', '/9113001/apagar-nota', { motivo: 'Paga pela UneCont' }); assert.equal(r.s, 200, JSON.stringify(r.b));
    const row = await ler(9113001);
    for (const c of ['nota_ok', 'erro_validacao', 'numnota', 'data_emissao', 'dataEnvio', 'regularizada_em']) assert.equal(row[c], null, c);
    assert.equal(row.nota_apagada.antes.nota_ok, 'https://x/a.xml'); assert.equal(String(row.nota_apagada.antes.numnota), '14');
    assert.equal(row.nota_apagada.motivo, 'Paga pela UneCont');
  });
  await caso('ESCOPO: outro tenant -> 404 e o banco não muda', async () => {
    const r = await call('POST', '/9113002/ja-pago', {}); assert.equal(r.s, 404);
    assert.equal((await ler(9113002)).conciliada_em, null);
  });
  await caso('Desfazer conciliação UNECONT -> 409 e o banco não muda', async () => {
    const r = await call('DELETE', '/9113003/ja-pago'); assert.equal(r.s, 409);
    assert.equal((await ler(9113003)).conciliada_origem, 'UNECONT:abc');
  });
  await caso('Movimento aberto -> 404 (não é retido)', async () => {
    assert.equal((await call('POST', '/9113004/ja-pago', {})).s, 404);
  });
  await caso('Auditoria gravada para as 3 ações', async () => {
    const a = await hubPostgrestRequest(`Auditoria?recurso=eq.EnvioMassa&recurso_id=eq.9113001&criado_em=gte.${process.env.INICIO}&select=acao`, 'GET', null, { usuarioId: 328, empresaAtiva: 9001, escopo: [9001], adminPlataforma: true });
    assert.deepEqual(a.map((x) => x.acao).sort(), ['retido_ja_pago_desfeito', 'retido_marcado_ja_pago', 'retido_nota_apagada']);
  });
  srv.close();
  console.log(fail ? 'resultado: FALHOU' : 'resultado: OK'); process.exit(fail ? 1 : 0);
})();
JS
docker run --rm --network hub_homolog_net -e RAIZ="$RAIZ" -e INICIO="$INICIO" -e POSTGREST_URL=http://postgrest:3000 -e PGRST_JWT_SECRET="$SECRET" \
  -v /var/lib/envioMassa_homologacao:/var/lib/envioMassa_homologacao:ro -v /tmp/hub-retidos-acoes-$$.js:/t.js:ro node:20-alpine node /t.js
RC=$?; rm -f /tmp/hub-retidos-acoes-$$.js; exit $RC
