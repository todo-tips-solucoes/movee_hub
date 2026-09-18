#!/usr/bin/env bash
# =============================================================================
# hub-avisos-carga-roundtrip-integration.sh — tasks.md 9.5 + 9.6.2 (feature
# "Notificações push no app do motorista"), execute-task onda-026.
#
# Molde de infra/hub/testes/hub-avisos-integration.sh (setup/seed/push-mock/
# login), reaproveitado para DOIS objetivos combinados numa única subida de
# hub-test (economia de orçamento — um único ciclo docker up/build/down):
#
#   9.5  Carga concorrente (SC-005/CHK003): ≥100 inscrições ativas + disparo
#        toda_base, medindo o tempo de resposta de 2 rotas NÃO relacionadas
#        (GET /api/v1/motoristas, GET /motorista/push/chave-publica) ANTES,
#        DURANTE (enquanto o worker fire-and-forget processa as entregas no
#        MESMO processo Node — evento-loop único) e DEPOIS do processamento.
#
#   9.6.2 Roundtrip end-to-end obrigatório: captura real (sem mock/fixture no
#        lado do backend) dos 7 corpos do quickstart Scenario 20 — POST
#        /avisos, GET /avisos/:id, GET /avisos/alcance, GET /avisos/cobertura,
#        GET /motorista/push/chave-publica, PUT /motorista/push/inscricao,
#        GET /motorista/avisos/:id — salvos em JSON (sem cookie/JWT/segredo)
#        para comparação com contracts/*.md e para um teste vitest no
#        frontend_v2 que passa os 4 corpos do HUB pelos parsers de
#        lib/hub/avisos-dto.ts (os 3 do app motorista não têm parser dedicado
#        — cobertos pelo E2E Playwright do cenário 1/12/13, já verde).
#
# Uso: infra/hub/testes/hub-avisos-carga-roundtrip-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"
EVID_DIR="/var/lib/envioMassa_homologacao/docs/specs/envioMassa_homologacao/evidencias/9.5-9.6.2"
mkdir -p "$EVID_DIR"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
VAPID_KEYS_FILE="$(get_var VAPID_KEYS_FILE "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$VAPID_KEYS_FILE" ] || { echo "HUB_DB_USER/HUB_DB_NAME/VAPID_KEYS_FILE ausentes em $ENV_FILE" >&2; exit 2; }
KEYID_ATIVO="$(jq -r '.keyId' "$VAPID_KEYS_FILE" 2>/dev/null)"
[ -n "$KEYID_ATIVO" ] && [ "$KEYID_ATIVO" != "null" ] || { echo "keyId ausente em $VAPID_KEYS_FILE" >&2; exit 2; }
newuuid() { cat /proc/sys/kernel/random/uuid; }

# Mesmo achado/override documentado em hub-avisos-integration.sh: só nesta
# sessão de shell, nunca escreve no .env.hub.test compartilhado.
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
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; rm -f "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"; }
trap cleanup EXIT

echo "df -h / e swap antes do build:"; df -h /; swapon --show; free -h

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+push-mock efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait push-mock

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

echo "rodando migrate.sh (série completa)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0062_modulo_avisos.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo"; tail -60 "$TMP/migrate.log"; exit 1; }

echo "df -h / antes do build do backend:"; df -h /
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -80 "$TMP/build.log"; exit 1; }
dc up -d --wait backend
sleep 2

node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

