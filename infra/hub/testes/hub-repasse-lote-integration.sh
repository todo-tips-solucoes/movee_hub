#!/usr/bin/env bash
# =============================================================================
# hub-repasse-lote-integration.sh — integração da F5 (lote de pagamento do
# repasse): migration 0108 + 9 RPCs hub_repasse_*, DIRETO NO POSTGREST (JWT
# assinado pelo helper de produção lib/hub-postgrest-jwt.js), num projeto
# hub-test EFÊMERO (db+postgrest, tmpfs, SEM backend). Plano:
# docs/plans/nota-pendente-motorista/PLANO-F5-LOTE-REPASSE.md (§3.5/§3.7).
#
# Escolha: atacar o PostgREST (RPCs), não o backend Node — é onde mora o
# dinheiro (elegibilidade, idempotência, lock, transições) e é o que os
# drivers irmãos do adiantamento fazem. As 8 rotas Node seguem cobertas só
# por unit (tests/hub-repasse-lotes-rotas-unit.test.js, PostgREST simulado).
#
# Tudo o que o teste cria nasce e morre com o projeto efêmero (down -v):
# repetível por construção; nada é deixado em hub_homolog.
#
# Uso: infra/hub/testes/hub-repasse-lote-integration.sh
# Saída final: "HUB-REPASSE-LOTE-INTEGRATION: OK (N PASS / 0 FAIL)"
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
CURL_CT="${PROJECT}-curl"
cleanup() { docker rm -f "$CURL_CT" >/dev/null 2>&1 || true; dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest efêmeros ($PROJECT, tmpfs, SEM backend)…"
dc up -d --wait db
dc up -d --wait postgrest
docker run -d --name "$CURL_CT" --network "$NET" --entrypoint sleep curlimages/curl:8.11.1 3600 >/dev/null

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
q() { psql_t -tAc "$1" | tr -d '[:space:]'; }   # escalar sem espaço
qs() { psql_t -tAc "$1"; }                       # escalar com espaço
# mut <sql>: mutação de fixture; se o SQL falhar o teste aborta (um UPDATE que não pegou faria o cenário passar por engano)
mut() { psql_t -c "$1" >/dev/null || { echo "FAIL FATAL: mutação de fixture recusada: $1"; exit 1; }; }

echo "rodando migrate.sh (série completa, até 0108)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0108_repasse_lote.sql" "$TMP/migrate.log" || { echo "FAIL: 0108 não aplicada"; tail -30 "$TMP/migrate.log"; exit 1; }
# a imagem do PostgREST lê o schema no boot; recarrega por garantia
docker kill -s SIGUSR1 "$(dc ps -q postgrest)" >/dev/null 2>&1 || true
sleep 2

jwt_for() { # jwt_for <sub> <empresaAtiva> <escopoCsv>
  PGRST_JWT_SECRET="$PGRST_SECRET" node -e "
    const { generateHubPostgrestJWT } = require('$RAIZ/app_homologacao/backend/lib/hub-postgrest-jwt');
    process.stdout.write(generateHubPostgrestJWT({ usuarioId: process.argv[1], empresaAtiva: process.argv[2], escopo: process.argv[3].split(',').map(Number) }));
  " "$1" "$2" "$3"
}
jwt_worker() { # token do tick do worker (claim interna hub_adiantamento_worker)
  PGRST_JWT_SECRET="$PGRST_SECRET" node -e "
    const { generateHubPostgrestJWT } = require('$RAIZ/app_homologacao/backend/lib/hub-postgrest-jwt');
    process.stdout.write(generateHubPostgrestJWT({ adiantamentoWorker: true }));
  "
}

# rpc <jwt> <função> <json>  -> BODY / STATUS
BODY=""; STATUS=""
rpc() {
  local out
  out="$(docker exec "$CURL_CT" curl -s -w '\nHTTP_STATUS:%{http_code}' -X POST "http://postgrest:3000/rpc/$2" \
    -H "Authorization: Bearer $1" -H "Content-Type: application/json" -d "$3")"
  STATUS="$(printf '%s' "$out" | tail -n1 | cut -d: -f2)"
  BODY="$(printf '%s' "$out" | sed '$d')"
}
get() { # get <jwt> <path-com-query> -> BODY / STATUS
  local out
  out="$(docker exec "$CURL_CT" curl -s -w '\nHTTP_STATUS:%{http_code}' "http://postgrest:3000/$2" -H "Authorization: Bearer $1")"
  STATUS="$(printf '%s' "$out" | tail -n1 | cut -d: -f2)"
  BODY="$(printf '%s' "$out" | sed '$d')"
}
jq_b() { printf '%s' "$BODY" | jq -r "$1"; }

