#!/usr/bin/env bash
# =============================================================================
# hub-lancamento-externo-integration.sh — feature lancamento-externo, tasks 4.1/4.2/4.4.
# Stack EFEMERO (hub-test-*), aplica TODAS as migrations (inclui 0117) e exercita as RPCs
# como o PostgREST as chamaria (SET ROLE authenticated + claims). Nao toca producao.
#
# Cenarios: C15/C15.b (escopo), resumo (a)(b)(c) (gate dec-036), C1 (primeira apuracao),
# C2 (previa == fechamento), C3/C3.b/C3.c (idempotencia), C7 (credito), C9 (flag desligada),
# C14 (empresa sem lancamento inalterada).
# C8 (tres fontes), C10 (tipo invalido, no SQL; os erros de ARQUIVO vivem no teste de rota) e C11
# (concorrencia, duas sessoes + advisory lock) tambem cobertos aqui.
#
# Controles negativos (so em stack de teste, NUNCA em hub_homolog):
#   LE_NEG=cte-off     -> remove o termo externo de fechar/previa (prova C1/C2/C7)
#   LE_NEG=escopo-1    -> remove `IF NOT (6 = ANY (v_escopo))` (prova C15)
#   LE_NEG=escopo-2    -> remove `AND e.id_empresa = 6` (prova C15.b)
#   LE_NEG=gate-resumo -> devolve o gate do resumo a `pagamento_confirmar` (prova (a))
#   LE_NEG=app-off     -> remove o termo externo da funcao do APP do motorista (prova C16)
#   LE_NEG=contencao   -> remove a checagem de semana por contencao (prova C17)
#   LE_NEG=faixa-sql   -> remove o teto de valor do aplicar (prova C10/SQL)
#   LE_NEG=h5          -> volta a ORDEM ANTIGA (janela antes da idempotencia) (prova H5: C3.c-bis e C3.c-ter)
#   LE_NEG=p3          -> remove a recusa SEMANA_ANTERIOR_A_APURACAO (prova P3)
#   LE_NEG=p8          -> deixa o cast de data/valor sem o handler de excecao (prova P8: o lote inteiro aborta)
#   LE_NEG=escopo-resumo -> o RESUMO volta a devolver a flag da config da 6 a quem nao alcanca a 6 (prova P9)
#   LE_NEG=w1          -> a PREVIA volta a deduzir so PAGA (prova W1/C18b com EXPORTADA)
#   LE_NEG=excesso     -> remove a recusa VALOR_EXCEDE_LIQUIDO do aplicar (prova ALTO 2: o excedente desaparece)
#   LE_NEG=excluir-fechada -> remove a guarda de semana FECHADA da exclusao (prova a regra inegociavel)
#   LE_NEG=liquido-sem-exportada -> o liquido deixa de deduzir EXPORTADA (prova a PARIDADE liquido x previa)
#   LE_NEG=excluir-sem-rastro -> a exclusao nao grava o rastro (prova a auditoria)
#   LE_NEG=excluir-liquido -> a exclusao de CREDITO deixa de recusar liquido negativo (prova A1: os R$ 90 que evaporavam)
#   LE_NEG=contador-5b -> o contador do aviso volta a ignorar quem teve lancamento excluido (prova A1 da rodada 5b)
#   LE_NEG=excluir-app -> volta a guarda de exclusao ANTIGA, que olha deducao do app (prova C3: credito imortal)
#   LE_NEG=col-previa | col-congelado | col-app-fechado | col-app-corrente
#                      -> zera a coluna `lancamentos_externos` em UMA superficie (prova C18a/C18b, uma por superficie)
#
# Uso: infra/hub/testes/hub-lancamento-externo-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou"; exit 1; }
echo "subindo db efemero ($PROJECT)..."
dc up -d --wait db

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_relaxed() { dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0; passes=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate1.log" 2>&1 \
  || { echo "FAIL: migrate"; tail -30 "$TMP/migrate1.log"; exit 1; }
grep -q "0117_lancamento_externo.sql" "$TMP/migrate1.log" || { echo "FAIL: 0117 nao aplicada"; exit 1; }

# --- prova de qual corpo esta no ar (md5 do pg_get_functiondef) -------------
md5_fn() { psql_t -tAc "SELECT md5(pg_get_functiondef('$1'::regprocedure));"; }
echo "md5 resumo=$(md5_fn 'hub_lancamento_externo_resumo(date)') aplicar=$(md5_fn 'hub_lancamento_externo_aplicar(text,jsonb)')"

# --- controles negativos: altera a funcao SO neste stack efemero -------------
patch_fn() { # patch_fn <regprocedure> <sed-expr>
  psql_t -tA -c "SELECT pg_get_functiondef('$1'::regprocedure);" > "$TMP/fn.sql"
  cp "$TMP/fn.sql" "$TMP/fn.orig"
  sed -i "$2" "$TMP/fn.sql"
  # M11 (rodada 4): um `sed` que nao casa deixa a funcao INTACTA e o controle negativo "passa" sem provar nada.
  cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "FAIL: patch_fn nao alterou $1 (controle negativo OCO: a expressao nao casa com o corpo vivo)"; exit 1; }
  psql_t -q < "$TMP/fn.sql" >/dev/null
}
case "${LE_NEG:-}" in
  cte-off)
    patch_fn 'hub_adiantamento_repasse_fechar(date)' 's/ - l\.externos_deducao + l\.externos_credito//'
    patch_fn 'hub_adiantamento_repasse(date,text,boolean,integer,integer)' 's/ - externos_deducao + externos_credito//'
    echo "NEG cte-off: aplicado (corpo conferido: $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse_fechar(date)'::regprocedure) ~ 'externos_deducao \+ l.externos_credito'" ) = f esperado)";;
  escopo-1)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' "s/IF NOT (6 = ANY (v_escopo)) THEN RAISE EXCEPTION 'FORA_DE_ESCOPO'; END IF;//"
    echo "NEG escopo-1: gate presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'FORA_DE_ESCOPO'") (f esperado)";;
  escopo-2)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' 's/AND e\.id_empresa = 6;/;/'
    echo "NEG escopo-2: filtro presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'e.id_empresa = 6;'") (f esperado)";;
  app-off)
    patch_fn 'hub_adiantamento_repasse_motorista()' 's/ - v_externo_deducao + v_externo_credito//'
    echo "NEG app-off: termo presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse_motorista()'::regprocedure) ~ 'v_externo_deducao \+ v_externo_credito'") (f esperado)";;
  contencao)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' 's/ OR v_data BETWEEN a\.periodo_inicio AND a\.periodo_fim//'
    echo "NEG contencao: checagem presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'v_data BETWEEN a.periodo_inicio'") (f esperado)";;
  faixa-sql)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' "s/IF v_bruto > 5000.00 THEN/IF false THEN/"
    echo "NEG faixa-sql: teto presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'IF v_bruto > 5000.00'") (f esperado)";;
  col-previa)
    patch_fn 'hub_adiantamento_repasse(date,text,boolean,integer,integer)' 's/(f\.externos_credito - f\.externos_deducao), sum(f\.externos_credito - f\.externos_deducao) OVER ()/0::numeric, 0::numeric/'
    echo "NEG col-previa: coluna real presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse(date,text,boolean,integer,integer)'::regprocedure) ~ 'f.externos_credito - f.externos_deducao\)'") (f esperado)";;
  col-congelado)
    patch_fn 'hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer)' 's/f\.lancamentos_externos, sum(f\.lancamentos_externos) OVER ()/0::numeric, 0::numeric/'
    echo "NEG col-congelado: coluna real presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer)'::regprocedure) ~ 'f.lancamentos_externos,'") (f esperado)";;
  col-app-fechado)
    patch_fn 'hub_adiantamento_repasse_motorista_ultimo_fechado()' 's/^           i\.lancamentos_externos$/           0::numeric/'
    echo "NEG col-app-fechado: coluna real presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse_motorista_ultimo_fechado()'::regprocedure) ~ 'i.lancamentos_externos\n'") (f esperado)";;
  col-app-corrente)
    patch_fn 'hub_adiantamento_repasse_motorista()' 's/(v_externo_credito - v_externo_deducao);/0::numeric;/'
    echo "NEG col-app-corrente: coluna real presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse_motorista()'::regprocedure) ~ '\(v_externo_credito - v_externo_deducao\);'") (f esperado)";;
  h5)
    # reproduz a ORDEM ANTIGA: a idempotencia so vale se a semana NAO estiver fechada (a janela vence)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' "s/IF v_existente IS NOT NULL THEN/IF v_existente IS NOT NULL AND NOT EXISTS (SELECT 1 FROM \"ApuracaoRepasse\" a WHERE a.id_empresa = 6 AND v_data BETWEEN a.periodo_inicio AND a.periodo_fim) THEN/"
    echo "NEG h5: idempotencia condicionada a semana aberta? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'v_existente IS NOT NULL AND NOT EXISTS'") (t esperado)";;
  p3)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' 's/IF v_semana < (SELECT min(a\.periodo_inicio) FROM "ApuracaoRepasse" a WHERE a\.id_empresa = 6) THEN/IF false THEN/'
    echo "NEG p3: recusa presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'IF v_semana < \(SELECT min'") (f esperado)";;
  p8)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' 's/EXCEPTION WHEN OTHERS THEN v_data := NULL;/EXCEPTION WHEN no_data_found THEN v_data := NULL;/;s/EXCEPTION WHEN OTHERS THEN v_bruto := NULL;/EXCEPTION WHEN no_data_found THEN v_bruto := NULL;/'
    echo "NEG p8: handler presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'WHEN OTHERS THEN v_data'") (f esperado)";;
  escopo-resumo)
    patch_fn 'hub_lancamento_externo_resumo(date)' 's/(6 = ANY (v_escopo)) AND v_config\.desconto_adiantamentos/v_config.desconto_adiantamentos/'
    echo "NEG escopo-resumo: guarda da flag presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_resumo(date)'::regprocedure) ~ '6 = ANY \(v_escopo\)\) AND v_config'") (f esperado)";;
  w1)
    patch_fn 'hub_adiantamento_repasse(date,text,boolean,integer,integer)' 's/THEN COALESCE(a\.pagos, 0) + COALESCE(a\.processando, 0) ELSE 0 END AS adiantamentos/THEN COALESCE(a.pagos, 0) ELSE 0 END AS adiantamentos/'
    echo "NEG w1: soma PAGA+EXPORTADA presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_adiantamento_repasse(date,text,boolean,integer,integer)'::regprocedure) ~ 'a.pagos, 0\) \+ COALESCE\(a.processando'") (f esperado)";;
  excesso)
    patch_fn 'hub_lancamento_externo_aplicar(text,jsonb)' "s/IF v_valor > v_liquido THEN/IF false THEN/"
    echo "NEG excesso: recusa presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_aplicar(text,jsonb)'::regprocedure) ~ 'IF v_valor > v_liquido'") (f esperado)";;
  excluir-fechada)
    patch_fn 'hub_lancamento_externo_excluir(bigint)' "s/IF hub_lancamento_externo_semana_fechada(v_l.data_pagamento, v_config.apuracao_dia_inicio) THEN/IF false THEN/"
    echo "NEG excluir-fechada: guarda presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure) ~ 'IF hub_lancamento_externo_semana_fechada'") (f esperado)";;
  liquido-sem-exportada)
    patch_fn 'hub_lancamento_externo_liquido(integer,date,"AdiantamentoConfiguracao")' "s/s.status IN ('PAGA', 'EXPORTADA')/s.status IN ('PAGA')/"
    echo "NEG liquido-sem-exportada: soma de EXPORTADA presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_liquido(integer,date,\"AdiantamentoConfiguracao\")'::regprocedure) ~ 'PAGA., .EXPORTADA'") (f esperado)";;
  excluir-liquido)
    # A1 (rodada 4): remove a guarda que recusa a exclusao de CREDITO que deixaria o liquido negativo
    psql_t -tA -c "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure);" > "$TMP/fn.sql"
    cp "$TMP/fn.sql" "$TMP/fn.orig"
    perl -0pi -e 's/IF \(SELECT t\.sinal FROM "LancamentoExternoTipo" t WHERE t\.codigo = v_l\.tipo\) > 0.*?END IF;//s' "$TMP/fn.sql"
    cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "FAIL: excluir-liquido nao alterou o corpo (controle negativo OCO)"; exit 1; }
    psql_t -q < "$TMP/fn.sql" >/dev/null
    echo "NEG excluir-liquido: guarda presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure) ~ 'EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO'") (f esperado)";;
  contador-5b)
    # A1 (rodada 5b): o contador do aviso volta a varrer SO quem TEM lancamento (sem o rastro de exclusao)
    psql_t -tA -c "SELECT pg_get_functiondef('hub_lancamento_externo_resumo(date)'::regprocedure);" > "$TMP/fn.sql"
    cp "$TMP/fn.sql" "$TMP/fn.orig"
    perl -0pi -e 's/UNION\s+SELECT e\.entregador_id FROM "LancamentoExternoExclusao" e\s+WHERE e\.id_empresa = 6 AND e\.data_pagamento BETWEEN p_periodo_inicio AND v_fim//s' "$TMP/fn.sql"
    cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "FAIL: contador-5b nao alterou o corpo (controle negativo OCO)"; exit 1; }
    psql_t -q < "$TMP/fn.sql" >/dev/null
    echo "NEG contador-5b: varredura do rastro presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_resumo(date)'::regprocedure) ~ 'SELECT e\.entregador_id FROM'") (f esperado)";;
  excluir-app)
    # C3 (rodada 5): volta a guarda ANTIGA (olha o liquido total, inclusive deducao do app) — prova o cenario do motorista 17
    psql_t -tA -c "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure);" > "$TMP/fn.sql"
    cp "$TMP/fn.sql" "$TMP/fn.orig"
    perl -0pi -e 's/AND v_config\.desconto_adiantamentos\s+AND EXISTS \(SELECT 1 FROM "LancamentoExterno" x.*?\+ 6\)\s+AND hub_lancamento_externo_liquido/AND hub_lancamento_externo_liquido/s' "$TMP/fn.sql"
    cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "FAIL: excluir-app nao alterou o corpo (controle negativo OCO)"; exit 1; }
    psql_t -q < "$TMP/fn.sql" >/dev/null
    echo "NEG excluir-app: filtro de deducao externa presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure) ~ 'xt.sinal < 0'") (f esperado)";;
  excluir-sem-rastro)
    psql_t -tA -c "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure);" > "$TMP/fn.sql"
    perl -0pi -e 's/INSERT INTO "LancamentoExternoExclusao".*?v_l\.criado_em, v_sub\);//s' "$TMP/fn.sql"
    psql_t -q < "$TMP/fn.sql" >/dev/null
    echo "NEG excluir-sem-rastro: INSERT de rastro presente? $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_excluir(bigint)'::regprocedure) ~ 'INSERT INTO .LancamentoExternoExclusao'") (f esperado)";;
  gate-resumo)
    patch_fn 'hub_lancamento_externo_resumo(date)' "s/adiantamentos\.pagamentos_consultar/adiantamentos.pagamento_confirmar/"
    echo "NEG gate-resumo: gate atual = $(psql_t -tAc "SELECT pg_get_functiondef('hub_lancamento_externo_resumo(date)'::regprocedure) ~ 'pagamentos_consultar'") (f esperado)";;