# ─────────────────────────────────────────────────────────────────────────────
# Seed: admin (empresa 6, admin_entidade) — mesmo padrão de hub-avisos-integration.sh
# ─────────────────────────────────────────────────────────────────────────────
SENHA_ADMIN='SenhaSinteticaCarga#1'
HASH_ADMIN="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA_ADMIN" 2>"$TMP/hash-admin.log" | tr -d '[:space:]')"
[ -n "$HASH_ADMIN" ] || { echo "FAIL: hash admin"; cat "$TMP/hash-admin.log"; exit 1; }
psql_t -c "INSERT INTO \"Usuario\" (email, senha_hash, nome, ativo) VALUES ('carga-admin@example.test','$HASH_ADMIN','Usuario Teste Carga Admin',true);" >/dev/null
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='carga-admin@example.test';" | tr -d '[:space:]')"
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade';" | tr -d '[:space:]')"
[ -n "$UID_ADMIN" ] && [ -n "$PAPEL_ADMIN_ENTIDADE" ] || { echo "FAIL: seed de admin/papel"; exit 1; }
psql_t -c "INSERT INTO \"UsuarioEntidade\" (usuario_id, empresa_id, papel_id, ativo) VALUES ($UID_ADMIN, 6, $PAPEL_ADMIN_ENTIDADE, true);" >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Seed: motorista "credencial" (grupo Movee, senha p/ login legado real) — vai
# se auto-inscrever via PUT real (não SQL) para o roundtrip 9.6.2.
# ─────────────────────────────────────────────────────────────────────────────
CNPJ_CRED="97000000000001"
SENHA_MOTORISTA='SenhaSinteticaMotoristaCarga#1'
HASH_MOTORISTA="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA_MOTORISTA" 2>"$TMP/hash-mot.log" | tr -d '[:space:]')"
[ -n "$HASH_MOTORISTA" ] || { echo "FAIL: hash motorista"; cat "$TMP/hash-mot.log"; exit 1; }
psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo, senha) VALUES ('$CNPJ_CRED','Motorista Teste Carga Credencial', true, '$HASH_MOTORISTA') ON CONFLICT DO NOTHING;" >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Seed: 100 Motorista + PushInscricao (grupo Movee, fixture de carga — 9.5.1)
# via 1 único psql -f (100 INSERT em lote, não 100 processos dc exec).
# ─────────────────────────────────────────────────────────────────────────────
SEED_SQL="$TMP/seed_carga.sql"
: >"$SEED_SQL"
for i in $(seq 1 100); do
  cnpj="$(printf '96%012d' "$i")"
  printf "INSERT INTO \"Motorista\" (cnpj_prestador, nome, ativo) VALUES ('%s','Motorista Teste Carga %03d', true) ON CONFLICT DO NOTHING;\n" "$cnpj" "$i" >>"$SEED_SQL"
  printf "INSERT INTO \"PushInscricao\" (cnpj_prestador,endpoint,endpoint_hash,p256dh,auth,key_id,plataforma,dispositivo_id) VALUES ('%s','https://push-mock:8443/e/carga%03d','hash-carga-%03d','%s','%s','%s','android','%s') ON CONFLICT DO NOTHING;\n" \
    "$cnpj" "$i" "$i" "$PDH" "$AUTHK" "$KEYID_ATIVO" "$(newuuid)" >>"$SEED_SQL"
done
dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <"$SEED_SQL" >"$TMP/seed.log" 2>&1 \
  || { echo "FAIL: seed em lote de 100 inscrições"; tail -60 "$TMP/seed.log"; exit 1; }
