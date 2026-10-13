#!/usr/bin/env bash
# =============================================================================
# smoke-deploy.sh — smoke test de produção pós-deploy. SÓ LEITURA.
#
# Prova que o deploy subiu o código certo, não só que o serviço respondeu.
# Detalhes, significado de cada falha e o que fazer: README-smoke-deploy.md
#
# Uso: infra/producao/smoke-deploy.sh [-t [serviço=]TAG]... [-s ARQ] [-B]
#   -t TAG          exige essa tag em backend, frontend_v2 e frontend_motorista
#   -t svc=TAG      exige a tag só nesse serviço (repetível)
#   -s ARQ          strings de bundle, linhas "serviço|tag|string ASCII"; a string só
#                   vale se a tag NO AR for a registrada (senão FALHA: prova obsoleta)
#                   (padrão: smoke-deploy.strings ao lado do script, se existir)
#   -B              pula a verificação de funções no banco
# Saída: 0 = tudo OK; 1 = alguma FALHA; 2 = uso incorreto.
# =============================================================================
set -uo pipefail

PROJ=envio-massa-homologacao
SERVICOS=(backend frontend_v2 frontend_motorista frontend)   # frontend = legado (v1)
APP_HOST=https://app.moveelog.com.br
MOTORISTA_HOST=https://app.motorista.moveelog.com.br
ROTA_AUTH=/api/v1/adiantamentos/repasse/lotes/previa
FUNCOES_PREFIXO='hub_repasse_%'
DB_CONT_FILTRO='^pgadmin_db\.'          # produção; o do hub isolado é hub_homolog_db
STRINGS="$(dirname "$0")/smoke-deploy.strings"
USAR_BANCO=1
declare -A TAG_ESPERADA=() TAG_NO_AR=()
URLS=${SMOKE_URLS:-"$APP_HOST/hub/login $APP_HOST/login $MOTORISTA_HOST/"}   # SMOKE_URLS: só para testar o 000

while getopts 't:s:Bh' o; do
  case $o in
    t) if [[ $OPTARG == *=* ]]; then TAG_ESPERADA[${OPTARG%%=*}]=${OPTARG#*=}
       else for s in backend frontend_v2 frontend_motorista; do TAG_ESPERADA[$s]=$OPTARG; done; fi ;;
    s) STRINGS=$OPTARG ;;
    B) USAR_BANCO=0 ;;
    *) sed -n 2,16p "$0"; exit 2 ;;
  esac
done

total=0; falhas=0
ok()    { total=$((total+1)); printf '  OK     %-34s %s\n' "$1" "$2"; }
falha() { total=$((total+1)); falhas=$((falhas+1)); printf '  FALHA  %-34s %s\n' "$1" "$2"; }
secao() { printf '\n%s\n' "$1"; }

# container em execução do serviço (nome do Swarm tem sufixo .N.<hash>)
cont() { docker ps -qf "name=^${PROJ}_${1}_homologacao\." 2>/dev/null | head -n1; }