fails=0; passes=0
check() { # check <descricao> <obtido> <esperado>
  if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}
# o PostgREST devolve o RAISE EXCEPTION em .message
check_erro() { # check_erro <descricao> <CODIGO>  (usa BODY/STATUS do último rpc)
  local msg; msg="$(jq_b '.message // empty')"
  check "$1" "$msg|$STATUS" "$2|400"
}

# --------------------------------------------------------------------------
# Fixture (tudo efêmero)
# --------------------------------------------------------------------------
E=9001; OUTRA=9010
psql_t >/dev/null <<SQL
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('rep-aprovador@example.test','x','Aprovador Repasse',true),
  ('rep-financeiro@example.test','x','Financeiro Repasse',true),
  ('rep-outra@example.test','x','Operador Outra Empresa',true);
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='rep-aprovador@example.test'), $E, (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true),
  ((SELECT id FROM "Usuario" WHERE email='rep-financeiro@example.test'), $E, (SELECT id FROM "Papel" WHERE nome='financeiro'), true),
  ((SELECT id FROM "Usuario" WHERE email='rep-outra@example.test'), $OUTRA, (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true);
-- módulo adiantamentos ativo nas duas empresas (hub_adiantamento_tem_permissao exige)
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, e, true FROM "Modulo" m, unnest(ARRAY[$E,$OUTRA]) e WHERE m.codigo = 'adiantamentos'
ON CONFLICT (modulo_id, empresa_id) DO UPDATE SET ativo = true;
SQL
U_APR="$(q "SELECT id FROM \"Usuario\" WHERE email='rep-aprovador@example.test'")"
U_FIN="$(q "SELECT id FROM \"Usuario\" WHERE email='rep-financeiro@example.test'")"
U_OUT="$(q "SELECT id FROM \"Usuario\" WHERE email='rep-outra@example.test'")"
[ -n "$U_APR" ] && [ -n "$U_FIN" ] && [ -n "$U_OUT" ] || { echo "FAIL: seed de usuários"; exit 1; }

# mk_par <empresa> <rótulo> <fechado_por> [valor_pago=100] [semanas_de_deslocamento=0 (único por empresa+período)] -> "apuracao_id entregador_id envio_id conta_id item_id"
# par completo e ELEGÍVEL: apuração fechada, valor_pago=100, nota aprovada, conta APROVADA.
mk_par() {
  psql_t -tA -F' ' <<SQL | tail -n1
WITH cfg AS (
  INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura,
      horario_corte, percentual, taxa_fixa, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse)
  VALUES ($1, (SELECT COALESCE(max(versao),0)+1 FROM "AdiantamentoConfiguracao" WHERE id_empresa=$1), now(), 'America/Sao_Paulo',
      '{1,2,3,4,5}', '08:00', '17:00', 50, 0, 'em 2 dias', 'Repasse {data_producao:DD.MM.AA} - {nome}', 1, 3)
  RETURNING id
), ent AS (
  INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES ($1, gen_random_uuid(), 'Teste $2') RETURNING id
), env AS (
  INSERT INTO "EnvioMassa" (nome, cnpj_prestador, valor, id_empresa, mov_fechado, nota_ok, erro_validacao)
  VALUES ('Teste $2', '', 100, $1, false, 'http://x/nota.xml', NULL) RETURNING id
), apu AS (
  INSERT INTO "ApuracaoRepasse" (id_empresa, periodo_inicio, periodo_fim, data_repasse, configuracao_id, fechado_por, fechado_em)
  SELECT $1, date '2026-10-05' + 7*${5:-0}, date '2026-10-11' + 7*${5:-0}, date '2026-10-14' + 7*${5:-0}, cfg.id, $3, now() FROM cfg RETURNING id
), it AS (
  INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente, detalhe, valor_pago)
  SELECT apu.id, $1, ent.id, 100, 0, 0, 0, '{}'::jsonb, ${4:-100} FROM apu, ent RETURNING id
), mv AS (
  INSERT INTO "ApuracaoRepasseMovimento" (apuracao_id, entregador_id, id_empresa, envio_massa_id, valor, gorjeta)
  SELECT apu.id, ent.id, $1, env.id, 100, 0 FROM apu, ent, env RETURNING id
), cb AS (
  INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo,
      banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id)
  SELECT $1, ent.id, 'HUB', 'APROVADA', 'Teste $2', '12345678909', 'PF', '001', 'Banco do Brasil', '1234', '56789', '0', 'CORRENTE', ent.id
  FROM ent RETURNING id
)
SELECT apu.id, ent.id, env.id, cb.id, it.id FROM apu, ent, env, cb, it, mv;
SQL
}

