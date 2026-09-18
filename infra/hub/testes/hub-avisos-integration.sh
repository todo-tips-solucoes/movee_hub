#!/usr/bin/env bash
# =============================================================================
# hub-avisos-integration.sh — tasks.md 9.2 (feature "Notificações push no app
# do motorista"): suíte de integração E2E REAL, molde de
# hub-performance-integration.sh, cobrindo o que os drivers anteriores da
# FASE 1/4/5 (hub-avisos-modulo-integration.sh, hub-push-avisos-integration.sh,
# hub-push-worker-integration.sh) ainda NÃO provam de ponta a ponta:
#
#   (a) RLS: Aviso visível só dentro do escopo; AvisoEntrega/PushInscricao/
#       PushEstadoAtivacao sem NENHUM grant a `authenticated` (acesso direto
#       negado, só via as funções SECURITY DEFINER); PushChaveVapid só
#       visível com a claim hub_push_worker.
#   (b) SKIP LOCKED: 2 chamadas CONCORRENTES de verdade a hub_push_reivindicar
#       sobre o MESMO aviso — soma das entregas reivindicadas pelas 2
#       chamadas = total pendente, sem sobreposição (prova real de
#       "FOR UPDATE SKIP LOCKED", não só leitura do código).
#   (c) reinício: lease vencido (`processando` + lease_ate no passado) vira
#       falha/interrompida na próxima reivindicação — mecanismo que sustenta
#       a retomada pós-crash (prova mais ampla, com boot real do processo,
#       já em hub-push-worker-integration.sh 5.2.1/5.2.3 — aqui só o núcleo
#       SQL, sem duplicar o boot).
#   (d) push-mock real (HTTPS, onda-021): fluxo HTTP completo POST /avisos ->
#       worker fire-and-forget -> web-push de verdade contra o push-mock ->
#       201 aceito / 404 e 410 morta (PushInscricao apagada) / 429 rejeitada
#       sem retry / 500,500,201 retry com sucesso / 500,500,500 retry
#       esgotado — nenhum dos 3 drivers anteriores tinha o push-mock (só
#       existe desde onda-021).
#   (e) auditoria: POST /avisos real grava "aviso_disparado" em "Auditoria".
#   (f) expurgo: hub_push_expurgo() remove só o aviso >90 dias; a auditoria
#       do aviso expurgado sobrevive (política de 12 meses, migration 0041).
#   (g) corrida na finalização (migration 0065, execute-task onda-024): as 2
#       ÚLTIMAS entregas de um aviso resolvidas em transações sobrepostas —
#       sem a trava FOR UPDATE na linha do Aviso, nenhuma das 2 chamadas de
#       hub_push_registrar_resultado enxergava a resolução da outra e o
#       Aviso ficava preso em 'em_andamento' para sempre. Também assertado
#       aqui: Aviso.status='concluido' no caso comum de lote único (0064).
#
# Uso: infra/hub/testes/hub-avisos-integration.sh
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
VAPID_KEYS_FILE="$(get_var VAPID_KEYS_FILE "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$VAPID_KEYS_FILE" ] || { echo "HUB_DB_USER/HUB_DB_NAME/VAPID_KEYS_FILE ausentes em $ENV_FILE" >&2; exit 2; }
KEYID_ATIVO="$(jq -r '.keyId' "$VAPID_KEYS_FILE" 2>/dev/null)"
[ -n "$KEYID_ATIVO" ] && [ "$KEYID_ATIVO" != "null" ] || { echo "keyId ausente em $VAPID_KEYS_FILE" >&2; exit 2; }
newuuid() { cat /proc/sys/kernel/random/uuid; }

# Achado desta suíte: em .env.hub.test, POSTGREST_API_KEY != PGRST_JWT_SECRET
# (diferente de .env.hub.homolog/.env.hub.dev.homolog, onde os valores
# coincidem por convenção). lib/postgrest.js (legado — server.js
# postgrestRequest/generatePostgrestJWT, usado por routes/grupo.js#
# mesmoGrupoQue, chamado por routes/hub-avisos.js#resolverContextoAvisos)
# assina o JWT com POSTGREST_API_KEY; o PostgREST desta suíte só aceita
# PGRST_JWT_SECRET — a falha de assinatura faz mesmoGrupoQue cair no catch
# (fail-safe "return false") e todo POST /avisos vira 403
# FORA_DO_GRUPO_MOVEE antes mesmo de checar o grupo de verdade. Override só
# nesta sessão de shell (mesmo padrão de PUSH_HOSTS_PERMITIDOS abaixo) —
# nunca escreve no arquivo de secrets compartilhado.
PGRST_JWT_SECRET_VAL="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$PGRST_JWT_SECRET_VAL" ] || { echo "PGRST_JWT_SECRET ausente em $ENV_FILE" >&2; exit 2; }
export POSTGREST_API_KEY="$PGRST_JWT_SECRET_VAL"

