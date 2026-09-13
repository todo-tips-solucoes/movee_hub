#!/usr/bin/env bash
# =============================================================================
# hub-push-worker-integration.sh — tasks 5.2.1/5.2.3/5.2.4/5.3.2/5.3.3 (tasks.md
# FASE 5, feature "Notificações push no app do motorista"): prova E2E REAL
# (compose hub-test efêmero) do worker de envio (lib/hub-push-worker.js),
# retomada no boot (FR-018) e expurgo de 90 dias (FR-030) — complementa
# tests/hub-push-worker-unit.test.js (mocks) com Postgres real e, para 5.2.1,
# o boot real do backend (Dockerfile.hub) com a chave VAPID cujo `subject` foi
# definido pelo operador em 2026-09-11 (dec-095/dec-096:
# https://app.moveelog.com.br).
#
# 5.2.3/5.2.4/5.3.2/5.3.3 chamam as funções SECURITY DEFINER (hub_push_
# reivindicar/hub_aviso_criar/hub_push_expurgo) DIRETO via psql, setando a GUC
# `request.jwt.claims` (mesma que hub_jwt_claims()/hub_jwt_escopo_ids()/
# hub_jwt_push_worker() leem — migration 0006:35-53) na própria sessão —
# sem precisar subir postgrest nem assinar JWT: o `DB_USER` já é o dono das
# funções/tabelas (bypassa RLS, mesmo padrão de hub-avisos-modulo-integration.sh).
# Só 5.2.1 precisa do stack completo (db+postgrest+backend), porque o que está
# em prova ali é o BOOT real do processo (server.js chamando
# hubPushWorker.retomarAvisosPendentes() de verdade).
#
# IDs gerados por INSERT são recuperados por uma SELECT SEPARADA usando uma
# chave literal conhecida (chave_idempotencia/endpoint_hash/cnpj_prestador
# gerados no bash, nunca `RETURNING` capturado com `-tAc`): psql em modo
# tuples-only ainda imprime o command tag ("INSERT 0 1") numa linha à parte
# quando a instrução é INSERT — mesmo com RETURNING — e concatenar as duas
# linhas via `tr -d '[:space:]'` corrompe o valor (visto nesta sessão:
# "1INSERT01"). Mesmo motivo pelo qual hub-auditoria-integration.sh nunca usa
# RETURNING capturado — sempre INSERT seguido de SELECT.
#
# Cobre:
#   5.2.3 — mecanismo real de "0 reenvio após reinício" (SC-010/FR-018):
#     semeia 1 aviso com 4 entregas simulando um crash no meio do lote —
#     aceito / processando+lease válido / processando+lease EXPIRADO / pendente
#     — chama hub_push_reivindicar() (a MESMA função que o worker chama) como
#     se fosse a retomada pós-reinício, e confirma que só a expirada
#     (recuperação segura) e a pendente (trabalho real) mudam de estado — a já
#     aceita e a em voo com lease ainda válido ficam INTOCADAS.
#   5.2.4 — duplo disparo concorrente da MESMA chave de idempotência: 2
#     sessões psql paralelas (cada uma com pg_sleep antes da chamada, para
#     forçar sobreposição real da janela SELECT-then-INSERT de
#     hub_aviso_criar) chamando hub_aviso_criar(...) simultaneamente ->
#     exatamente 1 "Aviso" e 1 conjunto de "AvisoEntrega" (FR-018/SC-010),
#     mesmo que uma das 2 chamadas erre por violação do UNIQUE
#     (criado_por, chave_idempotencia).
#   5.3.2 — fixture com 3 avisos (criado_em a 91/89/30 dias) ->
#     hub_push_expurgo() remove exatamente 1 (91 dias) e mantém 2.
#   5.3.3 — o registro de Auditoria (aviso_disparado) do aviso expurgado NÃO é
#     removido pelo expurgo de 90 dias (permanece sob a política de 12 meses
#     de hub_auditoria_expurgo, migration 0041).
#   5.2.1 — boot REAL do backend (build via Dockerfile.hub, mesmo padrão de
#     1.4.3/hub-avisos-modulo-integration.sh) com um aviso 'na_fila' semeado
#     ANTES do boot, apontando para um endpoint fora da allowlist padrão:
#     confirma que retomarAvisosPendentes() (chamada real de server.js no
#     boot) reivindica a entrega e o worker a processa de verdade (pendente
#     -> falha/envio_bloqueado — sem precisar de nenhum push-mock, já que o
#     bloqueio pela allowlist acontece ANTES do envio real) e 0 ocorrências de
#     PUSH_INDISPONIVEL no log de boot (chave com subject
#     https://app.moveelog.com.br carregada com sucesso).
#
# Uso: infra/hub/testes/hub-push-worker-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
VAPID_KEYS_FILE="$(get_var VAPID_KEYS_FILE "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$VAPID_KEYS_FILE" ] || { echo "HUB_DB_USER/HUB_DB_NAME/VAPID_KEYS_FILE ausentes em $ENV_FILE" >&2; exit 2; }
KEYID_ATIVO="$(jq -r '.keyId' "$VAPID_KEYS_FILE" 2>/dev/null)"
[ -n "$KEYID_ATIVO" ] && [ "$KEYID_ATIVO" != "null" ] || { echo "keyId ausente em $VAPID_KEYS_FILE" >&2; exit 2; }
newuuid() { cat /proc/sys/kernel/random/uuid; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "df -h / e swap antes do build:"; df -h /; swapon --show

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db efêmero ($PROJECT)…"
dc up -d --wait db

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

echo "aplicando migrations completas…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1 \
  || { echo "FAIL: migrate.sh retornou erro:"; tail -80 "$TMP/migrate.log"; exit 1; }

psql_t -c "INSERT INTO \"Usuario\" (email, senha_hash, nome, ativo) VALUES ('push-worker-int@example.test','x','Push Worker Integration',true);" >/dev/null
UID_TESTE="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='push-worker-int@example.test';")"
[ -n "$UID_TESTE" ] || { echo "FAIL: seed de Usuario falhou"; exit 1; }