esac

# --- fixtures SINTETICAS (CNPJ 900000000000NN, nomes ficticios) --------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES
  ('90000000001001','Motorista Teste 01'),('90000000000002','Motorista Teste 02'),('90000000000003','Motorista Teste 03'),
  ('90000000000004','Motorista Teste 04'),('90000000000005','Motorista Teste 05');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id) VALUES
  (6,    gen_random_uuid(), 'Motorista Teste 01', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000001001')),
  (6,    gen_random_uuid(), 'Motorista Teste 02', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000000002')),
  (6,    gen_random_uuid(), 'Motorista Teste 03', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000000003')),
  (9002, gen_random_uuid(), 'Motorista Teste 04', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000000004')),
  (9001, gen_random_uuid(), 'Motorista Teste 05', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000000005'));
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES
  ('fin@example.com','x','Fin'),('adm@example.com','x','Adm'),('op@example.com','x','Op'),('fin9001@example.com','x','Fin9001');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='fin@example.com'),     6,    (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true),
  ((SELECT id FROM "Usuario" WHERE email='adm@example.com'),     6,    (SELECT id FROM "Papel" WHERE nome='admin_entidade'),       true),
  ((SELECT id FROM "Usuario" WHERE email='op@example.com'),      6,    (SELECT id FROM "Papel" WHERE nome='operador'),             true),
  ((SELECT id FROM "Usuario" WHERE email='fin9001@example.com'), 9001, (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true);
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) SELECT id, 9001, true FROM "Modulo" WHERE codigo='adiantamentos';
-- semana comeca na SEGUNDA (dia 1); semanas fechaveis no passado: 2026-09-14, 09-21, 09-28
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato)
VALUES (6, 90, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 1, 2, 'data_lancamento', ARRAY['Corrida']);
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('e',64), 'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador=v.cnpj),
       v.dia::date, v.dia::date, 'Credito', v.valor, 'Corrida', md5(v.cnpj||v.dia)||md5(v.dia||v.cnpj)
FROM (VALUES ('90000000001001','2026-09-16',100.00),('90000000000002','2026-09-16',50.00),
             ('90000000000002','2026-09-23',4.00),('90000000000003','2026-09-30',80.00)) AS v(cnpj,dia,valor);
SQL
[ $? -eq 0 ] || { echo "FAIL: seed"; cat "$TMP/seed.log"; exit 1; }

# rpc <email> <escopo-json> <empresa_ativa> <sql>  -> saida filtrada, erros incluidos
rpc() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='$1'),'empresa_ativa','$3','escopo','$2'::jsonb)::text, true);
SET ROLE authenticated;
$4
ROLLBACK;
SQL
}
# rpc_commit: igual, mas COMMIT (para gravar de verdade)
rpcc() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='$1'),'empresa_ativa','$3','escopo','$2'::jsonb)::text, true);
SET ROLE authenticated;
$4
COMMIT;
SQL
}
n_lanc() { psql_t -tAc "SELECT count(*) FROM \"LancamentoExterno\" $1;"; }
linha() { echo "[{\"i\":0,\"cnpj\":\"$1\",\"data\":\"$2\",\"valor\":\"$3\",\"obs\":null}]"; }
aplicar() { rpcc "$1" "$2" "$3" "SELECT idx||':'||situacao FROM hub_lancamento_externo_aplicar('$4', '$(linha "$5" "$6" "$7")'::jsonb);"; }

# ============ 4.1 — C15 / C15.b: escopo ============
R="$(aplicar fin9001@example.com '[9001]' 9001 ADIANTAMENTO 90000000000005 2026-09-16 30.00)"
check "C15: escopo SEM a empresa 6 -> excecao FORA_DE_ESCOPO" "$(printf '%s' "$R" | grep -c 'FORA_DE_ESCOPO')" "1"
check "C15: zero linha em LancamentoExterno (CNPJ de entregador do proprio escopo 9001)" "$(n_lanc '')" "0"
R="$(aplicar fin@example.com '[6,9002]' 6 ADIANTAMENTO 90000000000004 2026-09-16 30.00)"
check "C15.b: escopo [6,9002] + CNPJ de entregador da 9002 -> CNPJ_SEM_MOTORISTA (e.id_empresa = 6)" "$R" "0:CNPJ_SEM_MOTORISTA"
check "C15.b: nada gravado para entregador alheio" "$(n_lanc "WHERE cnpj_prestador='90000000000004'")" "0"

# ============ 4.2 — resumo: gate pagamentos_consultar (dec-036) ============
R="$(rpc adm@example.com '[6]' 6 "SELECT qtd_deducao||'|'||total_deducao||'|'||qtd_credito||'|'||total_credito||'|'||flag_desconto_ligada FROM hub_lancamento_externo_resumo('2026-09-14');")"
check "resumo (a): papel com SO pagamentos_consultar VE o aviso (qtd/totais/flag)" "$R" "0|0.00|0|0.00|true"
R="$(rpc op@example.com '[6]' 6 "SELECT * FROM hub_lancamento_externo_resumo('2026-09-14');")"
check "resumo (b): papel SEM nenhuma das duas permissoes -> PERMISSAO_NEGADA" "$(printf '%s' "$R" | grep -c 'PERMISSAO_NEGADA')" "1"
R="$(aplicar adm@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-09-17 30.00)"
check "resumo (c): so pagamentos_consultar NAO consegue aplicar (escrita exige pagamento_confirmar)" "$(printf '%s' "$R" | grep -c 'PERMISSAO_NEGADA')" "1"
check "resumo (c): nada gravado" "$(n_lanc '')" "0"

R="$(rpc fin9001@example.com '[9001]' 9001 "SELECT qtd_deducao||'|'||total_deducao||'|'||qtd_credito||'|'||total_credito||'|'||flag_desconto_ligada FROM hub_lancamento_externo_resumo('2026-09-14');")"
check "P9/FR-034: resumo com escopo SEM a empresa 6 NAO levanta FORA_DE_ESCOPO (mesmo gate da previa), zero linhas e flag FALSE (nao vaza a config da 6, que e true)" "$R" "0|0.00|0|0.00|false"

