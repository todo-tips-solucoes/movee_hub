#!/usr/bin/env bash
# =============================================================================
# hub-avisos-e2e-browser.sh — tasks.md FASE 9.4.1/9.4.3 (feature "Notificações
# push no app do motorista"): E2E de BROWSER de /hub/dashboard/avisos +
# /hub/dashboard/avisos/[id], cobrindo 7.2.4 (cobertura por número), 7.3.5
# (3 modos + alcance + 0-inscrições bloqueia + duplo-clique = 1 requisição),
# 7.4.2 (polling para exatamente ao atingir concluido), 8.2.3 (teclado),
# 8.2.4 (axe).
#
# Ambiente: stack efêmero hub-test-<runid> (compose.hub.test.yml — mesmo
# molde de hub-avisos-integration.sh: db+postgrest+push-mock+backend, série
# de migrations completa aplicada do zero). NÃO usa hub-homolog: no momento
# em que este driver foi escrito, hub-homolog ainda não tinha as migrations
# 0061/0062/0063 aplicadas nem os containers rebuilded com este código
# (tasks.md 9.7 cobre esse rebuild, deliberadamente à parte — ver
# docs/specs/envioMassa_homologacao/tasks.md FASE 9.7).
#
# SEM serviço de frontend novo no compose: `next build && next start` roda
# DENTRO do próprio container oficial `mcr.microsoft.com/playwright` (bind
# mount do host, SEM `npm install` — reusa node_modules já instalado, mesmo
# cuidado de hub-motorista-360-e2e-browser.sh quanto ao gotcha de
# package-lock.json). Frontend e Playwright ficam no MESMO container
# (falam por 127.0.0.1); só o `backend` é outro container, alcançado pelo
# nome do serviço via `docker run --network <project>_default` (rede
# default do projeto compose — descoberta em runtime, nunca hardcoded).
# BACKEND_URL/HUB_BACKEND_URL são lidos em RUNTIME pelo proxy Next
# (app/api/[...path]/route.ts), não inlinados — não precisam estar
# presentes durante `next build`, só durante `next start` (estão nas duas
# fases aqui, sem problema).
#
# APP_ENV=dev -> cookiesSaoSeguras() (routes/hub-auth.js) retorna
# secure=false: os cookies de sessão funcionam sobre HTTP simples, sem TLS
# ad-hoc só para este driver (mesmo espírito do push-mock, que gera o seu
# próprio cert self-signed para o WEB PUSH em si).
#
# Uso: infra/hub/testes/hub-avisos-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/envioMassa_homologacao/evidencias/9.4"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/9.4.1-e2e-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
VAPID_KEYS_FILE="$(get_var VAPID_KEYS_FILE "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$VAPID_KEYS_FILE" ] || { echo "HUB_DB_USER/HUB_DB_NAME/VAPID_KEYS_FILE ausentes em $ENV_FILE" >&2; exit 2; }
KEYID_ATIVO="$(jq -r '.keyId' "$VAPID_KEYS_FILE" 2>/dev/null)"
[ -n "$KEYID_ATIVO" ] && [ "$KEYID_ATIVO" != "null" ] || { echo "keyId ausente em $VAPID_KEYS_FILE" >&2; exit 2; }
newuuid() { cat /proc/sys/kernel/random/uuid; }

# dec-122 (mesmo achado de hub-avisos-integration.sh): .env.hub.test tem
# POSTGREST_API_KEY != PGRST_JWT_SECRET; lib/postgrest.js assina com
# POSTGREST_API_KEY e este PostgREST efêmero só aceita PGRST_JWT_SECRET.
# Override só nesta sessão de shell — nunca escreve no arquivo compartilhado.
PGRST_JWT_SECRET_VAL="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$PGRST_JWT_SECRET_VAL" ] || { echo "PGRST_JWT_SECRET ausente em $ENV_FILE" >&2; exit 2; }
export POSTGREST_API_KEY="$PGRST_JWT_SECRET_VAL"
export PUSH_HOSTS_PERMITIDOS="push-mock"

read -r PDH AUTHK <<EOF
$(node -e "const c=require('crypto');const e=c.createECDH('prime256v1');e.generateKeys();console.log(e.getPublicKey().toString('base64url'),c.randomBytes(16).toString('base64url'));")
EOF
[ -n "$PDH" ] && [ -n "$AUTHK" ] || { echo "FAIL: geração do par p256dh/auth falhou"; exit 1; }

TLS_DIR="$HUB_DIR/mocks/push-mock/tls"
mkdir -p "$TLS_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
  -subj "/CN=push-mock" \
  -addext "subjectAltName=DNS:push-mock" \
  -addext "basicConstraints=critical,CA:true" >"$TMP/openssl.log" 2>&1 \
  || { echo "FAIL: geração do cert/key do push-mock"; cat "$TMP/openssl.log"; exit 1; }
