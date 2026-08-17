#!/usr/bin/env bash
# =============================================================================
# hub-performance-metas-integration.sh — impeccable r24 parte 2: prova E2E de
# /api/v1/performance/metas contra um projeto hub-test EFÊMERO e descartável.
# Mesmo padrão de isolamento de infra/hub/testes/hub-papeis-integration.sh —
# nunca toca chatmasterveloz/produção.
#
# Cobre:
#   (a) sem cookie -> 401
#   (b) admin_entidade: GET vazio -> 200 { metas: [] }
#   (c) PUT define -> 200; GET reflete
#   (d) PUT no MESMO cruzamento -> UPSERT (mesmo id, valor novo), nunca 409.
#       Este é o caso que já falhou uma vez: `hubPostgrestRequest` monta o
#       header `Prefer` internamente e ignora `opts.headers`, então um
#       `resolution=merge-duplicates` passado como header cru some e o upsert
#       vira INSERT duplicado.
#   (e) unidade: valor 90 (quem quis dizer 90%) -> 400 VALOR_FORA_DA_FAIXA,
#       ANTES do banco. É o erro por fator 100 que a migration 0048 também
#       barra no CHECK — aqui se prova a primeira das três barreiras.
#   (f) indicador fora do enum e praça/turno vazios -> 400 com código próprio
#   (g) DELETE -> 204; DELETE de novo -> 404 META_NAO_ENCONTRADA (nunca 204
#       silencioso, que o operador leria como sucesso)
#   (h) RBAC: `operador` (sem performance.metas_gerenciar) LÊ (200) e não
#       ESCREVE (403). Ler é deliberado: a tela de performance precisa das
#       metas para marcar quem está abaixo.
#   (i) isolamento multi-tenant: meta da entidade B nunca aparece para A
#   (j) canonização (r24, achado adversarial): caixa, espaço interno e forma
#       Unicode (NFD vs NFC) do MESMO cruzamento são upsert, não linha nova —
#       era assim que "SAO PAULO" e "Sao Paulo" viravam duas metas e uma chave,
#       com a última vencendo em silêncio
#   (k) teto de comprimento de praca/periodo
#   (l) id não-numérico no DELETE -> 400 (parseInt permissivo apagava outra meta)
#   (m) `id_empresa` no CORPO é ignorado — escopo vem do token (Princípio II)
#   (n) DELETE de meta de OUTRA entidade -> 404, nunca 204 silencioso
#
# Uso: infra/hub/testes/hub-performance-metas-integration.sh
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
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+mailpit-mock+backend efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

fails=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (todas as migrations, inclusive 0048)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0048_performance_meta.sql" "$TMP/migrate.log" || { echo "FAIL: migration 0048 não aplicada"; cat "$TMP/migrate.log"; exit 1; }

SENHA_OK='SenhaSinteticaMetas#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_A=940001
E_B=940002

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('metas-admin@example.test',    '$HASH_OK', 'Admin Entidade Metas', true),
  ('metas-operador@example.test', '$HASH_OK', 'Operador Metas', true);
SQL
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='metas-admin@example.test'" | tr -d '[:space:]')"
UID_OPER="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='metas-operador@example.test'" | tr -d '[:space:]')"

PAPEL_ADMIN="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_OPER="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
MODULO_PERF="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='performance'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN" ] && [ -n "$PAPEL_OPER" ] && [ -n "$MODULO_PERF" ] || { echo "FAIL: seed 0007 incompleto"; exit 1; }

# Guarda do próprio contrato da 0048: `operador` NÃO pode ter a permissão nova.
# Se um seed futuro a conceder, o assert (h) abaixo passaria a testar outra
# coisa sem ninguém perceber — melhor falhar aqui, explicitamente.
OPER_TEM_META="$(psql_t -tAc "
  SELECT count(*) FROM \"PapelPermissao\" pp
  JOIN \"Papel\" p ON p.id = pp.papel_id
  JOIN \"Permissao\" pe ON pe.id = pp.permissao_id
  WHERE p.nome='operador' AND pe.codigo='performance.metas_gerenciar'" | tr -d '[:space:]')"
check "operador NÃO recebe performance.metas_gerenciar (contrato da 0048)" "$OPER_TEM_META" "0"

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN, $E_A, $PAPEL_ADMIN, true),
  ($UID_OPER,  $E_A, $PAPEL_OPER,  true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_PERF, $E_A, true);

-- Meta de OUTRA entidade, para o assert de isolamento. Inserida por SQL
-- (bypassa RLS como dono do schema) justamente porque a API não deixaria.
INSERT INTO "PerformanceMeta" (id_empresa, praca, periodo, indicador, valor)
VALUES ($E_B, 'PRACA DA OUTRA', 'TURNO DA OUTRA', 'aceitacao', 0.99);
SQL