read -r APU ENT ENV CONTA ITEM <<<"$(mk_par $E Principal "$U_APR")"
[ -n "$APU" ] && [ -n "$ENT" ] || { echo "FAIL: fixture do par principal não criado"; exit 1; }
read -r APU_O ENT_O ENV_O CONTA_O ITEM_O <<<"$(mk_par $OUTRA OutraEmpresa "$U_OUT")"
[ -n "$APU_O" ] || { echo "FAIL: fixture do par da outra empresa não criado"; exit 1; }

JWT_APR="$(jwt_for "$U_APR" "$E" "$E")"
JWT_FIN="$(jwt_for "$U_FIN" "$E" "$E")"
JWT_OUT="$(jwt_for "$U_OUT" "$OUTRA" "$OUTRA")"
JWT_WORKER="$(jwt_worker)"
[ -n "$JWT_APR" ] && [ -n "$JWT_WORKER" ] || { echo "FAIL: geração de JWT"; exit 1; }

PAR_A="[$APU]"; PAR_E="[$ENT]"
previa_par() { rpc "$JWT_APR" hub_repasse_lote_previa "{\"p_apuracoes\":$PAR_A,\"p_entregadores\":$PAR_E}"; }
criar() { # criar <chave> [qtd] [total] [jwt]
  rpc "${4:-$JWT_APR}" hub_repasse_lote_criar "{\"p_apuracoes\":$PAR_A,\"p_entregadores\":$PAR_E,\"p_quantidade_esperada\":${2:-1},\"p_total_esperado\":${3:-100},\"p_chave\":\"$1\"}"
}
reset_lotes() { psql_t -c 'DELETE FROM "RepasseLoteItem"; DELETE FROM "RepasseLote";' >/dev/null; }
n_lotes() { q 'SELECT count(*) FROM "RepasseLote"'; }
n_itens() { q 'SELECT count(*) FROM "RepasseLoteItem"'; }
uuid() { cat /proc/sys/kernel/random/uuid; }

# --------------------------------------------------------------------------
echo "=== Elegibilidade (controle negativo: desfaz a condição, prova o bloqueio, restaura) ==="
previa_par
check "[sanidade] par fixture começa apto" "$(jq_b '.[0].apta')|$(jq_b '.[0].valor_pago')" "true|100.00"

# 7 — nota reprovada: erro_validacao preenchido COM nota_ok presente
mut "UPDATE \"EnvioMassa\" SET erro_validacao='CNPJ divergente' WHERE id=$ENV"
previa_par; check "7 nota reprovada (nota_ok presente + erro_validacao) => NOTA_REPROVADA" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|NOTA_REPROVADA"
criar "$(uuid)"; check_erro "7 criar com nota reprovada => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
mut "UPDATE \"EnvioMassa\" SET erro_validacao=NULL WHERE id=$ENV"
previa_par; check "7 restaurado => apto" "$(jq_b '.[0].apta')" "true"

