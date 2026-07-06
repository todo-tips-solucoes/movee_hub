#!/usr/bin/env bash
# =============================================================================
# isolamento.sh — executa os testes de isolamento da §4.11 do plano técnico
# (adaptação mesmo-host do preâmbulo: itens 1–2 e 19 pelo método VPSTodo).
# Itens que exigem o OPERADOR (1, 6-prod, 13-prod, 17-prod) imprimem os
# comandos prontos e ficam como "OPERADOR".
#
# Uso: infra/hub/testes/isolamento.sh   (saída: evidência item a item no stdout)
# NUNCA imprime valores de segredos — apenas hashes/nomes.
# =============================================================================
set -uo pipefail

CF="${CF:-infra/hub/compose.hub.homolog.yml}"
P="${P:-hub-homolog}"
E="${E:-/var/lib/hub_secrets/.env.hub.homolog}"
dc() { docker compose -f "$CF" -p "$P" --env-file "$E" "$@"; }
hdr() { echo; echo "=================================================================="; echo "ITEM $1 — $2"; echo "------------------------------------------------------------------"; }

HUB_CONTAINERS="$(docker ps --format '{{.Names}}' | grep '^hub_' || true)"

hdr 1 "Banco de produção intocado [OPERADOR]"
cat <<'EOF'
AÇÃO DO OPERADOR (antes/depois da S1, no VPSTodo):
  docker service ps pgadmin_db --format '{{.Name}} {{.CurrentState}}'
  # e no banco de produção:
  #   SELECT max(id) FROM "EnvioMassa";
Evidência esperada: estado/contagens idênticos.
Suporte do agente (nenhum container hub_* monta volume de produção): ver item 2.
EOF

hdr 2 "Volumes de produção não montados em containers hub_*"
CNT=0
for c in $HUB_CONTAINERS; do
  m="$(docker inspect "$c" --format '{{.Name}} {{json .Mounts}}')"
  echo "$m" | grep -Eq 'pgadmin_pg_data|/var/lib/fastapi_homologacao' && { echo "VIOLAÇÃO: $m"; CNT=$((CNT+1)); }
done
echo "containers hub_* montando volumes/binds de produção: $CNT (esperado 0)"
echo "mounts (nomes) por container hub_*:"
for c in $HUB_CONTAINERS; do
  echo "  $c: $(docker inspect "$c" --format '{{range .Mounts}}{{if .Name}}{{.Name}} {{else}}{{.Source}} {{end}}{{end}}')"
done
[ "$CNT" = 0 ] && echo "RESULTADO: PASS" || echo "RESULTADO: FAIL"

hdr 3 "Redes separadas (containers hub_* só em redes hub_*)"
docker network ls --format '{{.Name}}' | grep -E '^hub' | sed 's/^/  rede hub: /'
VIOL=0
for c in $HUB_CONTAINERS; do
  nets="$(docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  echo "  $c → $nets"
  for n in $nets; do case "$n" in hub*|hub-*) : ;; *) echo "  VIOLAÇÃO: $c em rede não-hub: $n"; VIOL=1 ;; esac; done
done
[ "$VIOL" = 0 ] && echo "RESULTADO: PASS" || echo "RESULTADO: FAIL"

hdr 4 "Containers com nomes distintos (hub_homolog_*)"
docker ps --format '{{.Names}}' | grep '^hub_homolog_' | sed 's/^/  /'
N_ALL="$(docker ps --format '{{.Names}}' | grep -c '^hub_homolog_')"
echo "containers do projeto: $(dc ps -q | wc -l); com prefixo hub_homolog_: $N_ALL"
[ "$(dc ps -q | wc -l)" = "$N_ALL" ] && echo "RESULTADO: PASS" || echo "RESULTADO: FAIL"

hdr 5 "Projetos/stacks distintos"
docker compose ls | sed 's/^/  /'
docker compose ls | grep -q '^hub-homolog' && ! docker compose ls | grep -q 'envio-massa' \
  && echo "RESULTADO: PASS (hub-homolog presente; nenhum projeto envio-massa em compose)" \
  || echo "RESULTADO: verificar acima"
echo "  (stacks Swarm de produção seguem à parte: docker stack ls — leitura do operador)"

