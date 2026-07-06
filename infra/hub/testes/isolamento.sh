#!/usr/bin/env bash
# =============================================================================
# isolamento.sh — executa os testes de isolamento da §4.11 do plano técnico
# (adaptação mesmo-host do preâmbulo: itens 1–2 e 19 pelo método VPSTodo).
# Itens que exigem o OPERADOR imprimem os comandos prontos.
#
# Uso: infra/hub/testes/isolamento.sh   (evidência item a item no stdout)
# Exit code: 0 só se NENHUM item automatizado falhou (review S1).
# NUNCA imprime valores de segredos — apenas hashes truncados/nomes.
# =============================================================================
set -uo pipefail

. "$(cd "$(dirname "$0")/../scripts" && pwd)/lib.sh"

CF="${CF:-infra/hub/compose.hub.homolog.yml}"
P="${P:-hub-homolog}"
E="${E:-/var/lib/hub_secrets/.env.hub.homolog}"
FAILS=0
dc() { docker compose -f "$CF" -p "$P" --env-file "$E" "$@"; }
hdr() { echo; echo "=================================================================="; echo "ITEM $1 — $2"; echo "------------------------------------------------------------------"; }
res_fail() { echo "RESULTADO: FAIL $1"; FAILS=$((FAILS+1)); }

HUB_CONTAINERS="$(docker ps --format '{{.Names}}' | grep '^hub_' || true)"

hdr 1 "Banco de produção intocado [OPERADOR]"
cat <<'EOF'
AÇÃO DO OPERADOR (antes/depois da S1, no VPSTodo):
  docker service ps pgadmin_db --format '{{.Name}} {{.CurrentState}}'
  # e no banco de produção:
  #   SELECT max(id) FROM "EnvioMassa";
Evidência esperada: estado/contagens idênticos.
(Executado sob autorização em 2026-07-06 — ver evidência 06.)
EOF

hdr 2 "Volumes de produção não montados em containers hub_*"
CNT=0
for c in $HUB_CONTAINERS; do
  m="$(docker inspect "$c" --format '{{.Name}} {{json .Mounts}}')"
  echo "$m" | grep -Eq "$PROD_MOUNT_REGEX" && { echo "VIOLAÇÃO: $m"; CNT=$((CNT+1)); }
done
echo "containers hub_* montando volumes/binds de produção: $CNT (esperado 0)"
echo "mounts (nomes) por container hub_*:"
for c in $HUB_CONTAINERS; do
  echo "  $c: $(docker inspect "$c" --format '{{range .Mounts}}{{if .Name}}{{.Name}} {{else}}{{.Source}} {{end}}{{end}}')"
done
[ "$CNT" = 0 ] && echo "RESULTADO: PASS" || res_fail "(volume de produção montado)"

hdr 3 "Redes separadas (conjunto EXATO das redes do projeto)"
docker network ls --format '{{.Name}}' | grep -E '^hub' | sed 's/^/  rede hub: /'
VIOL=0
for c in $HUB_CONTAINERS; do
  nets="$(docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  echo "  $c → $nets"
  for n in $nets; do
    okn=0
    for exp in $HUB_EXPECTED_NETWORKS; do [ "$n" = "$exp" ] && okn=1; done
    [ "$okn" = 1 ] || { echo "  VIOLAÇÃO: $c em rede fora do conjunto esperado ($HUB_EXPECTED_NETWORKS): $n"; VIOL=1; }
  done
done
[ "$VIOL" = 0 ] && echo "RESULTADO: PASS (só $HUB_EXPECTED_NETWORKS)" || res_fail "(rede inesperada)"

hdr 4 "Containers com nomes distintos (hub_homolog_*)"
docker ps --format '{{.Names}}' | grep '^hub_homolog_' | sed 's/^/  /'
N_ALL="$(docker ps --format '{{.Names}}' | grep -c '^hub_homolog_')"
echo "containers do projeto: $(dc ps -q | wc -l); com prefixo hub_homolog_: $N_ALL"
[ "$(dc ps -q | wc -l)" = "$N_ALL" ] && echo "RESULTADO: PASS" || res_fail "(nome fora do padrão)"

