#!/usr/bin/env bash
# =============================================================================
# hub-push-avisos-integration.sh — tasks 1.2.8-1.2.12 (tasks.md FASE 1, feature
# "Notificações push no app do motorista"): prova E2E REAL (sem mock, sem
# build do backend) de que a migration 0061_push_avisos.sql aplica sem erro,
# é idempotente, e que RLS/REVOKE/GRANT das 11 funções SECURITY DEFINER se
# comportam como data-model.md/plan.md descrevem (achados owasp-security
# S1/S2/S4/S10). Mesmo padrão de isolamento efêmero de
# infra/hub/testes/hub-rls-importacoes-integration.sh, mas chama o PostgREST
# de dentro do container `mailpit-mock` (node:20-alpine já presente no
# compose, sem build) em vez de `backend` — os claims `motorista_cnpj` e
# `hub_push_worker` são exclusivos desta feature e ainda não existem em
# app_homologacao/backend/lib/hub-postgrest-jwt.js (isso é tarefa de FASE 2+,
# rotas), então o assinador HS256 aqui é hand-rolled com node:crypto (stdlib,
# sem dependência nova) só para fins deste teste de camada de dados.
#
# Cobre:
#   1.2.8  — migrate.sh aplica 0061 e o registra 1x em "SchemaMigration";
#            reaplicar é no-op (idempotência)
#   S1  (1.2.9)  — as 11 funções SECURITY DEFINER chamadas via /rpc/ SEM
#            Authorization -> as 11 recusadas com 401/403 (REVOKE FROM PUBLIC)
#   S2  (1.2.10) — 11 chamadas a hub_push_inscricao_registrar do MESMO
#            motorista -> exatamente 10 linhas em PushInscricao, sobrevive a
#            mais recente (teto dec-043/block-004)
#   S4  (1.2.11) — hub_aviso_alcance modo toda_base, 3 contas: só vínculo
#            Entregador fora do grupo Movee -> excluída; sem nenhum vínculo
#            -> alcançada; vínculo dentro do grupo -> alcançada. (O 3º caso
#            do tasks.md original — "1 vínculo dentro + 1 fora para o MESMO
#            motorista" — é IRREPRODUTÍVEL no schema atual:
#            idx_entregador_motorista_id_unico (0021_conta_motorista.sql:57)
#            é um índice único em Entregador.motorista_id, então uma
#            ContaMotorista nunca tem mais de 1 Entregador vinculado
#            simultaneamente — GROUP BY/bool_or no SQL sempre agrega no
#            máximo 1 linha. Substituído pelo caso simétrico "vínculo dentro
#            do escopo" para exercitar o outro ramo do HAVING, com achado
#            registrado como Decisão em vez de forçar um seed impossível.)
#   S10 (1.2.12) — hub_jwt_motorista_cnpj() recusa claim nula, vazia e fora
#            de 14 dígitos (3 casos); bônus: hub_jwt_push_worker() recusa
#            claim ausente
#
# Uso: infra/hub/testes/hub-push-avisos-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
JWT_SECRET="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$JWT_SECRET" ] || { echo "HUB_DB_USER/HUB_DB_NAME/PGRST_JWT_SECRET ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+mailpit-mock efêmeros ($PROJECT)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

# --- 1.2.8: aplicar migrations (inclui 0061) e confirmar registro único -----
echo "aplicando migrations (inclui 0061)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
if ! grep -q "0061_push_avisos.sql" "$TMP/migrate.log"; then
  echo "FAIL: 0061 não aplicada — log completo:"; tail -100 "$TMP/migrate.log"; exit 1
fi

N_SCHEMA="$(psql_t -tAc "SELECT count(*) FROM \"SchemaMigration\" WHERE nome LIKE '0061%'")"
check "1.2.8: SchemaMigration tem exatamente 1 linha para 0061%" "$N_SCHEMA" "1"

