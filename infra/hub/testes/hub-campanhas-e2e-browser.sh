#!/usr/bin/env bash
# =============================================================================
# hub-campanhas-e2e-browser.sh — feature campanhas-motorista, onda W4: E2E de BROWSER de ponta a
# ponta, conferido no banco.
#
#   (a) hub: rascunho pelo formulário (opções reais, pesos 30/30/20/20, corte, 2 faixas objeto+dinheiro)
#       -> editar -> "Revisar e lançar" (botão desabilitado até marcar a caixa) -> lançar;
#       banco: lancada_em e UPDATE/DELETE direto recusados pelo gatilho
#   (b) lançada: sem caminho de edição na UI; PUT direto -> 409 CAMPANHA_IMUTAVEL
#   (c) recalcular (hub_campanhas_recalcular_ativas, como o gancho) -> ranking, abas, contagens;
#       financeiro enxerga
#   (d) app: login -> card -> tela (pódio, top 10 abreviado, indicadores; nenhum sobrenome de
#       terceiro no DOM/HTML/JSON); 2º motorista abaixo do corte vê "fora do ranking" + hipotética
#   (e) fechar -> hub mostra vencedores; entrega do objeto; planilha de prêmios em dinheiro
#       (cabeçalho = CABECALHO_ESPERADO e lida pelo PARSER REAL do lançamento externo); app: "Resultado final"
#   (f) hub_campanhas_avisar_inicio() -> notificação /campanhas/<id> na central do app, link clicável
#
# Ambiente: stack efêmero hub-test-<runid> (db + postgrest + backend, série de migrations completa).
# UM container oficial do Playwright fica de pé com os DOIS frontends (hub :3005 e app motorista
# :3006, `next build && next start`, sem `npm install`); cada fase é um spec rodado por `docker exec`
# e o banco é mexido ENTRE as fases (specs não têm psql). "Hoje" é o do banco (hub_hoje_sp());
# na fase de fechamento ele é fixado em HOJE+2 neste stack efêmero (como o hub-campanhas-db.sh).
#
# CAMP_KEEP=1   não derruba o stack no fim (só para depurar; derrube à mão depois).
# CAMP_REUSE=<projeto> CAMP_PW=<container> CAMP_PHASES="3 4"   reaproveita um stack já no ar.
# Uso: infra/hub/testes/hub-campanhas-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
MOTORISTA_DIR="$REPO_DIR/app_homologacao/frontend_motorista"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="${CAMP_REUSE:-hub-test-$RUNID}"
PW="${CAMP_PW:-$PROJECT-pw}"
TMP="$(mktemp -d)"
DL="$TMP/dl"; mkdir -p "$DL"; chmod 777 "$DL"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/envioMassa_homologacao/evidencias/campanhas"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/campanhas-e2e-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"
PHASES="${CAMP_PHASES:-1 2 3 4 5}"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
VAPID_KEYS_FILE="$(get_var VAPID_KEYS_FILE "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$VAPID_KEYS_FILE" ] || { echo "HUB_DB_USER/HUB_DB_NAME/VAPID_KEYS_FILE ausentes em $ENV_FILE" >&2; exit 2; }
# mesmo achado do hub-avisos-e2e-browser.sh (dec-122): o PostgREST efêmero só aceita PGRST_JWT_SECRET.
PGRST_JWT_SECRET_VAL="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$PGRST_JWT_SECRET_VAL" ] || { echo "PGRST_JWT_SECRET ausente em $ENV_FILE" >&2; exit 2; }
export POSTGREST_API_KEY="$PGRST_JWT_SECRET_VAL"

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_relaxed() { dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }
own() { psql_t -tAc "$1" 2>&1 | tr -d '\r'; }
ownx() { psql_relaxed -tA 2>&1 -c "$1" | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }

# rpc <email> <escopo-json> <empresa_ativa> <sql>: como o PostgREST chamaria (SET ROLE authenticated + claims)
rpc() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"' | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='$1'),'empresa_ativa','$3','escopo','$2'::jsonb)::text, true);
SET ROLE authenticated;
$4
COMMIT;
SQL
}
worker() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"hub_push' | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_push_worker":true,"escopo":[]}', true);
SET ROLE authenticated;
$1
COMMIT;
SQL
}

fails=0; passes=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}
check_match() { # check_match <desc> <valor> <regex-ERE>
  if printf '%s' "$2" | grep -qE "$3"; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado~/$3/)"; fails=$((fails + 1)); fi
}