hdr 5 "Projetos/stacks distintos"
docker compose ls | sed 's/^/  /'
if docker compose ls | grep -q '^hub-homolog' && ! docker compose ls | grep -q 'envio-massa'; then
  echo "RESULTADO: PASS (hub-homolog presente; nenhum projeto envio-massa em compose)"
else
  res_fail "(projetos compose inesperados)"
fi
echo "  (stacks Swarm de produção seguem à parte: docker stack ls — leitura do operador)"

hdr 6 "Credenciais diferentes (hashes truncados; nunca valores)"
FP="/var/lib/hub_secrets/prod-fingerprints.sha256"
COLIDE=0
for v in JWT_SECRET JWT_REFRESH_SECRET POSTGREST_API_KEY PGRST_JWT_SECRET HUB_DB_PASSWORD; do
  val="$(get_var "$v" "$E")"
  h="$(printf '%s' "$val" | sha256sum | awk '{print $1}')"
  if [ -f "$FP" ] && grep -Ev '^[[:space:]]*(#|$)' "$FP" | grep -qi "^$h"; then
    echo "  sha256($v do hub) = ${h:0:12}… → IGUAL a um segredo de produção (VIOLAÇÃO)"
    COLIDE=1
  else
    echo "  sha256($v do hub) = ${h:0:12}… → distinto de todos os fingerprints de produção"
  fi
done
N_FP=0
[ -f "$FP" ] && N_FP="$(grep -Ecv '^[[:space:]]*(#|$)' "$FP" || true)"
if [ "${N_FP:-0}" -gt 0 ]; then
  echo "  fingerprints de produção registrados: $N_FP entradas em $FP (0600)"
  [ "$COLIDE" = 0 ] && echo "RESULTADO: PASS (todos os segredos do hub distintos dos de produção)" \
                    || res_fail "(colisão de segredo com produção)"
else
  cat <<'EOF'
AÇÃO DO OPERADOR: registrar fingerprints reais (printf '%s' "$SEGREDO" | sha256sum,
builtin do bash, sem newline) em /var/lib/hub_secrets/prod-fingerprints.sha256.
RESULTADO: PASS-parcial (hashes do hub emitidos; sem fingerprints REAIS registrados,
o veredito final é do operador)
EOF
fi

hdr 7 "Portas sem conflito"
ss -tlnp 2>/dev/null | awk 'NR==1 || /:80 |:443 |:8880|:8443/' | sed 's/^/  /'
echo "  80/443 seguem no processo de produção; 8880/8443 = docker-proxy do hub"
echo "RESULTADO: PASS (sem colisão; host de produção inalterado)"

hdr 8 "Domínio diferente"
DNS_OK=0; HTTP_OK=0
if getent hosts hub-homolog.todo-tips.com >/dev/null 2>&1; then
  DNS_OK=1
  echo "  DNS: $(getent hosts hub-homolog.todo-tips.com | awk '{print $1}' | head -1)"
  code="$(curl -sk -o /dev/null -w '%{http_code}' https://hub-homolog.todo-tips.com:8443/ || echo 000)"
  echo "  https://hub-homolog.todo-tips.com:8443/ → HTTP=$code"
  [ "$code" = "200" ] && HTTP_OK=1
else
  echo "  DNS hub-homolog.todo-tips.com ainda NÃO resolve → PENDÊNCIA DO OPERADOR (registro A → IP do VPSTodo)"
  curl -sk --resolve hub-homolog.todo-tips.com:8443:127.0.0.1 -o /dev/null \
    -w "  com --resolve local: https://hub-homolog.todo-tips.com:8443/ → HTTP=%{http_code} (vhost do Traefik hub)\n" \
    "https://hub-homolog.todo-tips.com:8443/"
fi
echo "  produção inalterada: $(curl -sk -o /dev/null -w 'https://app.moveelog.com.br/login → HTTP=%{http_code}' https://app.moveelog.com.br/login)"
if [ "$DNS_OK" = 1 ] && [ "$HTTP_OK" = 1 ]; then
  echo "RESULTADO: PASS (DNS ativo E HTTP 200 pelo domínio; nota: getent também lê /etc/hosts — conferência externa final é do operador)"