# ============ 4.4 — C1: PRIMEIRA apuracao (zero ApuracaoRepasse) ============
check "C1 pre: zero ApuracaoRepasse" "$(psql_t -tAc 'SELECT count(*) FROM "ApuracaoRepasse"')" "0"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-09-17 30.00)"
check "C1: ADIANTAMENTO de R\$ 30,00 em 2026-09-17 aplicado" "$R" "0:APLICADA"
PREVIA_A="$(rpc fin@example.com '[6]' 6 "SELECT nome||'|'||remanescente||'|'||valor_pago FROM hub_adiantamento_repasse('2026-09-14') ORDER BY nome;")"
check "C2: previa antes de fechar (A deduzido; B sem lancamento intacto)" "$PREVIA_A" "$(printf 'Motorista Teste 01|70.00|70.00\nMotorista Teste 02|50.00|50.00')"
R="$(rpcc fin@example.com '[6]' 6 "SELECT motoristas||'|'||total FROM hub_adiantamento_repasse_fechar('2026-09-14');")"
check "C1: fechamento da PRIMEIRA apuracao nao levanta APURACAO_FORA_DE_ORDEM (2 motoristas, total 120.00)" "$R" "2|120.00"
item() { psql_t -tAc "SELECT i.valor_pago||'|'||i.saldo_anterior||'|'||i.lancamentos_externos||'|'||i.remanescente FROM \"ApuracaoRepasseItem\" i JOIN \"ApuracaoRepasse\" a ON a.id=i.apuracao_id JOIN \"Entregador\" e ON e.id=i.entregador_id JOIN \"ContaMotorista\" c ON c.id=e.motorista_id WHERE a.periodo_inicio='$1' AND c.cnpj_prestador='$2';"; }
check "C1: repasse de A = R\$ 70,00; saldo_anterior 0 (COALESCE); lancamentos_externos -30,00 (conserva)" "$(item 2026-09-14 90000000001001)" "70.00|0.00|-30.00|70.00"
check "C1: nenhum outro motorista afetado (B: 50,00 / 0 externos)" "$(item 2026-09-14 90000000000002)" "50.00|0.00|0.00|50.00"
check "C14: empresa/motorista sem lancamento inalterado (lancamentos_externos = 0)" "$(item 2026-09-14 90000000000002 | cut -d'|' -f3)" "0.00"
POS="$(psql_t -tAc "SELECT string_agg(e.nome||'|'||i.remanescente||'|'||i.valor_pago, E'\n' ORDER BY e.nome) FROM \"ApuracaoRepasseItem\" i JOIN \"Entregador\" e ON e.id=i.entregador_id")"
check "C2: previa == fechamento, zero centavo de diferenca" "$PREVIA_A" "$POS"

# P3: a 1a apuracao e 09-14; semana ANTERIOR (09-07) nunca poderia ser fechada (fechar exige max+7) -> recusa.
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-09-08 10.00)"
check "P3: semana anterior a PRIMEIRA apuracao -> SEMANA_ANTERIOR_A_APURACAO" "$R" "0:SEMANA_ANTERIOR_A_APURACAO"
check "P3: nada gravado (nao vira linha fantasma em tabela append-only)" "$(n_lanc "WHERE data_pagamento='2026-09-08'")" "0"

# ============ C3 / C3.b / C3.c — idempotencia ============
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-09-17 30.00)"
check "C3.c-bis (H5/FR-027): reenvio de linha JA aplicada, em semana JA FECHADA -> JA_APLICADO (idempotencia ANTES da janela; antes dava SEMANA_JA_FECHADA, igual a 'nunca aplicada')" "$R" "0:JA_APLICADO"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-09-17 99.00)"
check "C3.c-ter (H5): mesma chave, valor DIFERENTE, semana fechada -> VALOR_DIVERGENTE (o original e mantido)" "$R" "0:VALOR_DIVERGENTE"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000002 2026-09-17 30.00)"
check "C3.c-quater (H5): chave NUNCA aplicada em semana fechada -> SEMANA_JA_FECHADA (a janela segue valendo; so deixou de mascarar a idempotencia)" "$R" "0:SEMANA_JA_FECHADA"
check "C3.c: lancamento em semana JA FECHADA -> SEMANA_JA_FECHADA, nada gravado a mais" "$(n_lanc '')" "1"
# ALTO 2 (rodada 3): a DEDUCAO nao pode exceder o liquido da semana. O 02 tem credito de 4,00 em 09-23; o credito externo de 3,00
# vem PRIMEIRO (liquido 7,00), para a deducao de 7,00 do C3 caber. (A ordem importa e e testada abaixo, no ALTO 2.)
R="$(aplicar fin@example.com '[6]' 6 AJUSTE_CREDITO 90000000000002 2026-09-25 3.00)"; check "C7.c: AJUSTE_CREDITO aplicado (eleva o liquido do 02 de 4,00 para 7,00)" "$R" "0:APLICADA"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000002 2026-09-24 7.00)"; check "C3: 1a aplicacao (semana aberta 09-21)" "$R" "0:APLICADA"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000002 2026-09-24 7.00)"; check "C3: reenvio, mesmo valor -> JA_APLICADO" "$R" "0:JA_APLICADO"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000002 2026-09-24 99.00)"; check "C3.b: mesma chave, valor diferente -> VALOR_DIVERGENTE" "$R" "0:VALOR_DIVERGENTE"
check "C3.b: original preservado (7.00), uma unica linha de ADIANTAMENTO" "$(psql_t -tAc "SELECT valor||'|'||count(*) OVER () FROM \"LancamentoExterno\" WHERE cnpj_prestador='90000000000002' AND tipo='ADIANTAMENTO'")" "7.00|1"

# ============ C7 — credito entra ANTES do piso (R$ 4 + R$ 3 = R$ 7 recebe) ============
# Tres motoristas NOVOS na semana 2026-09-21 (piso de repasse = 5,50, default da config):
#   06: credito 4,00 + AJUSTE_CREDITO 3,00 = 7,00 >= piso  -> RECEBE 7,00 (o credito tira o motorista da retencao, FR-018)
#   07: credito 4,00 + AJUSTE_CREDITO 1,00 = 5,00 <  piso  -> retido: pago 0, transportado 5,00 (C7.b, FR-019)
#   08: credito 20,00 - ADIANTAMENTO 15,00 = 5,00 <  piso  -> retido com DEDUCAO: pago 0, transportado 5,00 (FR-019)
psql_t -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "FAIL: seed do C7"; exit 1; }
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90000000000006','Motorista Teste 06'),('90000000000007','Motorista Teste 07'),('90000000000008','Motorista Teste 08');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), c.nome, c.id FROM "ContaMotorista" c WHERE c.cnpj_prestador IN ('90000000000006','90000000000007','90000000000008');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador=v.cnpj),
       '2026-09-23', '2026-09-23', 'Credito', v.valor, 'Corrida', md5('c7'||v.cnpj)||md5(v.cnpj||'c7')
FROM (VALUES ('90000000000006',4.00),('90000000000007',4.00),('90000000000008',20.00)) AS v(cnpj,valor);
SQL
R="$(aplicar fin@example.com '[6]' 6 AJUSTE_CREDITO 90000000000006 2026-09-24 3.00)"; check "C7: credito do 06 aplicado" "$R" "0:APLICADA"
R="$(aplicar fin@example.com '[6]' 6 AJUSTE_CREDITO 90000000000007 2026-09-24 1.00)"; check "C7.b: credito do 07 aplicado" "$R" "0:APLICADA"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000008 2026-09-24 15.00)"; check "FR-019: adiantamento externo do 08 aplicado" "$R" "0:APLICADA"
PV="$(rpc fin@example.com '[6]' 6 "SELECT nome||'|'||valor_pago::numeric(12,2)||'|'||valor_transportado::numeric(12,2)||'|'||retido FROM hub_adiantamento_repasse('2026-09-21') WHERE nome IN ('Motorista Teste 06','Motorista Teste 07','Motorista Teste 08') ORDER BY nome;")"
check "C7/C7.b/FR-019 na PREVIA: 06 recebe 7,00; 07 e 08 retidos com 5,00 transportado" "$PV" "$(printf 'Motorista Teste 06|7.00|0.00|false\nMotorista Teste 07|0.00|5.00|true\nMotorista Teste 08|0.00|5.00|true')"
R="$(rpcc fin@example.com '[6]' 6 "SELECT motoristas FROM hub_adiantamento_repasse_fechar('2026-09-21');")"
# B: credito 4,00 (faturamento) - 7,00 (adiantamento externo) + 3,00 (credito externo) = 0,00. Antes da rodada 3 este cenario
# deduzia 10,00 de um liquido de 7,00 e o remanescente ficava NEGATIVO (-3,00): o excedente de 3,00 sumia. Agora a linha seria recusada.
check "C7.c: B = 4,00 - 7,00 + 3,00 = 0,00 -> nada pago, nada transportado; a conta fecha com externos liquidos de -4,00" "$(item 2026-09-21 90000000000002)" "0.00|0.00|-4.00|0.00"
itemt() { psql_t -tAc "SELECT i.valor_pago||'|'||i.valor_transportado||'|'||i.lancamentos_externos||'|'||i.remanescente||'|'||(i.remanescente + i.saldo_anterior = i.valor_pago + i.valor_transportado) FROM \"ApuracaoRepasseItem\" i JOIN \"ApuracaoRepasse\" a ON a.id=i.apuracao_id JOIN \"Entregador\" e ON e.id=i.entregador_id JOIN \"ContaMotorista\" c ON c.id=e.motorista_id WHERE a.periodo_inicio='$1' AND c.cnpj_prestador='$2';"; }
check "C7 (FECHAMENTO): 06 = 4,00 + 3,00 = 7,00 >= piso 5,50 -> RECEBE 7,00 (conservacao ok)" "$(itemt 2026-09-21 90000000000006)" "7.00|0.00|3.00|7.00|true"
check "C7.b (FECHAMENTO): 07 = 5,00 < piso -> pago 0, transportado 5,00 (conservacao ok)" "$(itemt 2026-09-21 90000000000007)" "0.00|5.00|1.00|5.00|true"
check "FR-019 (FECHAMENTO): 08 = 20,00 - 15,00 = 5,00 < piso -> pago 0, transportado 5,00 (conservacao ok)" "$(itemt 2026-09-21 90000000000008)" "0.00|5.00|-15.00|5.00|true"