cleanup() {
  echo; echo "=== cleanup ==="
  if [ -n "${CAMP_KEEP:-}" ] || [ -n "${CAMP_REUSE:-}" ]; then
    echo "CAMP_KEEP/CAMP_REUSE: stack MANTIDO ($PROJECT, container $PW) — derrube à mão: docker rm -f $PW; docker compose -f $COMPOSE -p $PROJECT --env-file $ENV_FILE down -v --rmi local"
  else
    docker rm -f "$PW" >/dev/null 2>&1 || true
    dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  echo "=== conferindo package-lock.json (gotcha do container Playwright) ==="
  for d in "$FRONTEND_DIR" "$MOTORISTA_DIR"; do
    if ! git -C "$d" diff --quiet -- package-lock.json 2>/dev/null; then
      echo "AVISO: package-lock.json de $d foi alterado pelo container — revertendo" >&2
      git -C "$d" checkout -- package-lock.json
    else
      echo "package-lock.json intacto em $d"
    fi
  done
  echo "=== sobras hub-test-* (deve ser 0) ==="
  docker ps -a --format '{{.Names}}' | grep '^hub-test-' || echo "(nenhum container)"
  docker volume ls --format '{{.Name}}' | grep '^hub-test-' || echo "(nenhum volume)"
  docker network ls --format '{{.Name}}' | grep '^hub-test-' || echo "(nenhuma rede)"
  echo "=== estado do host DEPOIS ==="; free -h; df -h /
}
trap cleanup EXIT

# ------------------------------ guardas de recurso ------------------------------
echo "df -h / e swap antes do build:"; df -h /; swapon --show
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
SWAP_FREE_KB=$(awk '/SwapFree/{print $2}' /proc/meminfo)
DISK_AVAIL_KB=$(df -Pk / | awk 'NR==2{print $4}')
[ "${AVAIL_KB:-0}" -ge 2097152 ] || { echo "ABORTADO: RAM disponível < 2Gi (lição 2026-06-11)" >&2; exit 2; }
[ "${SWAP_FREE_KB:-0}" -ge 1048576 ] || { echo "ABORTADO: swap livre < 1Gi" >&2; exit 2; }
[ "${DISK_AVAIL_KB:-0}" -ge 20971520 ] || { echo "ABORTADO: disco livre em / < 20Gi (lição 2026-08-30)" >&2; exit 2; }

# ------------------------------ stack + seeds + frontends ------------------------------
SENHA_ADMIN='SenhaSinteticaCampanhas#1'
SENHA_MOT='SenhaMotoristaCampanhas#1'
ADMIN_EMAIL="camp-admin@example.test"; FIN_EMAIL="camp-fin@example.test"
EMP=6
NOME_CAMPANHA='Rei do Jantar E2E'
# CNPJs com dígito verificador válido (o parser real do lançamento externo confere)
cnpj_valido() { node -e "
const b='9000000'+String(process.argv[1]).padStart(5,'0');const d=(s,p)=>{let t=0;for(let i=0;i<s.length;i++)t+=+s[i]*p[i];const r=t%11;return r<2?0:11-r};
const p1=[5,4,3,2,9,8,7,6,5,4,3,2],p2=[6,5,4,3,2,9,8,7,6,5,4,3,2];const a=b+d(b,p1);process.stdout.write(a+d(a,p2));" "$1"; }
C_ALINE="$(cnpj_valido 1)"; C_BRUNO="$(cnpj_valido 2)"; C_CARLA="$(cnpj_valido 3)"; C_EVA="$(cnpj_valido 4)"
C_DIEGO="$(cnpj_valido 5)"; C_FABIO="$(cnpj_valido 6)"; C_GIL="$(cnpj_valido 7)"; C_HUGO="$(cnpj_valido 8)"

if [ -z "${CAMP_REUSE:-}" ]; then
  "$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }
  mkdir -p "$HUB_DIR/mocks/push-mock/tls"   # bind do compose (sem push-mock neste driver: o cert não é usado)
  echo "subindo db+postgrest efêmeros ($PROJECT, tmpfs)…"
  dc up -d --wait db
  dc up -d --wait postgrest
  echo "rodando migrate.sh (série completa, inclusive a 0127)…"
  "$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1 || { echo "FAIL: migrate"; tail -40 "$TMP/migrate.log"; exit 1; }
  grep -q "0127_campanhas.sql" "$TMP/migrate.log" || { echo "FAIL: 0127 não aplicada"; tail -40 "$TMP/migrate.log"; exit 1; }
  echo "PASS: série de migrations aplicada do zero, com a 0127"
  # recarrega o schema cache do PostgREST (RPCs novas)
  dc kill -s SIGUSR1 postgrest >/dev/null 2>&1 || true

  echo "df -h / antes do build do backend:"; df -h /
  DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -80 "$TMP/build.log"; exit 1; }
  dc up -d --wait backend

  HASH_ADMIN="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA_ADMIN" 2>"$TMP/h1.log" | tr -d '[:space:]')"
  HASH_MOT="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA_MOT" 2>"$TMP/h2.log" | tr -d '[:space:]')"
  [ -n "$HASH_ADMIN" ] && [ -n "$HASH_MOT" ] || { echo "FAIL: hash bcrypt"; cat "$TMP/h1.log" "$TMP/h2.log"; exit 1; }

  HOJE="$(own "SELECT hub_hoje_sp()")"
  echo "hoje (banco) = $HOJE"
  # --- usuários (admin_entidade e financeiro) + módulo campanhas habilitado para a empresa ---
  psql_t -q <<SQL >"$TMP/seed1.log" 2>&1 || { echo "FAIL: seed usuários/módulo"; cat "$TMP/seed1.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('$ADMIN_EMAIL','$HASH_ADMIN','E2E Campanhas Admin',true),('$FIN_EMAIL','$HASH_ADMIN','E2E Campanhas Financeiro',true);
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='$ADMIN_EMAIL'), $EMP, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='$FIN_EMAIL'),   $EMP, (SELECT id FROM "Papel" WHERE nome='financeiro'), true);
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
  SELECT m.id, $EMP, true FROM "Modulo" m WHERE m.codigo = 'campanhas'
  ON CONFLICT DO NOTHING;