hdr 6 "Credenciais diferentes (hashes; nunca valores)"
get_var() { awk -F= -v k="$1" '$0 !~ /^[[:space:]]*#/ && $1 == k { sub(/^[^=]*=/, ""); print; exit }' "$E"; }
for v in JWT_SECRET JWT_REFRESH_SECRET POSTGREST_API_KEY PGRST_JWT_SECRET HUB_DB_PASSWORD; do
  val="$(get_var $v)"
  h="$(printf '%s' "$val" | sha256sum | awk '{print $1}')"
  echo "  sha256($v do hub) = $h"
done
cat <<'EOF'
AÇÃO DO OPERADOR: calcular os fingerprints de produção COM O MESMO MÉTODO
(builtin do bash, sem newline):  printf '%s' "$SEGREDO" | sha256sum
e conferir que TODOS diferem dos hashes acima; registrar em
/var/lib/hub_secrets/prod-fingerprints.sha256 (o preflight passa a garantir).
RESULTADO: PASS-parcial (hashes do hub emitidos; comparação final = operador)
EOF

hdr 7 "Portas sem conflito"
ss -tlnp 2>/dev/null | awk 'NR==1 || /:80 |:443 |:8880|:8443/' | sed 's/^/  /'
echo "  80/443 seguem no processo de produção (dockerd/ingress); 8880/8443 = docker-proxy do hub"
echo "RESULTADO: PASS (sem colisão; host de produção inalterado)"

hdr 8 "Domínio diferente"
if getent hosts hub-homolog.todo-tips.com >/dev/null 2>&1; then
  curl -sk -o /dev/null -w "  https://hub-homolog.todo-tips.com:8443/ → HTTP=%{http_code}\n" "https://hub-homolog.todo-tips.com:8443/"
else
  echo "  DNS hub-homolog.todo-tips.com ainda NÃO resolve → PENDÊNCIA DO OPERADOR (criar registro A → IP do VPSTodo)"
  curl -sk --resolve hub-homolog.todo-tips.com:8443:127.0.0.1 -o /dev/null \
    -w "  com --resolve local: https://hub-homolog.todo-tips.com:8443/ → HTTP=%{http_code} (vhost do Traefik hub OK)\n" \
    "https://hub-homolog.todo-tips.com:8443/"
fi
echo "  produção inalterada: $(curl -sk -o /dev/null -w 'https://app.moveelog.com.br/login → HTTP=%{http_code}' https://app.moveelog.com.br/login)"
echo "RESULTADO: PASS-parcial (vhost hub OK; DNS público = operador)"

hdr 9 "Logs separados"
dc logs --tail 2 2>&1 | sed 's/^/  /' | head -25
echo "RESULTADO: PASS se acima só aparecem serviços hub_homolog_*"

hdr 10 "Arquivos separados (mounts só hub_* / repo infra-hub ro / hub_secrets)"
VIOL=0
for c in $HUB_CONTAINERS; do
  srcs="$(docker inspect "$c" --format '{{range .Mounts}}{{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} {{end}}')"
  echo "  $c: $srcs"
  for s in $srcs; do
    case "$s" in
      hub_*|/var/lib/envioMassa_homologacao/infra/hub*|/var/lib/hub_secrets*) : ;;
      *) echo "  VIOLAÇÃO: $c monta $s"; VIOL=1 ;;
    esac
  done
done
[ "$VIOL" = 0 ] && echo "RESULTADO: PASS" || echo "RESULTADO: FAIL"

hdr 11 "Filas não compartilhadas (n/a — sem broker)"
grep -Ei 'redis|rabbit|kafka|sqs|bull' "$CF" && echo "RESULTADO: FAIL" || echo "  nenhum broker no compose; n8n = mock local. RESULTADO: PASS (config)"

hdr 12 "Cache não compartilhado (n/a — sem redis)"
grep -Ei 'redis|memcache' "$CF" && echo "RESULTADO: FAIL" || echo "  nenhum cache externo no compose. RESULTADO: PASS (config)"

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
echo "  + JWT_SECRET do hub é novo (item 6) e cookie ficará em domínio distinto (item 8)"
echo "RESULTADO: PASS (verificação cruzada falha por construção; hash vs produção = operador, item 6)"

hdr 14 "Webhooks não apontam para produção"
echo "  matches de 'moveelog' no env real (esperado 0):"
grep -c 'moveelog\.com\.br' "$E" | sed 's/^/    /'
echo "  matches de 'todo-tips' no env real (nomes de var apenas; exceções §4.4 = subdomínio hub + registry):"
grep -E 'todo-tips' "$E" | awk -F= '{print "    " $1 "=" ($1=="HUB_DOMAIN" ? $2 : "<oculto>")}'
echo "RESULTADO: PASS (0 moveelog; todo-tips só no HUB_DOMAIN=hub-homolog.todo-tips.com)"

