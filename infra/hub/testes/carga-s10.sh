#!/usr/bin/env bash
# =============================================================================
# carga-s10.sh — S10, escopo item 3 (teste de carga básico sobre o banco
# volumoso do ensaio): p95 dos endpoints principais < 1s e importação de um
# arquivo diário completo (pipeline real, incluindo o auto-refresh das MVs
# mv_faturamento_dia/mv_performance_dia) < 60s, com números reais registrados.
#
# Pré-requisito: stack do RUN B do ensaio-migrations-s10.sh mantido no ar
# (flag -k), com ~1,5M FaturamentoLancamento + ~1M PerformanceTurno no tenant
# 9001 e o ÚLTIMO dia do dataset sintético reservado (não carregado) — ele é
# o "arquivo diário" importado aqui pelo pipeline REAL (POST /api/v1/
# importacoes → polling → completed), o que também re-comprova a
# idempotência de linha sob volume (arquivo re-enviado + arquivo com 1 linha
# nova ⇒ exatamente 1 fato novo).
#
# NUNCA toca produção nem o hub-homolog: só o projeto hub-s10b-* passado em -p.
#
# Uso:
#   infra/hub/testes/carga-s10.sh -p <projeto-hub-s10b> [-s dir-seeds] [-o dir-evid] [-n N_REQ]
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
COMPOSE="$HUB_DIR/compose.hub.s10.yml"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

PROJECT="" N_REQ=100
SEEDS="$HUB_DIR/seeds/out-s10"
EVID="$REPO_DIR/docs/plans/hub-frota/evidencias/S10/carga-$TS"
while getopts "p:s:o:n:" opt; do
  case "$opt" in
    p) PROJECT="$OPTARG" ;;
    s) SEEDS="$OPTARG" ;;
    o) EVID="$OPTARG" ;;
    n) N_REQ="$OPTARG" ;;
    *) echo "uso: $0 -p <projeto> [-s dir-seeds] [-o dir-evid] [-n N]" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] || { echo "-p <projeto hub-s10b-*> obrigatório (ensaio-migrations-s10.sh -k)" >&2; exit 2; }
case "$PROJECT" in hub-*) ;; *) echo "projeto deve ser prefixado hub- (exceção G1)" >&2; exit 2 ;; esac
mkdir -p "$EVID"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

echo "carga-s10: projeto=$PROJECT, evidências em $EVID"

# ── backend no ar (build com o cap anti-starvation obrigatório) ─────────────
# preflight fail-safe (§4.8) ANTES de qualquer up — mesmo gate de todas as
# outras suítes; a checagem de prefixo hub-* acima é só a primeira camada
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" \
  || { echo "preflight abortou — não prossegue"; exit 1; }

echo "── build/up do backend (DOCKER_BUILDKIT=0, --memory=2g)"
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$EVID/build.log" 2>&1 \
  || { echo "FAIL: build do backend"; tail -40 "$EVID/build.log"; exit 1; }
dc up -d --wait backend || { echo "FAIL: backend não subiu"; dc logs backend | tail -30; exit 1; }

# ── usuário de carga (admin_entidade @ 9001, mesmo padrão das suítes .sh) ───
SENHA='SenhaSinteticaCargaS10#1'
HASH="$(node_e "require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });" "$SENHA" | tr -d '[:space:]')"
[ -n "$HASH" ] || { echo "FAIL: hash bcrypt"; exit 1; }
psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo)
VALUES ('carga-s10@example.test', '$HASH', 'Usuario Carga S10', true)
ON CONFLICT (email) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, ativo = true;
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
SELECT u.id, 9001, p.id, true FROM "Usuario" u, "Papel" p
WHERE u.email = 'carga-s10@example.test' AND p.nome = 'admin_entidade'
ON CONFLICT DO NOTHING;
SQL

# ── pré-limpeza (re-execução): remove restos de cargas s10-dia-* anteriores ─
# (fatos/erros/cabeçalhos do dia reservado importados por uma execução prévia;
# psql = superuser, ignora o append-only de aplicação)
psql_t <<'SQL' >/dev/null
DELETE FROM "FaturamentoLancamento" WHERE importacao_id IN (SELECT id FROM "ImportacaoArquivo" WHERE nome_arquivo LIKE 's10-dia-%');
DELETE FROM "PerformanceTurno"      WHERE importacao_id IN (SELECT id FROM "ImportacaoArquivo" WHERE nome_arquivo LIKE 's10-dia-%');
DELETE FROM "ImportacaoLinhaErro"   WHERE importacao_id IN (SELECT id FROM "ImportacaoArquivo" WHERE nome_arquivo LIKE 's10-dia-%');
DELETE FROM "ImportacaoArquivo"     WHERE nome_arquivo LIKE 's10-dia-%';
SQL