# ── 5.2.3 — retomada sem reenvio (mecanismo real hub_push_reivindicar) ─────
CHAVE_523="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,iniciado_em) VALUES (6,'Teste 5.2.3','corpo teste 5.2.3','toda_base','{}'::int[],'em_andamento','$CHAVE_523',$UID_TESTE,now());" >/dev/null
AVISO_523="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_523';")"
psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('55555555000199','https://push.example/523','hash-523','dummy-p256dh','dummy-auth','testkeyid-523','android','$(newuuid)');" >/dev/null
INSC_523="$(psql_t -tAc "SELECT id FROM \"PushInscricao\" WHERE endpoint_hash='hash-523';")"
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status) VALUES ($AVISO_523,'11111111000100','aceito');" >/dev/null
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status,lease_ate,lease_token) VALUES ($AVISO_523,'22222222000100','processando', now() + interval '60 seconds', '$(newuuid)');" >/dev/null
LEASE_E2_ANTES="$(psql_t -tAc "SELECT lease_token FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_523 AND cnpj_prestador='22222222000100';")"
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status,lease_ate,lease_token) VALUES ($AVISO_523,'33333333000100','processando', now() - interval '5 seconds', '$(newuuid)');" >/dev/null
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,inscricao_id,cnpj_prestador,status) VALUES ($AVISO_523,$INSC_523,'55555555000199','pendente');" >/dev/null

psql_t -tAc "SET request.jwt.claims='{\"hub_push_worker\":true}'; SELECT * FROM hub_push_reivindicar($AVISO_523, 50, 120, '$(newuuid)', 'testkeyid-523');" >"$TMP/523-reivindicar.log" 2>&1
cat "$TMP/523-reivindicar.log"