# Override SÓ nesta sessão de shell (nunca escreve no .env.hub.test
# compartilhado — mesmo padrão de HUB_MOTORISTA_LOGIN_CONTA_ATIVA já
# documentado em compose.hub.test.yml): shell env tem precedência sobre
# --env-file na interpolação do compose, então isto é o que faz
# PUSH_HOSTS_PERMITIDOS chegar como "push-mock" dentro do container backend
# mesmo com o arquivo de secrets real ainda vazio nesse campo.
export PUSH_HOSTS_PERMITIDOS="push-mock"

# Par p256dh/auth ESTRUTURALMENTE válido (EC P-256 sem comprimir, 65 bytes
# 0x04-prefixados + 16 bytes de auth) — suficiente para a pré-validação local
# do `web-push` (generateRequestDetails) aceitar e seguir para o envio HTTP
# real contra o push-mock; nenhuma inscrição "de verdade" é necessária (o
# mock não decifra, só responde o status programado).
read -r PDH AUTHK <<EOF
$(node -e "const c=require('crypto');const e=c.createECDH('prime256v1');e.generateKeys();console.log(e.getPublicKey().toString('base64url'),c.randomBytes(16).toString('base64url'));")
EOF
[ -n "$PDH" ] && [ -n "$AUTHK" ] || { echo "FAIL: geração do par p256dh/auth falhou"; exit 1; }

# Cert/key TLS efêmero do push-mock (tasks.md 9.1.2/9.2 — nunca gerado antes
# desta suíte/9.4). CN=SAN=push-mock (nome do serviço na rede docker do
# projeto — é o hostname que o backend resolve e que o worker usa no
# endpoint da inscrição).
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
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; rm -f "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"; }
trap cleanup EXIT

echo "df -h / e swap antes do build:"; df -h /; swapon --show

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+push-mock efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait push-mock

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

echo "rodando migrate.sh (série completa, inclusive 0061/0062)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
for m in 0061_push_avisos.sql 0062_modulo_avisos.sql; do
  grep -q "$m" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo ($m ausente)"; tail -60 "$TMP/migrate.log"; exit 1; }
done

# Backend sobe SÓ APÓS as migrations (diferente de hub-performance/hub-rls
# integration.sh, que sobem antes): registrarChaveVapid/retomarAvisosPendentes/
# executarExpurgo rodam UMA VEZ no boot (fire-and-forget) e não são
# retentadas depois — se o schema ainda não existir nesse instante,
# PushChaveVapid nunca é populada nesta execução (mesmo padrão observado em
# hub-push-worker-integration.sh 5.2.1, que por isso builda/sobe o backend
# só ao final, depois do migrate+seed).
echo "df -h / antes do build do backend:"; df -h /
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -80 "$TMP/build.log"; exit 1; }
dc up -d --wait backend
sleep 2
echo "--- boot log (linhas 'push:'/'boot') ---"
dc logs backend 2>&1 | grep -iE "push|boot" || echo "(nenhuma linha push/boot no log de boot)"

node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

# ─────────────────────────────────────────────────────────────────────────────
# Seed: 1 Usuario admin (empresa 6 = grupo Movee, papel admin_entidade — já
# concede avisos.consultar/avisos.enviar via migration 0062; ModuloEntidade
# de 'avisos' para a empresa 6 também já vem semeado pela 0062).
# ─────────────────────────────────────────────────────────────────────────────
SENHA_OK='SenhaSinteticaAvisos#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

psql_t -c "INSERT INTO \"Usuario\" (email, senha_hash, nome, ativo) VALUES ('avisos-admin@example.test','$HASH_OK','Usuario Teste Avisos Admin',true);" >/dev/null
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='avisos-admin@example.test';" | tr -d '[:space:]')"
[ -n "$UID_ADMIN" ] || { echo "FAIL: seed de Usuario falhou"; exit 1; }
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade';" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] || { echo "FAIL: seed 0007 não populou o papel 'admin_entidade'"; exit 1; }
psql_t -c "INSERT INTO \"UsuarioEntidade\" (usuario_id, empresa_id, papel_id, ativo) VALUES ($UID_ADMIN, 6, $PAPEL_ADMIN_ENTIDADE, true);" >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Seed: 6 Motorista (legado — HUB_MOTORISTA_LOGIN_CONTA_ATIVA não setada nesta
# suíte, então hub_aviso_alcance usa o ramo 'legado') + 6 PushInscricao
# apontando cada uma para um path do push-mock com comportamento distinto.
# ─────────────────────────────────────────────────────────────────────────────
declare -A CNPJ=( [aceito]=90000000000101 [morta404]=90000000000102 [morta410]=90000000000103 \
                  [rejeitada429]=90000000000104 [retryok]=90000000000105 [retryfail]=90000000000106 )

for k in "${!CNPJ[@]}"; do
  psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo) VALUES ('${CNPJ[$k]}','Motorista Teste Avisos $k', true) ON CONFLICT DO NOTHING;" >/dev/null
  psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('${CNPJ[$k]}','https://push-mock:8443/e/$k','hash-$k','$PDH','$AUTHK','$KEYID_ATIVO','android','$(newuuid)') ON CONFLICT DO NOTHING;" >/dev/null