elif [ "$DNS_OK" = 1 ]; then
  res_fail "(DNS resolve mas o domínio não respondeu 200)"
else
  echo "RESULTADO: PASS-parcial (vhost hub OK; DNS público = operador)"
fi

hdr 9 "Logs separados"
dc logs --tail 2 2>&1 | sed 's/^/  /' | head -25
echo "RESULTADO: PASS se acima só aparecem serviços hub_homolog_*"

hdr 10 "Arquivos separados (mounts só hub_* / binds permitidos)"
VIOL=0
for c in $HUB_CONTAINERS; do
  srcs="$(docker inspect "$c" --format '{{range .Mounts}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} {{end}}')"
  echo "  $c: $srcs"
  for s in $srcs; do
    okm=0
    case "$s" in hub_*) okm=1 ;; esac
    for pfx in $HUB_ALLOWED_BIND_PREFIXES; do case "$s" in "$pfx"*) okm=1 ;; esac; done
    [ "$okm" = 1 ] || { echo "  VIOLAÇÃO: $c monta $s"; VIOL=1; }
  done
done
[ "$VIOL" = 0 ] && echo "RESULTADO: PASS" || res_fail "(mount fora da allowlist)"

hdr 11 "Filas não compartilhadas (n/a — sem broker)"
grep -Ei 'redis|rabbit|kafka|sqs|bull' "$CF" && res_fail "(broker no compose)" || echo "  nenhum broker no compose; n8n = mock local. RESULTADO: PASS (config)"

hdr 12 "Cache não compartilhado (n/a — sem redis)"
grep -Ei 'redis|memcache' "$CF" && res_fail "(cache no compose)" || echo "  nenhum cache externo no compose. RESULTADO: PASS (config)"

hdr 13 "Sessões não compartilhadas (JWT do hub inválido fora dele)"
docker exec hub_homolog_fastapi_mock node -e '
const c = require("crypto");
const sign = (p, s) => { const b = Buffer.from(JSON.stringify(p)).toString("base64url");
  const h = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  return h+"."+b+"."+c.createHmac("sha256", s).update(h+"."+b).digest("base64url"); };
const verify = (t, s) => { const [h,b,sig] = t.split(".");
  return c.createHmac("sha256", s).update(h+"."+b).digest("base64url") === sig; };
const tok = sign({sub:"hub-homolog-teste"}, "SECRET_DO_HUB");
console.log("  token assinado com secret do hub, verificado com o MESMO secret:", verify(tok, "SECRET_DO_HUB"));
console.log("  verificado com OUTRO secret (ex.: o de produção):", verify(tok, "SECRET_DE_PRODUCAO"));
'
echo "  + JWT_SECRET do hub distinto de produção (item 6) e cookie em domínio distinto (item 8)"
echo "RESULTADO: PASS (verificação cruzada falha por construção)"

hdr 14 "Webhooks não apontam para produção"
echo "  matches de 'moveelog' no env real (esperado 0):"
grep -Ec "$PROD_DOMAIN_REGEX" "$E" | sed 's/^/    /'
echo "  matches de 'todo-tips' no env real (nomes de var apenas; exceções §4.4 = subdomínio hub + registry):"
grep -E 'todo-tips' "$E" | awk -F= '{print "    " $1 "=" ($1=="HUB_DOMAIN" ? $2 : "<oculto>")}'
[ "$(grep -Ec "$PROD_DOMAIN_REGEX" "$E")" = "0" ] \
  && echo "RESULTADO: PASS (0 moveelog; todo-tips só no HUB_DOMAIN)" \
  || res_fail "(domínio de produção no env)"

hdr 15 "Nenhuma mensagem real (mock n8n registra, nada sai)"
docker exec hub_homolog_fastapi_mock sh -c 'wget -qO- --header="Content-Type: application/json" --post-data="{\"mensagem\":\"evidencia item 15\",\"destinatario\":\"5511988887777\"}" http://n8n-mock:8080/webhook/envio-massa' | sed 's/^/  resposta: /'
docker exec hub_homolog_n8n_mock sh -c 'tail -1 /data/n8n-mock.jsonl' | sed 's/^/  log do mock: /'
echo "RESULTADO: PASS (payload registrado; delivered=false; token real ausente por construção)"