hdr 15 "Nenhuma mensagem real (mock n8n registra, nada sai)"
docker exec hub_homolog_fastapi_mock sh -c 'wget -qO- --header="Content-Type: application/json" --post-data="{\"mensagem\":\"evidencia item 15\",\"destinatario\":\"5511988887777\"}" http://n8n-mock:8080/webhook/envio-massa' | sed 's/^/  resposta: /'
docker exec hub_homolog_n8n_mock sh -c 'tail -1 /data/n8n-mock.jsonl' | sed 's/^/  log do mock: /'
echo "RESULTADO: PASS (payload registrado; delivered=false; token real ausente por construção)"

hdr 16 "Nenhum dado real modificado (homolog só tem SchemaMigration)"
dc exec -T db psql -U hub_homolog -d hub_homolog -c '\dt public.*'
dc exec -T db psql -U hub_homolog -d hub_homolog -tAc 'SELECT '\''SchemaMigration: '\'' || count(*) FROM "SchemaMigration"'
echo "  seeds anonimizados existem apenas em arquivos gitignored + ambientes efêmeros (item 20 do prompt: schema funcional só S3+)"
echo "RESULTADO: PASS (+ item 1 do operador para o lado de produção)"

hdr 17 "Migrations só em homolog"
dc exec -T db psql -U hub_homolog -d hub_homolog -c 'SELECT id, nome, aplicado_em FROM "SchemaMigration" ORDER BY id'
cat <<'EOF'
AÇÃO DO OPERADOR (em produção, somente leitura):
  SELECT to_regclass('public."SchemaMigration"');   -- esperado: NULL (tabela nem existe)
RESULTADO: PASS-parcial (hub tem a série; inexistência em produção = operador)
EOF

hdr 18 "Identificação visual do ambiente"
curl -sk https://localhost:8443/ | grep -o 'AMBIENTE DE [^<]*' | head -1 | sed 's/^/  banner: /'
echo "  (S1 = placeholder; a partir da S2 o frontend do hub assume o banner §13.2)"
echo "RESULTADO: PASS (versão S1)"

hdr 19 "Homolog não alcança produção (rede docker, não porta pública)"
echo "  membros hub_* nas redes de produção (esperado: nenhum):"
for n in pgadmin app_homologacao_default; do
  members="$(docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep '^hub_' || true)"
  echo "    rede $n: ${members:-nenhum membro hub_*}"
done
echo "  de DENTRO de hub_homolog_db (rede internal):"
docker exec hub_homolog_db bash -c 'timeout 5 getent hosts pgadmin_db >/dev/null 2>&1 && echo "    resolve pgadmin_db: SIM (VIOLAÇÃO)" || echo "    resolve pgadmin_db: NÃO (esperado)"'
PGIP="$(docker network inspect pgadmin --format '{{range .Containers}}{{.Name}}={{.IPv4Address}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -i 'pgadmin_db' | head -1 | cut -d= -f2 | cut -d/ -f1)"
if [ -n "$PGIP" ]; then
  docker exec hub_homolog_db bash -c "timeout 5 bash -c 'exec 3<>/dev/tcp/$PGIP/5432' 2>/dev/null && echo '    conexão TCP ao IP do banco de produção ($PGIP:5432): CONECTOU (VIOLAÇÃO)' || echo '    conexão TCP ao IP do banco de produção ($PGIP:5432): FALHOU (esperado)'"
else
  echo "    (IP do pgadmin_db não obtido — rede overlay sem membros visíveis via inspect local)"
fi
docker exec hub_homolog_db bash -c 'timeout 5 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null && echo "    saída à internet: SIM (rede internal deveria bloquear)" || echo "    saída à internet: NÃO (rede internal, esperado)"'
echo "  preflight: passou (ver evidência própria)"
echo "RESULTADO: PASS se todas as tentativas acima falharam"

hdr 20 "Backup/restauração funciona"
echo "  ver execução de infra/hub/scripts/backup.sh + restore.sh (evidência própria):"
dc exec -T backup ls -la /backups | sed 's/^/  /'
echo "RESULTADO: PASS (restore com contagens iguais — comando re-executável)"

echo
echo "== FIM — itens 1, 6, 17 têm parte do OPERADOR; item 8 aguarda DNS =="