# 8 — nota_ok vazio/NULL
mut "UPDATE \"EnvioMassa\" SET nota_ok=NULL WHERE id=$ENV"
previa_par; check "8 nota_ok NULL => NOTA_PENDENTE" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|NOTA_PENDENTE"
mut "UPDATE \"EnvioMassa\" SET nota_ok='   ' WHERE id=$ENV"
previa_par; check "8 nota_ok só com espaços => NOTA_PENDENTE" "$(jq_b '.[0].motivo_pendencia')" "NOTA_PENDENTE"
mut "UPDATE \"EnvioMassa\" SET nota_ok='http://x/nota.xml' WHERE id=$ENV"
previa_par; check "8 restaurado => apto" "$(jq_b '.[0].apta')" "true"

# 9 — conta não-APROVADA
mut "UPDATE \"ContaBancariaMotorista\" SET status='CANCELADA' WHERE id=$CONTA"
previa_par; check "9 conta não-APROVADA => SEM_CONTA" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|SEM_CONTA"
mut "UPDATE \"ContaBancariaMotorista\" SET status='APROVADA' WHERE id=$CONTA"
previa_par; check "9 restaurado => apto" "$(jq_b '.[0].apta')" "true"

# 11 — valor_pago <= 0 (ApuracaoRepasseItem é imutável por trigger: a condição entra pelo fixture, não por UPDATE)
read -r APU_Z ENT_Z _ _ _ <<<"$(mk_par $E ValorZero "$U_APR" 0 1)"
rpc "$JWT_APR" hub_repasse_lote_previa "{\"p_apuracoes\":[$APU_Z],\"p_entregadores\":[$ENT_Z]}"
check "11 valor_pago=0 => VALOR_INVALIDO" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|VALOR_INVALIDO"
rpc "$JWT_APR" hub_repasse_lote_criar "{\"p_apuracoes\":[$APU_Z],\"p_entregadores\":[$ENT_Z],\"p_quantidade_esperada\":1,\"p_total_esperado\":0,\"p_chave\":\"$(uuid)\"}"
check_erro "11 criar com valor_pago=0 => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "11 [controle] prévia padrão (valor_pago>0) segue só com o par bom" "$(jq_b 'length')|$(jq_b '.[0].entregador_id')" "1|$ENT"
check "7-11 nenhuma tentativa bloqueada criou lote/item" "$(n_lotes)|$(n_itens)" "0|0"

# --------------------------------------------------------------------------
echo "=== 19 isolamento de tenant (EnvioMassa tem RLS USING(true): a prova é do escopo explícito) ==="
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "19 prévia padrão (escopo 9001) devolve só o par da própria empresa" "$(jq_b 'length')|$(jq_b '.[0].entregador_id')" "1|$ENT"
rpc "$JWT_APR" hub_repasse_lote_previa "{\"p_apuracoes\":[$APU_O],\"p_entregadores\":[$ENT_O]}"
check "19 prévia explícita do par de OUTRA empresa => vazia" "$(jq_b 'length')" "0"
rpc "$JWT_APR" hub_repasse_lote_criar "{\"p_apuracoes\":[$APU_O],\"p_entregadores\":[$ENT_O],\"p_quantidade_esperada\":1,\"p_total_esperado\":100,\"p_chave\":\"$(uuid)\"}"
check_erro "19 criar com par de outra empresa => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
rpc "$JWT_APR" hub_repasse_lote_criar "{\"p_apuracoes\":[$APU,$APU_O],\"p_entregadores\":[$ENT,$ENT_O],\"p_quantidade_esperada\":2,\"p_total_esperado\":200,\"p_chave\":\"$(uuid)\"}"
check_erro "19 criar misturando par próprio + alheio => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
rpc "$JWT_OUT" hub_repasse_lote_previa "{\"p_apuracoes\":[$APU_O],\"p_entregadores\":[$ENT_O]}"
check "19 [controle] a outra empresa enxerga o próprio par como apto" "$(jq_b '.[0].apta')" "true"
check "19 nada foi criado" "$(n_lotes)|$(n_itens)" "0|0"