SQL
  # --- elenco: PerformanceTurno de HOJE (jantar, SP), MV, modal no dados_entrego_json, conta + legado ---
  # contas calculadas à mão (max pedidos dos classificados = 12):
  #   Aline  acc 100 conc 100 tempo 95 ped 100            -> 99,00   1º
  #   Bruno  acc  90 conc 100 tempo 90 ped 83,33          -> 91,67   2º
  #   Carla  acc  90 conc 88,89 tempo 90 ped 75           -> 86,67   3º
  #   Eva    acc  80 conc 100 tempo 90 ped 66,67 (=corte) -> 85,33   4º   (motorista A do app)
  #   Diego  acc  70 (< corte 80) -> abaixo_corte; hipotética 77,33 = 5º (motorista B do app)
  #   Fabio  sem modal -> sem_modal · Gil modal CARRO -> fora (nem gravado)
  #   Hugo   Campinas/almoço -> só alimenta as opções (praça CAMPINAS, turno ALMOCO)
  psql_t -q <<SQL >"$TMP/seed2.log" 2>&1 || { echo "FAIL: seed elenco"; cat "$TMP/seed2.log"; exit 1; }
CREATE TEMP TABLE spec (nome text, modal text, praca text, periodo text, dur interval, o int, a int, c int, p int, t numeric, cnpj text);
INSERT INTO spec VALUES
 ('Aline Ribeiro Santos',  ' moto ', 'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10, 10, 10, 12, 3.8, '$C_ALINE'),
 ('Bruno Teixeira Souza',  'MOTO',   'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10,  9,  9, 10, 3.6, '$C_BRUNO'),
 ('Carla Dias Moreira',    'MOTO',   'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10,  9,  8,  9, 3.6, '$C_CARLA'),
 ('Eva Costa Lima',        'MOTO',   'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10,  8,  8,  8, 3.6, '$C_EVA'),
 ('Diego Pires Oliveira',  'MOTO',   'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10,  7,  7,  5, 3.6, '$C_DIEGO'),
 ('Fabio Nunes Pinto',     NULL,     'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10,  9,  9,  8, 3.6, '$C_FABIO'),
 ('Gil Rocha Prado',       'CARRO',  'SAO PAULO', 'JANTAR 18H-22H', interval '4 hours', 10,  9,  9,  8, 3.6, '$C_GIL'),
 ('Hugo Campos Lopes',     'MOTO',   'CAMPINAS',  'ALMOCO 11H-14H', interval '3 hours', 10,  9,  9,  8, 2.7, '$C_HUGO');
-- legado (login do app) ANTES da conta: o gatilho da 0123 adota a senha do legado
INSERT INTO "Motorista" (cnpj_prestador, nome, ativo, senha) SELECT cnpj, nome, true, '$HASH_MOT' FROM spec;
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo) SELECT cnpj, nome, true FROM spec ON CONFLICT (cnpj_prestador) DO NOTHING;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, ativo, dados_entrego_json)
  SELECT $EMP, gen_random_uuid(), s.nome, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = s.cnpj), true,
         CASE WHEN s.modal IS NULL THEN NULL ELSE jsonb_build_object('informacoesEntrega', jsonb_build_object('modal', s.modal)) END
  FROM spec s;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES ($EMP,'performance',repeat('a',64),'completed');
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT $EMP, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('a',64)), e.id, '$HOJE'::date, s.periodo, s.dur, s.praca,
       s.o, s.a, s.c, s.p, make_interval(secs => (s.t * 3600)::float8), md5(e.id::text||'$HOJE'||s.periodo)||md5('$HOJE'||e.id::text)
FROM spec s JOIN "Entregador" e ON e.nome = s.nome AND e.id_empresa = $EMP;
REFRESH MATERIALIZED VIEW mv_performance_dia;
SQL
  check "seed: 8 entregadores e 8 turnos em PerformanceTurno" "$(own "SELECT (SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMP)||'/'||(SELECT count(*) FROM \"PerformanceTurno\" WHERE id_empresa=$EMP)")" "8/8"
  check "seed: módulo campanhas habilitado para a empresa $EMP" "$(own "SELECT count(*) FROM \"ModuloEntidade\" me JOIN \"Modulo\" m ON m.id=me.modulo_id WHERE m.codigo='campanhas' AND me.empresa_id=$EMP AND me.ativo")" "1"

  # --- frontends: UM container Playwright de pé, builds e starts dentro dele ---
  NET="$(docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Name}}' | head -1)"
  [ -n "$NET" ] || { echo "FAIL: rede docker do projeto $PROJECT não encontrada"; exit 1; }
  echo "rede docker do projeto: $NET"
  docker run -d --name "$PW" --memory=2g --network "$NET" \
    -e CI=true \
    -v "$FRONTEND_DIR:/work" -v "$MOTORISTA_DIR:/motorista" -v "$DL:/dl" \
    -w /work "$PLAYWRIGHT_IMAGE" tail -f /dev/null >/dev/null || { echo "FAIL: container Playwright"; exit 1; }
  echo "df -h / antes dos builds dos frontends:"; df -h /
  docker exec -e NODE_ENV=production -e APP_ENV=dev -e BACKEND_URL=http://backend:3000 -e HUB_BACKEND_URL=http://backend:3000/api \
    "$PW" bash -lc 'cd /work && npm run build > /tmp/build-hub.log 2>&1 || { echo BUILD_HUB_FAILED; tail -120 /tmp/build-hub.log; exit 1; }' || exit 1
  docker exec -e NODE_ENV=production -e BACKEND_URL=http://backend:3000 \
    "$PW" bash -lc 'cd /motorista && npm run build > /tmp/build-app.log 2>&1 || { echo BUILD_APP_FAILED; tail -120 /tmp/build-app.log; exit 1; }' || exit 1
  docker exec -d -e NODE_ENV=production -e APP_ENV=dev -e BACKEND_URL=http://backend:3000 -e HUB_BACKEND_URL=http://backend:3000/api \
    "$PW" bash -lc 'cd /work && npx next start -p 3005 -H 0.0.0.0 > /tmp/start-hub.log 2>&1'
  docker exec -d -e NODE_ENV=production -e BACKEND_URL=http://backend:3000 \
    "$PW" bash -lc 'cd /motorista && npx next start -p 3006 -H 0.0.0.0 > /tmp/start-app.log 2>&1'
  for porta_url in "3005 hub/login" "3006 login"; do
    set -- $porta_url; ok=""
    for _ in $(seq 1 40); do
      docker exec "$PW" curl -sf -o /dev/null "http://127.0.0.1:$1/$2" && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || { echo "FRONTEND_NAO_SUBIU (porta $1)"; docker exec "$PW" bash -c 'tail -30 /tmp/start-hub.log /tmp/start-app.log'; exit 1; }
  done
  echo "frontends no ar (hub :3005, app :3006)"
fi

HOJE="$(own "SELECT hub_hoje_sp()")"
ADM="$ADMIN_EMAIL"; E6="[$EMP]"

# placar agregado do Playwright por fase
PW_PASSED=0; PW_FAILED=0; PW_FLAKY=0; PW_EXIT_ALL=0
roda_fase() { # roda_fase <rótulo> <arquivo-do-spec> [VAR=valor ...]
  local rotulo="$1" arq="$2"; shift 2
  local envs=(-e "HUB_E2E_BASE_URL=http://127.0.0.1:3005" -e "MOTORISTA_E2E_BASE_URL=http://127.0.0.1:3006"
              -e "CAMP_HOJE=$HOJE" -e "CAMP_ADMIN_EMAIL=$ADMIN_EMAIL" -e "CAMP_ADMIN_SENHA=$SENHA_ADMIN"
              -e "CAMP_FIN_EMAIL=$FIN_EMAIL" -e "CAMP_FIN_SENHA=$SENHA_ADMIN" -e "CAMP_MOT_SENHA=$SENHA_MOT"
              -e "CAMP_MOT_A_CNPJ=$C_EVA" -e "CAMP_MOT_B_CNPJ=$C_DIEGO" -e "CAMP_MOT_W_CNPJ=$C_ALINE"
              -e "CAMP_ID=${CAMP_ID:-0}")
  local v; for v in "$@"; do envs+=(-e "$v"); done
  echo; echo "=== fase $rotulo ($arq) ==="
  local out="$TMP/fase-$rotulo.log"
  docker exec "${envs[@]}" "$PW" bash -lc "cd /work && npx playwright test -c playwright.config.hub-campanhas.ts tests/e2e-hub-campanhas/$arq" 2>&1 | tee "$out"
  local rc=${PIPESTATUS[0]}
  cat "$out" >> "$RUN_LOG"
  local n
  n="$(grep -oE '^ +[0-9]+ passed' "$out" | grep -oE '[0-9]+' | tail -1)"; PW_PASSED=$((PW_PASSED + ${n:-0}))
  n="$(grep -oE '^ +[0-9]+ failed' "$out" | grep -oE '[0-9]+' | tail -1)"; PW_FAILED=$((PW_FAILED + ${n:-0}))
  n="$(grep -oE '^ +[0-9]+ flaky' "$out" | grep -oE '[0-9]+' | tail -1)"; PW_FLAKY=$((PW_FLAKY + ${n:-0}))
  [ "$rc" = "0" ] || PW_EXIT_ALL=1
  return "$rc"
}
campanha_id() { own "SELECT id FROM \"Campanha\" WHERE nome='$NOME_CAMPANHA' AND lancada_em IS NOT NULL ORDER BY id DESC LIMIT 1"; }
tem_fase() { case " $PHASES " in *" $1 "*) return 0;; *) return 1;; esac; }