# ============ C18 — a MESMA decomposicao em TODAS as superficies (prévia x fechamento x congelado x app) ============
# A parcela "pago por fora" tem de aparecer igual onde quer que a decomposicao seja exibida e SOMAR
# (creditos - adiantamentos - debitos + lancamentos_externos = remanescente). Defeito da ocorrencia 4 (funcao
# do motorista esquecida), agora com 5 superficies. Tupla: cred|adiant|deb|lanc_ext|rem|saldo_ant|pago|transp|retido|soma-fecha.
TUP="creditos::numeric(12,2)||'|'||adiantamentos::numeric(12,2)||'|'||debitos::numeric(12,2)||'|'||lancamentos_externos::numeric(12,2)||'|'||remanescente::numeric(12,2)||'|'||saldo_anterior::numeric(12,2)||'|'||valor_pago::numeric(12,2)||'|'||valor_transportado::numeric(12,2)||'|'||retido||'|'||(creditos - adiantamentos - debitos + lancamentos_externos = remanescente)"
tup_previa()    { rpc fin@example.com '[6]' 6 "SELECT $TUP FROM hub_adiantamento_repasse('$1') WHERE nome='$2';"; }
tup_congelado() { rpc fin@example.com '[6]' 6 "SELECT $TUP FROM hub_adiantamento_repasse_congelado('$1') WHERE nome='$2';"; }
tup_item() { psql_t -tAc "SELECT $TUP FROM (SELECT i.creditos, i.adiantamentos, i.debitos, i.lancamentos_externos, i.remanescente, i.saldo_anterior, i.valor_pago, i.valor_transportado, (i.remanescente >= 0 AND i.valor_pago = 0 AND i.valor_transportado > 0) AS retido FROM \"ApuracaoRepasseItem\" i JOIN \"ApuracaoRepasse\" a ON a.id=i.apuracao_id JOIN \"Entregador\" e ON e.id=i.entregador_id WHERE a.periodo_inicio='$1' AND e.nome='$2') q;"; }
appq() { # appq <cnpj> <sql> -> roda a SQL como o motorista (claim motorista_cnpj), saida filtrada
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub','1','motorista_cnpj','$1')::text, true);
SET ROLE authenticated;
$2
ROLLBACK;
SQL
}
tup_app_fechado() { appq "$1" "SELECT $TUP FROM hub_adiantamento_repasse_motorista_ultimo_fechado();"; }

# ============ C9 — flag desligada: deducao nao entra, credito entra, aviso FR-049 ============
# P20: sem `|| fail`, uma falha do seed aparecia depois como erro de aritmetica no check.
psql_t -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "FAIL: seed do C9"; exit 1; }
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, desconto_adiantamentos, repasse_visivel_app)
VALUES (6, 91, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 1, 2, 'data_lancamento', ARRAY['Corrida'], false, true);
SQL
aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000003 2026-09-30 20.00 >/dev/null
aplicar fin@example.com '[6]' 6 AJUSTE_CREDITO 90000000000003 2026-10-01 5.00 >/dev/null
R="$(rpc adm@example.com '[6]' 6 "SELECT qtd_deducao||'|'||total_deducao||'|'||flag_desconto_ligada FROM hub_lancamento_externo_resumo('2026-09-28');")"
check "C9/FR-049: flag desligada + 1 deducao -> resumo avisa (qtd 1, 20.00, flag f)" "$R" "1|20.00|false"
P03="$(tup_previa 2026-09-28 'Motorista Teste 03')"; P07="$(tup_previa 2026-09-28 'Motorista Teste 07')"
rpcc fin@example.com '[6]' 6 "SELECT motoristas FROM hub_adiantamento_repasse_fechar('2026-09-28');" >/dev/null
# 03: credito 80,00 + externo +5,00 (a DEDUCAO de 20,00 e barrada pela flag) = 85,00. 07: sem atividade, saldo 5,00 carregado, retido.
check "C18a: motorista 03 (credito externo +5,00) - PREVIA ja fecha a conta" "$P03" "80.00|0.00|0.00|5.00|85.00|0.00|85.00|0.00|false|true"
check "C18a: motorista 03 - FECHAMENTO (item congelado) == previa" "$(tup_item 2026-09-28 'Motorista Teste 03')" "$P03"
check "C18a: motorista 03 - CONGELADO (hub, semana fechada) == previa" "$(tup_congelado 2026-09-28 'Motorista Teste 03')" "$P03"
check "C18a: motorista 03 - APP (ultimo fechado) == previa" "$(tup_app_fechado 90000000000003)" "$P03"
check "C18a: motorista 07 (saldo_anterior 5,00 + retido) - PREVIA" "$P07" "0.00|0.00|0.00|0.00|0.00|5.00|0.00|5.00|true|true"
check "C18a: motorista 07 - FECHAMENTO == previa (saldo_anterior e retido incluidos)" "$(tup_item 2026-09-28 'Motorista Teste 07')" "$P07"
check "C18a: motorista 07 - CONGELADO == previa" "$(tup_congelado 2026-09-28 'Motorista Teste 07')" "$P07"
check "C18a: motorista 07 - APP (ultimo fechado) == previa" "$(tup_app_fechado 90000000000007)" "$P07"
check "C9: deducao NAO entra (flag off), credito entra: 80,00 + 5,00 = 85,00; externos = +5,00" "$(item 2026-09-28 90000000000003)" "85.00|0.00|5.00|85.00"

# ============ C8 — TRES fontes somam, nenhuma substitui nem conta duas vezes (FR-016) ============
# Semana 2026-10-05, motorista 01: credito 100,00 (faturamento) - 20,00 (adiantamento do APP, PAGA)
# - 10,00 (debito de faturamento) - 15,00 (externo) = 55,00. Flags ligadas (versao 92).
psql_t -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, desconto_adiantamentos, desconto_debitos)
VALUES (6, 92, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 1, 2, 'data_lancamento', ARRAY['Corrida'], true, true);
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000001001'),
       v.dia::date, v.dia::date, v.tipo, v.valor, v.descr, md5('c8'||v.dia||v.tipo)||md5(v.tipo||v.dia||'c8')
FROM (VALUES ('2026-10-06','Credito',100.00,'Corrida'),('2026-10-07','Debito',-10.00,'Multa'),
             ('2026-10-14','Credito',1.00,'Corrida')) AS v(dia,tipo,valor,descr);
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
SELECT 6, e.id, 'CARGA_INICIAL', 'APROVADA', 'Motorista Teste 01', '00000000000', 'PF', '001', 'Banco Teste', '0001', '0000001', '0', 'CORRENTE', e.id, now()
FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000001001';
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_bruto, valor_liquido, conta_bancaria_id)
SELECT 6, c.id, c.cnpj_prestador, e.id, (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 AND versao=92),
       '2026-10-08', '2026-10-07', repeat('a',64), 'PAGA', gen_random_uuid(), 20.00, 20.00,
       (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=e.id)
FROM "ContaMotorista" c JOIN "Entregador" e ON e.motorista_id=c.id WHERE c.cnpj_prestador='90000000001001';
SQL
[ $? -eq 0 ] || { echo "FAIL: seed do C8 (erro de SQL acima)"; exit 1; }
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-10-08 15.00)"; check "C8: externo aplicado (3a fonte)" "$R" "0:APLICADA"
PREVIA_C8="$(rpc fin@example.com '[6]' 6 "SELECT nome||'|'||remanescente||'|'||valor_pago FROM hub_adiantamento_repasse('2026-10-05') WHERE nome = 'Motorista Teste 01';")"
check "C8: previa = 100 - 20 (app) - 10 (debito) - 15 (externo) = 55,00" "$PREVIA_C8" "Motorista Teste 01|55.00|55.00"
rpcc fin@example.com '[6]' 6 "SELECT motoristas FROM hub_adiantamento_repasse_fechar('2026-10-05');" >/dev/null
check "C8: fechamento = 55,00 (adiantamentos 20 / debitos 10 / externos -15; nenhuma fonte contada 2x)" \
  "$(psql_t -tAc "SELECT i.valor_pago||'|'||i.adiantamentos||'|'||i.debitos||'|'||i.lancamentos_externos FROM \"ApuracaoRepasseItem\" i JOIN \"ApuracaoRepasse\" a ON a.id=i.apuracao_id JOIN \"Entregador\" e ON e.id=i.entregador_id JOIN \"ContaMotorista\" c ON c.id=e.motorista_id WHERE a.periodo_inicio='2026-10-05' AND c.cnpj_prestador='90000000001001'")" \
  "55.00|20.00|10.00|-15.00"

# ============ C10 (no SQL) — erro de ARQUIVO: tipo invalido aborta sem gravar nada ============
ANTES="$(n_lanc '')"
R="$(aplicar fin@example.com '[6]' 6 QUALQUER_COISA 90000000001001 2026-10-15 9.00)"
check "C10/SQL: tipo fora do dominio -> TIPO_INVALIDO" "$(printf '%s' "$R" | grep -c 'TIPO_INVALIDO')" "1"
check "C10/SQL: nada gravado" "$(n_lanc '')" "$ANTES"

# C10/SQL (defesa em profundidade, dec-026): a RPC e chamavel direto pelo PostgREST; as faixas valem no banco tambem,
# como RECUSA DE LINHA (nunca excecao que aborte o lote).
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2099-01-01 9.00)"; check "C10/SQL: data no futuro -> DATA_FORA_DA_FAIXA" "$R" "0:DATA_FORA_DA_FAIXA"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2023-12-31 9.00)"; check "C10/SQL: data anterior a 2024-01-01 -> DATA_FORA_DA_FAIXA" "$R" "0:DATA_FORA_DA_FAIXA"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-10-15 5000.01)"; check "C10/SQL: valor acima do teto -> VALOR_ACIMA_DO_TETO" "$R" "0:VALOR_ACIMA_DO_TETO"
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-10-15 0.00)"; check "C10/SQL: valor zero -> VALOR_INVALIDO" "$R" "0:VALOR_INVALIDO"
OBS="$(printf 'x%.0s' $(seq 1 501))"
R="$(rpcc fin@example.com '[6]' 6 "SELECT idx||':'||situacao FROM hub_lancamento_externo_aplicar('ADIANTAMENTO', '[{\"i\":0,\"cnpj\":\"90000000001001\",\"data\":\"2026-10-15\",\"valor\":\"9.00\",\"obs\":\"$OBS\"}]'::jsonb);")"
check "C10/SQL: observacao com 501 caracteres -> OBSERVACAO_MUITO_LONGA (recusa de linha, sem excecao)" "$R" "0:OBSERVACAO_MUITO_LONGA"
 # P8: cast de data/valor ANTES da recusa abortava o LOTE; agora cada linha ruim e recusada e o lote segue.
