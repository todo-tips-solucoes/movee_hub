#!/usr/bin/env bash
# =============================================================================
# hub-auditoria-admin-integration.sh — task 6.1.1 (tasks.md FASE 6): prova E2E
# REAL (sem mock) de `GET /api/v1/auditoria` contra um projeto hub-test
# EFÊMERO e descartável. Mesmo padrão de isolamento de
# infra/hub/testes/hub-papeis-integration.sh/hub-admin-integration.sh —
# nunca toca chatmasterveloz/produção.
#
# Este script fecha o GAP explícito deixado pela FASE 3 (tasks.md 3.2.6,
# nota): "Cenários 2/3 do quickstart contra usuário admin_plataforma REAL
# (com seed próprio) ficam para o script dedicado da FASE 6 — nenhum seed de
# teste com vínculo admin_plataforma existe ainda". Os Cenários 4/5/6/7 já
# têm evidência AO VIVO completa em scripts dedicados das fases anteriores
# (hub-auditoria-integration.sh, hub-usuarios-integration.sh,
# hub-papeis-integration.sh, hub-admin-integration.sh) — este script NÃO os
# duplica; a task 6.1 os re-executa como regressão (ver evidência no
# tasks.md).
#
# Cobre (Cenários 1/2/3 do quickstart):
#   (a) admin_entidade: GET /auditoria só retorna eventos da PRÓPRIA entidade
#       (nunca da outra, nunca globais/entidadeId:null) — Cenário 1/3 passo 4
#   (b) filtro acao= isola o evento certo; `detalhes` do evento nunca carrega
#       senha/CPF/CNPJ em texto claro — Cenário 1 passos 3/4
#   (c) usuário multi-entidade SEM entidade ativa selecionada -> `200
#       {eventos:[],total:0}` (nega-por-padrão) — Cenário 2 passo 1/2
#   (d) admin_entidade forçando `entidadeId` de outra entidade -> `403
#       PERMISSAO_NEGADA` — Cenário 2 passo 3
#   (e) admin_plataforma SEM entidadeId -> vê eventos de MÚLTIPLAS entidades
#       + eventos globais (entidadeId:null, ex. login_sucesso) — Cenário 3
#       passo 2
#   (f) admin_plataforma COM entidadeId=E_A -> só eventos da E_A (paridade
#       com o que o admin_entidade da E_A vê) — Cenário 3 passo 3
#
# Uso: infra/hub/testes/hub-auditoria-admin-integration.sh
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

echo "rodando migrate.sh (todas as migrations, inclusive 0035-0039)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0039_usuarioentidade_escrita_admin.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas até 0039"; cat "$TMP/migrate.log"; exit 1; }

SENHA_OK='SenhaSinteticaAuditoria#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

# entidades sintéticas — faixa 9500xx (papeis usou 9300xx, admin usou 9400xx)
E_A=950001
E_B=950002

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('audit-admin-entidade@example.test', '$HASH_OK', 'Admin Entidade Audit', true),
  ('audit-admin-plataforma@example.test', '$HASH_OK', 'Admin Plataforma Audit', true),
  ('audit-operador-b@example.test', '$HASH_OK', 'Operador B Audit', true),
  ('audit-multi-entidade@example.test', '$HASH_OK', 'Multi Entidade Audit', true);
SQL
UID_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='audit-admin-entidade@example.test'" | tr -d '[:space:]')"
UID_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='audit-admin-plataforma@example.test'" | tr -d '[:space:]')"
UID_OPERADOR_B="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='audit-operador-b@example.test'" | tr -d '[:space:]')"
UID_MULTI="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='audit-multi-entidade@example.test'" | tr -d '[:space:]')"

PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_plataforma'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
MODULO_USUARIOS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='usuarios'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] && [ -n "$PAPEL_ADMIN_PLATAFORMA" ] && [ -n "$PAPEL_OPERADOR" ] && [ -n "$MODULO_USUARIOS" ] || { echo "FAIL: seed 0007 incompleto"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN_ENTIDADE, $E_A, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_ADMIN_PLATAFORMA, $E_A, $PAPEL_ADMIN_PLATAFORMA, true),
  ($UID_OPERADOR_B, $E_B, $PAPEL_OPERADOR, true),
  ($UID_MULTI, $E_A, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_MULTI, $E_B, $PAPEL_ADMIN_ENTIDADE, true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_USUARIOS, $E_A, true);
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
async function login(email, senha) {
  const r = await fetch("http://localhost:3000/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(r);
  return { status: r.status, jar };
}
async function trocaEntidade(jar, empresaId) {
  const r = await fetch("http://localhost:3000/api/v1/me/entidade", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  const novoJar = { ...jar, ...parseSetCookie(r) };
  return { status: r.status, jar: novoJar };
}
'

ST_SEM_COOKIE="$(node_e "
  fetch('http://localhost:3000/api/v1/auditoria').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "GET /auditoria sem cookie -> 401" "$ST_SEM_COOKIE" "401"

OUT1="$(run_node "$SENHA_OK" "$E_A" "$E_B" "$PAPEL_OPERADOR" <<JS
$BASE_HELPERS
async function main() {
  const senhaOk = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const empresaB = Number(process.argv[4]);
  const papelOperador = Number(process.argv[5]);
  const out = {};

  // --- Cenário 2 passo 1/2: multi-entidade SEM selecionar entidade ativa ----
  let { jar: jarMulti } = await login('audit-multi-entidade@example.test', senhaOk);
  const rSemEntidade = await fetch('http://localhost:3000/api/v1/auditoria', { headers: { Cookie: cookieHeader(jarMulti) } });
  const bSemEntidade = await rSemEntidade.json();
  out.sem_entidade_status = rSemEntidade.status;
  out.sem_entidade_eventos_vazio = Array.isArray(bSemEntidade.eventos) && bSemEntidade.eventos.length === 0 ? 'true' : 'false';
  out.sem_entidade_total = bSemEntidade.total;

  // --- Cenário 1: admin_entidade ativa E_A, gera eventos reais -------------
  let { jar: jarAE } = await login('audit-admin-entidade@example.test', senhaOk);
  ({ jar: jarAE } = await trocaEntidade(jarAE, empresaA)); // gera troca_entidade_ativa (id_empresa=A)

  const rCriarUsuario = await fetch('http://localhost:3000/api/v1/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAE) },
    body: JSON.stringify({ nome: 'Usuario Auditado', email: 'auditado-cenario1@example.test', senha: senhaOk, vinculo: { entidadeId: empresaA, papelId: papelOperador } }),
  });
  const bCriarUsuario = await rCriarUsuario.json();
  out.criar_usuario_status = rCriarUsuario.status;

  // --- Cenário 1 passo 3: GET /auditoria (própria entidade) -----------------
  const rListaAE = await fetch('http://localhost:3000/api/v1/auditoria?pageSize=50', { headers: { Cookie: cookieHeader(jarAE) } });
  const bListaAE = await rListaAE.json();
  out.lista_ae_status = rListaAE.status;
  const eventosAE = bListaAE.eventos || [];
  out.lista_ae_todos_da_propria_entidade = eventosAE.every((e) => e.entidadeId === empresaA) ? 'true' : 'false';
  out.lista_ae_nunca_global = eventosAE.some((e) => e.entidadeId === null) ? 'false' : 'true';
  out.lista_ae_tem_eventos = eventosAE.length > 0 ? 'true' : 'false';

  // --- Cenário 1 passo 4: filtro por acao= + detalhe sem dado sensivel ------
  const rFiltro = await fetch('http://localhost:3000/api/v1/auditoria?acao=usuario_criado&pageSize=10', { headers: { Cookie: cookieHeader(jarAE) } });
  const bFiltro = await rFiltro.json();
  out.filtro_status = rFiltro.status;
  const eventoUsuarioCriado = (bFiltro.eventos || [])[0];
  out.filtro_encontrou_evento = eventoUsuarioCriado ? 'true' : 'false';
  const detalhesStr = eventoUsuarioCriado ? JSON.stringify(eventoUsuarioCriado.detalhes || {}) : '';
  out.detalhes_sem_senha = detalhesStr.toLowerCase().includes('senha') ? 'false' : 'true';
  out.detalhes_sem_senha_literal = detalhesStr.includes(senhaOk) ? 'false' : 'true';
  out.detalhes_sem_email = detalhesStr.includes('auditado-cenario1@example.test') ? 'false' : 'true';

  // --- Cenário 2 passo 3: forçar entidadeId de outra entidade -> 403 --------
  const rCrossTenant = await fetch(\`http://localhost:3000/api/v1/auditoria?entidadeId=\${empresaB}\`, { headers: { Cookie: cookieHeader(jarAE) } });
  const bCrossTenant = await rCrossTenant.json();
  out.cross_tenant_status = rCrossTenant.status;
  out.cross_tenant_erro = bCrossTenant.erro;

  // --- gera evento real na entidade B (operador-b troca p/ B) ---------------
  let { jar: jarOpB } = await login('audit-operador-b@example.test', senhaOk);
  ({ jar: jarOpB } = await trocaEntidade(jarOpB, empresaB)); // gera troca_entidade_ativa (id_empresa=B) + login_sucesso global

  // --- Cenário 3: admin_plataforma ativa E_A -------------------------------
  let { jar: jarAP } = await login('audit-admin-plataforma@example.test', senhaOk); // login_sucesso global (id_empresa=null)
  ({ jar: jarAP } = await trocaEntidade(jarAP, empresaA));

  const rGlobalAP = await fetch('http://localhost:3000/api/v1/auditoria?pageSize=100', { headers: { Cookie: cookieHeader(jarAP) } });
  const bGlobalAP = await rGlobalAP.json();
  out.global_ap_status = rGlobalAP.status;
  const eventosGlobalAP = bGlobalAP.eventos || [];
  const entidadesVistas = new Set(eventosGlobalAP.map((e) => e.entidadeId));
  out.global_ap_ve_multiplas_entidades = (entidadesVistas.has(empresaA) && entidadesVistas.has(empresaB)) ? 'true' : 'false';
  out.global_ap_ve_evento_global = eventosGlobalAP.some((e) => e.entidadeId === null && e.acao === 'login_sucesso') ? 'true' : 'false';

  const rEscopadoAP = await fetch(\`http://localhost:3000/api/v1/auditoria?entidadeId=\${empresaA}&pageSize=100\`, { headers: { Cookie: cookieHeader(jarAP) } });
  const bEscopadoAP = await rEscopadoAP.json();
  out.escopado_ap_status = rEscopadoAP.status;
  const eventosEscopadoAP = bEscopadoAP.eventos || [];
  out.escopado_ap_so_entidade_a = eventosEscopadoAP.every((e) => e.entidadeId === empresaA) ? 'true' : 'false';
  // Paridade (Cenário 3 passo 3): tudo que o admin_entidade da E_A viu ANTES
  // também aparece no que o admin_plataforma vê ESCOPADO à E_A agora — não
  // comparamos contagem exata pq a própria ativação de entidade do
  // admin_plataforma (trocaEntidade acima) gera 1 evento novo em E_A
  // (troca_entidade_ativa) entre as duas capturas (ordem cronológica real).
  const idsEscopadoAP = new Set(eventosEscopadoAP.map((e) => e.id));
  out.escopado_ap_paridade_com_ae = eventosAE.every((e) => idsEscopadoAP.has(e.id)) ? 'true' : 'false';

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT1" | grep -v '___RESULT_JSON___' || true
R1="$(echo "$OUT1" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R1" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT1"; exit 1; }
jget() { printf '%s' "$R1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

# Cenário 2 (nega-por-padrão sem entidade ativa)
check "multi-entidade SEM entidade ativa: GET /auditoria -> 200" "$(jget sem_entidade_status)" "200"
check "multi-entidade SEM entidade ativa: eventos=[] (nega-por-padrao)" "$(jget sem_entidade_eventos_vazio)" "true"
check "multi-entidade SEM entidade ativa: total=0" "$(jget sem_entidade_total)" "0"

# Cenário 1 (trilha própria entidade + filtros + detalhe sem dado sensivel)
check "admin_entidade: criar usuario (gera evento usuario_criado) -> 201" "$(jget criar_usuario_status)" "201"
check "admin_entidade: GET /auditoria -> 200" "$(jget lista_ae_status)" "200"
check "admin_entidade: TODOS os eventos sao da propria entidade (E_A)" "$(jget lista_ae_todos_da_propria_entidade)" "true"
check "admin_entidade: NUNCA ve evento global (entidadeId:null)" "$(jget lista_ae_nunca_global)" "true"
check "admin_entidade: lista tem eventos (troca_entidade_ativa + usuario_criado)" "$(jget lista_ae_tem_eventos)" "true"
check "admin_entidade: filtro acao=usuario_criado encontra o evento" "$(jget filtro_encontrou_evento)" "true"
check "admin_entidade: detalhes do evento sem chave/valor 'senha'" "$(jget detalhes_sem_senha)" "true"
check "admin_entidade: detalhes do evento sem a senha literal" "$(jget detalhes_sem_senha_literal)" "true"
check "admin_entidade: detalhes do evento sem o email do usuario criado" "$(jget detalhes_sem_email)" "true"

# Cenário 2 (403 cross-tenant)
check "admin_entidade forcando entidadeId de OUTRA entidade -> 403" "$(jget cross_tenant_status)" "403"
check "admin_entidade cross-tenant -> erro=PERMISSAO_NEGADA" "$(jget cross_tenant_erro)" "PERMISSAO_NEGADA"

# Cenário 3 (visão global admin_plataforma)
check "admin_plataforma: GET /auditoria (sem entidadeId) -> 200" "$(jget global_ap_status)" "200"
check "admin_plataforma: ve eventos de MULTIPLAS entidades (A e B)" "$(jget global_ap_ve_multiplas_entidades)" "true"
check "admin_plataforma: ve evento GLOBAL (entidadeId:null, login_sucesso)" "$(jget global_ap_ve_evento_global)" "true"
check "admin_plataforma: GET /auditoria?entidadeId=E_A -> 200" "$(jget escopado_ap_status)" "200"
check "admin_plataforma escopado: SO eventos da E_A" "$(jget escopado_ap_so_entidade_a)" "true"
check "admin_plataforma escopado(E_A) INCLUI tudo que admin_entidade da E_A viu (paridade)" "$(jget escopado_ap_paridade_com_ae)" "true"

# Confirmação via DB direto: evento usuario_criado tem id_empresa=E_A e detalhes sem senha
N_EVENTO_DB="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='usuario_criado' AND id_empresa=$E_A AND detalhes::text NOT ILIKE '%senha%'" | tr -d '[:space:]')"
check "DB: evento usuario_criado gravado em E_A sem 'senha' em detalhes" "$([ "${N_EVENTO_DB:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

N_EVENTO_GLOBAL_DB="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='login_sucesso' AND id_empresa IS NULL" | tr -d '[:space:]')"
check "DB: eventos login_sucesso gravados com id_empresa NULL (globais)" "$([ "${N_EVENTO_GLOBAL_DB:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

echo
if [ "$fails" -eq 0 ]; then
  echo "HUB-AUDITORIA-ADMIN-INTEGRATION: OK — todos os asserts passaram (FASE 6.1, Cenarios 1/2/3)"
  exit 0
else
  echo "HUB-AUDITORIA-ADMIN-INTEGRATION: FALHOU — $fails assert(s) falharam"
  exit 1
fi