chmod 644 "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_val() { psql_t -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

cleanup() {
  echo; echo "=== cleanup: derrubando stack $PROJECT (down -v) ==="
  dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
  rm -f "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"
  echo "=== conferindo package-lock.json (gotcha do container Playwright) ==="
  if ! git -C "$FRONTEND_DIR" diff --quiet -- package-lock.json 2>/dev/null; then
    echo "AVISO: package-lock.json foi alterado pelo container — revertendo" >&2
    git -C "$FRONTEND_DIR" checkout -- package-lock.json
  else
    echo "package-lock.json intacto"
  fi
  echo "=== sobras hub-test-* (deve ser 0) ==="
  docker ps -a --format '{{.Names}}' | grep '^hub-test-' || echo "(nenhuma)"
  docker volume ls --format '{{.Name}}' | grep '^hub-test-' || echo "(nenhum volume)"
  echo "=== estado do host DEPOIS ==="; free -h; df -h /
}
trap cleanup EXIT

echo "df -h / e swap antes do build:"; df -h /; swapon --show
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
SWAP_FREE_KB=$(awk '/SwapFree/{print $2}' /proc/meminfo)
DISK_AVAIL_KB=$(df -Pk / | awk 'NR==2{print $4}')
if [ "${AVAIL_KB:-0}" -lt 2097152 ]; then
  echo "ABORTADO: RAM disponível < 2Gi — não prosseguir (lição 2026-06-11)" >&2; exit 2
fi
if [ "${SWAP_FREE_KB:-0}" -lt 1048576 ]; then
  echo "ABORTADO: swap livre < 1Gi — não prosseguir" >&2; exit 2
fi
if [ "${DISK_AVAIL_KB:-0}" -lt 5242880 ]; then
  echo "ABORTADO: disco livre em / < 5Gi — não prosseguir (lição 2026-08-30)" >&2; exit 2
fi
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+push-mock efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait push-mock

echo "rodando migrate.sh (série completa, inclusive 0061/0062/0063)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
for m in 0061_push_avisos.sql 0062_modulo_avisos.sql 0063_auditoria_push_worker.sql 0064_push_registrar_resultado_finaliza_aviso.sql; do
  grep -q "$m" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo ($m ausente)"; tail -80 "$TMP/migrate.log"; exit 1; }
done

echo "df -h / antes do build do backend:"; df -h /
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -100 "$TMP/build.log"; exit 1; }
dc up -d --wait backend
sleep 2
echo "--- boot log (linhas 'push:'/'boot'/AUDITORIA_PERDIDA) ---"
dc logs backend 2>&1 | grep -iE "push|boot|AUDITORIA_PERDIDA" || echo "(nenhuma linha push/boot/auditoria-perdida no log de boot)"

# ─────────────────────────────────────────────────────────────────────────────
# dec-123 (onda-023): confirma que a chave VAPID foi auditada SEM cair em
# AUDITORIA_PERDIDA — prova viva da migration 0063 + claims.hubPushWorker.
# ─────────────────────────────────────────────────────────────────────────────
AUDITORIA_CHAVE="$(psql_val "SELECT count(*) FROM \"Auditoria\" WHERE acao IN ('push_chave_registrada','push_chave_substituida');")"
if [ "$AUDITORIA_CHAVE" = "0" ]; then
  echo "FAIL: dec-123 — nenhum evento push_chave_registrada/substituida na Auditoria (RLS ainda bloqueando?)"
  exit 1
fi
echo "PASS: dec-123 — $AUDITORIA_CHAVE evento(s) de chave VAPID auditado(s) com sucesso (migration 0063 confirmada em ambiente vivo)"