done

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 11 do quickstart (payload sem PII) — 9.6.1: inscrição DEDICADA com
# par ECDH real (a chave privada efêmera é gravada só em /tmp DENTRO do
# container backend, nunca impressa/logada) para decifrar de verdade o corpo
# aes128gcm que o worker envia ao push-mock e afirmar as chaves do payload.
# ─────────────────────────────────────────────────────────────────────────────
CNPJ_C11="90000000000111"
NOME_C11="Motorista Teste Avisos PII-SECRETO-CENARIO11"
C11_KEYS_OUT="$(run_node <<'JS'
const crypto = require('crypto');
const fs = require('fs');
const curve = crypto.createECDH('prime256v1');
curve.generateKeys();
fs.writeFileSync('/tmp/c11-priv.b64', curve.getPrivateKey().toString('base64url'));
const auth = crypto.randomBytes(16);
process.stdout.write(curve.getPublicKey().toString('base64url') + ' ' + auth.toString('base64url'));
JS
)"
read -r PDH_C11 AUTHK_C11 <<<"$C11_KEYS_OUT"
[ -n "$PDH_C11" ] && [ -n "$AUTHK_C11" ] || { echo "FAIL: geração do par ECDH do cenário 11 falhou"; exit 1; }
psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo) VALUES ('$CNPJ_C11','$NOME_C11', true) ON CONFLICT DO NOTHING;" >/dev/null
psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('$CNPJ_C11','https://push-mock:8443/e/cenario11','hash-cenario11','$PDH_C11','$AUTHK_C11','$KEYID_ATIVO','android','$(newuuid)') ON CONFLICT DO NOTHING;" >/dev/null

# Programa as respostas do push-mock ANTES do disparo (via node dentro do
# backend, único container com rede até o push-mock e o CA confiável já
# montado em /etc/push-mock-ca/cert.pem).
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

async function main() {
  const cenarios = {
    '/e/aceito': [201],
    '/e/morta404': [404],
    '/e/morta410': [410],
    '/e/rejeitada429': [429],
    '/e/retryok': [500, 500, 201],
    '/e/retryfail': [500, 500, 500],
  };
  const out = {};
  for (const [path, respostas] of Object.entries(cenarios)) {
    const r = await post('/_programar', { path, respostas });
    out[path] = r.status;
  }
  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$PROGRAM_OUT" | grep -v '___RESULT_JSON___'
PROGRAM_LINE="$(echo "$PROGRAM_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$PROGRAM_LINE" ] || { echo "FAIL: programação do push-mock não retornou resultado"; exit 1; }
node_e "const d=JSON.parse(process.argv[1]); const ok=Object.values(d).every(s=>s===200); process.exit(ok?0:1);" "$PROGRAM_LINE" \
  || { echo "FAIL: /_programar não respondeu 200 para todos os paths: $PROGRAM_LINE"; exit 1; }
echo "PASS: push-mock programado (6 cenários: 201/404/410/429/retry-ok/retry-esgotado)"

# ─────────────────────────────────────────────────────────────────────────────
# (d)+(e) Disparo real: login + POST /avisos (toda_base) — o worker
# fire-and-forget processa as entregas (6 cenários de status + cenário 11
# dedicado ao payload sem PII) contra o push-mock de verdade.
# ─────────────────────────────────────────────────────────────────────────────
CHAVE_DISPARO="$(newuuid)"
DISPARO_OUT="$(run_node "$SENHA_OK" "$CHAVE_DISPARO" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function postJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify(corpo) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function main() {
  const [senha, chave] = process.argv.slice(2);
  const out = {};
  let jar = await login('avisos-admin@example.test', senha);
  jar = await trocarEntidade(jar, 6);
  const r = await postJson(jar, '/avisos', { titulo: 'Aviso integração 9.2', corpo: 'corpo de teste hub-avisos-integration', modoDestinatarios: 'toda_base', chaveIdempotencia: chave });
  out.status = r.status;
  out.body = r.body;
  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$DISPARO_OUT" | grep -v '___RESULT_JSON___'
DISPARO_LINE="$(echo "$DISPARO_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$DISPARO_LINE" ] || { echo "FAIL: script de disparo não retornou resultado"; exit 1; }
echo "disparo: $DISPARO_LINE"
djget() { printf '%s' "$DISPARO_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null?'null':v===undefined?'undefined':String(v))"; }

check "POST /avisos (toda_base) -> 201" "$(djget status)" "201"
AVISO_ID="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_DISPARO';" | tr -d '[:space:]')"
[ -n "$AVISO_ID" ] || { echo "FAIL: Aviso não foi criado"; exit 1; }