BASE_HELPERS='
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); }
const BASE = "http://localhost:3000/api/v1";
async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, senha }) });
  return { status: r.status, jar: parseSetCookie(r) };
}
async function trocaEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { status: r.status, jar: { ...jar, ...parseSetCookie(r) } };
}
async function req(jar, path, method = "GET", body = null) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let corpo = null;
  try { corpo = await r.json(); } catch { corpo = null; }
  return { status: r.status, corpo };
}
'

ST_SEM_COOKIE="$(node_e "
  fetch('http://localhost:3000/api/v1/performance/metas').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "(a) GET /performance/metas sem cookie -> 401" "$ST_SEM_COOKIE" "401"

# O corpo do teste vai para um arquivo e roda de uma vez: os helpers precisam
# de expansão do shell (vêm de $BASE_HELPERS), o main NÃO — montar tudo num
# heredoc só misturaria as duas coisas.
cat > "$TMP/teste.js" <<JS
$BASE_HELPERS
JS
cat >> "$TMP/teste.js" <<'JS'
async function main() {
  const senha = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const idOutroTenant = Number(process.argv[4]);
  const out = {};

  const l = await login('metas-admin@example.test', senha);
  const { jar } = await trocaEntidade(l.jar, empresaA);

  const vazio = await req(jar, '/performance/metas');
  out.getVazioStatus = vazio.status;
  out.getVazioQtd = Array.isArray(vazio.corpo?.metas) ? vazio.corpo.metas.length : -1;

  const criada = await req(jar, '/performance/metas', 'PUT',
    { praca: 'SP', periodo: 'ALMOCO', indicador: 'aceitacao', valor: 0.9 });
  out.putStatus = criada.status;
  const idCriada = criada.corpo?.meta?.id;

  const upsert = await req(jar, '/performance/metas', 'PUT',
    { praca: 'SP', periodo: 'ALMOCO', indicador: 'aceitacao', valor: 0.85 });
  out.upsertStatus = upsert.status;
  out.upsertMesmoId = upsert.corpo?.meta?.id === idCriada;
  out.upsertValor = upsert.corpo?.meta?.valor;

  const depois = await req(jar, '/performance/metas');
  out.qtdDepois = depois.corpo?.metas?.length ?? -1;
  out.vazouOutraEntidade = (depois.corpo?.metas ?? []).some((m) => m.praca === 'PRACA DA OUTRA');

  const unidade = await req(jar, '/performance/metas', 'PUT',
    { praca: 'SP', periodo: 'ALMOCO', indicador: 'aceitacao', valor: 90 });
  out.unidadeStatus = unidade.status;
  out.unidadeErro = unidade.corpo?.erro;

  const indicador = await req(jar, '/performance/metas', 'PUT',
    { praca: 'SP', periodo: 'ALMOCO', indicador: 'inventado', valor: 0.5 });
  out.indicadorErro = indicador.corpo?.erro;

  const semPraca = await req(jar, '/performance/metas', 'PUT',
    { praca: '  ', periodo: 'ALMOCO', indicador: 'aceitacao', valor: 0.5 });
  out.semPracaErro = semPraca.corpo?.erro;

  const del = await req(jar, `/performance/metas/${idCriada}`, 'DELETE');
  out.delStatus = del.status;
  const delDeNovo = await req(jar, `/performance/metas/${idCriada}`, 'DELETE');
  out.delDeNovoStatus = delDeNovo.status;
  out.delDeNovoErro = delDeNovo.corpo?.erro;

  // (j) canonização: caixa/espaço/NFD do MESMO cruzamento é upsert, não linha nova.
  const canon1 = await req(jar, '/performance/metas', 'PUT',
    { praca: 'SAO PAULO', periodo: 'ALMOCO', indicador: 'conclusao', valor: 0.8 });
  const canon2 = await req(jar, '/performance/metas', 'PUT',
    { praca: ' sao  paulo ', periodo: 'Almoco', indicador: 'conclusao', valor: 0.6 });
  out.canonMesmoId = canon1.corpo?.meta?.id === canon2.corpo?.meta?.id;
  out.canonGravaMaiuscula = canon2.corpo?.meta?.praca;

  const nfd = await req(jar, '/performance/metas', 'PUT',
    { praca: 'MO\u00d3CA'.normalize('NFD'), periodo: 'ALMOCO', indicador: 'conclusao', valor: 0.5 });
  const nfc = await req(jar, '/performance/metas', 'PUT',
    { praca: 'MO\u00d3CA'.normalize('NFC'), periodo: 'ALMOCO', indicador: 'conclusao', valor: 0.4 });
  out.nfdMesmoId = nfd.corpo?.meta?.id === nfc.corpo?.meta?.id;

  // (k) teto de texto
  out.textoLongoErro = (await req(jar, '/performance/metas', 'PUT',
    { praca: 'X'.repeat(200), periodo: 'ALMOCO', indicador: 'conclusao', valor: 0.5 })).corpo?.erro;

  // (l) id não-numérico no DELETE não pode virar parseInt permissivo
  out.idLixoStatus = (await req(jar, '/performance/metas/7abc', 'DELETE')).status;

  // (m) `id_empresa` no CORPO é ignorado — o escopo vem do token, nunca do corpo
  const tentaOutroTenant = await req(jar, '/performance/metas', 'PUT',
    { praca: 'INJETADA', periodo: 'X', indicador: 'aceitacao', valor: 0.5, id_empresa: 940002 });
  out.injecaoStatus = tentaOutroTenant.status;

  const lo = await login('metas-operador@example.test', senha);
  const { jar: jarOper } = await trocaEntidade(lo.jar, empresaA);
  out.operLeStatus = (await req(jarOper, '/performance/metas')).status;
  out.operEscreveStatus = (await req(jarOper, '/performance/metas', 'PUT',
    { praca: 'SP', periodo: 'ALMOCO', indicador: 'aceitacao', valor: 0.5 })).status;
  // (n) DELETE de meta de OUTRA entidade -> 404, nunca 204 silencioso
  out.delOutroTenantStatus = (await req(jar, `/performance/metas/${idOutroTenant}`, 'DELETE')).status;

  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
main();
JS

ID_OUTRO_TENANT="$(psql_t -tAc "SELECT id FROM \"PerformanceMeta\" WHERE id_empresa=$E_B LIMIT 1" | tr -d '[:space:]')"
RES="$(run_node "$SENHA_OK" "$E_A" "$ID_OUTRO_TENANT" < "$TMP/teste.js")"
[ -n "$RES" ] || { echo "FAIL: corpo do teste não produziu saída"; exit 1; }