# --------------------------------------------------------------------------
echo "=== 13/14 proteção de valor e quantidade (antes de qualquer lote) ==="
criar "$(uuid)" 2 100; check_erro "13 quantidadeEsperada errada => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
criar "$(uuid)" 1 99.99; check_erro "14 totalEsperado errado (99.99) => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
criar "$(uuid)" 1 100.01; check_erro "14 totalEsperado errado (100.01) => PREVIA_DESATUALIZADA" PREVIA_DESATUALIZADA
check "13/14 nenhuma recusa criou lote/item" "$(n_lotes)|$(n_itens)" "0|0"

# --------------------------------------------------------------------------
echo "=== Ciclo feliz: prévia -> criar -> arquivo -> download -> confirmar ==="
K1="$(uuid)"
# 1
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "1 prévia devolve o par como apta:true" "$(jq_b '.[0].apta')|$(jq_b '.[0].entregador_id')" "true|$ENT"
# 2
criar "$K1"
LOTE="$(jq_b '.[0].id')"
check "2 criar => GERANDO, qtd 1, total 100.00, reutilizado=false" \
  "$(jq_b '.[0].status')|$(jq_b '.[0].quantidade')|$(jq_b '.[0].valor_total')|$(jq_b '.[0].reutilizado')|$STATUS" "GERANDO|1|100.00|false|200"
ITEM_LOTE="$(q "SELECT id FROM \"RepasseLoteItem\" WHERE lote_id=$LOTE")"
check "2 item guarda o valor_pago (100.00), situacao incluido" "$(q "SELECT valor||'|'||situacao FROM \"RepasseLoteItem\" WHERE id=$ITEM_LOTE")" "100.00|incluido"
check "2 col_id_integracao = REP-<id do item, padding 6>" \
  "$(q "SELECT col_id_integracao FROM \"RepasseLoteItem\" WHERE id=$ITEM_LOTE")" "REP-$(printf '%06d' "$ITEM_LOTE")"
check "2 col_documento FORMATADO (não mascarado)" "$(q "SELECT col_documento FROM \"RepasseLoteItem\" WHERE id=$ITEM_LOTE")" "123.456.789-09"

# 12 idempotência
criar "$K1"
check "12 2ª chamada, mesma chave => reutilizado=true, mesmo lote" "$(jq_b '.[0].reutilizado')|$(jq_b '.[0].id')|$STATUS" "true|$LOTE|200"
check "12 sem lote novo nem item novo (conta antes=1/1)" "$(n_lotes)|$(n_itens)" "1|1"

# 10 par já em lote ativo
previa_par
check "10 par em lote ativo => prévia JA_EM_LOTE" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|JA_EM_LOTE"
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "10 prévia padrão já não lista o par (é histórico)" "$(jq_b 'length')" "0"
criar "$(uuid)"
check_erro "10 criar com chave nova sobre par já em lote => ITENS_EM_OUTRO_LOTE" ITENS_EM_OUTRO_LOTE
check "10 sem lote/item extra" "$(n_lotes)|$(n_itens)" "1|1"

# 16 confirmar fora do estado EXPORTADO
rpc "$JWT_APR" hub_repasse_lote_confirmar "{\"p_lote_id\":$LOTE,\"p_falhas\":[]}"
check_erro "16 confirmar em lote GERANDO => TRANSICAO_INVALIDA" TRANSICAO_INVALIDA