# ─────────────────────────────────────────────────────────────────────────────
# Seed: 1 Usuario admin (empresa 6 = grupo Movee, papel admin_entidade).
# ─────────────────────────────────────────────────────────────────────────────
SENHA_OK='SenhaSinteticaAvisosBrowser#1'
HASH_OK="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }
ADMIN_EMAIL="avisos-browser-admin@example.test"
psql_t -c "INSERT INTO \"Usuario\" (email, senha_hash, nome, ativo) VALUES ('$ADMIN_EMAIL','$HASH_OK','E2E Browser Avisos Admin',true);" >/dev/null
UID_ADMIN="$(psql_val "SELECT id FROM \"Usuario\" WHERE email='$ADMIN_EMAIL';")"
PAPEL_ADMIN_ENTIDADE="$(psql_val "SELECT id FROM \"Papel\" WHERE nome='admin_entidade';")"
[ -n "$UID_ADMIN" ] && [ -n "$PAPEL_ADMIN_ENTIDADE" ] || { echo "FAIL: seed de Usuario/Papel"; exit 1; }
psql_t -c "INSERT INTO \"UsuarioEntidade\" (usuario_id, empresa_id, papel_id, ativo) VALUES ($UID_ADMIN, 6, $PAPEL_ADMIN_ENTIDADE, true);" >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Seed: cobertura (PushEstadoAtivacao) — 6 linhas, números conhecidos
# (7.2.4). desktop_outros/sem_suporte ficam em 0 por AUSÊNCIA de linha.
# ─────────────────────────────────────────────────────────────────────────────
psql_t <<SQL >/dev/null
INSERT INTO "PushEstadoAtivacao" (dispositivo_id, cnpj_prestador, estado, plataforma) VALUES
  ('$(newuuid)', '90000000000301', 'ativas', 'android'),
  ('$(newuuid)', '90000000000302', 'ativas', 'android'),
  ('$(newuuid)', '90000000000303', 'ativas', 'ios'),
  ('$(newuuid)', '90000000000304', 'ios_sem_instalacao', 'ios'),
  ('$(newuuid)', '90000000000305', 'bloqueadas', 'android'),
  ('$(newuuid)', '90000000000306', 'nao_ativadas', 'android');
SQL
COB_ANDROID=2; COB_IOS=1; COB_DESKTOP=0; COB_IOS_SEM_INST=1; COB_BLOQUEADAS=1; COB_SEM_SUPORTE=0; COB_NAO_ATIVADAS=1

# ─────────────────────────────────────────────────────────────────────────────
# Seed: Entregador "ComInscr..." (Motorista+ContaMotorista+PushInscricao real,
# push-mock programado 201) e Entregador "SemInscr..." (ContaMotorista SEM
# PushInscricao -> 0 alcance). `Entregador.motorista_id` tem FK física para
# "ContaMotorista" (fk_entregador_conta_motorista, achado desta suíte —
# comentário da migration 0010 ["sem FK física"] está desatualizado) — os
# DOIS fixtures precisam de uma ContaMotorista real, só o 2º fica sem
# PushInscricao. Prefixos DISTINTOS nos 8 primeiros chars — a busca usa
# slice(0,8).
# ─────────────────────────────────────────────────────────────────────────────
NOME_COM="ComInscrE2E Browser Motorista"
NOME_SEM="SemInscrE2E Browser Motorista"
CNPJ_COM=90000000000401
CNPJ_SEM=90000000000402

psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo) VALUES ('$CNPJ_COM','Motorista Teste Browser',true) ON CONFLICT DO NOTHING;" >/dev/null
# D-15 (adiantamento-motorista FASE 5, 10.2.3 — achado desta suíte): sem esta
# linha, hub_aviso_publico (fonte_conta='legado' — HUB_MOTORISTA_LOGIN_CONTA_ATIVA
# não é setada neste driver) não enxerga CNPJ_SEM em nenhum modo (a tabela
# "Motorista" legada é a ÚNICA fonte de "público" sob fonte_conta='legado'),
# fazendo `motoristas=0` mesmo ele existindo como Entregador+ContaMotorista —
# antes do D-15 isso não importava (só PushInscricao contava para `alcance`).
psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo) VALUES ('$CNPJ_SEM','Motorista Teste Browser Sem Push',true) ON CONFLICT DO NOTHING;" >/dev/null
psql_t -c "INSERT INTO \"ContaMotorista\" (cnpj_prestador, nome, ativo) VALUES ('$CNPJ_COM','$NOME_COM',true) ON CONFLICT (cnpj_prestador) DO NOTHING;" >/dev/null
psql_t -c "INSERT INTO \"ContaMotorista\" (cnpj_prestador, nome, ativo) VALUES ('$CNPJ_SEM','$NOME_SEM',true) ON CONFLICT (cnpj_prestador) DO NOTHING;" >/dev/null
CONTA_COM_ID="$(psql_val "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='$CNPJ_COM';")"
CONTA_SEM_ID="$(psql_val "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='$CNPJ_SEM';")"
[ -n "$CONTA_COM_ID" ] && [ -n "$CONTA_SEM_ID" ] || { echo "FAIL: seed de ContaMotorista"; exit 1; }

psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome, motorista_id, ativo) VALUES (6, '$(newuuid)', '$NOME_COM', $CONTA_COM_ID, true);" >/dev/null
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome, motorista_id, ativo) VALUES (6, '$(newuuid)', '$NOME_SEM', $CONTA_SEM_ID, true);" >/dev/null

psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('$CNPJ_COM','https://push-mock:8443/e/cominscr','hash-cominscr','$PDH','$AUTHK','$KEYID_ATIVO','android','$(newuuid)') ON CONFLICT DO NOTHING;" >/dev/null