echo "aguardando o worker processar as 7 entregas (6 + cenário 11) contra o push-mock…"
for _ in $(seq 1 20); do
  PENDENTES="$(psql_t -tAc "SELECT count(*) FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_ID AND status IN ('pendente','processando');" | tr -d '[:space:]')"
  [ "$PENDENTES" = "0" ] && break
  sleep 1
done
check "worker esgotou as 7 entregas (nenhuma pendente/processando após espera)" "$PENDENTES" "0"
check "Aviso finalizado no caso de lote único (0064): status='concluido'" \
  "$(psql_t -tAc "SELECT status FROM \"Aviso\" WHERE id=$AVISO_ID;" | tr -d '[:space:]')" "concluido"

for k in "${!CNPJ[@]}"; do
  ST="$(psql_t -tAc "SELECT status||'/'||coalesce(motivo,'-')||'/'||tentativas FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_ID AND cnpj_prestador='${CNPJ[$k]}';" | tr -d '[:space:]')"
  case "$k" in
    aceito)        check "push-mock 201 -> entrega aceita" "$ST" "aceito/-/1" ;;
    morta404)      check "push-mock 404 -> entrega morta (sem retry, 1 tentativa)" "$ST" "morta/-/1" ;;
    morta410)      check "push-mock 410 -> entrega morta (sem retry, 1 tentativa)" "$ST" "morta/-/1" ;;
    rejeitada429)  check "push-mock 429 -> falha/rejeitada (sem retry, tentativa única)" "$ST" "falha/rejeitada/1" ;;
    retryok)       check "push-mock 500,500,201 -> aceita na 3ª tentativa" "$ST" "aceito/-/3" ;;
    retryfail)     check "push-mock 500,500,500 -> falha/transitoria_esgotada (3 tentativas)" "$ST" "falha/transitoria_esgotada/3" ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 11 (payload sem PII) — decifra de verdade o corpo aes128gcm que o
# push-mock registrou para a inscrição dedicada e afirma as chaves do
# payload, ausência de sequência de 14 dígitos e ausência do nome do
# motorista (9.6.1).
# ─────────────────────────────────────────────────────────────────────────────
ST_C11="$(psql_t -tAc "SELECT status||'/'||coalesce(motivo,'-')||'/'||tentativas FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_ID AND cnpj_prestador='$CNPJ_C11';" | tr -d '[:space:]')"
check "cenário 11: push-mock 201 (default) -> entrega aceita" "$ST_C11" "aceito/-/1"

C11_DECRYPT_OUT="$(run_node "$AVISO_ID" "$AUTHK_C11" <<'JS'
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const ece = require('http_ece');
const ca = fs.readFileSync('/etc/push-mock-ca/cert.pem');

function getLog() {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'push-mock', port: 8443, path: '/_log', ca }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

async function main() {
  const [avisoId, authB64] = process.argv.slice(2);
  const entradas = JSON.parse(await getLog());
  const entrada = entradas.find((e) => e.path === '/e/cenario11');
  if (!entrada || !entrada.body_cifrado_base64) {
    console.log('___RESULT_JSON___' + JSON.stringify({ erro: 'sem_entrada_no_log' }));
    return;
  }
  const cipherBuf = Buffer.from(entrada.body_cifrado_base64, 'base64');
  const privBuf = Buffer.from(fs.readFileSync('/tmp/c11-priv.b64', 'utf8').trim(), 'base64url');
  const curve = crypto.createECDH('prime256v1');
  curve.setPrivateKey(privBuf);
  const authBuf = Buffer.from(authB64, 'base64url');
  const claro = ece.decrypt(cipherBuf, { version: 'aes128gcm', privateKey: curve, authSecret: authBuf });
  const texto = claro.toString('utf8');
  const payload = JSON.parse(texto);
  const chaves = Object.keys(payload).sort();
  const semQuatorzeDigitos = !/\d{14}/.test(texto);
  const semNomeMotorista = !texto.includes('PII-SECRETO-CENARIO11');
  fs.unlinkSync('/tmp/c11-priv.b64');
  console.log('___RESULT_JSON___' + JSON.stringify({
    chaves, avisoIdBate: String(payload.avisoId) === String(avisoId),
    semQuatorzeDigitos, semNomeMotorista, payload,
  }));
}
main().catch((e) => { console.log('___RESULT_JSON___' + JSON.stringify({ erro: String(e && e.message || e) })); });
JS
)"
echo "$C11_DECRYPT_OUT" | grep -v '___RESULT_JSON___'
C11_LINE="$(echo "$C11_DECRYPT_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$C11_LINE" ] || { echo "FAIL: decrypt do cenário 11 não retornou resultado"; exit 1; }
echo "cenário 11 — payload decifrado (evidência, sem PII): $C11_LINE"
c11get() { printf '%s' "$C11_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===undefined?'undefined':JSON.stringify(v))"; }