# 3 arquivo
printf 'bytes-xlsx-sinteticos-repasse\x00\x01\xff' >"$TMP/arq.bin"
SHA="$(sha256sum "$TMP/arq.bin" | cut -d' ' -f1)"; B64="$(base64 -w0 "$TMP/arq.bin")"; NB="$(stat -c %s "$TMP/arq.bin")"
rpc "$JWT_APR" hub_repasse_lote_arquivo "{\"p_lote_id\":$LOTE,\"p_arquivo\":\"$B64\",\"p_sha256\":\"$SHA\",\"p_bytes\":$NB,\"p_nome\":\"repasse-$LOTE.xlsx\",\"p_itens\":[{\"id\":$ITEM_LOTE,\"descricao\":\"Repasse 11.10.26 - Teste Principal\"}]}"
check "3 lote_arquivo => GERADO" "$(jq_b '.[0].status')|$STATUS" "GERADO|200"
check "3 arquivo_sha256/arquivo_bytes gravados" "$(q "SELECT arquivo_sha256||'|'||arquivo_bytes FROM \"RepasseLote\" WHERE id=$LOTE")" "$SHA|$NB"
check "3 descrição Pix renderizada pelo Node substitui o modelo bruto" "$(qs "SELECT col_descricao_pix FROM \"RepasseLoteItem\" WHERE id=$ITEM_LOTE")" "Repasse 11.10.26 - Teste Principal"
rpc "$JWT_APR" hub_repasse_lote_arquivo "{\"p_lote_id\":$LOTE,\"p_arquivo\":\"$B64\",\"p_sha256\":\"$SHA\",\"p_bytes\":$NB,\"p_nome\":\"x.xlsx\"}"
check_erro "3 lote_arquivo repetido (lote já GERADO) => TRANSICAO_INVALIDA" TRANSICAO_INVALIDA

rpc "$JWT_APR" hub_repasse_lote_confirmar "{\"p_lote_id\":$LOTE,\"p_falhas\":[]}"
check_erro "16 confirmar em lote GERADO (ainda não baixado) => TRANSICAO_INVALIDA" TRANSICAO_INVALIDA

# 20 bytes do arquivo não saem por listagem
get "$JWT_APR" "RepasseLote?select=arquivo"
check "20 GET RepasseLote?select=arquivo => 403 (GRANT por coluna)" "$STATUS" "403"
get "$JWT_APR" "RepasseLote?select=*"
check "20 GET RepasseLote?select=* também recusado (sem vazar bytes)" "$STATUS" "403"
get "$JWT_APR" "RepasseLote?select=id,status,arquivo_sha256,downloads&id=eq.$LOTE"
check "20 [controle] colunas liberadas listam normalmente" "$STATUS|$(jq_b '.[0].arquivo_sha256')" "200|$SHA"

# 4 download
rpc "$JWT_APR" hub_repasse_lote_download "{\"p_lote_id\":$LOTE}"
printf '%s' "$(jq_b '.[0].arquivo_base64')" | base64 -d >"$TMP/baixado.bin"
check "4 download devolve exatamente os bytes gravados" "$(sha256sum "$TMP/baixado.bin" | cut -d' ' -f1)" "$SHA"
check "4 download incrementa downloads (1) e o lote vira EXPORTADO" "$(jq_b '.[0].downloads')|$(q "SELECT status||'|'||downloads FROM \"RepasseLote\" WHERE id=$LOTE")" "1|EXPORTADO|1"
rpc "$JWT_APR" hub_repasse_lote_download "{\"p_lote_id\":$LOTE}"
check "4 2º download => downloads=2, segue EXPORTADO" "$(jq_b '.[0].downloads')|$(q "SELECT status||'|'||downloads FROM \"RepasseLote\" WHERE id=$LOTE")" "2|EXPORTADO|2"

# permissão: o papel `financeiro` NÃO tem pagamento_confirmar
rpc "$JWT_FIN" hub_repasse_lote_confirmar "{\"p_lote_id\":$LOTE,\"p_falhas\":[]}"
check_erro "(RBAC) papel financeiro não confirma => PERMISSAO_NEGADA" PERMISSAO_NEGADA
check "(RBAC) lote seguiu EXPORTADO" "$(q "SELECT status FROM \"RepasseLote\" WHERE id=$LOTE")" "EXPORTADO"