R="$(rpcc fin@example.com '[6]' 6 "SELECT idx||':'||situacao FROM hub_lancamento_externo_aplicar('ADIANTAMENTO', '[{\"i\":0,\"cnpj\":\"90000000001001\",\"data\":\"2026-13-45\",\"valor\":\"9.00\"},{\"i\":1,\"cnpj\":\"90000000001001\",\"data\":\"2026-10-15\",\"valor\":\"abc\"},{\"i\":2,\"cnpj\":\"90000000001001\",\"data\":\"2026-10-15\",\"valor\":\"1e20\"},{\"i\":3,\"cnpj\":\"90000000001001\",\"data\":\"2026-10-15\",\"valor\":\"9.005\"}]'::jsonb);")"
check "P8: data/valor ilegiveis e fracao de centavo -> recusa POR LINHA, o lote nao aborta" "$R" "$(printf '0:DATA_INVALIDA\n1:VALOR_INVALIDO\n2:VALOR_ACIMA_DO_TETO\n3:VALOR_FRACAO_DE_CENTAVO')"
check "C10/SQL: nenhuma das recusas gravou" "$(n_lanc "WHERE data_pagamento IN ('2099-01-01','2023-12-31','2026-10-15')")" "0"

# ============ C11 — concorrencia com o fechamento (FR-041) ============
# Sessao 1 fecha a semana 2026-10-12 e SEGURA a transacao 6 s; a sessao 2 tenta aplicar nessa semana.
# EXCLUSAO (rodada 3): a sessao 3 tenta EXCLUIR um lancamento dessa mesma semana (ainda aberta ao pedir) — mesma trava.
excluir() { rpcc "$1" "$2" "$3" "SELECT lancamento_id||':'||tipo_excluido||':'||valor_excluido||':'||data_excluida FROM hub_lancamento_externo_excluir($4);"; }
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-10-14 1.00)"; check "C11 pre: deducao de 1,00 (liquido da semana 10-12 = credito de 1,00) aplicada" "$R" "0:APLICADA"
ID_C11="$(psql_t -tAc "SELECT id FROM \"LancamentoExterno\" WHERE cnpj_prestador='90000000001001' AND data_pagamento='2026-10-14'")"
( psql_relaxed -tA >"$TMP/c11-s1.log" 2>&1 <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='fin@example.com'),'empresa_ativa','6','escopo','[6]'::jsonb)::text, true);
SET ROLE authenticated;
SELECT 'fechou:'||motoristas FROM hub_adiantamento_repasse_fechar('2026-10-12');
SELECT pg_sleep(6);
COMMIT;
SQL
) &
S1=$!
sleep 2
( T1=$(date +%s); excluir fin@example.com '[6]' 6 "$ID_C11" >"$TMP/c11-excl.log" 2>&1; echo $(( $(date +%s) - T1 )) >"$TMP/c11-excl.t" ) &
S3=$!
T0=$(date +%s)
R="$(aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 2026-10-15 9.00)"
ESPERA=$(( $(date +%s) - T0 ))
wait $S1
check "C11: sessao 1 conseguiu fechar a semana" "$(grep -c 'fechou:' "$TMP/c11-s1.log")" "1"
check "C11: a aplicacao ESPEROU a trava (>= 3 s de bloqueio)" "$([ "$ESPERA" -ge 3 ] && echo sim || echo "nao($ESPERA s)")" "sim"
check "C11: ao obter a trava com a semana fechada -> SEMANA_JA_FECHADA" "$R" "0:SEMANA_JA_FECHADA"
check "C11: nada gravado na semana fechada" "$(n_lanc "WHERE data_pagamento='2026-10-15'")" "0"
wait $S3
check "C11/EXCLUSAO: a exclusao tambem ESPEROU a trava do fechamento (>= 2 s)" "$([ "$(cat "$TMP/c11-excl.t")" -ge 2 ] && echo sim || echo "nao($(cat "$TMP/c11-excl.t") s)")" "sim"
check "C11/EXCLUSAO: ao obter a trava com a semana ja fechada -> SEMANA_JA_FECHADA" "$(grep -c 'SEMANA_JA_FECHADA' "$TMP/c11-excl.log")" "1"
check "C11/EXCLUSAO: o lancamento da semana fechada NAO foi apagado (congelado e tabela seguem iguais)" "$(n_lanc "WHERE id=$ID_C11")|$(psql_t -tAc "SELECT i.lancamentos_externos FROM \"ApuracaoRepasseItem\" i JOIN \"ApuracaoRepasse\" a ON a.id=i.apuracao_id JOIN \"Entregador\" e ON e.id=i.entregador_id JOIN \"ContaMotorista\" c ON c.id=e.motorista_id WHERE a.periodo_inicio='2026-10-12' AND c.cnpj_prestador='90000000001001'")" "1|-1.00"

# ============ C16 — a TERCEIRA funcao viva: o APP do motorista (hub_adiantamento_repasse_motorista) ============
# FR-022 nomeia tres pontos (previa, fechamento, detalhe por motorista). Sem este, o motorista veria um
# remanescente e receberia outro. Semana EM CURSO = a de hoje (SP); credito de hoje + externo de hoje.
HOJE="$(psql_t -tAc "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: seed do C16"; exit 1; }
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
VALUES (6, 93, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 1, 2, 'data_lancamento', ARRAY['Corrida'], true, true, true);
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador=v.cnpj),
       '$HOJE'::date, '$HOJE'::date, 'Credito', v.valor, 'Corrida', md5('c16'||v.cnpj)||md5(v.cnpj||'c16')
FROM (VALUES ('90000000001001',50.00),('90000000000002',20.00)) AS v(cnpj,valor);
SQL
aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000001001 "$HOJE" 15.00 >/dev/null
aplicar fin@example.com '[6]' 6 ADIANTAMENTO 90000000000002 "$HOJE" 15.00 >/dev/null
app() { # app <cnpj> -> remanescente|negativo|abaixo_do_minimo|visivel (funcao do app, claim motorista_cnpj)
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub','1','motorista_cnpj','$1')::text, true);
SET ROLE authenticated;
SELECT remanescente||'|'||negativo||'|'||abaixo_do_minimo||'|'||visivel FROM hub_adiantamento_repasse_motorista();
ROLLBACK;
SQL
}
check "C16: APP do motorista 01 = 50,00 - 15,00 externo = 35,00 (nao 50,00)" "$(app 90000000001001 | cut -d'|' -f1)" "35.00"
check "C16: APP do motorista 02 = 20,00 - 15,00 = 5,00 < piso 5,50 -> abaixo_do_minimo = true" "$(app 90000000000002)" "5.00|false|true|true"

# W1 (rodada 1 do code review): a PREVIA deduzia so PAGA; o fechamento e o app deduzem PAGA + EXPORTADA. A fixture
# anterior NAO tinha nenhuma EXPORTADA, entao C18b so provava a AUSENCIA do caso. Agora o motorista 01 tem uma
# solicitacao EXPORTADA (5,00, ainda nao paga) na semana em curso — o teste tem de provar a igualdade COM ela.
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: seed da EXPORTADA (W1)"; exit 1; }
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_bruto, valor_liquido, conta_bancaria_id)
SELECT 6, c.id, c.cnpj_prestador, e.id, (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 AND versao=93),
       '$HOJE'::date + 1, '$HOJE'::date, repeat('b',64), 'EXPORTADA', gen_random_uuid(), 5.00, 5.00,
       (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=e.id)
FROM "ContaMotorista" c JOIN "Entregador" e ON e.motorista_id=c.id WHERE c.cnpj_prestador='90000000001001';
SQL

# C18b — semana EM CURSO: previa (hub) x funcao do APP, mesma decomposicao (com saldo_anterior e retido/abaixo_do_minimo)
SEM_HOJE="$(psql_t -tAc "SELECT '$HOJE'::date - ((extract(dow FROM '$HOJE'::date)::int - 1 + 7) % 7)")"
TUP_APP="creditos::numeric(12,2)||'|'||(SELECT COALESCE(sum((x->>'valorBruto')::numeric),0) FROM jsonb_array_elements(adiantamentos) x)::numeric(12,2)||'|'||debitos::numeric(12,2)||'|'||lancamentos_externos::numeric(12,2)||'|'||remanescente::numeric(12,2)||'|'||saldo_anterior::numeric(12,2)||'|'||abaixo_do_minimo"
TUP_PRV="creditos::numeric(12,2)||'|'||adiantamentos::numeric(12,2)||'|'||debitos::numeric(12,2)||'|'||lancamentos_externos::numeric(12,2)||'|'||remanescente::numeric(12,2)||'|'||saldo_anterior::numeric(12,2)||'|'||retido"
for N in 01 02; do
  PV="$(rpc fin@example.com '[6]' 6 "SELECT $TUP_PRV FROM hub_adiantamento_repasse('$SEM_HOJE') WHERE nome='Motorista Teste $N';")"
  CN="900000000000$N"; [ "$N" = 01 ] && CN=90000000001001   # 01 = cnpjSintetico(1), DV invalido
  AP="$(appq $CN "SELECT $TUP_APP FROM hub_adiantamento_repasse_motorista();")"
  check "C18b: motorista $N - PREVIA == APP na semana em curso (incl. saldo_anterior e retido)" "$AP" "$PV"
  check "C18b: motorista $N - lancamentos_externos = -15,00 nas duas superficies" "$(printf '%s\n%s' "$PV" "$AP" | cut -d'|' -f4 | sort -u)" "-15.00"
done
PV01="$(rpc fin@example.com '[6]' 6 "SELECT adiantamentos::numeric(12,2)||'|'||remanescente::numeric(12,2)||'|'||em_processamento FROM hub_adiantamento_repasse('$SEM_HOJE') WHERE nome='Motorista Teste 01';")"
check "W1: PREVIA deduz a EXPORTADA (5,00): remanescente 50 - 5 - 15 = 30,00, em_processamento preservado" "$PV01" "5.00|30.00|true"
check "W1: APP do motorista 01 == 30,00 (ja deduzia as duas)" "$(app 90000000001001 | cut -d'|' -f1)" "30.00"