check "cenário 11: payload decifrado tem exatamente as chaves avisoId/corpo/titulo" "$(c11get chaves)" '["avisoId","corpo","titulo"]'
check "cenário 11: avisoId do payload decifrado bate com o Aviso disparado" "$(c11get avisoIdBate)" "true"
check "cenário 11: payload decifrado NÃO contém sequência de 14 dígitos" "$(c11get semQuatorzeDigitos)" "true"
check "cenário 11: payload decifrado NÃO contém nome do motorista" "$(c11get semNomeMotorista)" "true"

# "limpeza de assinatura morta": 404/410 fazem o worker apagar a PushInscricao.
check "PushInscricao apagada após 404 (morta)" "$(psql_t -tAc "SELECT count(*) FROM \"PushInscricao\" WHERE cnpj_prestador='${CNPJ[morta404]}';" | tr -d '[:space:]')" "0"
check "PushInscricao apagada após 410 (morta)" "$(psql_t -tAc "SELECT count(*) FROM \"PushInscricao\" WHERE cnpj_prestador='${CNPJ[morta410]}';" | tr -d '[:space:]')" "0"
check "PushInscricao dos demais cenários permanece" "$(psql_t -tAc "SELECT count(*) FROM \"PushInscricao\" WHERE cnpj_prestador IN ('${CNPJ[aceito]}','${CNPJ[rejeitada429]}','${CNPJ[retryok]}','${CNPJ[retryfail]}');" | tr -d '[:space:]')" "4"

# (e) auditoria — POST /avisos real registrou aviso_disparado.
check "Auditoria: aviso_disparado registrado pelo disparo real" \
  "$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='aviso_disparado' AND recurso='Aviso' AND recurso_id='$AVISO_ID';" | tr -d '[:space:]')" "1"

# ─────────────────────────────────────────────────────────────────────────────
# (a) RLS — via PostgREST DIRETO (bypass do Express), mesmo padrão de
# hub-rls-integration.sh: token sintético via lib/hub-postgrest-jwt.js.
# ─────────────────────────────────────────────────────────────────────────────
RLS_OUT="$(run_node "$AVISO_ID" <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
async function pg(jwt, path) {
  const r = await fetch(`http://postgrest:3000/${path}`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function main() {
  const [avisoId] = process.argv.slice(2);
  const out = {};
  const jwtEscopo6 = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: 6, escopo: [6] });
  const jwtEscopoOutra = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: 999999, escopo: [999999] });
  const jwtWorker = generateHubPostgrestJWT({ hubPushWorker: true });

  const rAvisoDentro = await pg(jwtEscopo6, `Aviso?id=eq.${avisoId}&select=id`);
  out.aviso_dentro_status = rAvisoDentro.status;
  out.aviso_dentro_len = Array.isArray(rAvisoDentro.body) ? rAvisoDentro.body.length : -1;

  const rAvisoFora = await pg(jwtEscopoOutra, `Aviso?id=eq.${avisoId}&select=id`);
  out.aviso_fora_status = rAvisoFora.status;
  out.aviso_fora_len = Array.isArray(rAvisoFora.body) ? rAvisoFora.body.length : -1;

  const rEntregaDireta = await pg(jwtEscopo6, `AvisoEntrega?aviso_id=eq.${avisoId}&select=id`);
  out.entrega_direta_status = rEntregaDireta.status;
  const rInscricaoDireta = await pg(jwtEscopo6, `PushInscricao?select=id&limit=1`);
  out.inscricao_direta_status = rInscricaoDireta.status;
  const rEstadoDireto = await pg(jwtEscopo6, `PushEstadoAtivacao?select=cnpj_prestador&limit=1`);
  out.estado_direto_status = rEstadoDireto.status;

  const rChaveSemClaim = await pg(jwtEscopo6, `PushChaveVapid?select=key_id`);
  out.chave_sem_claim_len = Array.isArray(rChaveSemClaim.body) ? rChaveSemClaim.body.length : -1;
  const rChaveWorker = await pg(jwtWorker, `PushChaveVapid?select=key_id`);
  out.chave_worker_len = Array.isArray(rChaveWorker.body) ? rChaveWorker.body.length : -1;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$RLS_OUT" | grep -v '___RESULT_JSON___'