# 5 confirmar sem falhas
rpc "$JWT_APR" hub_repasse_lote_confirmar "{\"p_lote_id\":$LOTE,\"p_falhas\":[]}"
check "5 confirmar p_falhas=[] => CONCLUIDO" "$(jq_b '.[0].status')|$STATUS" "CONCLUIDO|200"
check "5 todos os itens pago (origem retorno), concluido_em preenchido" \
  "$(q "SELECT string_agg(situacao||'/'||origem_situacao, ',') FROM \"RepasseLoteItem\" WHERE lote_id=$LOTE")|$(q "SELECT (concluido_em IS NOT NULL)::text FROM \"RepasseLote\" WHERE id=$LOTE")" "pago/retorno|true"

# 15 reimportar o mesmo retorno
SIT_ANTES="$(q "SELECT situacao||'|'||situacao_em FROM \"RepasseLoteItem\" WHERE id=$ITEM_LOTE")"
rpc "$JWT_APR" hub_repasse_lote_confirmar "{\"p_lote_id\":$LOTE,\"p_falhas\":[{\"id\":$ITEM_LOTE,\"motivo\":\"devolvido\"}],\"p_origem\":\"retorno\"}"
check_erro "15 reimportar o mesmo retorno (lote CONCLUIDO) => TRANSICAO_INVALIDA" TRANSICAO_INVALIDA
check "15 inócuo: item segue pago, com a mesma situacao_em" "$(q "SELECT situacao||'|'||situacao_em FROM \"RepasseLoteItem\" WHERE id=$ITEM_LOTE")" "$SIT_ANTES"

# 6 a prévia não devolve mais o par
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "6 prévia padrão não devolve mais o par" "$(jq_b 'length')" "0"
previa_par
check "6 prévia explícita: JA_EM_LOTE (pago), nunca apto" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|JA_EM_LOTE"
criar "$(uuid)"; check_erro "6 não dá para pagar o par duas vezes (criar => ITENS_EM_OUTRO_LOTE)" ITENS_EM_OUTRO_LOTE

# --------------------------------------------------------------------------
echo "=== 17 cancelar devolve o par ao pool ==="
reset_lotes
criar "$(uuid)"; LOTE2="$(jq_b '.[0].id')"
rpc "$JWT_APR" hub_repasse_lote_cancelar "{\"p_lote_id\":$LOTE2,\"p_motivo\":\"teste de cancelamento\"}"
check "17 cancelar lote GERANDO => CANCELADO" "$(jq_b '.[0].status')|$STATUS" "CANCELADO|200"
check "17 itens viram cancelado" "$(q "SELECT string_agg(situacao, ',') FROM \"RepasseLoteItem\" WHERE lote_id=$LOTE2")" "cancelado"
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "17 prévia volta a mostrar o par como apta" "$(jq_b 'length')|$(jq_b '.[0].apta')|$(jq_b '.[0].entregador_id')" "1|true|$ENT"
criar "$(uuid)"; check "17 e um novo lote pode ser criado sobre o par" "$(jq_b '.[0].status')" "GERANDO"
rpc "$JWT_APR" hub_repasse_lote_cancelar "{\"p_lote_id\":$LOTE2,\"p_motivo\":\"de novo\"}"
check_erro "17 cancelar lote já CANCELADO => TRANSICAO_INVALIDA" TRANSICAO_INVALIDA

echo "=== item falhou volta ao pool; lote CONCLUIDO_COM_FALHAS ==="
reset_lotes
criar "$(uuid)"; LOTE3="$(jq_b '.[0].id')"; IT3="$(q "SELECT id FROM \"RepasseLoteItem\" WHERE lote_id=$LOTE3")"
rpc "$JWT_APR" hub_repasse_lote_arquivo "{\"p_lote_id\":$LOTE3,\"p_arquivo\":\"$B64\",\"p_sha256\":\"$SHA\",\"p_bytes\":$NB,\"p_nome\":\"r3.xlsx\"}"
rpc "$JWT_APR" hub_repasse_lote_download "{\"p_lote_id\":$LOTE3}"
rpc "$JWT_APR" hub_repasse_lote_confirmar "{\"p_lote_id\":$LOTE3,\"p_falhas\":[{\"id\":$IT3,\"motivo\":\"conta encerrada\"}],\"p_origem\":\"manual\"}"
check "falha: lote => CONCLUIDO_COM_FALHAS" "$(jq_b '.[0].status')" "CONCLUIDO_COM_FALHAS"
check "falha: item falhou com o motivo e origem manual" "$(q "SELECT situacao||'/'||situacao_motivo||'/'||origem_situacao FROM \"RepasseLoteItem\" WHERE id=$IT3" | tr -d ' ')" "falhou/contaencerrada/manual"
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "falha: o par volta ao pool (apto)" "$(jq_b 'length')|$(jq_b '.[0].apta')" "1|true"