# ============ ALTO 2 (rodada 3) — a DEDUCAO que excede o liquido e RECUSADA (decisao do operador) ============
# Antes: remanescente negativo => valor_pago 0 e o negativo NAO transporta; com credito 30 e ADIANTAMENTO 100, a reducao real
# era 30 e os 70 SUMIAM numa tabela append-only. SC-001 ("reduzido em EXATAMENTE esse valor") exige recusar a linha.
# Semana em curso (config v93, inicio na SEGUNDA). Motoristas NOVOS 10..14, cada um com credito de faturamento de 30,00.
D2="$(psql_t -tAc "SELECT '$SEM_HOJE'::date + 1")"
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: seed do ALTO 2"; exit 1; }
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90000000000010','Motorista Teste 10'),('90000000000011','Motorista Teste 11'),
  ('90000000000012','Motorista Teste 12'),('90000000000013','Motorista Teste 13'),('90000000000014','Motorista Teste 14');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), c.nome, c.id FROM "ContaMotorista" c WHERE c.cnpj_prestador BETWEEN '90000000000010' AND '90000000000014';
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador=v.cnpj),
       '$SEM_HOJE'::date, '$SEM_HOJE'::date, v.tipo, v.valor, v.descr, md5('a2'||v.cnpj||v.tipo)||md5(v.tipo||v.cnpj||'a2')
FROM (VALUES ('90000000000010','Credito',30.00,'Corrida'),('90000000000011','Credito',30.00,'Corrida'),
             ('90000000000012','Credito',30.00,'Corrida'),('90000000000013','Credito',30.00,'Corrida'),
             ('90000000000013','Debito',-12.00,'Multa'),('90000000000014','Credito',30.00,'Corrida')) AS v(cnpj,tipo,valor,descr);
SQL
prev_rem() { rpc fin@example.com '[6]' 6 "SELECT remanescente FROM hub_adiantamento_repasse('$SEM_HOJE') WHERE nome='Motorista Teste $1';"; }
# aplicarl <email> <escopo> <empresa> <tipo> <json-de-linhas> -> "idx:situacao:liquido" por linha
aplicarl() { rpcc "$1" "$2" "$3" "SELECT idx||':'||situacao||':'||COALESCE(liquido::text,'') FROM hub_lancamento_externo_aplicar('$4', '$5'::jsonb);"; }
lj() { echo "{\"i\":$1,\"cnpj\":\"$2\",\"data\":\"$3\",\"valor\":\"$4\",\"obs\":null}"; }
FIN=fin@example.com

# --- motorista 10: liquido 30,00 ---
check "ALTO 2 pre: prévia do 10 = 30,00" "$(prev_rem 10)" "30.00"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000010 "$SEM_HOJE" 100.00)]")"
check "ALTO 2: ADIANTAMENTO 100,00 com liquido 30,00 -> VALOR_EXCEDE_LIQUIDO, e a RPC NOMEIA o liquido (30.00)" "$R" "0:VALOR_EXCEDE_LIQUIDO:30.00"
check "ALTO 2: a linha recusada NAO gravou nada" "$(n_lanc "WHERE cnpj_prestador='90000000000010'")" "0"
check "ALTO 2: a previa segue em 30,00 (nada some do repasse)" "$(prev_rem 10)" "30.00"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000010 "$SEM_HOJE" 30.00)]")"
check "ALTO 2: deducao IGUAL ao liquido (30,00) cabe -> APLICADA" "$R" "0:APLICADA:"
check "ALTO 2/SC-001: o repasse foi reduzido em EXATAMENTE 30,00 (30,00 -> 0,00), zero centavo de diferenca" "$(prev_rem 10)" "0.00"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000010 "$D2" 0.01)]")"
check "ALTO 2: com liquido ZERO, ate 0,01 e recusado e o liquido nomeado e 0.00 (nunca negativo)" "$R" "0:VALOR_EXCEDE_LIQUIDO:0.00"

# --- motorista 11: ORDEM DENTRO DO ARQUIVO — a 2a linha ve o liquido ja descontado da 1a ---
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000011 "$SEM_HOJE" 20.00),$(lj 1 90000000000011 "$D2" 20.00)]")"
check "ALTO 2 (ordem): no MESMO arquivo, 1a deducao (20,00) cabe e a 2a (20,00) ja nao: liquido restante 10.00" "$R" "$(printf '0:APLICADA:\n1:VALOR_EXCEDE_LIQUIDO:10.00')"
check "ALTO 2 (ordem): so a 1a foi gravada; previa do 11 = 30,00 - 20,00 = 10,00" "$(n_lanc "WHERE cnpj_prestador='90000000000011'")|$(prev_rem 11)" "1|10.00"

# --- motorista 12: um AJUSTE_CREDITO importado ANTES eleva o liquido; credito nunca e recusado ---
R="$(aplicarl $FIN '[6]' 6 AJUSTE_CREDITO "[$(lj 0 90000000000012 "$SEM_HOJE" 20.00)]")"; check "ALTO 2: credito externo de 20,00 aplicado (liquido do 12: 30 -> 50)" "$R" "0:APLICADA:"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000012 "$SEM_HOJE" 45.00)]")"; check "ALTO 2 (ordem): deducao de 45,00 CABE porque o credito veio antes (liquido 50,00)" "$R" "0:APLICADA:"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000012 "$D2" 5.01)]")"; check "ALTO 2: sobram 5,00; 5,01 -> recusa nomeando 5.00" "$R" "0:VALOR_EXCEDE_LIQUIDO:5.00"
R="$(aplicarl $FIN '[6]' 6 AJUSTE_CREDITO "[$(lj 0 90000000000012 "$D2" 1000.00)]")"; check "ALTO 2: CREDITO nunca e recusado por exceder liquido" "$R" "0:APLICADA:"
check "ALTO 2: previa do 12 = 30 + 20 - 45 + 1000 = 1005,00" "$(prev_rem 12)" "1005.00"

# --- motorista 13: o liquido considera os DEBITOS de faturamento (30 - 12 = 18) ---
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000013 "$SEM_HOJE" 18.01)]")"; check "ALTO 2: liquido = credito 30 - debito 12 = 18; 18,01 -> recusa nomeando 18.00" "$R" "0:VALOR_EXCEDE_LIQUIDO:18.00"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000013 "$SEM_HOJE" 18.00)]")"; check "ALTO 2: 18,00 cabe" "$R" "0:APLICADA:"

# --- PARIDADE: o liquido da RPC == o remanescente da PREVIA (a conta e uma COPIA; so este check impede a deriva) ---
NOMES="'Motorista Teste 01','Motorista Teste 02','Motorista Teste 10','Motorista Teste 11','Motorista Teste 12','Motorista Teste 13'"
LIQ="$(psql_t -tAc "SELECT string_agg(e.nome||'|'||hub_lancamento_externo_liquido(e.id, '$SEM_HOJE'::date, (SELECT c FROM hub_adiantamento_config_vigente(6) c))::numeric(12,2), E'\n' ORDER BY e.nome) FROM \"Entregador\" e WHERE e.nome IN ($NOMES)")"
PRV="$(rpc $FIN '[6]' 6 "SELECT nome||'|'||remanescente::numeric(12,2) FROM hub_adiantamento_repasse('$SEM_HOJE') WHERE nome IN ($NOMES) ORDER BY nome;")"
check "ALTO 2/paridade: liquido (helper) == remanescente da previa para 01 (PAGA+EXPORTADA+externo), 02, 10, 11, 12, 13" "$LIQ" "$PRV"

# --- permissoes / escopo seguem valendo com a recusa nova ---
R="$(aplicarl adm@example.com '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000014 "$SEM_HOJE" 100.00)]")"
check "ALTO 2: a recusa por liquido NAO substitui o gate de permissao (so consulta -> PERMISSAO_NEGADA)" "$(printf '%s' "$R" | grep -c 'PERMISSAO_NEGADA')" "1"

# ============ EXCLUSAO + LISTAGEM (autorizadas pelo operador em 2026-10-23) ============
excluir() { rpcc "$1" "$2" "$3" "SELECT lancamento_id||':'||tipo_excluido||':'||valor_excluido||':'||data_excluida FROM hub_lancamento_externo_excluir($4);"; }
lid() { psql_t -tAc "SELECT id FROM \"LancamentoExterno\" WHERE cnpj_prestador='$1' AND data_pagamento='$2' AND tipo='$3'"; }
n_excl() { psql_t -tAc "SELECT count(*) FROM \"LancamentoExternoExclusao\" $1;"; }

# --- listagem ---
N_SEM="$(n_lanc "WHERE data_pagamento BETWEEN '$SEM_HOJE' AND '$SEM_HOJE'::date + 6")"
R="$(rpc $FIN '[6]' 6 "SELECT count(*)||'|'||min(total)||'|'||bool_and(excluivel) FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 0, 200);")"
check "LISTAGEM: mostra TODOS os lancamentos da semana ($N_SEM), com total e excluivel=true para quem pode excluir (semana aberta)" "$R" "$N_SEM|$N_SEM|true"
R="$(rpc $FIN '[6]' 6 "SELECT string_agg(entregador_nome||'|'||tipo||'|'||valor, ';' ORDER BY id) FROM hub_lancamento_externo_listar('$SEM_HOJE', 'teste 11', 0, 50);")"
check "LISTAGEM: busca por nome (sem acento/caixa) filtra e traz nome, tipo e valor" "$R" "Motorista Teste 11|ADIANTAMENTO|20.00"
# Paginacao: as paginas (0,2) e (2,2) nao se sobrepoem, cada uma tem 1..2 itens e fora de faixa vem VAZIA.
# Pre-condicao explicita (nao herdada das secoes anteriores): ha pelo menos 3 lancamentos na semana.
check "LISTAGEM (paginacao): pre-condicao — a semana tem >= 3 lancamentos" "$([ "$N_SEM" -ge 3 ] && echo sim || echo nao)" "sim"
R="$(rpc $FIN '[6]' 6 "SELECT (SELECT count(*) FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 0, 2) a) BETWEEN 1 AND 2 AND (SELECT count(*) FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 2, 2) b) BETWEEN 1 AND 2 AND NOT EXISTS (SELECT 1 FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 0, 2) a JOIN hub_lancamento_externo_listar('$SEM_HOJE', NULL, 2, 2) b USING (id)) AND (SELECT count(*) FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 100000, 2) c) = 0;")"
check "LISTAGEM: paginacao — paginas (0,2) e (2,2) nao se sobrepoem, cada uma tem 1..2 itens, e fora de faixa vem vazia" "$R" "t"
R="$(rpc adm@example.com '[6]' 6 "SELECT count(*)||'|'||bool_or(excluivel)||'|'||bool_or(semana_fechada) FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 0, 200);")"
check "LISTAGEM: papel SO de consulta ve a lista, excluivel=false MAS semana_fechada=false (M3: sem permissao != semana fechada)" "$R" "$N_SEM|false|false"
R="$(rpc fin9001@example.com '[9001]' 9001 "SELECT count(*) FROM hub_lancamento_externo_listar('$SEM_HOJE', NULL, 0, 200);")"
check "LISTAGEM: escopo SEM a empresa 6 nao ve nada (nem de outra empresa)" "$R" "0"
R="$(rpc op@example.com '[6]' 6 "SELECT * FROM hub_lancamento_externo_listar('$SEM_HOJE');")"
check "LISTAGEM: papel sem pagamentos_consultar -> PERMISSAO_NEGADA" "$(printf '%s' "$R" | grep -c 'PERMISSAO_NEGADA')" "1"
R="$(rpc $FIN '[6]' 6 "SELECT count(*)||'|'||bool_or(excluivel)||'|'||bool_and(semana_fechada) FROM hub_lancamento_externo_listar('2026-09-14');")"
check "LISTAGEM: semana FECHADA (09-14) aparece, excluivel=false e semana_fechada=true" "$R" "1|false|true"