RLS_LINE="$(echo "$RLS_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RLS_LINE" ] || { echo "FAIL: script de RLS não retornou resultado"; exit 1; }
rget() { printf '%s' "$RLS_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null?'null':v===undefined?'undefined':String(v))"; }

check "RLS Aviso: escopo=[6] vê o aviso (200, 1 linha)" "$(rget aviso_dentro_status)/$(rget aviso_dentro_len)" "200/1"
check "RLS Aviso: escopo=[outra empresa] NÃO vê o aviso (0 linhas)" "$(rget aviso_fora_len)" "0"
check "RLS AvisoEntrega: SELECT direto negado (sem GRANT — só via função)" "$(node_e "process.stdout.write(String($(rget entrega_direta_status) !== 200))")" "true"
check "RLS PushInscricao: SELECT direto negado (sem GRANT — só via função)" "$(node_e "process.stdout.write(String($(rget inscricao_direta_status) !== 200))")" "true"
check "RLS PushEstadoAtivacao: SELECT direto negado (sem GRANT — só via função)" "$(node_e "process.stdout.write(String($(rget estado_direto_status) !== 200))")" "true"
check "RLS PushChaveVapid: sem claim hub_push_worker -> 0 linhas" "$(rget chave_sem_claim_len)" "0"
check "RLS PushChaveVapid: com claim hub_push_worker -> vê a chave ativa" "$(node_e "process.stdout.write(String(Number('$(rget chave_worker_len)') >= 1))")" "true"

# ─────────────────────────────────────────────────────────────────────────────
# (b) SKIP LOCKED — 2 chamadas CONCORRENTES de hub_push_reivindicar sobre o
# MESMO aviso, com metade do limite cada uma; soma = total pendente, 0
# sobreposição (senão a mesma AvisoEntrega apareceria nas 2 respostas).
# ─────────────────────────────────────────────────────────────────────────────
CHAVE_SKIP="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,iniciado_em) VALUES (6,'Teste SKIP LOCKED','corpo teste skip locked','toda_base','{}'::int[],'em_andamento','$CHAVE_SKIP',$UID_ADMIN,now());" >/dev/null
AVISO_SKIP="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_SKIP';" | tr -d '[:space:]')"
N_SKIP=20
for i in $(seq 1 $N_SKIP); do
  psql_t -c "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('9100000000$(printf '%04d' $i)','https://push-mock:8443/e/skip$i','hash-skip-$i','$PDH','$AUTHK','testkeyid-skip','android','$(newuuid)');" >/dev/null
done
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,inscricao_id,cnpj_prestador,status)
  SELECT $AVISO_SKIP, id, cnpj_prestador, 'pendente' FROM \"PushInscricao\" WHERE endpoint_hash LIKE 'hash-skip-%';" >/dev/null