check "5.2.3: entrega já 'aceito' antes do restart continua intocada" "$(psql_t -tAc "SELECT status FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_523 AND cnpj_prestador='11111111000100';")" "aceito"
check "5.2.3: entrega 'processando' com lease AINDA válido não é reclamada (0 reenvio)" "$(psql_t -tAc "SELECT status FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_523 AND cnpj_prestador='22222222000100';")" "processando"
check "5.2.3: lease_token da entrega em voo (lease válido) não mudou" "$(psql_t -tAc "SELECT lease_token FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_523 AND cnpj_prestador='22222222000100';")" "$LEASE_E2_ANTES"
check "5.2.3: entrega 'processando' com lease EXPIRADO vira falha/interrompida (recuperação segura, sem reenvio)" "$(psql_t -tAc "SELECT status||'/'||motivo FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_523 AND cnpj_prestador='33333333000100';")" "falha/interrompida"
check "5.2.3: entrega 'pendente' de fato é reivindicada nesta retomada" "$(psql_t -tAc "SELECT status FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_523 AND cnpj_prestador='55555555000199';")" "processando"

# ── 5.2.4 — duplo disparo concorrente da mesma chave de idempotência ───────
psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo) VALUES ('66666666000188','Motorista Teste 524',true);" >/dev/null
psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('66666666000188','https://push.example/524','hash-524','dummy-p256dh','dummy-auth','testkeyid-524','android','$(newuuid)');" >/dev/null
CHAVE_524="$(newuuid)"

cat >"$TMP/524.sql" <<SQL
BEGIN;
SELECT pg_sleep(0.3);
SET LOCAL request.jwt.claims = '{"sub":$UID_TESTE,"empresa_ativa":6,"escopo":[6]}';
SELECT * FROM hub_aviso_criar('Teste 524','corpo teste 524','toda_base','{}'::int[], '$CHAVE_524'::uuid, 'testkeyid-524', 'legado');
COMMIT;
SQL

dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" < "$TMP/524.sql" >"$TMP/524-a.log" 2>&1 &
PID_A=$!
dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" < "$TMP/524.sql" >"$TMP/524-b.log" 2>&1 &
PID_B=$!
wait "$PID_A"; wait "$PID_B"
echo "--- 524 sessão A ---"; cat "$TMP/524-a.log"
echo "--- 524 sessão B ---"; cat "$TMP/524-b.log"

N_AVISO_524="$(psql_t -tAc "SELECT count(*) FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_524';")"
check "5.2.4: exatamente 1 Aviso criado sob duplo disparo concorrente (mesma chave)" "$N_AVISO_524" "1"
AVISO_524_ID="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_524';")"
N_ENTREGA_524="$(psql_t -tAc "SELECT count(*) FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_524_ID;")"
check "5.2.4: exatamente 1 conjunto de entregas processado (1 inscrição visada, não 2)" "$N_ENTREGA_524" "1"

# ── 5.3.2/5.3.3 — expurgo de 90 dias e auditoria sobrevivente ──────────────
CHAVE_91="$(newuuid)"; CHAVE_89="$(newuuid)"; CHAVE_30="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,criado_em) VALUES (6,'Expurgo 91','corpo 91','toda_base','{}'::int[],'concluido','$CHAVE_91',$UID_TESTE, now() - interval '91 days');" >/dev/null
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,criado_em) VALUES (6,'Expurgo 89','corpo 89','toda_base','{}'::int[],'concluido','$CHAVE_89',$UID_TESTE, now() - interval '89 days');" >/dev/null
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,criado_em) VALUES (6,'Expurgo 30','corpo 30','toda_base','{}'::int[],'concluido','$CHAVE_30',$UID_TESTE, now() - interval '30 days');" >/dev/null
A91="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_91';")"
A89="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_89';")"
A30="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_30';")"
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status) VALUES ($A91,'77777777000100','aceito');" >/dev/null
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status) VALUES ($A89,'77777777000200','aceito');" >/dev/null
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status) VALUES ($A30,'77777777000300','aceito');" >/dev/null
psql_t -c "INSERT INTO \"Auditoria\" (id_empresa,usuario_id,acao,recurso,recurso_id,detalhes) VALUES (6, NULL, 'aviso_disparado', 'Aviso', '$A91', '{}'::jsonb);" >/dev/null