# ============================ fase 1: criar, editar, lançar (a, b) ============================
if tem_fase 1; then
  roda_fase 1 01-hub-criar-lancar
  CAMP_ID="$(campanha_id)"
  echo "--- banco depois da fase 1 (campanha #$CAMP_ID) ---"
  check_match "a/banco: campanha lançada (lancada_em preenchido) e situação em_andamento" "$(own "SELECT (lancada_em IS NOT NULL)||'/'||hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$CAMP_ID")" '^true/em_andamento$|^t/em_andamento$'
  check "a/banco: só UMA campanha lançada com esse nome (retry não duplicou)" "$(own "SELECT count(*) FROM \"Campanha\" WHERE nome='$NOME_CAMPANHA' AND lancada_em IS NOT NULL")" "1"
  check "c/banco: rascunho excluido pela UI nao existe mais (nem prêmios órfãos)" "$(own "SELECT (SELECT count(*) FROM \"Campanha\" WHERE nome LIKE 'Rascunho para excluir E2E%')||'/'||(SELECT count(*) FROM \"CampanhaPremio\" WHERE campanha_id NOT IN (SELECT id FROM \"Campanha\"))")" "0/0"
  check "a/banco: campos do formulário gravados (nome, período, praça/turno/modal canônicos, min_turnos)" \
    "$(own "SELECT nome||'|'||data_inicio||'|'||data_fim||'|'||pracas::text||turnos::text||modais::text||'|'||min_turnos FROM \"Campanha\" WHERE id=$CAMP_ID")" \
    "$NOME_CAMPANHA|$HOJE|$(date -u -d "$HOJE + 1 day" +%F)|{\"SAO PAULO\"}{\"JANTAR 18H-22H\"}{MOTO}|1"
  check "a/banco: pesos 30/30/20/20 e corte de aceitação 0,8 (demais sem corte)" \
    "$(own "SELECT peso_aceitacao||'/'||peso_conclusao||'/'||peso_tempo||'/'||peso_pedidos||' '||corte_aceitacao||' '||COALESCE(corte_conclusao::text,'-')||COALESCE(corte_tempo::text,'-')||COALESCE(corte_pedidos::text,'-') FROM \"Campanha\" WHERE id=$CAMP_ID")" \
    "30/30/20/20 0.8000 ---"
  check "a/banco: 2 faixas (1º objeto; 2º-3º dinheiro R\$ 100 = 10000 centavos)" \
    "$(own "SELECT string_agg(posicao_de||'-'||posicao_ate||':'||tipo||':'||descricao||':'||COALESCE(valor_centavos::text,'-'), ' | ' ORDER BY posicao_de) FROM \"CampanhaPremio\" WHERE campanha_id=$CAMP_ID")" \
    "1-1:objeto:Bag térmica Movee:- | 2-3:dinheiro:R\$ 100 no repasse:10000"
  check "a/banco: descrição EDITADA (o rascunho foi atualizado antes de lançar)" "$(own "SELECT descricao FROM \"Campanha\" WHERE id=$CAMP_ID")" "Quem mais pontuar no jantar leva o prêmio (editado)."
  check "a/banco: o rascunho foi escrito pelo admin e lançado por ele (auditável)" "$(own "SELECT (criada_por = lancada_por AND criada_por = (SELECT id FROM \"Usuario\" WHERE email='$ADMIN_EMAIL'))::text FROM \"Campanha\" WHERE id=$CAMP_ID")" "true"
  check "a/auditoria: criar/lançar registrados" "$(own "SELECT count(*)>0 FROM \"Auditoria\" WHERE acao LIKE 'campanha.%'")" "t"
  # gatilho: UPDATE/DELETE direto (até como dono das tabelas) recusado
  R="$(ownx "UPDATE \"Campanha\" SET nome='hack', peso_aceitacao=100, peso_conclusao=0, peso_tempo=0, peso_pedidos=0 WHERE id=$CAMP_ID")"
  check_match "a/banco: UPDATE direto de regra recusado pelo gatilho (CAMPANHA_IMUTAVEL)" "$R" 'CAMPANHA_IMUTAVEL'
  R="$(ownx "DELETE FROM \"Campanha\" WHERE id=$CAMP_ID")"
  check_match "a/banco: DELETE direto recusado pelo gatilho" "$R" 'CAMPANHA_IMUTAVEL'
  R="$(ownx "UPDATE \"CampanhaPremio\" SET descricao='hack' WHERE campanha_id=$CAMP_ID")"
  check_match "a/banco: UPDATE direto do prêmio recusado" "$R" 'CAMPANHA_IMUTAVEL'
  R="$(ownx "DELETE FROM \"CampanhaPremio\" WHERE campanha_id=$CAMP_ID")"
  check_match "a/banco: DELETE direto do prêmio recusado" "$R" 'CAMPANHA_IMUTAVEL'
  check "b/banco: nada mudou depois das tentativas (nome e pesos íntegros)" "$(own "SELECT nome||'|'||peso_aceitacao FROM \"Campanha\" WHERE id=$CAMP_ID")" "$NOME_CAMPANHA|30"
  check "b/banco: o PUT recusado não apagou nem trocou as faixas" "$(own "SELECT count(*) FROM \"CampanhaPremio\" WHERE campanha_id=$CAMP_ID")" "2"