# --------------------------------------------------------------------------
echo "=== 18 varredura de órfãos (lote GERANDO que ninguém terminou) ==="
reset_lotes
criar "$(uuid)"; LOTE4="$(jq_b '.[0].id')"
previa_par
check "18 lote deixado em GERANDO => par aparece JA_EM_LOTE" "$(jq_b '.[0].apta')|$(jq_b '.[0].motivo_pendencia')" "false|JA_EM_LOTE"
rpc "$JWT_APR" hub_repasse_lote_orfaos '{"p_minutos":0}'
check_erro "18 token de usuário comum NÃO varre => PERMISSAO_NEGADA" PERMISSAO_NEGADA
check "18 lote seguiu GERANDO depois da tentativa recusada" "$(q "SELECT status FROM \"RepasseLote\" WHERE id=$LOTE4")" "GERANDO"
rpc "$JWT_APR" hub_repasse_lote_orfaos '{}'
check_erro "18 usuário comum sem argumento também recusado" PERMISSAO_NEGADA
rpc "$JWT_WORKER" hub_repasse_lote_orfaos '{"p_minutos":5}'
check "18 [controle] lote recém-criado NÃO é órfão com janela de 5 min" "$STATUS|$(jq_b 'length')|$(q "SELECT status FROM \"RepasseLote\" WHERE id=$LOTE4")" "200|0|GERANDO"
rpc "$JWT_WORKER" hub_repasse_lote_orfaos '{"p_minutos":0}'
check "18 token de worker varre: devolve o lote órfão" "$STATUS|$(jq_b '.[0].id')" "200|$LOTE4"
check "18 lote => CANCELADO (falha_geracao), item => cancelado" \
  "$(q "SELECT status||'/'||cancelado_motivo FROM \"RepasseLote\" WHERE id=$LOTE4")|$(q "SELECT string_agg(situacao, ',') FROM \"RepasseLoteItem\" WHERE lote_id=$LOTE4")" "CANCELADO/falha_geracao|cancelado"
rpc "$JWT_APR" hub_repasse_lote_previa '{}'
check "18 a prévia VOLTA a apta:true (o par não fica trancado para sempre)" "$(jq_b 'length')|$(jq_b '.[0].apta')|$(jq_b '.[0].entregador_id')" "1|true|$ENT"
criar "$(uuid)"; check "18 e um novo lote nasce sobre o par destravado" "$(jq_b '.[0].status')" "GERANDO"
rpc "$JWT_WORKER" hub_repasse_lote_orfaos '{"p_minutos":0}'
rpc "$JWT_WORKER" hub_repasse_lote_orfaos '{"p_minutos":0}'
check "18 varredura é idempotente (2ª não acha nada)" "$(jq_b 'length')" "0"

# --------------------------------------------------------------------------
reset_lotes
echo "=== higiene: o driver não deixa lote/item para trás ==="
check "RepasseLote/RepasseLoteItem vazios no fim" "$(n_lotes)|$(n_itens)" "0|0"

echo
echo "RESULTADO: $passes PASS / $fails FAIL"
if [ "$fails" -eq 0 ]; then echo "HUB-REPASSE-LOTE-INTEGRATION: OK ($passes PASS / 0 FAIL)"; exit 0; fi
echo "HUB-REPASSE-LOTE-INTEGRATION: FALHOU ($passes PASS / $fails FAIL)"; exit 1