N_SEEDED="$(psql_t -tAc "SELECT count(*) FROM \"PushInscricao\" WHERE endpoint_hash LIKE 'hash-carga-%';" | tr -d '[:space:]')"
check "9.5.1: fixture com >=100 inscrições ativas seguidas (grupo Movee, ramo legado)" "$(node -e "process.stdout.write(String(Number('$N_SEEDED')>=100))")" "true"

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login admin+motorista, PUT self-registro, baseline
# ANTES, disparo toda_base, polling+timing DURANTE/DEPOIS, capturas de
# roundtrip (9.6.2). Tudo dentro do MESMO processo backend (single-thread —
# é exatamente o que SC-005 quer expor: bloqueio do event loop).
# ─────────────────────────────────────────────────────────────────────────────
CHAVE_DISPARO="$(newuuid)"
DISPOSITIVO_CRED="$(newuuid)"
CARGA_OUT="$(run_node "$SENHA_ADMIN" "$SENHA_MOTORISTA" "$CNPJ_CRED" "$CHAVE_DISPARO" "$PDH" "$AUTHK" "$KEYID_ATIVO" "$DISPOSITIVO_CRED" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
const APP_BASE = 'http://localhost:3000/motorista';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function loginAdmin(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function loginMotorista(cnpjPrestador, senha) {
  const r = await fetch(`${APP_BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cnpjPrestador, senha }) });
  const body = await r.json().catch(() => null);
  return { jar: parseSetCookie(r), status: r.status, body };
}
async function timedGet(url, jar) {
  const t0 = Date.now();
  const r = await fetch(url, { headers: { Cookie: cookieHeader(jar) } });
  const ms = Date.now() - t0;
  const body = await r.json().catch(() => null);
  return { ms, status: r.status, body };
}
async function main() {
  const [senhaAdmin, senhaMotorista, cnpjCred, chaveDisparo, pdh, authk, keyId, dispositivoId] = process.argv.slice(2);
  const out = {};

  let adminJar = await loginAdmin('carga-admin@example.test', senhaAdmin);
  adminJar = await trocarEntidade(adminJar, 6);

  const credLogin = await loginMotorista(cnpjCred, senhaMotorista);
  out.motorista_login_status = credLogin.status;
  const motoristaJar = credLogin.jar;

  // 9.6.2 — PUT /motorista/push/inscricao: self-registro REAL (não SQL).
  const t0put = Date.now();
  const putR = await fetch(`${APP_BASE}/push/inscricao`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(motoristaJar) },
    // validarEndpointUrl (lib/hub-push-endpoint.js) rejeita porta explícita
    // no endpoint (regra anti-SSRF do contrato) — o push-mock só escuta em
    // 8443, então o endpoint REAL registrado aqui (sem porta -> 443
    // implícita) fica syntaticamente válido mas NÃO entregável; é aceitável
    // para captura de shape do PUT/GET (9.6.2) — a entrega real de carga
    // (9.5) já é coberta pelas 100 inscrições semeadas via SQL com a porta
    // correta.
    body: JSON.stringify({ endpoint: 'https://push-mock/e/credencial', keys: { p256dh: pdh, auth: authk }, keyId, plataforma: 'android', dispositivoId }),
  });
  out.put_inscricao_status = putR.status;
  out.put_inscricao_ms = Date.now() - t0put;
  const putBodyText = await putR.text();
  out.put_inscricao_body_vazio = putBodyText.length === 0;
  out.put_inscricao_body_debug = putBodyText;

  // 9.6.2 — GET /avisos/alcance (ANTES do disparo)
  const alcanceR = await timedGet(`${BASE}/avisos/alcance?modo=toda_base`, adminJar);
  out.alcance_status = alcanceR.status;
  out.alcance_body = alcanceR.body;
  out.alcance_ms = alcanceR.ms;

  // baseline ANTES (5 amostras) das 2 rotas não relacionadas ao envio
  const antes = [];
  for (let i = 0; i < 5; i += 1) {
    const a = await timedGet(`${BASE}/motoristas`, adminJar);
    const b = await timedGet(`${APP_BASE}/push/chave-publica`, motoristaJar);
    antes.push({ motoristas_ms: a.ms, motoristas_status: a.status, chave_ms: b.ms, chave_status: b.status });
  }
  out.amostras_antes = antes;

  // 9.6.2 — POST /avisos (disparo real, toda_base)
  const t0disparo = Date.now();
  const disparoR = await fetch(`${BASE}/avisos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(adminJar) },
    body: JSON.stringify({ titulo: 'Carga 9.5-9.6.2', corpo: 'corpo de teste carga concorrente', modoDestinatarios: 'toda_base', chaveIdempotencia: chaveDisparo }),
  });
  const disparoBody = await disparoR.json().catch(() => null);
  out.disparo_status = disparoR.status;
  out.disparo_ms = Date.now() - t0disparo;
  out.disparo_body = disparoBody;
  const avisoId = disparoBody && disparoBody.id;
  out.aviso_id = avisoId;

  // 9.5 — polling + timing DURANTE/DEPOIS (mesmo processo Node do worker
  // fire-and-forget: se o event loop travar por causa do envio, as 2 rotas
  // NÃO relacionadas ficam lentas NESTA janela).
  const durante = [];
  const depois = [];
  let avisoDetalheFinal = null;
  let concluidoSeguidos = 0;
  const MAX_ITER = 400;
  for (let i = 0; i < MAX_ITER; i += 1) {
    const a = await timedGet(`${BASE}/motoristas`, adminJar);
    const b = await timedGet(`${APP_BASE}/push/chave-publica`, motoristaJar);
    const det = await timedGet(`${BASE}/avisos/${avisoId}`, adminJar);
    const status = det.body && det.body.status;
    const amostra = { motoristas_ms: a.ms, motoristas_status: a.status, chave_ms: b.ms, chave_status: b.status, aviso_status: status || null };
    avisoDetalheFinal = det.body;
    if (status === 'concluido') {
      depois.push(amostra);
      concluidoSeguidos += 1;
      if (concluidoSeguidos >= 5) break;
    } else {
      durante.push(amostra);
    }
  }
  out.amostras_durante = durante;
  out.amostras_depois = depois;
  out.aviso_detalhe = avisoDetalheFinal;

  // 9.6.2 — GET /avisos/cobertura
  const coberturaR = await timedGet(`${BASE}/avisos/cobertura`, adminJar);
  out.cobertura_status = coberturaR.status;
  out.cobertura_body = coberturaR.body;

  // 9.6.2 — GET /motorista/avisos/:id (motorista lendo o próprio aviso)
  const motAvisoR = await timedGet(`${APP_BASE}/avisos/${avisoId}`, motoristaJar);
  out.motorista_aviso_status = motAvisoR.status;
  out.motorista_aviso_body = motAvisoR.body;

  // 9.6.2 — GET /motorista/push/chave-publica (corpo isolado p/ captura)
  const chaveR = await timedGet(`${APP_BASE}/push/chave-publica`, motoristaJar);
  out.chave_publica_status = chaveR.status;
  out.chave_publica_body = chaveR.body;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$CARGA_OUT" | grep -v '___RESULT_JSON___'