fi
CAMP_ID="$(campanha_id)"
[ -n "$CAMP_ID" ] && [ "$CAMP_ID" != "0" ] || { echo "FAIL: sem campanha lançada para as fases seguintes (fase 1 falhou?)"; exit 1; }

# ============================ fase 2: recalcular -> ranking no hub (c) ============================
if tem_fase 2; then
  echo "--- recalcular como o gancho da importação (hub_campanhas_recalcular_ativas) ---"
  R="$(rpc $ADM $E6 $EMP "SELECT hub_campanhas_recalcular_ativas($EMP);")"
  check "c: recalcular_ativas -> 1 recalculada, 0 fechadas, 0 erros" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas,(.erros|length)]' 2>/dev/null)" "[1,0,0]"
  check "c/banco: classificados 4 · abaixo_corte 1 · sem_minimo 0 · sem_modal 1 (Gil/CARRO nem gravado)" \
    "$(own "SELECT string_agg(situacao||'='||n, ' ' ORDER BY situacao) FROM (SELECT situacao, count(*) n FROM \"CampanhaRanking\" WHERE campanha_id=$CAMP_ID GROUP BY situacao) x")" \
    "abaixo_corte=1 classificado=4 sem_modal=1"
  check "c/banco: notas dos classificados (99,00 / 91,67 / 86,67 / 85,33) na ordem das posições" \
    "$(own "SELECT string_agg(e.nome||'='||r.nota, ' ' ORDER BY r.posicao) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$CAMP_ID AND r.situacao='classificado'")" \
    "Aline Ribeiro Santos=99.00 Bruno Teixeira Souza=91.67 Carla Dias Moreira=86.67 Eva Costa Lima=85.33"
  check "c/banco: Diego abaixo do corte de aceitação, hipotética 77,33 = 5º" \
    "$(own "SELECT r.motivo_corte::text||' '||r.nota_hipotetica||' '||r.posicao_hipotetica FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$CAMP_ID AND e.nome='Diego Pires Oliveira'")" \
    "{aceitacao} 77.33 5"
  check "c/banco: dados_ate = hoje" "$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$CAMP_ID")" "$HOJE"
  roda_fase 2 02-hub-ranking CAMP_ID="$CAMP_ID"