RESULT_EXPURGO="$(psql_t -tAc "SET request.jwt.claims='{\"hub_push_worker\":true}'; SELECT avisos_removidos||'/'||entregas_removidas FROM hub_push_expurgo();")"
check "5.3.2: hub_push_expurgo() remove exatamente 1 aviso e 1 entrega (só o de 91 dias)" "$RESULT_EXPURGO" "1/1"
check "5.3.2: aviso de 91 dias removido de fato" "$(psql_t -tAc "SELECT count(*) FROM \"Aviso\" WHERE id=$A91;")" "0"
check "5.3.2: avisos de 89 e 30 dias mantidos (2/2)" "$(psql_t -tAc "SELECT count(*) FROM \"Aviso\" WHERE id IN ($A89,$A30);")" "2"
check "5.3.3: Auditoria (aviso_disparado) do aviso expurgado NÃO é removida" "$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE recurso='Aviso' AND recurso_id='$A91';")" "1"

# ── 5.2.1 — boot real com retomada de aviso pendente ───────────────────────
CHAVE_521="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por) VALUES (6,'Retomada no boot','corpo retomada boot','toda_base','{}'::int[],'na_fila','$CHAVE_521',$UID_TESTE);" >/dev/null
AVISO_521="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_521';")"
psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('99999999000100','https://nao-permitido.example.test/push/521','hash-521','dummy-p256dh','dummy-auth','$KEYID_ATIVO','android','$(newuuid)');" >/dev/null
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,inscricao_id,cnpj_prestador,status) VALUES ($AVISO_521,(SELECT id FROM \"PushInscricao\" WHERE endpoint_hash='hash-521'),'99999999000100','pendente');" >/dev/null

echo "subindo postgrest…"
dc up -d --wait postgrest

echo "buildando backend (Dockerfile.hub, --memory=2g)…"
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend"; tail -80 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

echo "aguardando boot do backend…"
BOOT_OK=0
for _ in 1 2 3 4 5 6; do
  dc logs backend >"$TMP/backend-boot.log" 2>&1
  if grep -q "Servidor rodando na porta 3000" "$TMP/backend-boot.log"; then BOOT_OK=1; break; fi
  sleep 3
done
check "5.2.1: backend terminou o boot ('Servidor rodando na porta 3000')" "$BOOT_OK" "1"
check "5.2.1: 0 ocorrências de PUSH_INDISPONIVEL no log de boot (subject https://app.moveelog.com.br OK)" \
  "$(grep -c "PUSH_INDISPONIVEL" "$TMP/backend-boot.log")" "0"

echo "aguardando retomada processar a entrega semeada…"
E521_OK=0
for _ in 1 2 3 4 5 6; do
  ST="$(psql_t -tAc "SELECT status FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_521 AND cnpj_prestador='99999999000100';")"
  if [ "$ST" != "pendente" ] && [ "$ST" != "processando" ]; then E521_OK=1; break; fi
  sleep 3
done
check "5.2.1: retomarAvisosPendentes() reivindicou e o worker processou a entrega de verdade" "$E521_OK" "1"
check "5.2.1: entrega finalizou 'falha/envio_bloqueado' (host fora da allowlist padrão, sem push-mock)" \
  "$(psql_t -tAc "SELECT status||'/'||motivo FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_521 AND cnpj_prestador='99999999000100';")" "falha/envio_bloqueado"
check "5.2.1: PushChaveVapid registrada com o keyId ativo (dec-096)" \
  "$(psql_t -tAc "SELECT count(*) FROM \"PushChaveVapid\" WHERE key_id='$KEYID_ATIVO';")" "1"

echo "-----------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  echo "RESULTADO: TODOS OS CHECKS PASSARAM"
else
  echo "RESULTADO: $fails CHECK(S) FALHARAM"
fi
exit "$fails"