secao "1. Imagem no ar por serviço"
for s in "${SERVICOS[@]}"; do
  # --filter name= é por prefixo; o nome exato é conferido no awk
  img=$(docker service ls --filter "name=${PROJ}_${s}_homologacao" --format '{{.Name}} {{.Image}}' 2>/dev/null \
        | awk -v n="${PROJ}_${s}_homologacao" '$1==n {print $2; exit}')
  if [[ -z $img ]]; then falha "$s" "serviço não encontrado"; continue; fi
  tag=${img##*:}; tag=${tag%%@*}; TAG_NO_AR[$s]=$tag
  esp=${TAG_ESPERADA[$s]:-}
  if [[ -n $esp && $tag != "$esp" ]]; then falha "$s" "no ar: $tag | esperado: $esp"
  else ok "$s" "tag $tag${esp:+ (confere com o esperado)}"; fi
done

secao "2. Runtime do backend (processo vivo)"
c=$(cont backend)
if [[ -z $c ]]; then falha "backend node" "nenhum container em execução"
else
  v=$(docker exec "$c" node --version 2>&1) || v=""
  if [[ $v == v20.* ]]; then ok "backend node" "$v"
  elif [[ -n $v ]]; then falha "backend node" "$v (esperado v20.x — imagem veio do Dockerfile antigo?)"
  else falha "backend node" "docker exec falhou"; fi
fi

secao "3. Prova de bundle (string no código servido)"
if [[ -r $STRINGS ]]; then
  while IFS='|' read -r svc tagreg str; do
    [[ -z $svc || $svc == \#* ]] && continue
    if [[ -z $str ]]; then falha "$svc" "linha mal formada (use serviço|tag|string)"; continue; fi
    if [[ ${TAG_NO_AR[$svc]:-} != "$tagreg" ]]; then
      falha "$svc" "ATENCAO: string registrada para a tag $tagreg, mas no ar esta ${TAG_NO_AR[$svc]:-?}; a prova de bundle NAO vale (atualize o .strings)"; continue
    fi
    if [[ ! $str =~ ^[[:print:]]+$ || $str =~ [^[:ascii:]] ]]; then falha "$svc" "string não-ASCII: use ASCII"; continue; fi
    c=$(cont "$svc")
    if [[ -z $c ]]; then falha "$svc" "sem container em execução"; continue; fi
    # BusyBox grep: sem --exclude-dir, então aponta só para o código (sem node_modules)
    if [[ $svc == backend ]]; then alvo="routes lib server.js"; else alvo=.next; fi
    # shellcheck disable=SC2086
    if docker exec "$c" grep -rqF -- "$str" $alvo 2>/dev/null; then ok "$svc" "'$str' presente"
    else falha "$svc" "'$str' AUSENTE no bundle servido"; fi
  done < "$STRINGS"
else
  printf '  (sem arquivo de strings em %s — verificação não executada)\n' "$STRINGS"
fi

secao "4. Rotas HTTP"
http() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null; }
for u in $URLS; do
  code=$(http "$u")
  if [[ $code == 200 ]]; then ok "$u" "200"
  elif [[ $code == 000 ]]; then
    k=$(http -k "$u")
    if [[ $k == 200 ]]; then falha "$u" "curl 000 = certificado recusado (app responde 200 com -k; NÃO é queda — veja cert-guard)"
    else falha "$u" "sem resposta (000 e -k deu $k)"; fi
  else falha "$u" "HTTP $code (esperado 200)"; fi
done

secao "5. Rota autenticada existe"
code=$(http -X POST -H 'content-type: application/json' -d '{}' "$APP_HOST$ROTA_AUTH")
case $code in
  401) ok "POST $ROTA_AUTH" "401 (existe e exige login)" ;;
  404) falha "POST $ROTA_AUTH" "404 — a rota sumiu" ;;
  5??) falha "POST $ROTA_AUTH" "$code — a rota quebrou" ;;
  *)   falha "POST $ROTA_AUTH" "HTTP $code (esperado 401)" ;;
esac

if (( USAR_BANCO )); then
  secao "6. Funções no banco (somente SELECT)"
  c=$(docker ps -qf "name=$DB_CONT_FILTRO" | head -n1)
  if [[ -z $c ]]; then falha "banco" "container pgadmin_db não encontrado"
  else
    fn=$(docker exec "$c" psql -U chatmasterveloz -d chatmasterveloz -tAc \
         "select count(*) from pg_proc where proname like '$FUNCOES_PREFIXO'" 2>&1) || fn=""
    if [[ $fn =~ ^[0-9]+$ && $fn -gt 0 ]]; then ok "funcoes $FUNCOES_PREFIXO" "$fn encontradas"
    else falha "funcoes $FUNCOES_PREFIXO" "nenhuma encontrada ou psql falhou"; fi
  fi
fi

printf '\n%d verificações, %d falhas\n' "$total" "$falhas"
(( falhas == 0 ))