"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate2.log" 2>&1
check "1.2.8: migrate.sh 2x — 0061 idempotente (pulada na 2ª corrida)" \
  "$(grep -c 'pulada (já aplicada): 0061_push_avisos.sql' "$TMP/migrate2.log")" "1"

# --- Seed para S4 (1.2.11), via psql direto (dono da tabela = bypass RLS) ---
echo "seedando contas/entregadores/inscrições para S4…"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES
  ('22222222000101', 'S4 Caso1 Fora'),
  ('22222222000102', 'S4 Caso2 SemVinculo'),
  ('22222222000103', 'S4 Caso3 Misto')
ON CONFLICT (cnpj_prestador) DO NOTHING;

INSERT INTO "PushInscricao" (cnpj_prestador, endpoint, endpoint_hash, p256dh, auth, key_id, plataforma, dispositivo_id) VALUES
  ('22222222000101', 'https://push.example/s4c1', 's4-hash-caso1', 'p', 'a', 'keyid-s4', 'android', '00000000-0000-0000-0000-0000000000a1'),
  ('22222222000102', 'https://push.example/s4c2', 's4-hash-caso2', 'p', 'a', 'keyid-s4', 'android', '00000000-0000-0000-0000-0000000000a2'),
  ('22222222000103', 'https://push.example/s4c3', 's4-hash-caso3', 'p', 'a', 'keyid-s4', 'android', '00000000-0000-0000-0000-0000000000a3')
ON CONFLICT (endpoint_hash) DO NOTHING;

INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id) VALUES
  (999, gen_random_uuid(), 'S4 Caso1 vinculo unico fora',
    (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = '22222222000101')),
  (6, gen_random_uuid(), 'S4 Caso3 vinculo dentro do escopo',
    (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = '22222222000103'));

-- D-15 (adiantamento-motorista FASE 5, tasks 5.1.3/5.1.4/5.2/5.3.3): 1 conta
-- COM push (D15Push) e 1 conta SEM push (D15SemPush), ambas no grupo Movee —
-- prova de que hub_aviso_criar grava NotificacaoMotorista para as DUAS
-- (histórico independe de push), enquanto AvisoEntrega continua só para
-- quem tem push.
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES
  ('44444444000101', 'D15 Com Push'),
  ('44444444000102', 'D15 Sem Push')
ON CONFLICT (cnpj_prestador) DO NOTHING;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id) VALUES
  (6, gen_random_uuid(), 'D15 Com Push', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = '44444444000101')),
  (6, gen_random_uuid(), 'D15 Sem Push', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = '44444444000102'));
INSERT INTO "PushInscricao" (cnpj_prestador, endpoint, endpoint_hash, p256dh, auth, key_id, plataforma, dispositivo_id) VALUES
  ('44444444000101', 'https://push.example/d15', 'd15-hash', 'p', 'a', 'keyid-d15', 'android', '00000000-0000-0000-0000-0000000000d1')
ON CONFLICT (endpoint_hash) DO NOTHING;
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('financeiro.d15@example.com', 'x', 'Financeiro D15')
ON CONFLICT (email) DO NOTHING;
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed S4/D15 deu erro"; cat "$TMP/seed.log"; exit 1; fi

SUB_D15="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email = 'financeiro.d15@example.com'")"