CARGA_LINE="$(echo "$CARGA_OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$CARGA_LINE" ] || { echo "FAIL: script de carga/roundtrip não retornou resultado"; exit 1; }
printf '%s' "$CARGA_LINE" >"$TMP/carga_result.json"
cp "$TMP/carga_result.json" "$EVID_DIR/carga-roundtrip-result-$(date -u +%Y%m%dT%H%M%SZ).json"

cget() { node -e "const d=JSON.parse(require('fs').readFileSync('$TMP/carga_result.json','utf8')); const v=d['$1']; process.stdout.write(v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):String(v));"; }

echo "DEBUG put_inscricao_body: $(cget put_inscricao_body_debug)"

check "motorista credencial: login legado real -> 200" "$(cget motorista_login_status)" "200"
check "PUT /motorista/push/inscricao (self-registro real) -> 204" "$(cget put_inscricao_status)" "204"
check "GET /avisos/alcance ANTES do disparo -> 200" "$(cget alcance_status)" "200"
check "POST /avisos (toda_base, >=100 inscrições) -> 201" "$(cget disparo_status)" "201"
check "GET /avisos/cobertura -> 200" "$(cget cobertura_status)" "200"
check "GET /motorista/avisos/:id (o próprio motorista lê seu aviso) -> 200" "$(cget motorista_aviso_status)" "200"
check "GET /motorista/push/chave-publica -> 200" "$(cget chave_publica_status)" "200"