fi

# ============================ fase 3: app do motorista (d) + aviso de início (f) ============================
if tem_fase 3; then
  echo "--- (f) hub_campanhas_avisar_inicio() com a claim do push worker ---"
  # o push worker do backend também varre a cada 60 s: a 1ª chamada a vencer cria, a outra devolve 0
  # (idempotência por aviso_inicio_em). Provado pelo ESTADO: 1 notificação por motorista do público, nunca 2.
  # aviso de início só a partir das 08:00 SP no dia do início: fixa a hora (gate testável hub_hora_sp)
  psql_t -q -c "CREATE OR REPLACE FUNCTION hub_hora_sp() RETURNS time LANGUAGE sql STABLE AS \$\$ SELECT '09:00'::time \$\$;" >/dev/null
  N1="$(worker "SELECT hub_campanhas_avisar_inicio();")"
  N2="$(worker "SELECT hub_campanhas_avisar_inicio();")"
  check_match "f: 1ª chamada devolve 0 ou 1 (o worker do backend pode ter vencido) e a 2ª sempre 0" "$N1/$N2" '^[01]/0$'
  check "f/banco: aviso_inicio_em carimbado" "$(own "SELECT (aviso_inicio_em IS NOT NULL)::text FROM \"Campanha\" WHERE id=$CAMP_ID")" "true"
  check "f/banco: Aviso criado para o início (categoria sistema, link /campanhas/<id>)" \
    "$(own "SELECT count(DISTINCT aviso_id)||' '||min(link)||' '||min(categoria) FROM \"NotificacaoMotorista\" WHERE link='/campanhas/$CAMP_ID'")" \
    "1 /campanhas/$CAMP_ID sistema"
  check "f/banco: exatamente 1 notificação por motorista do público (idempotente)" \
    "$(own "SELECT (count(*) = count(DISTINCT cnpj_prestador) AND count(*) > 0)::text FROM \"NotificacaoMotorista\" WHERE link='/campanhas/$CAMP_ID'")" "true"
  check "f/banco: a Eva (motorista A) está entre os destinatários" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE link='/campanhas/$CAMP_ID' AND cnpj_prestador='$C_EVA'")" "1"
  roda_fase 3 03-app-motorista CAMP_ID="$CAMP_ID"