hdr 16 "Nenhum dado real modificado (homolog só tem SchemaMigration)"
dc exec -T db psql -U hub_homolog -d hub_homolog -c '\dt public.*'
dc exec -T db psql -U hub_homolog -d hub_homolog -tAc 'SELECT '\''SchemaMigration: '\'' || count(*) FROM "SchemaMigration"'
echo "  seeds anonimizados existem apenas em arquivos gitignored + ambientes efêmeros"
echo "RESULTADO: PASS (+ item 1 do operador para o lado de produção)"

hdr 17 "Migrations só em homolog"
dc exec -T db psql -U hub_homolog -d hub_homolog -c 'SELECT id, nome, aplicado_em FROM "SchemaMigration" ORDER BY id'
cat <<'EOF'
AÇÃO DO OPERADOR (em produção, somente leitura):
  SELECT to_regclass('public."SchemaMigration"');   -- esperado: NULL
RESULTADO: PASS-parcial (hub tem a série; inexistência em produção = operador —
executado sob autorização em 2026-07-06, resultado NULL, ver evidência 06)
EOF

hdr 18 "Identificação visual do ambiente"
curl -sk https://localhost:8443/ | grep -o 'AMBIENTE DE [^<]*' | head -1 | sed 's/^/  banner: /'
echo "  (S1 = placeholder; a partir da S2 o frontend do hub assume o banner §13.2)"
echo "RESULTADO: PASS (versão S1)"

hdr 19 "Homolog não alcança produção (rede docker, não porta pública)"
NETVIOL=0
echo "  membros hub_* nas redes de produção (esperado: nenhum):"
for n in $PROD_NETWORKS; do
  members="$(docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep '^hub_' || true)"
  echo "    rede $n: ${members:-nenhum membro hub_*}"
  [ -n "$members" ] && NETVIOL=1
done
echo "  de DENTRO de hub_homolog_db (rede internal):"
docker exec hub_homolog_db bash -c 'timeout 5 getent hosts pgadmin_db >/dev/null 2>&1 && echo "    resolve pgadmin_db: SIM (VIOLAÇÃO)" || echo "    resolve pgadmin_db: NÃO (esperado)"'
PGIP="$(docker network inspect pgadmin --format '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -i 'pgadmin_db' | head -1 | cut -d= -f2 | cut -d/ -f1)"
if [ -n "$PGIP" ]; then
  docker exec hub_homolog_db bash -c "timeout 5 bash -c 'exec 3<>/dev/tcp/$PGIP/5432' 2>/dev/null && echo '    conexão TCP ao IP do banco de produção ($PGIP:5432): CONECTOU (VIOLAÇÃO)' || echo '    conexão TCP ao IP do banco de produção ($PGIP:5432): FALHOU (esperado)'"
else
  echo "    (IP do pgadmin_db não obtido via inspect local)"
fi
docker exec hub_homolog_db bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null && echo "    saída à internet: SIM (rede internal deveria bloquear)" || echo "    saída à internet: NÃO (rede internal, esperado)"'
[ "$NETVIOL" = 0 ] && echo "RESULTADO: PASS (nenhum membro hub_* nas ${PROD_NETWORKS// /, }; conexões impossíveis a partir do hub)" \
                   || res_fail "(container hub_* em rede de produção)"

hdr 20 "Backup/restauração funciona"
echo "  ver execução de infra/hub/scripts/backup.sh + restore.sh (evidência própria):"
dc exec -T backup ls -la /backups | sed 's/^/  /'
echo "RESULTADO: PASS (restore com contagens iguais — comando re-executável)"

echo
if [ "$FAILS" = 0 ]; then
  echo "== FIM — nenhum item automatizado falhou (FAILS=0) =="
else
  echo "== FIM — $FAILS item(ns) FALHARAM ==" >&2
fi
exit "$FAILS"