# --- 🔴 semana FECHADA: fail-closed ---
ID_FECH="$(lid 90000000001001 2026-09-17 ADIANTAMENTO)"
ANTES_ITEM="$(item 2026-09-14 90000000001001)"
R="$(excluir $FIN '[6]' 6 "$ID_FECH")"
check "EXCLUSAO (fail-closed): lancamento de semana FECHADA -> SEMANA_JA_FECHADA" "$(printf '%s' "$R" | grep -c 'SEMANA_JA_FECHADA')" "1"
check "EXCLUSAO (fail-closed): o lancamento SEGUE la" "$(n_lanc "WHERE id=$ID_FECH")" "1"
check "EXCLUSAO (fail-closed): o congelado e a tabela continuam IGUAIS (nenhuma divergencia)" "$(item 2026-09-14 90000000001001)|$(psql_t -tAc "SELECT -valor FROM \"LancamentoExterno\" WHERE id=$ID_FECH")" "$ANTES_ITEM|-30.00"
check "EXCLUSAO (fail-closed): nenhum rastro de exclusao gravado" "$(n_excl '')" "0"

# --- permissao / escopo / inexistente ---
ID_11="$(lid 90000000000011 "$SEM_HOJE" ADIANTAMENTO)"
R="$(excluir adm@example.com '[6]' 6 "$ID_11")"; check "EXCLUSAO: papel SO de consulta -> PERMISSAO_NEGADA" "$(printf '%s' "$R" | grep -c 'PERMISSAO_NEGADA')" "1"
R="$(excluir fin9001@example.com '[9001]' 9001 "$ID_11")"; check "EXCLUSAO: escopo sem a empresa 6 -> FORA_DE_ESCOPO (mesmo com a permissao)" "$(printf '%s' "$R" | grep -c 'FORA_DE_ESCOPO')" "1"
R="$(excluir $FIN '[6]' 6 999999999)"; check "EXCLUSAO: id inexistente -> LANCAMENTO_NAO_ENCONTRADO" "$(printf '%s' "$R" | grep -c 'LANCAMENTO_NAO_ENCONTRADO')" "1"
check "EXCLUSAO: nenhuma das recusas apagou nada" "$(n_lanc "WHERE id=$ID_11")|$(n_excl '')" "1|0"
R="$(rpc $FIN '[6]' 6 "DELETE FROM \"LancamentoExterno\" WHERE id=$ID_11;")"
check "EXCLUSAO: DELETE direto na tabela e negado a authenticated (a unica porta e a funcao)" "$(printf '%s' "$R" | grep -c 'permission denied')" "1"

# --- semana ABERTA: exclui, deixa rastro, prévia recalcula, reimportar funciona ---
check "EXCLUSAO pre: previa do 11 = 10,00 (30,00 - 20,00)" "$(prev_rem 11)" "10.00"
R="$(excluir $FIN '[6]' 6 "$ID_11")"
check "EXCLUSAO: semana aberta -> exclui e devolve o que havia (id:tipo:valor:data)" "$R" "$ID_11:ADIANTAMENTO:20.00:$SEM_HOJE"
check "EXCLUSAO: a linha sumiu de LancamentoExterno" "$(n_lanc "WHERE id=$ID_11")" "0"
check "EXCLUSAO: a PREVIA recalculou sozinha (10,00 -> 30,00)" "$(prev_rem 11)" "30.00"
check "EXCLUSAO (rastro): copia da linha + QUEM e QUANDO excluiu, na mesma transacao" \
  "$(psql_t -tAc "SELECT lancamento_id=$ID_11 AND valor=20.00 AND tipo='ADIANTAMENTO' AND cnpj_prestador='90000000000011' AND data_pagamento='$SEM_HOJE' AND criado_por=excluido_por AND excluido_por=(SELECT id FROM \"Usuario\" WHERE email='fin@example.com') AND excluido_em > now() - interval '5 minutes' FROM \"LancamentoExternoExclusao\"")" "t"
# M8 (rodada 4): a tabela guarda cnpj_prestador e NENHUM leitor do produto a le; o SELECT por escopo tinha gate mais fraco que
# a listagem. Agora o PostgREST (authenticated) nao a le de jeito nenhum — quem audita le como dono do banco.
check "EXCLUSAO (rastro): authenticated NAO le a tabela (nem fin, nem 9001); o dono do banco ve 1" "$(rpc $FIN '[6]' 6 'SELECT count(*) FROM "LancamentoExternoExclusao";' | grep -c 'permission denied')|$(rpc fin9001@example.com '[9001]' 9001 'SELECT count(*) FROM "LancamentoExternoExclusao";' | grep -c 'permission denied')|$(n_excl '')" "1|1|1"
R="$(rpc $FIN '[6]' 6 'DELETE FROM "LancamentoExternoExclusao";')"
check "EXCLUSAO (rastro): append-only — authenticated nao apaga o rastro" "$(printf '%s' "$R" | grep -c 'permission denied')" "1"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000011 "$SEM_HOJE" 20.00)]")"
check "EXCLUSAO: REIMPORTAR a mesma chave apos excluir funciona (APLICADA, nao JA_APLICADO) — era o ponto da feature" "$R" "0:APLICADA:"
check "EXCLUSAO: ...e o repasse volta a ser reduzido em 20,00 (30,00 -> 10,00)" "$(prev_rem 11)" "10.00"

# ============ A1 (rodada 4) — excluir um CREDITO que sustenta uma deducao faria os R$ 90 evaporarem ============
# O driver anterior so excluia DEDUCAO (inofensiva). Cenario do revisor, ponta a ponta: credito 100 APLICADA -> deducao 100 APLICADA
# (liquido 0) -> excluir o CREDITO => liquido -100 (que NAO transporta e some). Agora a exclusao do credito RECUSA, e a mensagem
# manda apagar a deducao primeiro. Motorista NOVO 15, sem faturamento (o credito e externo).
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: seed do A1"; exit 1; }
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90000000000015','Motorista Teste 15'),('90000000000016','Motorista Teste 16');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), c.nome, c.id FROM "ContaMotorista" c WHERE c.cnpj_prestador IN ('90000000000015','90000000000016');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000000016'),
       '$SEM_HOJE'::date, '$SEM_HOJE'::date, 'Credito', 30.00, 'Corrida', md5('a2-16')||md5('16-a2');
SQL
R="$(aplicarl $FIN '[6]' 6 AJUSTE_CREDITO "[$(lj 0 90000000000015 "$SEM_HOJE" 100.00)]")"; check "A1 pre: credito externo de 100,00 aplicado" "$R" "0:APLICADA:"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000015 "$SEM_HOJE" 100.00)]")"; check "A1 pre: deducao de 100,00 cabe por causa do credito (liquido 100,00 -> 0,00)" "$R" "0:APLICADA:"
check "A1 pre: previa do 15 = 0,00" "$(prev_rem 15)" "0.00"
ID_CRED="$(lid 90000000000015 "$SEM_HOJE" AJUSTE_CREDITO)"; ID_DED="$(lid 90000000000015 "$SEM_HOJE" ADIANTAMENTO)"
R="$(excluir $FIN '[6]' 6 "$ID_CRED")"
check "A1: excluir o CREDITO que sustenta a deducao e RECUSADO (EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO) — antes: previa -100 e R\$ 100 evaporavam" "$(printf '%s' "$R" | grep -c 'EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO')" "1"
check "A1: o HINT nao promete caminho limpo — avisa que apagar a deducao e depois o credito pode fechar NEGATIVO (rodada 5b)" "$(printf '%s' "$R" | grep -c 'confira o aviso ao fechar a semana')" "1"
check "A1: nada mudou — credito segue la, previa continua 0,00 (nunca negativa) e nenhum rastro de exclusao novo" "$(n_lanc "WHERE id=$ID_CRED")|$(prev_rem 15)|$(n_excl "WHERE lancamento_id=$ID_CRED")" "1|0.00|0"
R="$(excluir $FIN '[6]' 6 "$ID_DED")"; check "A1: excluir a DEDUCAO primeiro e permitido (so aumenta o liquido)" "$(printf '%s' "$R" | grep -c ":ADIANTAMENTO:100.00:")" "1"
check "A1: ...e a previa passa a 100,00" "$(prev_rem 15)" "100.00"
R="$(excluir $FIN '[6]' 6 "$ID_CRED")"; check "A1: agora o CREDITO pode ser excluido (nao sustenta mais nada)" "$(printf '%s' "$R" | grep -c ":AJUSTE_CREDITO:100.00:")" "1"
check "A1: sem lancamentos restantes e com 2 rastros de exclusao (credito + deducao): nada sumiu sem registro" "$(n_lanc "WHERE cnpj_prestador='90000000000015'")|$(n_excl "WHERE cnpj_prestador='90000000000015'")" "0|2"

# ============ C3 (rodada 5) — a guarda de exclusao so olha a deducao que `excluir` ALCANCA ============
# O liquido soma TRES fontes de deducao e `excluir` apaga UMA (LancamentoExterno). Com dedução do APP (AdiantamentoSolicitacao PAGA),
# a guarda antiga recusava o credito e o HINT ("apague a deducao primeiro") era falso: nao ha deducao externa para apagar, entao
# o credito ficava IMORTAL (semana aberta: esta guarda; fechada: SEMANA_JA_FECHADA). Motorista 17: credito externo 100,00 +
# solicitacao do app PAGA de 150,00 (liquido -50,00 ja ANTES da exclusao; aplicar nunca recusa credito).
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: seed do C3"; exit 1; }
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90000000000017','Motorista Teste 17');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), c.nome, c.id FROM "ContaMotorista" c WHERE c.cnpj_prestador = '90000000000017';
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
SELECT 6, e.id, 'CARGA_INICIAL', 'APROVADA', 'Motorista Teste 17', '00000000000', 'PF', '001', 'Banco Teste', '0001', '0000017', '0', 'CORRENTE', e.id, now()
FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000000017';
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_bruto, valor_liquido, conta_bancaria_id)
SELECT 6, c.id, c.cnpj_prestador, e.id, (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 AND versao=93),
       '$SEM_HOJE'::date + 1, '$SEM_HOJE'::date, repeat('c',64), 'PAGA', gen_random_uuid(), 150.00, 150.00,
       (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=e.id)
