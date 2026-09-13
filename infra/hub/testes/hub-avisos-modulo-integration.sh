#!/usr/bin/env bash
# =============================================================================
# hub-avisos-modulo-integration.sh — tasks 1.3.2/1.3.3/1.4.3 (tasks.md FASE 1,
# feature "Notificações push no app do motorista"): prova E2E REAL (compose
# hub-test efêmero, sem mock, com build do backend) de que a migration
# 0062_modulo_avisos.sql seeda o catálogo RBAC do módulo "avisos" e de que a
# precondição de dados que middleware/hub-require-modulo.js consulta
# (ModuloEntidade × Modulo, via lib/hub-rbac-cache.js:195-200) transiciona de
# "avisos ausente" para "avisos presente" exatamente como o seed descreve —
# a rota routes/hub-avisos.js ainda não existe (FASE 4), então o 403/200
# HTTP fim-a-fim fica para lá; aqui provamos a precondição de RBAC que o
# torna possível, com o MESMO JWT hand-rolled (node:crypto, claims
# `empresa_ativa`/`escopo`) já usado por hub-push-avisos-integration.sh e
# hub-rls-integration.sh.
#
# Cobre:
#   1.3.2 — migrate.sh aplica 0062 e cada uma das 4 tabelas do seed
#           (Modulo/Permissao/PapelPermissao/ModuloEntidade) ganha exatamente
#           as linhas novas esperadas (4/4)
#   1.3.3 — ANTES de 0062 (só até 0061 aplicada): módulo 'avisos' AUSENTE do
#           conjunto de módulos ativos da empresa 6 (precondição de 403
#           MODULO_DESABILITADO); DEPOIS de 0062: 'avisos' PRESENTE
#           (precondição de 200)
#   1.4.3 — build+boot do backend com o mount da chave VAPID e os envs novos
#           (VAPID_KEYS_FILE/PUSH_HOSTS_PERMITIDOS) — 0 ocorrências de
#           PUSH_INDISPONIVEL no log de boot (nenhum código ainda lê essas
#           vars — FASE 2 — então isto também prova que o mount/env novos
#           não quebram o boot atual)
#
# Uso: infra/hub/testes/hub-avisos-modulo-integration.sh
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

# Consulta ModuloEntidade×Modulo da empresa 6 via PostgREST, MESMA query de
# obterModulosAtivosPorEntidade (lib/hub-rbac-cache.js:195-200) — a
# precondição de dados de que middleware/hub-require-modulo.js depende.
modulos_ativos_empresa6() {
  dc exec -T -e JWT_SECRET="$JWT_SECRET" mailpit-mock node - <<'JS'
const crypto = require('crypto');
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sign(claims) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = Object.assign({ role: 'authenticated' }, claims);
  const h = b64url(Buffer.from(JSON.stringify(header)));
  const p = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac('sha256', process.env.JWT_SECRET).update(h + '.' + p).digest());
  return h + '.' + p + '.' + sig;
}
(async () => {
  const token = sign({ empresa_ativa: 6, escopo: [6] });
  const r = await fetch(
    'http://postgrest:3000/ModuloEntidade?empresa_id=eq.6&ativo=eq.true&select=modulo:Modulo(codigo)',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const text = await r.text();
  console.log('STATUS=' + r.status);
  let codigos = [];
  try { codigos = JSON.parse(text).map((l) => l.modulo && l.modulo.codigo).filter(Boolean); } catch (e) { console.error('PARSE_FALHOU', text.slice(0, 300)); }
  console.log('CODIGOS=' + JSON.stringify(codigos.sort()));
})().catch((e) => { console.error('EXCECAO_NODE', e); process.exit(1); });
JS
}

# --- 1.3.3 (pré): aplicar SOMENTE até 0061 — 0062 ainda não existe ----------
# Checagem via SchemaMigration/Modulo (psql), não via string-matching do log
# de migrate.sh: "ignorada (além de -t 0061): 0062_modulo_avisos.sql" contém
# o texto "0062_modulo_avisos.sql" tanto quanto "aplicando: 0062..." faria —
# grep na linha errada gera falso-FAIL (visto numa 1ª corrida deste script).
echo "aplicando migrations até 0061 (sem 0062) para provar o estado 'antes do seed'…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" -t 0061 >"$TMP/migrate-pre.log" 2>&1 \
  || { echo "FAIL: migrate.sh -t 0061 retornou erro:"; tail -60 "$TMP/migrate-pre.log"; exit 1; }

N_SCHEMA_0062_PRE="$(psql_t -tAc "SELECT count(*) FROM \"SchemaMigration\" WHERE nome LIKE '0062%'")"
check "1.3.3 (pré): 0062 NÃO está em SchemaMigration (-t 0061 respeitado)" "$N_SCHEMA_0062_PRE" "0"