SKIP_OUT="$(run_node "$AVISO_SKIP" <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
const crypto = require('crypto');
async function reivindicar(avisoId, limite) {
  const jwt = generateHubPostgrestJWT({ hubPushWorker: true });
  const r = await fetch('http://postgrest:3000/rpc/hub_push_reivindicar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ p_aviso_id: Number(avisoId), p_limite: limite, p_lease_segundos: 120, p_lease_token: crypto.randomUUID(), p_key_id: 'testkeyid-skip' }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, ids: Array.isArray(body) ? body.map((x) => x.entrega_id) : [] };
}
async function main() {
  const [avisoId] = process.argv.slice(2);
  const [ra, rb] = await Promise.all([reivindicar(avisoId, 15), reivindicar(avisoId, 15)]);
  const setA = new Set(ra.ids);
  const overlap = rb.ids.filter((id) => setA.has(id));
  const uniao = new Set([...ra.ids, ...rb.ids]);
  console.log('___RESULT_JSON___' + JSON.stringify({ statusA: ra.status, statusB: rb.status, nA: ra.ids.length, nB: rb.ids.length, overlap: overlap.length, uniao: uniao.size }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$SKIP_OUT" | grep -v '___RESULT_JSON___'
SKIP_LINE="$(echo "$SKIP_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$SKIP_LINE" ] || { echo "FAIL: script SKIP LOCKED não retornou resultado"; exit 1; }
skget() { printf '%s' "$SKIP_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(String(v))"; }

check "SKIP LOCKED: 2 chamadas concorrentes, 0 sobreposição" "$(skget overlap)" "0"
check "SKIP LOCKED: união das 2 chamadas reivindica as $N_SKIP entregas pendentes" "$(skget uniao)" "$N_SKIP"
check "SKIP LOCKED: as $N_SKIP entregas ficaram 'processando' no banco" \
  "$(psql_t -tAc "SELECT count(*) FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_SKIP AND status='processando';" | tr -d '[:space:]')" "$N_SKIP"

# ─────────────────────────────────────────────────────────────────────────────
# (c) reinício — lease vencido de uma reivindicação anterior (crash simulado)
# vira falha/interrompida na PRÓXIMA reivindicação (mesmo mecanismo de
# retomada; prova mais ampla com boot real em hub-push-worker-integration.sh).
# ─────────────────────────────────────────────────────────────────────────────
CHAVE_RESTART="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,iniciado_em) VALUES (6,'Teste reinício','corpo reinicio','toda_base','{}'::int[],'em_andamento','$CHAVE_RESTART',$UID_ADMIN,now());" >/dev/null
AVISO_RESTART="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_RESTART';" | tr -d '[:space:]')"
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status,lease_ate,lease_token) VALUES ($AVISO_RESTART,'92000000000199','processando', now() - interval '5 seconds', '$(newuuid)');" >/dev/null

psql_t -tAc "SET request.jwt.claims='{\"hub_push_worker\":true}'; SELECT * FROM hub_push_reivindicar($AVISO_RESTART, 50, 120, '$(newuuid)', 'testkeyid-restart');" >"$TMP/restart-reivindicar.log" 2>&1
cat "$TMP/restart-reivindicar.log"
check "reinício: entrega 'processando' com lease vencido vira falha/interrompida (nunca reenviada)" \
  "$(psql_t -tAc "SELECT status||'/'||motivo FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_RESTART AND cnpj_prestador='92000000000199';" | tr -d '[:space:]')" "falha/interrompida"

# ─────────────────────────────────────────────────────────────────────────────
# (g) corrida na finalização (execute-task onda-024, migration 0065) — as 2
# ÚLTIMAS entregas de um aviso resolvidas por transações sobrepostas: sem
# 0065, nenhuma das 2 chamadas de hub_push_registrar_resultado enxerga a
# entrega resolvida pela outra (READ COMMITTED, sem trava na linha do Aviso)
# e o Aviso fica preso em 'em_andamento' mesmo com 0 entregas pendentes/
# processando (reproduzido ao vivo antes do fix). Prova real via transação
# mantida aberta com um FIFO enquanto a segunda roda e comita — não depende
# de timing de wall-clock, só de a 1ª transação não ter comitado ainda.
# ─────────────────────────────────────────────────────────────────────────────
CHAVE_RACE="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,iniciado_em) VALUES (6,'Teste corrida finalização','corpo teste corrida final','toda_base','{}'::int[],'em_andamento','$CHAVE_RACE',$UID_ADMIN,now());" >/dev/null
AVISO_RACE="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_RACE';" | tr -d '[:space:]')"
LEASE_RACE_A="$(newuuid)"; LEASE_RACE_B="$(newuuid)"
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status,lease_ate,lease_token) VALUES ($AVISO_RACE,'93000000000racA','processando', now() + interval '2 minutes', '$LEASE_RACE_A');" >/dev/null
psql_t -c "INSERT INTO \"AvisoEntrega\" (aviso_id,cnpj_prestador,status,lease_ate,lease_token) VALUES ($AVISO_RACE,'93000000000racB','processando', now() + interval '2 minutes', '$LEASE_RACE_B');" >/dev/null
ENTREGA_RACE_A="$(psql_t -tAc "SELECT id FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_RACE AND cnpj_prestador='93000000000racA';" | tr -d '[:space:]')"
ENTREGA_RACE_B="$(psql_t -tAc "SELECT id FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_RACE AND cnpj_prestador='93000000000racB';" | tr -d '[:space:]')"

RACE_FIFO="$TMP/race.fifo"; mkfifo "$RACE_FIFO"
exec 9<>"$RACE_FIFO"
dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <&9 >"$TMP/race-sessaoA.log" 2>&1 &
PID_RACE_A=$!
printf "BEGIN;\n" >&9
printf "SET request.jwt.claims = '{\"hub_push_worker\":true}';\n" >&9
printf "SELECT hub_push_registrar_resultado(%s,'%s'::uuid,'aceito',NULL,0::smallint);\n" "$ENTREGA_RACE_A" "$LEASE_RACE_A" >&9
sleep 1.5