# --- Node ad hoc: HS256 hand-rolled (crypto stdlib) + fetch direto ao
# PostgREST via hostname da rede docker do projeto. Roda dentro do
# mailpit-mock (node:20-alpine, já em pé, sem build) via `node -` (lê o
# script do stdin, mesmo padrão dos drivers existentes).
OUT="$(dc exec -T -e JWT_SECRET="$JWT_SECRET" mailpit-mock node - <<'JS'
const crypto = require('crypto');

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(claims) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = Object.assign({ role: 'authenticated' }, claims);
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', process.env.JWT_SECRET).update(h + '.' + p).digest());
  return h + '.' + p + '.' + sig;
}
async function rpc(fn, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch('http://postgrest:3000/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const text = await r.text();
  return { status: r.status, text };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  // ---- S1: 11 funções, corpo válido, SEM Authorization -----------------
  const zeroUuid = '00000000-0000-0000-0000-000000000000';
  const bodies = {
    hub_push_inscricao_registrar: { p_endpoint: 'x', p_endpoint_hash: 's1-a', p_p256dh: 'x', p_auth: 'x', p_key_id: 'k', p_plataforma: 'android', p_dispositivo_id: zeroUuid },
    hub_push_inscricao_revogar: { p_endpoint_hash: 's1-a', p_dispositivo_id: zeroUuid },
    hub_push_estado_reportar: { p_dispositivo_id: zeroUuid, p_estado: 'ativas', p_plataforma: 'android' },
    hub_aviso_para_motorista: { p_aviso_id: 1 },
    hub_aviso_alcance: { p_modo: 'toda_base', p_ids: [], p_key_id: 'k', p_fonte_conta: 'conta_motorista' },
    hub_aviso_criar: { p_titulo: 't', p_corpo: 'c', p_modo: 'toda_base', p_ids: [], p_chave_idempotencia: zeroUuid, p_key_id: 'k', p_fonte_conta: 'conta_motorista' },
    hub_aviso_resumo: { p_aviso_ids: [1] },
    hub_push_cobertura: {},
    hub_push_reivindicar: { p_aviso_id: 1, p_limite: 1, p_lease_segundos: 60, p_lease_token: zeroUuid, p_key_id: 'k' },
    hub_push_registrar_resultado: { p_entrega_id: 1, p_lease_token: zeroUuid, p_status: 'aceito', p_motivo: null, p_tentativas: 1 },
    hub_push_expurgo: {},
  };
  let s1ok = 0;
  const funcs = Object.keys(bodies);
  for (const f of funcs) {
    const r = await rpc(f, bodies[f], null);
    if (r.status === 401 || r.status === 403) s1ok++;
    else console.error('S1_INESPERADO', f, r.status, r.text.slice(0, 200));
  }
  console.log('S1=' + s1ok + '/' + funcs.length);

  // ---- S2: 11 inscrições do mesmo motorista ------------------------------
  const cnpjS2 = '33333333000155';
  const tokenMotoristaS2 = sign({ motorista_cnpj: cnpjS2 });
  for (let i = 0; i < 11; i++) {
    const body = {
      p_endpoint: 'https://push.example/s2-' + i,
      p_endpoint_hash: 's2-hash-' + i,
      p_p256dh: 'p256dh' + i,
      p_auth: 'auth' + i,
      p_key_id: 'keyid-s2',
      p_plataforma: 'android',
      p_dispositivo_id: '00000000-0000-0000-0000-0000000000' + String(10 + i),
    };
    const r = await rpc('hub_push_inscricao_registrar', body, tokenMotoristaS2);
    if (r.status >= 300) console.error('S2_FALHA', i, r.status, r.text.slice(0, 200));
    await sleep(30);
  }
  console.log('S2_CNPJ=' + cnpjS2);

  // ---- S4: hub_aviso_alcance toda_base, escopo admin = [6] ---------------
  const tokenAdmin = sign({ empresa_ativa: 6, escopo: [6] });
  const rAlcance = await rpc('hub_aviso_alcance', { p_modo: 'toda_base', p_ids: [], p_key_id: 'keyid-s4', p_fonte_conta: 'conta_motorista' }, tokenAdmin);
  let alcancados = [];
  try { alcancados = JSON.parse(rAlcance.text).map((r) => r.cnpj_prestador); } catch (e) { console.error('S4_PARSE_FALHOU', rAlcance.status, rAlcance.text.slice(0, 300)); }
  console.log('S4_STATUS=' + rAlcance.status);
  console.log('S4_ALCANCADOS=' + JSON.stringify(alcancados.sort()));

  // ---- S10: hub_jwt_motorista_cnpj() — 3 casos (via função que exige a
  // claim) + bônus hub_jwt_push_worker() ausente ---------------------------
  const casosS10 = [
    { nome: 'nula', claims: {} },
    { nome: 'vazia', claims: { motorista_cnpj: '' } },
    { nome: 'fora_14digitos', claims: { motorista_cnpj: '123' } },
  ];
  let s10ok = 0;
  for (const c of casosS10) {
    const t = sign(c.claims);
    const r = await rpc('hub_push_inscricao_registrar', { p_endpoint: 'x', p_endpoint_hash: 's10-' + c.nome, p_p256dh: 'x', p_auth: 'x', p_key_id: 'k', p_plataforma: 'android', p_dispositivo_id: zeroUuid }, t);
    if (r.status >= 400 && /CLAIM_MOTORISTA_CNPJ_AUSENTE/.test(r.text)) s10ok++;
    else console.error('S10_FALHA', c.nome, r.status, r.text.slice(0, 200));
  }
  console.log('S10=' + s10ok + '/3');

  const tokenSemWorker = sign({});
  const rWorker = await rpc('hub_push_expurgo', {}, tokenSemWorker);
  const workerOk = rWorker.status >= 400 && /CLAIM_HUB_PUSH_WORKER_AUSENTE/.test(rWorker.text) ? 1 : 0;
  if (!workerOk) console.error('S10_WORKER_FALHA', rWorker.status, rWorker.text.slice(0, 200));
  console.log('S10_WORKER=' + workerOk);
})().catch((e) => { console.error('EXCECAO_NODE', e); process.exit(1); });
JS
)"
echo "$OUT"