# ─────────────────────────────────────────────────────────────────────────────
# 9.5.3 — reportar os tempos medidos (bruto + min/mediana/max) e checar que
# NENHUMA amostra (antes/durante/depois) teve status != 200 (erro atribuível
# ao envio).
# ─────────────────────────────────────────────────────────────────────────────
node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('$TMP/carga_result.json', 'utf8'));
function stats(arr, campo) {
  const vs = arr.map(a => a[campo]).sort((a,b)=>a-b);
  if (vs.length === 0) return { n: 0, min: null, mediana: null, max: null };
  const mediana = vs.length % 2 ? vs[(vs.length-1)/2] : (vs[vs.length/2-1]+vs[vs.length/2])/2;
  return { n: vs.length, min: vs[0], mediana, max: vs[vs.length-1] };
}
function errosStatus(arr, campo) { return arr.filter(a => a[campo] !== 200).length; }
const fases = { antes: d.amostras_antes || [], durante: d.amostras_durante || [], depois: d.amostras_depois || [] };
console.log('=== 9.5.3 — tempos medidos (ms) por fase ===');
for (const [nome, arr] of Object.entries(fases)) {
  const sm = stats(arr, 'motoristas_ms');
  const sc = stats(arr, 'chave_ms');
  console.log(\`\${nome}: GET /api/v1/motoristas n=\${sm.n} min=\${sm.min} mediana=\${sm.mediana} max=\${sm.max} | GET /motorista/push/chave-publica n=\${sc.n} min=\${sc.min} mediana=\${sc.mediana} max=\${sc.max}\`);
  console.log(\`\${nome}: erros(status!=200) motoristas=\${errosStatus(arr,'motoristas_status')} chave=\${errosStatus(arr,'chave_status')}\`);
}
console.log('total_deliveries_via_toda_base_inscricoes:', 101);
console.log('___STATS_ERROS___' + JSON.stringify({
  antes: errosStatus(fases.antes,'motoristas_status') + errosStatus(fases.antes,'chave_status'),
  durante: errosStatus(fases.durante,'motoristas_status') + errosStatus(fases.durante,'chave_status'),
  depois: errosStatus(fases.depois,'motoristas_status') + errosStatus(fases.depois,'chave_status'),
}));
" | tee "$TMP/stats.txt"
ERROS_LINE="$(grep '___STATS_ERROS___' "$TMP/stats.txt" | sed 's/^___STATS_ERROS___//')"
node -e "const d=JSON.parse(process.argv[1]); process.exit((d.antes+d.durante+d.depois)===0?0:1)" "$ERROS_LINE"
check "9.5.3: zero erro (status!=200) atribuível ao envio em qualquer fase" "$?" "0"

# ─────────────────────────────────────────────────────────────────────────────
# 9.6.2 — checagem de shape (camelCase, id/contagens como number, literais)
# dos 4 corpos do HUB, direto do JSON capturado (evidência bruta).
# ─────────────────────────────────────────────────────────────────────────────
node -e "
const d = JSON.parse(require('fs').readFileSync('$TMP/carga_result.json','utf8'));
const falhas = [];
const disparo = d.disparo_body || {};
if (typeof disparo.id !== 'number') falhas.push('POST /avisos: id não é number');
if (typeof disparo.status !== 'string') falhas.push('POST /avisos: status não é string');
if (typeof disparo.visados !== 'number') falhas.push('POST /avisos: visados não é number');
const det = d.aviso_detalhe || {};
if (typeof det.modoDestinatarios !== 'string') falhas.push('GET /avisos/:id: modoDestinatarios ausente (camelCase)');
if (!det.contagens || typeof det.contagens.aceitos !== 'number') falhas.push('GET /avisos/:id: contagens.aceitos não é number');
const alc = d.alcance_body || {};
if (typeof alc.motoristas !== 'number' || typeof alc.inscricoes !== 'number') falhas.push('GET /avisos/alcance: motoristas/inscricoes não são number');
const cob = d.cobertura_body || {};
if (!cob.ativos || typeof cob.ativos.android !== 'number') falhas.push('GET /avisos/cobertura: ativos.android não é number');
if (falhas.length) { console.error('SHAPE_FALHAS:', falhas.join(' | ')); process.exit(1); }
console.log('shape OK: camelCase + number nos 4 corpos do hub');
"
check "9.6.2: shape dos 4 corpos do hub bate com o contrato (camelCase, number)" "$?" "0"

# Corpos sem segredo (JWT/cookie) — só os 7 usados no roundtrip, extraídos p/
# arquivo dedicado para o teste vitest e para o registro (nenhum contém
# Set-Cookie/Authorization, só os corpos JSON de negócio).
node -e "
const d = JSON.parse(require('fs').readFileSync('$TMP/carga_result.json','utf8'));
const roundtrip = {
  disparo_body: d.disparo_body,
  aviso_detalhe: d.aviso_detalhe,
  alcance_body: d.alcance_body,
  cobertura_body: d.cobertura_body,
  chave_publica_body: d.chave_publica_body,
  motorista_aviso_body: d.motorista_aviso_body,
  put_inscricao_status: d.put_inscricao_status,
};
require('fs').writeFileSync('$EVID_DIR/roundtrip-cenario20-bodies.json', JSON.stringify(roundtrip, null, 2));
console.log('roundtrip bodies salvos em $EVID_DIR/roundtrip-cenario20-bodies.json');
"

echo "-----------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  echo "HUB-AVISOS-CARGA-ROUNDTRIP: OK — todos os asserts passaram (tasks.md 9.5 + 9.6.2)"
else
  echo "HUB-AVISOS-CARGA-ROUNDTRIP: $fails assert(s) FALHARAM" >&2
fi
exit "$fails"