PROGRAM_OUT="$(run_node <<'JS'
const https = require('https');
const fs = require('fs');
const ca = fs.readFileSync('/etc/push-mock-ca/cert.pem');
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: 'push-mock', port: 8443, path, method: 'POST', ca,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
post('/_programar', { path: '/e/cominscr', respostas: [201] })
  .then((r) => console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status })))
  .catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$PROGRAM_OUT" | grep -v '___RESULT_JSON___'
echo "$PROGRAM_OUT" | grep -q '"status":200' || { echo "FAIL: /_programar não respondeu 200"; exit 1; }
echo "PASS: push-mock programado (/e/cominscr -> 201)"

# ─────────────────────────────────────────────────────────────────────────────
# Frontend + Playwright no MESMO container oficial (sem imagem nova, sem
# `npm install` — ver cabeçalho). Rede do projeto compose descoberta em runtime.
# ─────────────────────────────────────────────────────────────────────────────
NET="$(docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Name}}' | head -1)"
[ -n "$NET" ] || { echo "FAIL: rede docker do projeto $PROJECT não encontrada"; exit 1; }
echo "rede docker do projeto: $NET"

echo "df -h / antes do build do frontend (dentro do container Playwright):"; df -h /
set -o pipefail
docker run --rm --memory=1536m --network "$NET" \
  -e BACKEND_URL="http://backend:3000" \
  -e HUB_BACKEND_URL="http://backend:3000/api" \
  -e APP_ENV=dev \
  -e NODE_ENV=production \
  -e HUB_E2E_BASE_URL="http://127.0.0.1:3005" \
  -e HUB_E2E_ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e HUB_E2E_ADMIN_SENHA="$SENHA_OK" \
  -e HUB_E2E_COBERTURA_ANDROID="$COB_ANDROID" \
  -e HUB_E2E_COBERTURA_IOS="$COB_IOS" \
  -e HUB_E2E_COBERTURA_DESKTOP="$COB_DESKTOP" \
  -e HUB_E2E_COBERTURA_IOS_SEM_INSTALACAO="$COB_IOS_SEM_INST" \
  -e HUB_E2E_COBERTURA_BLOQUEADAS="$COB_BLOQUEADAS" \
  -e HUB_E2E_COBERTURA_SEM_SUPORTE="$COB_SEM_SUPORTE" \
  -e HUB_E2E_COBERTURA_NAO_ATIVADAS="$COB_NAO_ATIVADAS" \
  -e HUB_E2E_ENTREGADOR_COM_INSCRICAO_NOME="$NOME_COM" \
  -e HUB_E2E_ENTREGADOR_SEM_INSCRICAO_NOME="$NOME_SEM" \
  -e HUB_E2E_EMPRESA_NOME="Empresa #6" \
  -e CI=true \
  -v "$FRONTEND_DIR:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc '
    set -e
    npm run build > /tmp/next-build.log 2>&1 || { echo "BUILD_FAILED"; tail -150 /tmp/next-build.log; exit 1; }
    (PORT=3005 HOSTNAME=0.0.0.0 npx next start -p 3005 -H 0.0.0.0 > /tmp/next-start.log 2>&1 &)
    ok=""
    for i in $(seq 1 30); do
      curl -sf -o /dev/null http://127.0.0.1:3005/hub/login && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || { echo "FRONTEND_NAO_SUBIU"; cat /tmp/next-start.log; exit 1; }
    npx playwright test -c playwright.config.hub-avisos.ts
  ' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

echo
if [ "$PW_EXIT" != "0" ]; then
  echo "=== diagnostico (falha) — Aviso/AvisoEntrega/PushInscricao/PushChaveVapid ==="
  psql_t -c "SELECT id, status, iniciado_em, concluido_em FROM \"Aviso\" ORDER BY id DESC LIMIT 3;" || true
  psql_t -c "SELECT id, aviso_id, inscricao_id, cnpj_prestador, status, motivo, tentativas, lease_ate, lease_token FROM \"AvisoEntrega\" ORDER BY id DESC LIMIT 5;" || true
  psql_t -c "SELECT id, cnpj_prestador, key_id, endpoint FROM \"PushInscricao\" WHERE cnpj_prestador='$CNPJ_COM';" || true
  psql_t -c "SELECT key_id, ativada_em FROM \"PushChaveVapid\" ORDER BY ativada_em DESC;" || true
  echo "--- push-mock log (via backend CA, verifica se a requisicao chegou) ---"
  dc logs backend 2>&1 | grep -iE "push|entrega|aviso" | tail -40 || true
fi
echo "=== log completo: $RUN_LOG ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-AVISOS-E2E-BROWSER: OK — 7.2.4/7.3.5/7.4.2/8.2.3/8.2.4 verdes"
else
  echo "HUB-AVISOS-E2E-BROWSER: Playwright FALHOU (exit=$PW_EXIT)" >&2
fi
exit "$PW_EXIT"