check "S1 (1.2.9): 11/11 funções recusadas sem Authorization" "$(printf '%s\n' "$OUT" | grep -o 'S1=[0-9]*/[0-9]*')" "S1=11/11"

CNPJ_S2="$(printf '%s\n' "$OUT" | grep -o 'S2_CNPJ=.*' | cut -d= -f2)"
N_S2="$(psql_t -tAc "SELECT count(*) FROM \"PushInscricao\" WHERE cnpj_prestador = '$CNPJ_S2'")"
check "S2 (1.2.10): exatamente 10 linhas em PushInscricao para o motorista" "$N_S2" "10"
EXISTE_S2_0="$(psql_t -tAc "SELECT EXISTS(SELECT 1 FROM \"PushInscricao\" WHERE endpoint_hash = 's2-hash-0')")"
check "S2 (1.2.10): a inscrição mais antiga (índice 0) foi removida" "$EXISTE_S2_0" "f"
EXISTE_S2_10="$(psql_t -tAc "SELECT EXISTS(SELECT 1 FROM \"PushInscricao\" WHERE endpoint_hash = 's2-hash-10')")"
check "S2 (1.2.10): a inscrição mais recente (índice 10) permanece" "$EXISTE_S2_10" "t"

ALCANCADOS="$(printf '%s\n' "$OUT" | grep -o 'S4_ALCANCADOS=.*')"
check "S4 (1.2.11): caso1 (só fora do grupo) NÃO alcançado" \
  "$(printf '%s' "$ALCANCADOS" | grep -c '22222222000101')" "0"
check "S4 (1.2.11): caso2 (sem vínculo) alcançado" \
  "$(printf '%s' "$ALCANCADOS" | grep -c '22222222000102')" "1"
check "S4 (1.2.11): caso3 (vínculo dentro do escopo) alcançado" \
  "$(printf '%s' "$ALCANCADOS" | grep -c '22222222000103')" "1"

check "S10 (1.2.12): motorista_cnpj nulo/vazio/malformado — 3/3 recusados" "$(printf '%s\n' "$OUT" | grep -o 'S10=[0-9]*/[0-9]*')" "S10=3/3"
check "S10 (1.2.12): bônus hub_jwt_push_worker() ausente — recusado" "$(printf '%s\n' "$OUT" | grep -o 'S10_WORKER=[0-9]*' | cut -d= -f2)" "1"