# Sessão B roda em background: com 0065 aplicada ela BLOQUEIA (PERFORM FOR
# UPDATE na linha do Aviso) até a sessão A comitar — sem isso o script
# travaria aqui esperando um resultado que só chega depois do commit abaixo.
( psql_t -tAc "SET request.jwt.claims = '{\"hub_push_worker\":true}'; SELECT hub_push_registrar_resultado($ENTREGA_RACE_B,'$LEASE_RACE_B'::uuid,'aceito',NULL,0::smallint);" >"$TMP/race-sessaoB.log" 2>&1 ) &
PID_RACE_B=$!
sleep 1.5

printf "COMMIT;\n" >&9
sleep 1
printf "\\\\q\n" >&9
wait "$PID_RACE_A" 2>/dev/null
exec 9>&- 2>/dev/null || true
wait "$PID_RACE_B" 2>/dev/null

check "corrida na finalização: Aviso conclui mesmo com as 2 últimas entregas resolvidas em transações sobrepostas (0065)" \
  "$(psql_t -tAc "SELECT status FROM \"Aviso\" WHERE id=$AVISO_RACE;" | tr -d '[:space:]')" "concluido"
check "corrida na finalização: as 2 entregas ficaram resolvidas (0 pendente/processando)" \
  "$(psql_t -tAc "SELECT count(*) FROM \"AvisoEntrega\" WHERE aviso_id=$AVISO_RACE AND status IN ('pendente','processando');" | tr -d '[:space:]')" "0"

# ─────────────────────────────────────────────────────────────────────────────
# (f) expurgo (90 dias) + sobrevivência da auditoria — mesmo padrão de
# hub-push-worker-integration.sh 5.3.2/5.3.3.
# ─────────────────────────────────────────────────────────────────────────────
CHAVE_91="$(newuuid)"; CHAVE_89="$(newuuid)"
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,criado_em) VALUES (6,'Expurgo 91','corpo 91','toda_base','{}'::int[],'concluido','$CHAVE_91',$UID_ADMIN, now() - interval '91 days');" >/dev/null
psql_t -c "INSERT INTO \"Aviso\" (id_empresa,titulo,corpo,modo_destinatarios,destinatarios_ids,status,chave_idempotencia,criado_por,criado_em) VALUES (6,'Expurgo 89','corpo 89','toda_base','{}'::int[],'concluido','$CHAVE_89',$UID_ADMIN, now() - interval '89 days');" >/dev/null
A91="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_91';" | tr -d '[:space:]')"
A89="$(psql_t -tAc "SELECT id FROM \"Aviso\" WHERE chave_idempotencia='$CHAVE_89';" | tr -d '[:space:]')"
psql_t -c "INSERT INTO \"Auditoria\" (id_empresa,usuario_id,acao,recurso,recurso_id,detalhes) VALUES (6, NULL, 'aviso_disparado', 'Aviso', '$A91', '{}'::jsonb);" >/dev/null

EXPURGO_OUT="$(run_node <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
async function main() {
  const jwt = generateHubPostgrestJWT({ hubPushWorker: true });
  const r = await fetch('http://postgrest:3000/rpc/hub_push_expurgo', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: '{}' });
  const body = await r.json().catch(() => null);
  console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status, body: (Array.isArray(body) && body[0]) || null }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$EXPURGO_OUT" | grep -v '___RESULT_JSON___'
EXPURGO_LINE="$(echo "$EXPURGO_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$EXPURGO_LINE" ] || { echo "FAIL: script de expurgo não retornou resultado"; exit 1; }
egget() { printf '%s' "$EXPURGO_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d.body && d.body['$1']; process.stdout.write(String(v))"; }

check "expurgo: remove exatamente 1 aviso (só o de 91 dias)" "$(egget avisos_removidos)" "1"
check "expurgo: aviso de 91 dias removido de fato" "$(psql_t -tAc "SELECT count(*) FROM \"Aviso\" WHERE id=$A91;" | tr -d '[:space:]')" "0"
check "expurgo: aviso de 89 dias mantido" "$(psql_t -tAc "SELECT count(*) FROM \"Aviso\" WHERE id=$A89;" | tr -d '[:space:]')" "1"
check "expurgo: Auditoria do aviso expurgado NÃO é removida (política de 12 meses)" \
  "$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE recurso='Aviso' AND recurso_id='$A91';" | tr -d '[:space:]')" "1"

echo "-----------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  echo "HUB-AVISOS-INTEGRATION: OK — todos os asserts passaram (tasks.md 9.2: RLS/SKIP LOCKED/reinício/404-410-429-retry/expurgo/auditoria)"
else
  echo "HUB-AVISOS-INTEGRATION: $fails assert(s) FALHARAM" >&2
fi
exit "$fails"
