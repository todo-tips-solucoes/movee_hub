#!/usr/bin/env bash
# Cria avisos de push em PRODUÇÃO pela API do hub, um por vez, cada um com texto
# próprio. Usa exatamente as rotas da tela de aviso — serve para teste de
# entrega, quando preencher a tela N vezes é inviável.
#
#   bash push-avisos-disparar.sh buscar  <nome ou CNPJ>   -> lista id + nome
#   bash push-avisos-disparar.sh alcance <id[,id...]>     -> quantos aparelhos
#   bash push-avisos-disparar.sh <N>     <id[,id...]>     -> cria N avisos
#
# Credenciais num arquivo 600 com duas linhas (email=… / senha=…), caminho em
# $CRED (padrão /var/lib/hub_secrets/.hub-api-login). Senha nunca em argumento:
# argumento vai para o histórico e para a lista de processos.
#
# ⚠️ O modo `toda_base` NÃO está disponível aqui, de propósito: em 2026-09-16 já
# havia 121 inscrições de 115 motoristas REAIS. Teste é sempre `individual`, e
# mesmo assim o script aborta acima de 5 aparelhos sem liberação explícita.
set -euo pipefail

BASE="https://app.moveelog.com.br/api/v1"
CRED=${CRED:-/var/lib/hub_secrets/.hub-api-login}
ACAO=${1:-}
ARG=${2:-}

uso() { sed -n '/^#   bash/,/^#$/p' "$0" | sed 's/^# \{0,1\}//'; }
[ -n "$ACAO" ] || { uso; exit 1; }

if [ ! -r "$CRED" ]; then
  echo "ABORTA: credenciais não encontradas em $CRED"
  echo "crie num editor (para a senha não ir para o histórico):  umask 077 && nano $CRED"
  echo "duas linhas:   email=voce@empresa.com"
  echo "               senha=suasenha"
  exit 1
fi
EMAIL=$(sed -n 's/^email=//p' "$CRED" | head -1)
SENHA=$(sed -n 's/^senha=//p' "$CRED" | head -1)
[ -n "$EMAIL" ] && [ -n "$SENHA" ] || { echo "ABORTA: $CRED precisa das linhas email= e senha="; exit 1; }

JAR=$(mktemp); chmod 600 "$JAR"; trap 'rm -f "$JAR"' EXIT
req() { curl -sS -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' "$@"; }

LOGIN=$(req -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" \
  --data "$(jq -nc --arg e "$EMAIL" --arg s "$SENHA" '{email:$e, senha:$s}')")
unset SENHA
[ "$LOGIN" = "200" ] || { echo "ABORTA: login devolveu $LOGIN"; exit 1; }

EMP=$(req "$BASE/me" | jq -r '.entidades[0].empresa_id // empty')
[ -n "$EMP" ] || { echo "ABORTA: nenhuma entidade no /me"; exit 1; }
ENT=$(req -o /dev/null -w '%{http_code}' -X POST "$BASE/me/entidade" --data "{\"empresa_id\":$EMP}")
[ "$ENT" = "200" ] || { echo "ABORTA: /me/entidade devolveu $ENT"; exit 1; }

if [ "$ACAO" = "buscar" ]; then
  [ -n "$ARG" ] || { echo "ABORTA: informe o termo (mínimo 3 letras)"; exit 1; }
  req "$BASE/avisos/destinatarios/motoristas?busca=$(printf '%s' "$ARG" | jq -sRr @uri)" \
    | jq -r 'if (.motoristas|length)==0 then "nenhum motorista para esse termo"
             else (.motoristas[] | "id=\(.id)  \(.nome)") end'
  exit 0
fi

ids_validos() { [[ "$1" =~ ^[0-9]+(,[0-9]+)*$ ]]; }

if [ "$ACAO" = "alcance" ]; then
  ids_validos "$ARG" || { echo "ABORTA: bash $0 alcance <id[,id]>"; exit 1; }
  req "$BASE/avisos/alcance?modo=individual&ids=$ARG" \
    | jq -r '"\(.motoristas) motorista(s), \(.inscricoes) aparelho(s) com inscrição ativa"'
  exit 0
fi

N=$ACAO; IDS=$ARG
[[ "$N" =~ ^[0-9]+$ ]] && [ "$N" -ge 1 ] && [ "$N" -le 30 ] || { echo "ABORTA: N de 1 a 30 (o backend limita 30 disparos/15min)"; exit 1; }
ids_validos "$IDS" || { echo "ABORTA: passe os ids. Descubra com: bash $0 buscar <nome>"; exit 1; }

ALC=$(req "$BASE/avisos/alcance?modo=individual&ids=$IDS")
QTD=$(printf '%s' "$ALC" | jq -r '.inscricoes // 0')
PES=$(printf '%s' "$ALC" | jq -r '.motoristas // 0')
echo "alcance medido: $PES motorista(s), $QTD aparelho(s) -> $((QTD*N)) notificações no total"
[ "$QTD" -gt 0 ] || { echo "ABORTA: esses ids não têm inscrição ativa (aparelho deslogado revoga a inscrição)"; exit 1; }

if [ "$QTD" -gt 5 ]; then
  [ "${ALCANCE_GRANDE_OK:-}" = "SIM, $QTD PESSOAS" ] || {
    echo "ABORTA: $QTD aparelhos é gente real, não teste."
    echo "se for intencional: ALCANCE_GRANDE_OK='SIM, $QTD PESSOAS' bash $0 $N $IDS"
    exit 1; }
fi

ok=0; falhou=0
for i in $(seq 1 "$N"); do
  BODY=$(jq -nc --arg t "Teste - aviso $i de $N" \
                --arg c "Mensagem de teste numero $i, enviada as $(date '+%H:%M:%S'). Toque para abrir e confira se o texto bate." \
                --arg k "$(cat /proc/sys/kernel/random/uuid)" --arg ids "$IDS" \
    '{titulo:$t, corpo:$c, modoDestinatarios:"individual", chaveIdempotencia:$k,
      destinatariosIds: ($ids|split(",")|map(tonumber))}')
  RESP=$(req -w '\n%{http_code}' -X POST "$BASE/avisos" --data "$BODY")
  CODE=$(printf '%s' "$RESP" | tail -1); CORPO=$(printf '%s' "$RESP" | sed '$d')
  case "$CODE" in
    201) ok=$((ok+1)); echo "  $i/$N  201  $(printf '%s' "$CORPO" | jq -c '{id, visados}')" ;;
    200) ok=$((ok+1)); echo "  $i/$N  200  reutilizado (idempotência): $CORPO" ;;
    *)   falhou=$((falhou+1)); echo "  $i/$N  $CODE  $CORPO" ;;
  esac
  sleep 2
done
echo
echo "criados=$ok falharam=$falhou"
echo "confira em ~1 min: bash $(dirname "$0")/push-avisos-conferir.sh $N"