ler() { printf '%s' "$RES" | node -e "
  let s=''; process.stdin.on('data', d => s += d).on('end', () => {
    try { process.stdout.write(String(JSON.parse(s)[process.argv[1]])); }
    catch { process.stdout.write('ERRO_PARSE'); }
  });
" "$1"; }

check "(b) GET vazio -> 200"                       "$(ler getVazioStatus)"     "200"
check "(b) GET vazio -> nenhuma meta"              "$(ler getVazioQtd)"        "0"
check "(c) PUT define -> 200"                      "$(ler putStatus)"          "200"
check "(d) PUT no mesmo cruzamento -> 200"         "$(ler upsertStatus)"       "200"
check "(d) upsert mantém o MESMO id"               "$(ler upsertMesmoId)"      "true"
check "(d) upsert grava o valor novo"              "$(ler upsertValor)"        "0.85"
check "(d) upsert não duplica linha"               "$(ler qtdDepois)"          "1"
check "(e) valor 90 (unidade errada) -> 400"       "$(ler unidadeStatus)"      "400"
check "(e) erro é VALOR_FORA_DA_FAIXA"             "$(ler unidadeErro)"        "VALOR_FORA_DA_FAIXA"
check "(f) indicador fora do enum -> erro próprio" "$(ler indicadorErro)"      "INDICADOR_INVALIDO"
check "(f) praça em branco -> erro próprio"        "$(ler semPracaErro)"       "PRACA_OBRIGATORIA"
check "(i) meta de outra entidade NÃO vaza"        "$(ler vazouOutraEntidade)" "false"
check "(g) DELETE -> 204"                          "$(ler delStatus)"          "204"
check "(g) DELETE de novo -> 404"                  "$(ler delDeNovoStatus)"    "404"
check "(g) 404 traz META_NAO_ENCONTRADA"           "$(ler delDeNovoErro)"      "META_NAO_ENCONTRADA"
check "(h) operador LÊ metas -> 200"               "$(ler operLeStatus)"       "200"
check "(h) operador NÃO escreve -> 403"            "$(ler operEscreveStatus)"  "403"
check "(j) caixa/espaço diferentes = MESMA meta"   "$(ler canonMesmoId)"        "true"
check "(j) grava a forma canônica (maiúscula)"     "$(ler canonGravaMaiuscula)" "SAO PAULO"
check "(j) NFD e NFC = MESMA meta"                 "$(ler nfdMesmoId)"          "true"
check "(k) texto acima do teto -> erro próprio"    "$(ler textoLongoErro)"      "PRACA_MUITO_LONGA"
check "(l) id não-numérico no DELETE -> 400"       "$(ler idLixoStatus)"        "400"
check "(m) id_empresa no corpo é ignorado -> 200"  "$(ler injecaoStatus)"       "200"
check "(n) DELETE de outra entidade -> 404"        "$(ler delOutroTenantStatus)" "404"

echo
if [ "$fails" -eq 0 ]; then
  echo "=== hub-performance-metas-integration: TODOS OS ASSERTS PASSARAM ==="
  exit 0
fi
echo "=== hub-performance-metas-integration: $fails FALHA(S) ==="
exit 1