N_MODULO_PRE="$(psql_t -tAc "SELECT count(*) FROM \"Modulo\" WHERE codigo='avisos'")"
check "1.3.3 (pré): módulo 'avisos' ainda não existe no catálogo" "$N_MODULO_PRE" "0"

PRE_OUT="$(modulos_ativos_empresa6)"
echo "$PRE_OUT"
check "1.3.3 (pré): status 200 na leitura de ModuloEntidade" "$(printf '%s\n' "$PRE_OUT" | grep -o 'STATUS=[0-9]*')" "STATUS=200"
check "1.3.3 (pré): 'avisos' AUSENTE do conjunto (precondição de 403 MODULO_DESABILITADO)" \
  "$(printf '%s\n' "$PRE_OUT" | grep -o 'CODIGOS=.*' | grep -c '"avisos"')" "0"

# --- 1.3.2: aplicar a série completa (inclui 0062) e conferir 4/4 tabelas --
echo "aplicando migrations completas (inclui 0062)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate-full.log" 2>&1
if ! grep -q "0062_modulo_avisos.sql" "$TMP/migrate-full.log"; then
  echo "FAIL: 0062 não aplicada — log completo:"; tail -100 "$TMP/migrate-full.log"; exit 1
fi

N_MODULO="$(psql_t -tAc "SELECT count(*) FROM \"Modulo\" WHERE codigo='avisos'")"
check "1.3.2 (1/4 Modulo): 1 linha nova (codigo='avisos')" "$N_MODULO" "1"
N_PERMISSAO="$(psql_t -tAc "SELECT count(*) FROM \"Permissao\" WHERE codigo IN ('avisos.consultar','avisos.enviar')")"
check "1.3.2 (2/4 Permissao): 2 linhas novas (consultar+enviar)" "$N_PERMISSAO" "2"
N_PAPELPERMISSAO="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Permissao\" perm ON perm.id = pp.permissao_id JOIN \"Papel\" p ON p.id = pp.papel_id WHERE perm.codigo IN ('avisos.consultar','avisos.enviar') AND p.nome IN ('admin_plataforma','admin_entidade')")"
check "1.3.2 (3/4 PapelPermissao): 4 linhas novas (2 papéis x 2 permissões)" "$N_PAPELPERMISSAO" "4"
N_MODULOENTIDADE="$(psql_t -tAc "SELECT count(*) FROM \"ModuloEntidade\" me JOIN \"Modulo\" m ON m.id = me.modulo_id WHERE m.codigo='avisos' AND me.empresa_id=6 AND me.ativo")"
check "1.3.2 (4/4 ModuloEntidade): 1 linha nova (avisos, empresa 6, ativo)" "$N_MODULOENTIDADE" "1"

"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate-full2.log" 2>&1
check "1.3.2: migrate.sh 2x — 0062 idempotente (pulada na 2ª corrida)" \
  "$(grep -c 'pulada (já aplicada): 0062_modulo_avisos.sql' "$TMP/migrate-full2.log")" "1"

POS_OUT="$(modulos_ativos_empresa6)"
echo "$POS_OUT"
check "1.3.3 (pós): status 200 na leitura de ModuloEntidade" "$(printf '%s\n' "$POS_OUT" | grep -o 'STATUS=[0-9]*')" "STATUS=200"
check "1.3.3 (pós): 'avisos' PRESENTE do conjunto (precondição de 200)" \
  "$(printf '%s\n' "$POS_OUT" | grep -o 'CODIGOS=.*' | grep -c '"avisos"')" "1"

# --- 1.4.3: build+boot do backend com o mount VAPID + envs novos -----------
echo "buildando backend (Dockerfile.hub, --memory=2g)…"
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

echo "aguardando boot do backend…"
BOOT_OK=0
for _ in 1 2 3 4 5 6; do
  dc logs backend >"$TMP/backend-boot.log" 2>&1
  if grep -q "Servidor rodando na porta 3000" "$TMP/backend-boot.log"; then BOOT_OK=1; break; fi
  sleep 3
done
check "1.4.3: backend terminou o boot (log 'Servidor rodando na porta 3000')" "$BOOT_OK" "1"
check "1.4.3: 0 ocorrências de PUSH_INDISPONIVEL no log de boot" \
  "$(grep -c "PUSH_INDISPONIVEL" "$TMP/backend-boot.log")" "0"

echo "-----------------------------------------------------------------"
if [ "$fails" -eq 0 ]; then
  echo "RESULTADO: TODOS OS CHECKS PASSARAM"
else
  echo "RESULTADO: $fails CHECK(S) FALHARAM"
fi
exit "$fails"