FROM "ContaMotorista" c JOIN "Entregador" e ON e.motorista_id=c.id WHERE c.cnpj_prestador='90000000000017';
SQL
R="$(aplicarl $FIN '[6]' 6 AJUSTE_CREDITO "[$(lj 0 90000000000017 "$SEM_HOJE" 100.00)]")"; check "C3 pre: credito externo de 100,00 e aplicado mesmo com deducao do app maior (aplicar nunca recusa credito)" "$R" "0:APLICADA:"
ID_C3="$(lid 90000000000017 "$SEM_HOJE" AJUSTE_CREDITO)"
R="$(excluir $FIN '[6]' 6 "$ID_C3")"
check "C3: excluir o CREDITO sustentado so por deducao do APP e PERMITIDO (nao ha deducao externa para apagar antes)" "$(printf '%s' "$R" | grep -c ":AJUSTE_CREDITO:100.00:")|$(printf '%s' "$R" | grep -c 'EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO')" "1|0"
check "C3: ...o credito saiu e o rastro de exclusao foi gravado" "$(n_lanc "WHERE cnpj_prestador='90000000000017'")|$(n_excl "WHERE cnpj_prestador='90000000000017'")" "0|1"
# Rodada 5b: este bloco LIMPAVA a solicitacao do 17 com o comentario "contaminaria o contador do A2". A crenca era falsa: o 17
# TEVE lancamento externo na semana (o rastro de exclusao prova) e fecha NEGATIVO (-150,00) — exatamente quem o aviso precisa
# ver. Antes o contador so olhava quem TEM lancamento e o 17 sumia do aviso. Agora e um CHECK, nao uma limpeza que esconde.
resumo_neg() { rpc $FIN '[6]' 6 "SELECT qtd_negativo||'|'||total_negativo FROM hub_lancamento_externo_resumo('$SEM_HOJE');"; }
check "A1 (5b): motorista que TEVE lancamento e o excluiu (17: sem lancamento, app deduz 150,00) CONTA no aviso do fechamento" "$(resumo_neg)" "1|150.00"
psql_t -q -v ON_ERROR_STOP=1 -c "DELETE FROM \"AdiantamentoSolicitacao\" WHERE cnpj_prestador='90000000000017';" || { echo "FAIL: limpeza do C3"; exit 1; }
check "A1 (5b): removida a deducao do app, o 17 deixa de fechar negativo e sai do aviso (0|0.00) — o aviso segue o liquido, nao o historico" "$(resumo_neg)" "0|0.00"

# ============ A1 (rodada 5b) — bypass de 2 etapas: apagar a deducao E DEPOIS o credito ============
# A guarda de UM passo (acima) protege; o HINT descrevia uma sequencia que remove a propria condicao da guarda. Motorista 18:
# credito externo 100, deducao externa 1, solicitacao do app PAGA 99 (liquido 0,00). Etapa 1 recusa; etapa 2 (apagar a deducao)
# passa; etapa 3 (apagar o credito) PASSA e o liquido vai a -99,00 com ZERO lancamento externo na semana. O contador do aviso
# varria so "LancamentoExterno" e dizia 0|0.00; agora tambem varre o rastro de exclusao e diz 1|99.00.
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: seed do A1 5b"; exit 1; }
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90000000000018','Motorista Teste 18');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), c.nome, c.id FROM "ContaMotorista" c WHERE c.cnpj_prestador = '90000000000018';
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
SELECT 6, e.id, 'CARGA_INICIAL', 'APROVADA', 'Motorista Teste 18', '00000000000', 'PF', '001', 'Banco Teste', '0001', '0000018', '0', 'CORRENTE', e.id, now()
FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000000018';
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_bruto, valor_liquido, conta_bancaria_id)
SELECT 6, c.id, c.cnpj_prestador, e.id, (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 AND versao=93),
       '$SEM_HOJE'::date + 1, '$SEM_HOJE'::date, repeat('d',64), 'PAGA', gen_random_uuid(), 99.00, 99.00,
       (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=e.id)
FROM "ContaMotorista" c JOIN "Entregador" e ON e.motorista_id=c.id WHERE c.cnpj_prestador='90000000000018';
SQL
R="$(aplicarl $FIN '[6]' 6 AJUSTE_CREDITO "[$(lj 0 90000000000018 "$SEM_HOJE" 100.00)]")"; check "A1 5b pre: credito externo de 100,00 aplicado" "$R" "0:APLICADA:"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000018 "$SEM_HOJE" 1.00)]")"; check "A1 5b pre: deducao externa de 1,00 cabe (liquido 1,00 apos o app 99,00)" "$R" "0:APLICADA:"
check "A1 5b pre: previa 0,00 e ninguem negativo" "$(prev_rem 18)|$(resumo_neg)" "0.00|0|0.00"
ID_C="$(lid 90000000000018 "$SEM_HOJE" AJUSTE_CREDITO)"; ID_D="$(lid 90000000000018 "$SEM_HOJE" ADIANTAMENTO)"
R="$(excluir $FIN '[6]' 6 "$ID_C")"; check "A1 5b etapa 1: excluir o credito e RECUSADO (a guarda de um passo protege)" "$(printf '%s' "$R" | grep -c 'EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO')" "1"
R="$(excluir $FIN '[6]' 6 "$ID_D")"; check "A1 5b etapa 2: apagar a deducao externa e permitido" "$(printf '%s' "$R" | grep -c ":ADIANTAMENTO:1.00:")" "1"
R="$(excluir $FIN '[6]' 6 "$ID_C")"; check "A1 5b etapa 3: apagar o credito agora PASSA (e o furo que a guarda de um passo nao fecha)" "$(printf '%s' "$R" | grep -c ":AJUSTE_CREDITO:100.00:")" "1"
check "A1 5b: zero lancamento externo restante" "$(n_lanc "WHERE cnpj_prestador='90000000000018'")" "0"
check "A1 5b: o RESUMO do fechamento enxerga o 18 (1|99.00) — antes: 0|0.00 e o fechamento dava um clique so" "$(resumo_neg)" "1|99.00"
psql_t -q -v ON_ERROR_STOP=1 -c "DELETE FROM \"AdiantamentoSolicitacao\" WHERE cnpj_prestador='90000000000018';" || { echo "FAIL: limpeza do A1 5b"; exit 1; }
check "A1 5b: sem a deducao do app, o 18 sai do aviso (0|0.00)" "$(resumo_neg)" "0|0.00"

# ============ A2 (rodada 4) — a guarda e do INSTANTE do import: o resumo conta quem fecha NEGATIVO agora ============
# Motorista 16: credito de faturamento 30,00; deducao externa de 30,00 CABE (liquido 30 -> 0). DEPOIS chega um debito de
# faturamento de 12,00 (o robo importa 11h/13h/14h): o remanescente vai a -12,00 e, no fechamento, os 12 nao seriam pagos nem
# transportados. O fechamento NAO recusa (decisao do operador): o resumo INFORMA quantos e quanto, e a tela exige confirmacao.
resumo_neg() { rpc $FIN '[6]' 6 "SELECT qtd_negativo||'|'||total_negativo FROM hub_lancamento_externo_resumo('$SEM_HOJE');"; }
check "A2 pre: ninguem fecha negativo na semana (qtd 0, total 0.00)" "$(resumo_neg)" "0|0.00"
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000016 "$SEM_HOJE" 30.00)]")"; check "A2 pre: deducao de 30,00 cabe (liquido 30,00)" "$R" "0:APLICADA:"
psql_t -q -v ON_ERROR_STOP=1 <<SQL || { echo "FAIL: debito tardio do A2"; exit 1; }
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000000016'),
       '$SEM_HOJE'::date, '$SEM_HOJE'::date, 'Debito', -12.00, 'Multa', md5('a2-16-deb')||md5('deb-16-a2');
SQL
check "A2: com o debito tardio a previa do 16 e NEGATIVA (-12,00) — o cenario que a guarda do import nao ve" "$(prev_rem 16)" "-12.00"
check "A2: o resumo informa 1 motorista e R\$ 12,00 que evaporariam" "$(resumo_neg)" "1|12.00"
check "A2: quem nao alcanca a empresa 6 (escopo 9001) NAO recebe a contagem" "$(rpc fin9001@example.com '[9001]' 9001 "SELECT qtd_negativo||'|'||total_negativo FROM hub_lancamento_externo_resumo('$SEM_HOJE');")" "0|0.00"

# ============ C17 — dia de inicio da semana mudou DEPOIS do fechamento: a semana fechada continua protegida ============
# Config nova com inicio na QUARTA (dow 3): a semana derivada de 2026-09-18 passa a comecar em 09-16, mas a apuracao
# antiga fechada tem periodo_inicio 09-14. Sem a checagem por contencao a linha entraria numa semana congelada.
psql_t -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "FAIL: seed do C17"; exit 1; }
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
VALUES (6, 94, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 3, 2, 'data_lancamento', ARRAY['Corrida'], true, true, true);
SQL
R="$(aplicar fin@example.com '[6]' 6 AJUSTE_CREDITO 90000000000003 2026-09-18 2.00)"
check "C17: dia de inicio mudou apos o fechamento; data dentro de apuracao JA fechada (09-14..09-20) -> SEMANA_JA_FECHADA" "$R" "0:SEMANA_JA_FECHADA"
check "C17: nada gravado" "$(n_lanc "WHERE data_pagamento='2026-09-18'")" "0"


# ============ ALTO 2 — flag `desconto_adiantamentos` DESLIGADA: a recusa por liquido nao se aplica ============
# Desligada, a deducao nem pesa no repasse (nada some) e o aviso de FR-049 ja cobre; recusar seria bloquear um lancamento inofensivo.
psql_t -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "FAIL: seed da flag desligada"; exit 1; }
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
VALUES (6, 95, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 3, 2, 'data_lancamento', ARRAY['Corrida'], false, true, true);
SQL
R="$(aplicarl $FIN '[6]' 6 ADIANTAMENTO "[$(lj 0 90000000000014 "$HOJE" 100.00)]")"
check "ALTO 2: flag desconto_adiantamentos DESLIGADA + deducao 100,00 (credito 30,00) -> APLICADA (nada sera deduzido; o aviso de FR-049 cobre)" "$R" "0:APLICADA:"

echo ""; echo "===================================================================="
echo "RESULTADO: $passes PASS / $fails FAIL"
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
