#!/usr/bin/env bash
# =============================================================================
# hub-financeiro-aprovador-furo.sh — tasks.md 2.1.1/2.1.2/2.1.4/2.1.5: prova
# do furo DIRETO NO POSTGREST (a defesa que vale de verdade, por comentário
# de lib/hub-papeis-restritos.js — a checagem em Node é só early-exit UX) num
# projeto hub-test EFÊMERO e descartável (db+postgrest apenas — SEM build do
# backend, que não participa desta prova: a checagem de rota já é coberta ao
# nível de unit por tests/hub-usuarios-trava-unit.test.js, ver
# docs/plans/repasse-saldo-minimo/EVIDENCIA-F2-CONTROLE-NEGATIVO.md).
#
# Cobre, ANTES (schema em 0096) e DEPOIS (0097 aplicada) da migration:
#   (a) POST /UsuarioEntidade concedendo papel_id RESTRITO (admin_plataforma)
#       a um usuário qualquer de uma entidade, com um JWT cujo único
#       privilégio é `escopo` conter essa entidade (RLS de UsuarioEntidade,
#       0097 seção 4)
#   (b) POST /PapelPermissao inserindo uma linha arbitrária na matriz RBAC
#       (GRANT bruto de 0003:58, REVOGADO pela 0097 seção 5)
#
# Uso: infra/hub/testes/hub-financeiro-aprovador-furo.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RAIZ="$(cd "$HUB_DIR/../.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
PGRST_SECRET="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$PGRST_SECRET" ] || { echo "HUB_DB_USER/HUB_DB_NAME/PGRST_JWT_SECRET ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
NET="${PROJECT}_default"
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest efêmeros ($PROJECT, tmpfs, SEM backend)…"
dc up -d --wait db
dc up -d --wait postgrest

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
curl_pg() { docker run --rm --network "$NET" curlimages/curl:8.11.1 -s -o /dev/stdout -w '\nHTTP_STATUS:%{http_code}\n' "$@"; }

# JWT via o MESMO helper de produção (lib/hub-postgrest-jwt.js), gerado no
# HOST (node local já tem jsonwebtoken instalado — sem precisar do container
# backend só para assinar um token).
jwt_for() { # jwt_for <sub> <empresaAtiva> <escopoCsv>
  PGRST_JWT_SECRET="$PGRST_SECRET" node -e "
    const { generateHubPostgrestJWT } = require('$RAIZ/app_homologacao/backend/lib/hub-postgrest-jwt');
    process.stdout.write(generateHubPostgrestJWT({ usuarioId: process.argv[1], empresaAtiva: process.argv[2], escopo: process.argv[3].split(',').map(Number) }));
  " "$1" "$2" "$3"
}

echo "rodando migrate.sh -t 0096 (schema ANTES da 0097)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" -t 0096 >"$TMP/migrate-antes.log" 2>&1
grep -q "^aplicando: 0096_email_motorista_no_hub.sql" "$TMP/migrate-antes.log" || { echo "FAIL: migrations até 0096 não aplicadas"; cat "$TMP/migrate-antes.log"; exit 1; }
grep -q "^aplicando: 0097" "$TMP/migrate-antes.log" && { echo "FAIL: 0097 não deveria ter sido aplicada ainda"; cat "$TMP/migrate-antes.log"; exit 1; }

E=930001
psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('furo-alvo@example.test', 'x', 'Usuario Alvo Furo', true),
  ('furo-caller@example.test', 'x', 'Usuario Caller Furo', true);
SQL
UID_ALVO="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='furo-alvo@example.test'" | tr -d '[:space:]')"
UID_CALLER="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='furo-caller@example.test'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
PAPEL_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_plataforma'" | tr -d '[:space:]')"
PERM_QUALQUER="$(psql_t -tAc "SELECT id FROM \"Permissao\" LIMIT 1" | tr -d '[:space:]')"
[ -n "$UID_ALVO" ] && [ -n "$PAPEL_LEITURA" ] && [ -n "$PAPEL_ADMIN_PLATAFORMA" ] && [ -n "$PERM_QUALQUER" ] \
  || { echo "FAIL: seed base (0007) não populou papéis/permissões esperados"; exit 1; }