fi

# ============================ fechamento (dado cobrindo data_fim) + fase 4/5 (e) ============================
if tem_fase 4 || tem_fase 5; then
  if [ "$(own "SELECT (fechada_em IS NOT NULL)::text FROM \"Campanha\" WHERE id=$CAMP_ID")" != "true" ]; then
    FIM="$(own "SELECT data_fim FROM \"Campanha\" WHERE id=$CAMP_ID")"
    D2="$(date -u -d "$HOJE + 2 day" +%F)"
    echo "--- fechar: hoje fixado em $D2 neste stack efêmero + dado do último dia ($FIM) + recalcular_ativas ---"
    psql_t -q -c "CREATE OR REPLACE FUNCTION hub_hoje_sp() RETURNS date LANGUAGE sql STABLE AS \$\$ SELECT '$D2'::date \$\$;" >/dev/null
    check "e: situação passa a apurando (acabou, o dado do último dia ainda não chegou)" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$CAMP_ID")" "apurando"
    psql_t -q <<SQL >"$TMP/seed3.log" 2>&1 || { echo "FAIL: seed do último dia"; cat "$TMP/seed3.log"; exit 1; }
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT id_empresa, importacao_id, entregador_id, '$FIM'::date, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel,
       md5(hash_linha||'d2')||md5('d2'||hash_linha)
FROM "PerformanceTurno" WHERE id_empresa = $EMP AND data_periodo = '$HOJE'::date;
REFRESH MATERIALIZED VIEW mv_performance_dia;
SQL
    R="$(rpc $ADM $E6 $EMP "SELECT hub_campanhas_recalcular_ativas($EMP);")"
    check "e: recalcular_ativas FECHA a campanha (0 recalculadas, 1 fechada, 0 erros)" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas,(.erros|length)]' 2>/dev/null)" "[0,1,0]"
    check "e/banco: fechada_em carimbado; situação encerrada" "$(own "SELECT (fechada_em IS NOT NULL)||'/'||hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$CAMP_ID")" "true/encerrada"
    check_match "e/banco: situação 'encerrada' (formato t/f do psql)" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$CAMP_ID")" '^encerrada$'
    check "e/banco: vencedores gravados (Aline 1º objeto; Bruno 2º e Carla 3º dinheiro)" \
      "$(own "SELECT string_agg(v.posicao||':'||e.nome||':'||p.tipo, ' | ' ORDER BY v.posicao) FROM \"CampanhaVencedor\" v JOIN \"Entregador\" e ON e.id=v.entregador_id JOIN \"CampanhaPremio\" p ON p.id=v.premio_id WHERE v.campanha_id=$CAMP_ID")" \
      "1:Aline Ribeiro Santos:objeto | 2:Bruno Teixeira Souza:dinheiro | 3:Carla Dias Moreira:dinheiro"
    check "e/banco: o resultado congelado mantém as posições (4 classificados, Eva 4ª)" \
      "$(own "SELECT count(*) FILTER (WHERE situacao='classificado')||' '||max(posicao) FROM \"CampanhaRanking\" WHERE campanha_id=$CAMP_ID")" "4 4"
    check "e/banco: 2º recalcular_ativas não refecha nada" "$(rpc $ADM $E6 $EMP "SELECT hub_campanhas_recalcular_ativas($EMP);" | jq -c '[.recalculadas,.fechadas]' 2>/dev/null)" "[0,0]"
  fi
fi