# ── arquivos do "dia diário" (último dia do dataset, reservado pelo ensaio) ─
FAT_DIA="$(ls "$SEEDS/faturamento"/*.csv | sort | tail -1)"
PERF_DIA="$(ls "$SEEDS/performance"/*.csv | sort | tail -1)"
DIA_INICIO="$(basename "$(ls "$SEEDS/faturamento"/*.csv | sort | head -1)" .csv)"
DIA_FIM="$(basename "$FAT_DIA" .csv)"
# variante "reimport + 1 linha nova": mesma linha 2, valor trocado (campo 11)
FAT_MAIS1="$EVID/fat-dia-mais-1-linha.csv"
cp "$FAT_DIA" "$FAT_MAIS1"
sed -n '2p' "$FAT_DIA" | awk -F';' 'BEGIN{OFS=";"} {$11="987,65"; print}' >>"$FAT_MAIS1"
dc cp "$FAT_DIA" backend:/tmp/s10-fat-dia.csv
dc cp "$PERF_DIA" backend:/tmp/s10-perf-dia.csv
dc cp "$FAT_MAIS1" backend:/tmp/s10-fat-mais1.csv
rm -f "$FAT_MAIS1"   # não versionar dado sintético; a evidência são os números

# ── runner (dentro do container backend — mesmo padrão das suítes .sh) ──────
RUNNER='
const fs = require("fs");
const BASE = "http://localhost:3000/api/v1";
function parseSetCookie(r) {
  const out = {};
  const list = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of list) { const kv = c.split(";")[0]; const i = kv.indexOf("="); out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, senha }) });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  if (r.status !== 200) throw new Error(`troca de entidade ${r.status}`);
  return { ...jar, ...parseSetCookie(r) };
}
async function medir(jar, path, n) {
  for (let i = 0; i < 3; i++) await fetch(`${BASE}${path}`, { headers: { Cookie: cookieHeader(jar) } }); // aquecimento
  const ms = []; let badStatus = 0;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookieHeader(jar) } });
    await r.arrayBuffer();
    ms.push(Date.now() - t0);
    if (r.status !== 200) badStatus++;
  }
  ms.sort((a, b) => a - b);
  const q = (p) => ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)];
  return { path, n, badStatus, p50: q(0.5), p95: q(0.95), max: ms[ms.length - 1] };
}
async function upload(jar, tipo, nomeArquivo, caminho) {
  const fd = new FormData();
  fd.append("tipo", tipo);
  fd.append("file", new Blob([fs.readFileSync(caminho)], { type: "text/csv" }), nomeArquivo);
  const r = await fetch(`${BASE}/importacoes`, { method: "POST", headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function aguardarTerminal(jar, id, timeoutMs) {
  const terminais = ["completed", "completed_with_errors", "failed", "cancelled"];
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const r = await fetch(`${BASE}/importacoes/${id}`, { headers: { Cookie: cookieHeader(jar) } });
    const body = await r.json().catch(() => null);
    if (body && terminais.includes(body.status)) return body;
    await new Promise((res) => setTimeout(res, 500));
  }
  return { status: "timeout" };
}
async function importar(jar, tipo, nome, caminho) {
  const t0 = Date.now();
  const up = await upload(jar, tipo, nome, caminho);
  if (up.status !== 200 && up.status !== 201) return { upload_status: up.status, body: up.body, ms: Date.now() - t0 };
  const fim = await aguardarTerminal(jar, up.body.id, 120000);
  return { upload_status: up.status, id: up.body.id, status_final: fim.status, total_linhas: fim.total_linhas, linhas_validas: fim.linhas_validas, linhas_invalidas: fim.linhas_invalidas, ms: Date.now() - t0 };
}
(async () => {
  const [fase, nReq, deData, ateData] = process.argv.slice(2);
  let jar = await login("carga-s10@example.test", process.env.CARGA_SENHA);
  jar = await trocarEntidade(jar, 9001);
  const out = {};
  if (fase === "p95") {
    const n = parseInt(nReq, 10);
    const janela = `de=${deData}&ate=${ateData}`;
    const d30 = new Date(`${ateData}T00:00:00Z`); d30.setUTCDate(d30.getUTCDate() - 30);
    const janela30 = `de=${d30.toISOString().slice(0, 10)}&ate=${ateData}`;
    // asserts duros (<1s): listas paginadas server-side + resumos na janela
    // PADRÃO das telas (30 dias — o que o dashboard abre por default)
    const alvosAssert = [
      `/faturamento/resumo?${janela30}`,
      `/faturamento/resumo?${janela30}&groupBy=dia`,
      `/performance/resumo?${janela30}`,
      `/performance/resumo?${janela30}&groupBy=dia`,
      `/faturamento?${janela}`,
      `/performance?${janela}`,
      `/importacoes`,
      `/auditoria`,
    ];
    // medições INFORMATIVAS de pior caso, SEM assert (achado S10, decisão do
    // operador): resumos na janela de 1 ano CHEIO varrem a MV inteira
    // (mv_faturamento_dia ~769k linhas neste dataset); /motoristas pagina e
    // filtra EM JS sobre todos os entregadores e agrega o histórico inteiro
    // via hub_areas_por_entregador (UNION ALL das 2 tabelas de fato, 2,5M
    // linhas) — melhorar exige mudança funcional, fora do escopo da S10.
    const alvosInfo = [
      `/faturamento/resumo?${janela}`,
      `/faturamento/resumo?${janela}&groupBy=dia`,
      `/performance/resumo?${janela}`,
      `/performance/resumo?${janela}&groupBy=dia`,
      `/motoristas`,
    ];
    out.endpoints = [];
    for (const a of alvosAssert) out.endpoints.push(await medir(jar, a, n));
    out.informativos = [];
    for (const a of alvosInfo) out.informativos.push(await medir(jar, a, n));
  } else if (fase === "import") {
    out.fat = await importar(jar, "faturamento", "s10-dia-fat.csv", "/tmp/s10-fat-dia.csv");
    out.perf = await importar(jar, "performance", "s10-dia-perf.csv", "/tmp/s10-perf-dia.csv");
  } else if (fase === "reimport") {
    out.reimport_identico = await importar(jar, "faturamento", "s10-dia-fat.csv", "/tmp/s10-fat-dia.csv");
    out.reimport_mais1 = await importar(jar, "faturamento", "s10-dia-fat-mais1.csv", "/tmp/s10-fat-mais1.csv");
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
'

contar_fatos() { psql_t -tAc 'SELECT count(*) FROM "FaturamentoLancamento"' | tr -d '[:space:]'; }
contar_perf()  { psql_t -tAc 'SELECT count(*) FROM "PerformanceTurno"' | tr -d '[:space:]'; }

echo "── fase p95 ($N_REQ reqs/endpoint, janela $DIA_INICIO..$DIA_FIM)"
dc exec -T -e CARGA_SENHA="$SENHA" backend node - p95 "$N_REQ" "$DIA_INICIO" "$DIA_FIM" <<<"$RUNNER" >"$EVID/p95.json" \
  || { echo "FAIL: runner p95"; cat "$EVID/p95.json"; exit 1; }
cat "$EVID/p95.json"

echo "── fase import (arquivo diário via pipeline real, inclui refresh das MVs)"
FAT_ANTES="$(contar_fatos)"; PERF_ANTES="$(contar_perf)"
dc exec -T -e CARGA_SENHA="$SENHA" backend node - import <<<"$RUNNER" >"$EVID/import.json" \
  || { echo "FAIL: runner import"; cat "$EVID/import.json"; exit 1; }
cat "$EVID/import.json"
FAT_DEPOIS="$(contar_fatos)"; PERF_DEPOIS="$(contar_perf)"
echo "fatos faturamento: $FAT_ANTES → $FAT_DEPOIS (+$((FAT_DEPOIS - FAT_ANTES)))"
echo "fatos performance: $PERF_ANTES → $PERF_DEPOIS (+$((PERF_DEPOIS - PERF_ANTES)))"

echo "── fase reimport (idempotência de linha sob volume)"
FAT_ANTES2="$(contar_fatos)"
dc exec -T -e CARGA_SENHA="$SENHA" backend node - reimport <<<"$RUNNER" >"$EVID/reimport.json" \
  || { echo "FAIL: runner reimport"; cat "$EVID/reimport.json"; exit 1; }
cat "$EVID/reimport.json"
FAT_DEPOIS2="$(contar_fatos)"
DELTA_REIMPORT=$((FAT_DEPOIS2 - FAT_ANTES2))
echo "fatos faturamento no reimport: $FAT_ANTES2 → $FAT_DEPOIS2 (+$DELTA_REIMPORT)"

# ── asserts + relatório ─────────────────────────────────────────────────────
PIORES="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ruins = d.endpoints.filter((e) => e.p95 >= 1000 || e.badStatus > 0);
  console.log(ruins.length === 0 ? "ok" : JSON.stringify(ruins));
' "$EVID/p95.json")"
check "p95 < 1000ms e HTTP 200 em todos os endpoints" "$PIORES" "ok"

IMP_OK="$(node -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  // completed_with_errors é aceito: o dataset SINTÉTICO re-perturba valores e
  // algumas linhas caem fora do domínio (ex.: atingido > 1000) — o parser
  // rejeita a LINHA corretamente; o assert de motivo abaixo prova que só o
  // artefato de síntese explica os erros.
  const ok = (x) => x && (x.status_final === "completed" || x.status_final === "completed_with_errors") && x.ms < 60000;
  console.log(ok(d.fat) && ok(d.perf) ? "ok" : JSON.stringify(d));
' "$EVID/import.json")"
check "import diário (fat e perf) terminou (completed*) em < 60s" "$IMP_OK" "ok"
MOTIVOS_FAT="$(psql_t -tAc "SELECT COALESCE(string_agg(DISTINCT e.motivo, ','), 'nenhum') FROM \"ImportacaoLinhaErro\" e JOIN \"ImportacaoArquivo\" a ON a.id = e.importacao_id WHERE a.nome_arquivo = 's10-dia-fat.csv'" | tr -d '[:space:]')"
# (tr acima remove espaços: 'fora da faixa 0-1000' vira 'foradafaixa0-1000')
case "$MOTIVOS_FAT" in
  nenhum|foradafaixa0-1000) MOTIVOS_OK="ok" ;;
  *) MOTIVOS_OK="inesperado:$MOTIVOS_FAT" ;;
esac
check "erros do import fat (se houver) são só artefato de síntese (fora da faixa)" "$MOTIVOS_OK" "ok"
check "reimportação sob volume: exatamente 1 fato novo (1 linha nova; resto deduplicado)" "$DELTA_REIMPORT" "1"

{
  echo "# Carga S10 ($TS) — projeto $PROJECT"
  echo
  echo "Base: $(psql_t -tAc 'SELECT count(*) FROM "FaturamentoLancamento"' | tr -d '[:space:]') FaturamentoLancamento, $(psql_t -tAc 'SELECT count(*) FROM "PerformanceTurno"' | tr -d '[:space:]') PerformanceTurno (tenant 9001, janela $DIA_INICIO..$DIA_FIM)."
  echo
  echo "## p95 por endpoint — ASSERT <1s ($N_REQ reqs, 3 de aquecimento descartadas)"
  echo
  echo "Listas paginadas server-side + resumos na janela padrão das telas (30d)."
  echo
  echo "| endpoint | p50 (ms) | p95 (ms) | max (ms) | HTTP≠200 |"
  echo "|---|---|---|---|---|"
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const e of d.endpoints) console.log(`| ${e.path} | ${e.p50} | ${e.p95} | ${e.max} | ${e.badStatus} |`);
  ' "$EVID/p95.json"
  echo
  echo "## Medições informativas de PIOR CASO (sem assert — achado S10)"
  echo
  echo "Resumos na janela de 1 ano cheio (varredura completa da MV) e"
  echo "/motoristas (paginação/filtro em JS + hub_areas_por_entregador sobre"
  echo "as 2 tabelas de fato inteiras). Melhorar exige mudança funcional —"
  echo "registrado para decisão do operador (follow-up pré ou pós-cutover)."
  echo
  echo "| endpoint | p50 (ms) | p95 (ms) | max (ms) | HTTP≠200 |"
  echo "|---|---|---|---|---|"
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const e of d.informativos || []) console.log(`| ${e.path} | ${e.p50} | ${e.p95} | ${e.max} | ${e.badStatus} |`);
  ' "$EVID/p95.json"
  echo
  echo "## Importação de arquivo diário (pipeline real + auto-refresh das MVs)"
  echo
  echo '```json'
  cat "$EVID/import.json"
  echo '```'
  echo
  echo "## Reimportação (idempotência de linha sob volume)"
  echo
  echo "Delta de fatos após reenviar o MESMO arquivo + um arquivo com 1 linha nova: +$DELTA_REIMPORT (esperado 1)."
  echo
  echo '```json'
  cat "$EVID/reimport.json"
  echo '```'
} >"$EVID/relatorio.md"
echo "relatório: $EVID/relatorio.md"

echo
if [ "$fails" = "0" ]; then
  echo "CARGA-S10: OK — p95 < 1s, import diário < 60s, idempotência re-comprovada"
  exit 0
else
  echo "CARGA-S10: $fails check(s) FALHARAM" >&2
  exit 1
fi