# --- D-15 (adiantamento-motorista FASE 5, tasks 5.1.3/5.1.4/5.2/5.3.3) ------
# Regressão do próprio hub_aviso_criar/hub_aviso_para_motorista alterados em
# 0068: histórico gravado para o público TOTAL (com e sem push), AvisoEntrega
# continua só para quem tem push, e SEM_DESTINATARIOS substitui
# SEM_INSCRICOES_ATIVAS. Via psql direto (dono da tabela) + set_config da
# claim (mesmo padrão de hub-adiantamentos-integration.sh), já que exercita
# só a camada SQL — a tradução HTTP já é coberta por hub-avisos-rotas-unit.test.js.
D15_CRIAR_OUT="$(psql_t -tA -F'|' -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', $SUB_D15, 'empresa_ativa', '6', 'escopo', jsonb_build_array(6))::text, true);
SET ROLE authenticated;
SELECT * FROM hub_aviso_criar('D15 aviso', 'D15 corpo', 'toda_base', ARRAY[]::int[], gen_random_uuid(), 'keyid-d15', 'conta_motorista');
COMMIT;
SQL
)"
D15_AVISO_ID="$(printf '%s\n' "$D15_CRIAR_OUT" | grep -E '^[0-9]+\|' | tail -n1 | cut -d'|' -f1 | tr -d ' ')"
check "D-15/5.1.3: hub_aviso_criar (toda_base, 1 conta sem push no público) não lança erro" \
  "$(printf '%s' "$D15_CRIAR_OUT" | grep -c 'ERROR')" "0"

N_NOTIF_COMPUSH="$(psql_t -tAc "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE aviso_id = $D15_AVISO_ID AND cnpj_prestador = '44444444000101'")"
check "D-15/5.1.3: NotificacaoMotorista gravada para o CNPJ COM push" "$N_NOTIF_COMPUSH" "1"
N_NOTIF_SEMPUSH="$(psql_t -tAc "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE aviso_id = $D15_AVISO_ID AND cnpj_prestador = '44444444000102'")"
check "D-15/5.1.3/5.3.3/FR-044: NotificacaoMotorista gravada TAMBÉM para o CNPJ SEM push" "$N_NOTIF_SEMPUSH" "1"
N_ENTREGA_SEMPUSH="$(psql_t -tAc "SELECT count(*) FROM \"AvisoEntrega\" WHERE aviso_id = $D15_AVISO_ID AND cnpj_prestador = '44444444000102'")"
check "D-15/5.1.3: AvisoEntrega NÃO gravada para quem não tem push (continua só push)" "$N_ENTREGA_SEMPUSH" "0"

D15_PARA_MOTORISTA_OUT="$(psql_t -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('motorista_cnpj', '44444444000102')::text, true);
SET ROLE authenticated;
SELECT * FROM hub_aviso_para_motorista($D15_AVISO_ID);
ROLLBACK;
SQL
)"
check "D-15/5.1.3: hub_aviso_para_motorista autoriza o motorista SEM push (via NotificacaoMotorista)" \
  "$(printf '%s' "$D15_PARA_MOTORISTA_OUT" | grep -c 'D15 aviso')" "1"

D15_SEM_DESTINATARIOS_OUT="$(psql_t -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', $SUB_D15, 'empresa_ativa', '6', 'escopo', jsonb_build_array(6))::text, true);
SET ROLE authenticated;
SELECT * FROM hub_aviso_criar('D15 vazio', 'D15 vazio corpo', 'individual', ARRAY[999999999], gen_random_uuid(), 'keyid-d15', 'conta_motorista');
ROLLBACK;
SQL
)"
check "D-15/5.3.2: público total vazio -> SEM_DESTINATARIOS (não mais SEM_INSCRICOES_ATIVAS)" \
  "$(printf '%s' "$D15_SEM_DESTINATARIOS_OUT" | grep -c 'SEM_DESTINATARIOS')" "1"

echo "-----------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  echo "RESULTADO: TODOS OS CHECKS PASSARAM"
else
  echo "RESULTADO: $fails CHECK(S) FALHARAM"
fi
exit "$fails"