if tem_fase 4; then
  rm -f "$DL"/premios.xlsx "$DL"/ranking.csv
  roda_fase 4 04-hub-fechar-vencedores CAMP_ID="$CAMP_ID"
  echo "--- planilha de prêmios em dinheiro: cabeçalho e linhas (lida pelo PARSER REAL do lançamento externo) ---"
  if [ -s "$DL/premios.xlsx" ]; then
    XLSX_B64="$(base64 -w0 "$DL/premios.xlsx")"
    PLAN="$(node_e "
      const path=require('path'); const XLSX=require('xlsx');
      const le=require(path.join(process.cwd(),'lib/lancamento-externo.js'));
      const buf=Buffer.from(process.argv[1],'base64');
      const wb=XLSX.read(buf,{type:'buffer'}); const ws=wb.Sheets[wb.SheetNames[0]];
      const aoa=XLSX.utils.sheet_to_json(ws,{header:1,raw:true});
      const r=le.lerLancamentos(buf);
      console.log(JSON.stringify({cab:aoa[0],igual:JSON.stringify(aoa[0])===JSON.stringify(le.CABECALHO_ESPERADO),
        linhas:aoa.slice(1).map(l=>({cnpj:String(l[0]),data:l[1],valor:l[2],nome:l[3],obs:l[4]})),
        validas:r.validas.length,recusadas:r.recusadas.length,valores:r.validas.map(v=>v.valor)}));
    " "$XLSX_B64" 2>&1 | tail -1)"
    echo "planilha: $PLAN"
    check "e/planilha: cabeçalho = CABECALHO_ESPERADO do lançamento externo" "$(printf '%s' "$PLAN" | jq -r '.igual' 2>/dev/null)" "true"
    check "e/planilha: 2 linhas (só os de dinheiro: Bruno 2º e Carla 3º; o objeto fica de fora)" "$(printf '%s' "$PLAN" | jq -r '.linhas|length' 2>/dev/null)" "2"
    check "e/planilha: CNPJ, valor 100 e observação de cada linha" \
      "$(printf '%s' "$PLAN" | jq -r '[.linhas[]|(.cnpj+"|"+(.valor|tostring)+"|"+.nome+"|"+.obs)]|join(" ; ")' 2>/dev/null)" \
      "$C_BRUNO|100|Bruno Teixeira Souza|Prêmio campanha #$CAMP_ID — 2º ; $C_CARLA|100|Carla Dias Moreira|Prêmio campanha #$CAMP_ID — 3º"
    check "e/planilha: Data do pagamento de cada linha = data (SP) do exportado_em do vencedor (errata A1)" \
      "$(printf '%s' "$PLAN" | jq -r '[.linhas[].data|tostring]|join(",")' 2>/dev/null)" \
      "$(own "SELECT string_agg(to_char(exportado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD'), ',' ORDER BY posicao) FROM \"CampanhaVencedor\" WHERE campanha_id=$CAMP_ID AND exportado_em IS NOT NULL")"
    check "e/planilha: o PARSER REAL do lançamento externo aceita as 2 linhas e recusa 0" "$(printf '%s' "$PLAN" | jq -r '"\(.validas)/\(.recusadas)"' 2>/dev/null)" "2/0"
  else
    echo "FAIL: planilha não baixada ($DL/premios.xlsx ausente)"; fails=$((fails + 1))
  fi
  check_match "e/csv: ranking.csv baixado, com cabeçalho" "$(head -1 "$DL/ranking.csv" 2>/dev/null)" 'ota'
  check "e/banco: entrega do objeto registrada (data, quem, observação)" \
    "$(own "SELECT (v.entregue_em IS NOT NULL)||' '||(v.entregue_por = (SELECT id FROM \"Usuario\" WHERE email='$ADMIN_EMAIL'))||' '||v.observacao FROM \"CampanhaVencedor\" v WHERE v.campanha_id=$CAMP_ID AND v.posicao=1")" \
    "true true Retirado na base, recibo E2E"
  check "e/banco: planilha carimbou exportado_em só nos de dinheiro (2º e 3º)" \
    "$(own "SELECT string_agg(posicao::text, ',' ORDER BY posicao) FROM \"CampanhaVencedor\" WHERE campanha_id=$CAMP_ID AND exportado_em IS NOT NULL")" "2,3"
  check "e/banco: premiosPendentes zerou" "$(own "SELECT count(*) FROM \"CampanhaVencedor\" v JOIN \"CampanhaPremio\" p ON p.id=v.premio_id WHERE v.campanha_id=$CAMP_ID AND ((p.tipo='objeto' AND v.entregue_em IS NULL) OR (p.tipo='dinheiro' AND v.exportado_em IS NULL))")" "0"
  check "e/auditoria: entrega e planilha auditadas" "$(own "SELECT count(*) FROM \"Auditoria\" WHERE acao IN ('campanha.entrega_registrada','campanha.planilha_exportada')")" "2"
fi

if tem_fase 5; then
  roda_fase 5 05-app-resultado-final CAMP_ID="$CAMP_ID"
fi

# ------------------------------ relatório ------------------------------
echo
echo "=== log completo: $RUN_LOG ==="
echo "Checagens de banco/driver: $passes PASS, $fails FAIL"
echo "Playwright (soma das fases): $PW_PASSED passed, $PW_FAILED failed, $PW_FLAKY flaky"
if [ "$fails" = "0" ] && [ "$PW_EXIT_ALL" = "0" ] && [ "$PW_FAILED" = "0" ]; then
  echo "HUB-CAMPANHAS-E2E-BROWSER: OK — a) b) c) d) e) f) verdes"
  exit 0
fi
echo "HUB-CAMPANHAS-E2E-BROWSER: FALHOU (checagens=$fails, playwright_exit=$PW_EXIT_ALL, failed=$PW_FAILED)" >&2
exit 1