# caller só tem vínculo comum (leitura) na entidade E — nenhum privilégio
# especial além de estar no escopo. Prova que a RLS pré-0097 não distingue
# "qualquer membro da entidade" de "admin_plataforma" para conceder papel restrito.
psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES ($UID_CALLER, $E, $PAPEL_LEITURA, true);
SQL

JWT="$(jwt_for "$UID_CALLER" "$E" "$E")"
[ -n "$JWT" ] || { echo "FAIL: geração do JWT falhou"; exit 1; }

fails=0
check_status() { # check_status <descricao> <output-com-HTTP_STATUS> <esperado-regex>
  local st; st="$(printf '%s' "$2" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)"
  if printf '%s' "$st" | grep -qE "$3"; then echo "PASS: $1 (HTTP $st)"; else echo "FAIL: $1 (HTTP $st, esperado $3)"; fails=$((fails + 1)); fi
}

echo "=== ANTES da 0097 (schema 0096) ==="
OUT_A="$(curl_pg -X POST "http://postgrest:3000/UsuarioEntidade" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d "{\"usuario_id\":$UID_ALVO,\"empresa_id\":$E,\"papel_id\":$PAPEL_ADMIN_PLATAFORMA,\"ativo\":true}")"
check_status "2.1.1/2.1.2(a) ANTES: POST /UsuarioEntidade papel_id=admin_plataforma (deveria PASSAR = furo)" "$OUT_A" '^2'

OUT_B="$(curl_pg -X POST "http://postgrest:3000/PapelPermissao" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d "{\"papel_id\":$PAPEL_LEITURA,\"permissao_id\":$PERM_QUALQUER}")"
check_status "2.1.2(b) ANTES: POST /PapelPermissao arbitrário (deveria PASSAR = furo, ON CONFLICT ou 2xx)" "$OUT_B" '^(2|409)'

echo
echo "=== evidência (2.1.4) salva em $TMP/evidencia-antes.txt ==="
{ echo "-- POST /UsuarioEntidade (papel_id=admin_plataforma) --"; echo "$OUT_A";
  echo "-- POST /PapelPermissao (arbitrário) --"; echo "$OUT_B"; } | tee "$TMP/evidencia-antes.txt" >/dev/null
cp "$TMP/evidencia-antes.txt" "$RAIZ/docs/plans/repasse-saldo-minimo/EVIDENCIA-F2-POSTGREST-ANTES.txt" 2>/dev/null || true

# limpa o vínculo criado pelo furo (se criou) antes de aplicar 0097, para o
# "depois" começar do mesmo estado limpo.
psql_t -c "DELETE FROM \"UsuarioEntidade\" WHERE usuario_id=$UID_ALVO AND empresa_id=$E" >/dev/null 2>&1 || true

echo
echo "aplicando o resto da série (0097+0098)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate-depois.log" 2>&1
grep -q "0098_repasse_saldo_minimo.sql" "$TMP/migrate-depois.log" || { echo "FAIL: 0097/0098 não aplicadas"; cat "$TMP/migrate-depois.log"; exit 1; }

echo "=== DEPOIS da 0097 (2.1.5 / Cenário F2.4) ==="
OUT_C="$(curl_pg -X POST "http://postgrest:3000/UsuarioEntidade" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d "{\"usuario_id\":$UID_ALVO,\"empresa_id\":$E,\"papel_id\":$PAPEL_ADMIN_PLATAFORMA,\"ativo\":true}")"
check_status "2.1.5(a) DEPOIS: POST /UsuarioEntidade papel_id=admin_plataforma (deve FALHAR)" "$OUT_C" '^4'

OUT_D="$(curl_pg -X POST "http://postgrest:3000/PapelPermissao" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -H "Prefer: return=minimal" \
  -d "{\"papel_id\":$PAPEL_LEITURA,\"permissao_id\":$PERM_QUALQUER}")"
check_status "2.1.5(b) DEPOIS: POST /PapelPermissao arbitrário (deve FALHAR)" "$OUT_D" '^4'

{ echo "-- POST /UsuarioEntidade (papel_id=admin_plataforma) --"; echo "$OUT_C";
  echo "-- POST /PapelPermissao (arbitrário) --"; echo "$OUT_D"; } > "$RAIZ/docs/plans/repasse-saldo-minimo/EVIDENCIA-F2-POSTGREST-DEPOIS.txt" 2>/dev/null || true

echo
echo "fails=$fails"
[ "$fails" -eq 0 ]
