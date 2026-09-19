#!/usr/bin/env bash
# =============================================================================
# hub-adiantamentos-integration.sh — tasks.md FASE 1, tarefas 1.2.7/1.2.8/1.5:
# prova REAL (sem mock) de que as migrations 0066/0067 (feature
# "Adiantamento pelo App, Dados Bancários e Exportação Transfeera") aplicam
# sem erro, são idempotentes, e que a máquina de estados/RBAC/concorrência
# de infra/hub/migrations/0067_adiantamento_funcoes.sql se comportam como
# data-model.md/contracts/sql-rpc.md descrevem. Mesmo padrão de isolamento
# efêmero de infra/hub/testes/hub-push-avisos-integration.sh: stack
# `hub-test-<epoch>` descartável, sem tocar homolog/produção.
#
# Cobre:
#   1.2.7 — todas as 16 transições válidas da máquina de estados de
#           AdiantamentoSolicitacao.status (inclui FALHOU->ENCERRADA, D-23) +
#           5 transições inválidas recusadas com TRANSICAO_INVALIDA
#   1.2.8 — concorrência REAL (dois processos psql simultâneos, não
#           simulada): duas solicitações do mesmo motorista/dia (edge #11) e
#           duas criações de lote sobrepostas (edge #17)
#   D-06/R-07 — arredondamento meio-para-cima via hub_adiantamento_recalcular
#           fim-a-fim (produção real 215.575 -> bruto 129.35, fronteira
#           129,345->129,35 do plan.md)
#   D-23 — fechamento recusado com pendências (APURACAO_COM_PENDENCIAS),
#           fechamento liberado quando só há finalizados, dupla tentativa
#           do mesmo período (APURACAO_JA_FECHADA), e FALHOU->ENCERRADA via
#           hub_adiantamento_encerrar_falha (PERMISSAO_NEGADA sem RBAC,
#           sucesso com RBAC)
#   2.1.5 — hub_adiantamento_janela (SQL) x janela() (backend/lib/adiantamento-regras.js,
#           JS) com o MESMO arquivo de vetores
#           (app_homologacao/backend/tests/fixtures/adiantamento-janela-vetores.json):
#           garante que os dois lados nunca divergem nas fronteiras de
#           abertura/corte, D-1 e virada de mês/ano.
#
# Uso: infra/hub/testes/hub-adiantamentos-integration.sh
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

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db efêmero ($PROJECT)…"
dc up -d --wait db

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_relaxed() { dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

# --- migrate 2x: aplica + idempotência --------------------------------------
echo "aplicando migrations (inclui 0066/0067/0069)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate1.log" 2>&1
if ! grep -q "0067_adiantamento_funcoes.sql" "$TMP/migrate1.log"; then
  echo "FAIL: 0067 não aplicada — log completo:"; tail -100 "$TMP/migrate1.log"; exit 1
fi
if ! grep -q "0069_auditoria_adiantamento.sql" "$TMP/migrate1.log"; then
  echo "FAIL: 0069 não aplicada — log completo:"; tail -100 "$TMP/migrate1.log"; exit 1
fi
# 10.2.1 (FASE 10): 0072 (RPC hub_conta_bancaria_carga_inicial, 8.1.7) só
# tinha sido verificada num postgres:13 avulso — aqui é aplicada de verdade
# via migrate.sh contra o stack hub-test-* efêmero deste driver.
if ! grep -q "0072_adiantamento_carga_inicial.sql" "$TMP/migrate1.log"; then
  echo "FAIL: 0072 não aplicada — log completo:"; tail -100 "$TMP/migrate1.log"; exit 1
fi
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate2.log" 2>&1
check "migrate.sh 2x — 0066/0067/0069 idempotentes (puladas na 2ª corrida)" \
  "$(grep -cE 'pulada \(já aplicada\): (0066|0067|0069)' "$TMP/migrate2.log")" "3"
check "10.2.1: migrate.sh 2x — 0072 idempotente (pulada na 2ª corrida)" \
  "$(grep -cE 'pulada \(já aplicada\): 0072' "$TMP/migrate2.log")" "1"

# --- fixtures --------------------------------------------------------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('33333333000101', 'Fulano Teste');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
VALUES (6, gen_random_uuid(), 'Fulano Teste', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')), 'CARGA_INICIAL', 'APROVADA', 'Fulano Teste', '12345678901', 'PF', '001', 'Banco do Brasil', '1234', '00012345', '6', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')), now());
-- Módulo/permissões/ModuloEntidade/papel "financeiro"/config v1 (incompleta)
-- já vêm da migration 0070 (task 1.4) — só liga usuários de teste aos 3
-- papéis relevantes (financeiro tem as 10 permissões; operador/leitura,
-- nenhuma — usados no bloco 1.4.4/1.4.5 abaixo).
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('financeiro.teste@example.com', 'x', 'Financeiro Teste');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), 6, (SELECT id FROM "Papel" WHERE nome='financeiro'), true);
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('operador.teste@example.com', 'x', 'Operador Teste');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email='operador.teste@example.com'), 6, (SELECT id FROM "Papel" WHERE nome='operador'), true);
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('leitura.teste@example.com', 'x', 'Leitura Teste');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email='leitura.teste@example.com'), 6, (SELECT id FROM "Papel" WHERE nome='leitura'), true);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed base deu erro"; cat "$TMP/seed.log"; exit 1; fi
check "seed base (conta/entregador/RBAC financeiro+operador+leitura) sem erro" "0" "0"

# --- 1.4.1/1.4.2: módulo/permissões/papel financeiro semeados por 0070 -----
N_ORDEM="$(psql_t -tAc "SELECT ordem FROM \"Modulo\" WHERE codigo='adiantamentos';")"
check "1.4.1: módulo adiantamentos ordem 35" "$N_ORDEM" "35"
N_PERMISSOES="$(psql_t -tAc "SELECT count(*) FROM \"Permissao\" perm JOIN \"Modulo\" m ON m.id=perm.modulo_id WHERE m.codigo='adiantamentos';")"
check "1.4.1: módulo adiantamentos com 10 permissões distintas" "$N_PERMISSOES" "10"
GRANTS="$(psql_t -tAc "SELECT p.nome || '=' || count(*) FROM \"Papel\" p JOIN \"PapelPermissao\" pp ON pp.papel_id=p.id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id JOIN \"Modulo\" m ON m.id=perm.modulo_id WHERE m.codigo='adiantamentos' GROUP BY p.nome ORDER BY p.nome;")"
check "1.4.2: só financeiro/admin_entidade/admin_plataforma têm as 10 permissões" "$GRANTS" "admin_entidade=10
admin_plataforma=10
financeiro=10"
N_OUTROS="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Permissao\" perm ON perm.id=pp.permissao_id JOIN \"Modulo\" m ON m.id=perm.modulo_id WHERE m.codigo='adiantamentos' AND pp.papel_id NOT IN (SELECT id FROM \"Papel\" WHERE nome IN ('financeiro','admin_plataforma','admin_entidade'));")"
check "1.4.2: fail-closed — nenhum outro papel (inclui operador/leitura) recebe permissão" "$N_OUTROS" "0"

# --- 1.4.3: config v1 (migration 0070) com D-04/D-05/D-06/D-21/Q-N2; Q-B2/Q-B3 nulos ---
CONFIG_V1="$(psql_t -tAc "SELECT dias_habilitados::text || '|' || horario_abertura || '|' || horario_corte || '|' || percentual || '|' || taxa_fixa || '|' || previsao_pagamento_texto || '|' || descricao_pix_modelo || '|' || (fonte_producao IS NULL) || '|' || (categorias_producao IS NULL) || '|' || (apuracao_dia_inicio IS NULL) || '|' || (apuracao_dias_ate_repasse IS NULL) || '|' || (apuracao_data_base IS NULL) || '|' || (categorias_extrato IS NULL) FROM \"AdiantamentoConfiguracao\" WHERE versao=1 AND id_empresa=6;")"
check "1.4.3: config v1 = D-04/D-05/D-06/D-21/Q-N2, Q-B2/Q-B3 todos nulos" "$CONFIG_V1" "{1,2,3,4,5,6}|09:00:00|15:00:00|60.00|0.35|entre 17h e 18h de hoje|Antecipação entregador mei {data_producao:DD.MM.AA}_{nome}|true|true|true|true|true|true"

# --- 1.4.3/FR-025/dec-053: config v1 incompleta -> disponibilidade().completa=false
#     e solicitar() recusa com NOT_CONFIGURED (antes só disponibilidade calculava
#     completude; solicitar não checava — corrigido nesta onda em 0067).
DISPONIB_V1_OUT="$(psql_relaxed -tA -F'|' -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT configuracao_completa, motivo_indisponivel FROM hub_adiantamento_disponibilidade();
ROLLBACK;
SQL
)"
check "1.4.3: disponibilidade() com config v1 (Q-B2/Q-B3 nulos) -> configuracao_completa=false" "$(echo "$DISPONIB_V1_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "f|"

SOLICITAR_V1_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_solicitar((SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=1 AND id_empresa=6), repeat('a',64), gen_random_uuid());
ROLLBACK;
SQL
)"
check "1.4.3/FR-025/dec-053: solicitar() com config v1 incompleta -> NOT_CONFIGURED" "$(echo "$SOLICITAR_V1_OUT" | grep -c 'NOT_CONFIGURED')" "1"
N_SOL_APOS_NOT_CONFIGURED="$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoSolicitacao\";")"
check "1.4.3: NOT_CONFIGURED não criou nenhuma solicitação" "$N_SOL_APOS_NOT_CONFIGURED" "0"

# --- 1.4.4/1.4.5 (parte SQL — Node/requirePermission é FASE 4, ainda não existe):
#     operador e leitura não têm NENHUMA das 10 permissões (1.4.2 já provou
#     via PapelPermissao) — aqui a prova fim-a-fim: uma RPC sensível de
#     verdade (hub_adiantamento_configuracao_salvar, exige
#     'adiantamentos.configurar') recusa os dois com PERMISSAO_NEGADA.
NEGADO_OPERADOR_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', (SELECT id FROM "Usuario" WHERE email='operador.teste@example.com'), 'empresa_ativa', '6', 'escopo', jsonb_build_array(6))::text, true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_configuracao_salvar(1, '{}'::jsonb);
ROLLBACK;
SQL
)"
check "1.4.4/1.4.5: papel operador (0/10 permissões) -> PERMISSAO_NEGADA em RPC sensível" "$(echo "$NEGADO_OPERADOR_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"

NEGADO_LEITURA_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', (SELECT id FROM "Usuario" WHERE email='leitura.teste@example.com'), 'empresa_ativa', '6', 'escopo', jsonb_build_array(6))::text, true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_configuracao_salvar(1, '{}'::jsonb);
ROLLBACK;
SQL
)"
check "1.4.4/1.4.5: papel leitura (0/10 permissões) -> PERMISSAO_NEGADA em RPC sensível" "$(echo "$NEGADO_LEITURA_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"

# --- config v2: mesmo shape da antiga v1 desta suíte (COMPLETA — fonte,
#     categorias e apuração preenchidas), usada pelo resto dos testes abaixo
#     que precisam calcular produção/lote/repasse de verdade.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/config_v2.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato)
VALUES (6, 2, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'entre 17h e 18h de hoje', 'Antecipação {data_producao:DD.MM.AA}_{nome}', 0, 2, 'data_lancamento', ARRAY['Corrida']);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de config v2 deu erro"; cat "$TMP/config_v2.log"; exit 1; fi

# --- 1.2.7: 16 transições válidas + 5 inválidas -----------------------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/transicoes_seed.log" 2>&1
DO $$
DECLARE
    v_conta_id int := (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101');
    v_entregador_id int := (SELECT id FROM "Entregador" WHERE motorista_id=v_conta_id);
    v_cb_id bigint := (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=v_entregador_id AND status='APROVADA');
    v_config_id bigint := (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6);
    v_transicoes text[][] := ARRAY[
        ARRAY['AGUARDANDO_CORTE','CANCELADA'], ARRAY['AGUARDANDO_CORTE','AGUARDANDO_PRODUCAO'],
        ARRAY['AGUARDANDO_CORTE','INELEGIVEL'], ARRAY['AGUARDANDO_CORTE','LIBERADA'],
        ARRAY['AGUARDANDO_PRODUCAO','LIBERADA'], ARRAY['AGUARDANDO_PRODUCAO','INELEGIVEL'],
        ARRAY['AGUARDANDO_PRODUCAO','REJEITADA'], ARRAY['LIBERADA','REJEITADA'],
        ARRAY['LIBERADA','EM_LOTE'], ARRAY['EM_LOTE','LIBERADA'], ARRAY['EM_LOTE','EXPORTADA'],
        ARRAY['EXPORTADA','LIBERADA'], ARRAY['EXPORTADA','PAGA'], ARRAY['EXPORTADA','FALHOU'],
        ARRAY['FALHOU','LIBERADA'], ARRAY['FALHOU','ENCERRADA']
    ];
    i int; v_de text;
BEGIN
    FOR i IN 1..array_length(v_transicoes,1) LOOP
        v_de := v_transicoes[i][1];
        INSERT INTO "AdiantamentoSolicitacao" (
            id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
            data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia,
            valor_liquido, conta_bancaria_id, motivo_status
        ) VALUES (
            i, 6, v_conta_id, '33333333000101', v_entregador_id, v_config_id,
            ('2026-01-01'::date + (i || ' days')::interval)::date,
            ('2026-01-01'::date + (i || ' days')::interval)::date - 1,
            repeat('a',64), v_de, gen_random_uuid(), 100.00, v_cb_id,
            CASE WHEN v_de='REJEITADA' THEN 'seed' ELSE NULL END
        );
    END LOOP;
    PERFORM setval(pg_get_serial_sequence('"AdiantamentoSolicitacao"','id'), 16, true);
END $$;
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de transições deu erro"; cat "$TMP/transicoes_seed.log"; exit 1; fi

psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/transicoes_validas.log" 2>&1
UPDATE "AdiantamentoSolicitacao" SET status='CANCELADA' WHERE id=1;
UPDATE "AdiantamentoSolicitacao" SET status='AGUARDANDO_PRODUCAO' WHERE id=2;
UPDATE "AdiantamentoSolicitacao" SET status='INELEGIVEL' WHERE id=3;
UPDATE "AdiantamentoSolicitacao" SET status='LIBERADA' WHERE id=4;
UPDATE "AdiantamentoSolicitacao" SET status='LIBERADA' WHERE id=5;
UPDATE "AdiantamentoSolicitacao" SET status='INELEGIVEL' WHERE id=6;
UPDATE "AdiantamentoSolicitacao" SET status='REJEITADA', motivo_status='veto teste' WHERE id=7;
UPDATE "AdiantamentoSolicitacao" SET status='REJEITADA', motivo_status='veto teste' WHERE id=8;
UPDATE "AdiantamentoSolicitacao" SET status='EM_LOTE' WHERE id=9;
UPDATE "AdiantamentoSolicitacao" SET status='LIBERADA' WHERE id=10;
UPDATE "AdiantamentoSolicitacao" SET status='EXPORTADA' WHERE id=11;
UPDATE "AdiantamentoSolicitacao" SET status='LIBERADA' WHERE id=12;
UPDATE "AdiantamentoSolicitacao" SET status='PAGA' WHERE id=13;
UPDATE "AdiantamentoSolicitacao" SET status='FALHOU' WHERE id=14;
UPDATE "AdiantamentoSolicitacao" SET status='LIBERADA' WHERE id=15;
UPDATE "AdiantamentoSolicitacao" SET status='ENCERRADA', motivo_status='falha definitiva teste' WHERE id=16;
SQL
check "1.2.7: 16/16 transições válidas aplicadas sem erro" "$?" "0"

N_EVENTOS="$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoEvento\" WHERE solicitacao_id BETWEEN 1 AND 16;")"
check "1.2.7: 16 eventos gravados (1 por transição, inclui FALHOU->ENCERRADA)" "$N_EVENTOS" "16"

N_INVALIDAS="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1 | grep -c "ERROR:  TRANSICAO_INVALIDA"
UPDATE "AdiantamentoSolicitacao" SET status='PAGA' WHERE id=1;
UPDATE "AdiantamentoSolicitacao" SET status='LIBERADA' WHERE id=1;
UPDATE "AdiantamentoSolicitacao" SET status='AGUARDANDO_CORTE' WHERE id=3;
UPDATE "AdiantamentoSolicitacao" SET status='EM_LOTE' WHERE id=6;
UPDATE "AdiantamentoSolicitacao" SET status='ENCERRADA' WHERE id=13;
SQL
)"
check "1.2.7: 5/5 amostras de transição inválida recusadas com TRANSICAO_INVALIDA" "$N_INVALIDAS" "5"

# --- 1.6.1: recalcular só em AGUARDANDO_PRODUCAO (id=10 LIBERADA, id=3 INELEGIVEL) --
RECALC_LIBERADA_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_recalcular(10);
ROLLBACK;
SQL
)"
check "1.6.1: recalcular em LIBERADA -> TRANSICAO_INVALIDA" "$(echo "$RECALC_LIBERADA_OUT" | grep -c 'TRANSICAO_INVALIDA')" "1"

RECALC_INELEGIVEL_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_recalcular(3);
ROLLBACK;
SQL
)"
check "1.6.1: recalcular em INELEGIVEL -> TRANSICAO_INVALIDA" "$(echo "$RECALC_INELEGIVEL_OUT" | grep -c 'TRANSICAO_INVALIDA')" "1"

N_VALORES_INALTERADOS="$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoSolicitacao\" WHERE id IN (10,3) AND valor_liquido = 100.00 AND status IN ('LIBERADA','INELEGIVEL');")"
check "1.6.1: tentativas recusadas não alteraram valores nem status (id 10 e 3)" "$N_VALORES_INALTERADOS" "2"

# --- D-06/R-07: arredondamento fim-a-fim via hub_adiantamento_recalcular ----
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/recalcular_seed.log" 2>&1
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('f',64), 'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
VALUES (6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('f',64)),
  (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
  '2026-03-01', '2026-03-01', 'Credito', 215.575, 'Corrida', repeat('h',64));
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    103, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6),
    '2026-03-02', '2026-03-01', repeat('a',64), 'AGUARDANDO_PRODUCAO', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de recalcular deu erro"; cat "$TMP/recalcular_seed.log"; exit 1; fi

RECALC_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_recalcular(103);
SELECT valor_bruto, valor_liquido FROM "AdiantamentoSolicitacao" WHERE id = 103;
COMMIT;
SQL
)"
check "D-06/R-07: produção 215.575 (fronteira 129,345) -> bruto 129.35 / líquido 129.00" "$(echo "$RECALC_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "129.35|129.00"

# --- 1.2.8: concorrência REAL (2 processos psql simultâneos) ----------------
cat >"$TMP/race_solicitar.sql" <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_solicitar(
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), repeat('c',64), gen_random_uuid());
COMMIT;
SQL
psql_relaxed -f - <"$TMP/race_solicitar.sql" >"$TMP/race1.out" 2>&1 &
P1=$!
psql_relaxed -f - <"$TMP/race_solicitar.sql" >"$TMP/race2.out" 2>&1 &
P2=$!
wait $P1 $P2
N_SUCESSO=$(cat "$TMP/race1.out" "$TMP/race2.out" | grep -c "AGUARDANDO_CORTE")
N_ALREADY=$(cat "$TMP/race1.out" "$TMP/race2.out" | grep -c "ALREADY_REQUESTED")
check "1.2.8 edge #11: concorrência real de solicitação — 1 sucesso" "$N_SUCESSO" "1"
check "1.2.8 edge #11: concorrência real de solicitação — 1 ALREADY_REQUESTED" "$N_ALREADY" "1"
N_LINHAS_HOJE="$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoSolicitacao\" WHERE conta_motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='33333333000101') AND status<>'CANCELADA' AND data_solicitacao=(now() AT TIME ZONE 'America/Sao_Paulo')::date;")"
check "1.2.8 edge #11: uma única linha persistida para o dia" "$N_LINHAS_HOJE" "1"
# id da solicitação de HOJE criada acima — reusada no 1.6.5 abaixo como o
# caso "corte ainda não passado" (não dá pra inserir outra linha para hoje:
# uniq_adiantamentosolicitacao_conta_dia é por conta_motorista_id+data_solicitacao).
ID_SOL_HOJE_AGUARDANDO_CORTE="$(psql_t -tAc "SELECT id FROM \"AdiantamentoSolicitacao\" WHERE conta_motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='33333333000101') AND status<>'CANCELADA' AND data_solicitacao=(now() AT TIME ZONE 'America/Sao_Paulo')::date;")"

psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/lote_seed.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id
) VALUES
(201, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-02-01', '2026-01-31',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 100.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA')),
(202, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-02-02', '2026-02-01',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 50.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de lote deu erro"; cat "$TMP/lote_seed.log"; exit 1; fi

cat >"$TMP/race_lote.sql" <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_criar(ARRAY[201,202]::bigint[], 2, 150.00, gen_random_uuid());
COMMIT;
SQL
psql_relaxed -f - <"$TMP/race_lote.sql" >"$TMP/racelote1.out" 2>&1 &
P3=$!
psql_relaxed -f - <"$TMP/race_lote.sql" >"$TMP/racelote2.out" 2>&1 &
P4=$!
wait $P3 $P4
N_GERANDO=$(cat "$TMP/racelote1.out" "$TMP/racelote2.out" | grep -c "GERANDO")
N_CONFLITO=$(cat "$TMP/racelote1.out" "$TMP/racelote2.out" | grep -c "SOLICITACOES_EM_OUTRO_LOTE")
check "1.2.8 edge #17: concorrência real de lote — 1 GERANDO" "$N_GERANDO" "1"
check "1.2.8 edge #17: concorrência real de lote — 1 SOLICITACOES_EM_OUTRO_LOTE" "$N_CONFLITO" "1"
N_LOTES="$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoLote\" WHERE quantidade=2 AND valor_total=150.00;")"
check "1.2.8 edge #17: um único lote persistido" "$N_LOTES" "1"

# --- 11.23/FR-050: corrida REAL com a MESMA chave de idempotência (2 --------
# processos psql simultâneos usando a MESMA chaveIdempotencia — cenário de
# duplo-clique/retry de rede) — DIFERENTE da corrida #11 acima (chaves
# DIFERENTES competindo pela vaga do DIA). Conta nova (nunca pediu hoje)
# pra não colidir com uniq_adiantamentosolicitacao_conta_dia; a corrida real
# é só na UNIQUE de idempotência (conta_motorista_id, chave_idempotencia).
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_11_23.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('88888888000101', 'Corrida Idempotencia');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
VALUES (6, gen_random_uuid(), 'Corrida Idempotencia', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='88888888000101'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='88888888000101')), 'CARGA_INICIAL', 'APROVADA', 'Corrida Idempotencia', '98765432100', 'PF', '001', 'Banco do Brasil', '1234', '00099999', '1', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='88888888000101')), now());
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de corrida de idempotência (11.23) deu erro"; cat "$TMP/seed_11_23.log"; exit 1; fi

cat >"$TMP/race_solicitar_mesma_chave.sql" <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"88888888000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_solicitar(
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), repeat('d',64), '99999999-9999-4999-8999-999999999999'::uuid);
COMMIT;
SQL
psql_relaxed -tA -f - <"$TMP/race_solicitar_mesma_chave.sql" >"$TMP/race_chave1.out" 2>&1 &
P5=$!
psql_relaxed -tA -f - <"$TMP/race_solicitar_mesma_chave.sql" >"$TMP/race_chave2.out" 2>&1 &
P6=$!
wait $P5 $P6
N_REUT_FALSE=$(cat "$TMP/race_chave1.out" "$TMP/race_chave2.out" | grep -cE '^[0-9]+\|AGUARDANDO_CORTE\|f\|')
N_REUT_TRUE=$(cat "$TMP/race_chave1.out" "$TMP/race_chave2.out" | grep -cE '^[0-9]+\|AGUARDANDO_CORTE\|t\|')
N_ALREADY_CHAVE=$(cat "$TMP/race_chave1.out" "$TMP/race_chave2.out" | grep -c "ALREADY_REQUESTED")
check "11.23: corrida com a MESMA chave — 1 criação (reutilizado=f)" "$N_REUT_FALSE" "1"
check "11.23: corrida com a MESMA chave — 1 reuso idempotente (reutilizado=t), NÃO um 2º erro" "$N_REUT_TRUE" "1"
check "11.23: corrida com a MESMA chave — 0 ALREADY_REQUESTED (bug antigo: as 3 UNIQUEs eram tratadas igual)" "$N_ALREADY_CHAVE" "0"
N_SOL_CHAVE="$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoSolicitacao\" WHERE conta_motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='88888888000101');")"
check "11.23: corrida com a MESMA chave — uma única solicitação persistida (não duplica)" "$N_SOL_CHAVE" "1"

# --- FASE 11 (converge onda-037, 11.14/11.15/migration 0074): fronteira
# SQL<->gerador do arquivo Transfeera. tests/adiantamento-transfeera-xlsx-unit.test.js
# alimenta col_documento/col_banco JÁ PRONTOS — nunca exercita o que a SQL
# realmente grava. Este driver roda a SQL real (hub_adiantamento_lote_criar
# acima, item da solicitação 201) — é o lugar certo para fechar a fronteira:
# titular_documento='12345678901' (fixture da linha ~96) deve virar
# col_documento FORMATADO ('123.456.789-01', contracts/transfeera-xlsx.md
# coluna B), nunca REDIGIDO ('*********01', hub_adiantamento_mascarar); e
# banco_codigo='001' (não banco_nome='Banco do Brasil') deve ir para
# col_banco (contracts/transfeera-xlsx.md coluna D).
COL_DOC_LOTE="$(psql_t -tAc "SELECT col_documento FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=201;")"
COL_BANCO_LOTE="$(psql_t -tAc "SELECT col_banco FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=201;")"
check "11.14: col_documento formatado (999.999.999-99), não redigido" "$COL_DOC_LOTE" "123.456.789-01"
check "11.15: col_banco é o código de 3 dígitos, não o nome do banco" "$COL_BANCO_LOTE" "001"

# --- D-23: fechamento com pendências / liberado / dupla tentativa -----------
PENDENCIA_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_repasse_fechar('2026-01-01'::date);
ROLLBACK;
SQL
)"
check "D-23: fechar com pendências -> APURACAO_COM_PENDENCIAS" "$(echo "$PENDENCIA_OUT" | grep -c 'APURACAO_COM_PENDENCIAS')" "1"

psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/finaliza.log" 2>&1
UPDATE "AdiantamentoSolicitacao" SET status='INELEGIVEL' WHERE id=2;
UPDATE "AdiantamentoSolicitacao" SET status='REJEITADA', motivo_status='fechar-teste' WHERE id=4;
UPDATE "AdiantamentoSolicitacao" SET status='REJEITADA', motivo_status='fechar-teste' WHERE id=5;
SQL
if [ $? -ne 0 ]; then echo "FAIL: finalização de pendências deu erro"; cat "$TMP/finaliza.log"; exit 1; fi

FECHAR_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT apuracao_id FROM hub_adiantamento_repasse_fechar('2026-01-01'::date);
COMMIT;
SQL
)"
check "D-23: fechamento liberado quando só há finalizados (apuracao_id=1)" "$(echo "$FECHAR_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "1"

# --- FASE 13 (converge onda-046, dec-185, 13.7/migration 0082): o item
# congelado no fechamento acima deve bater com o que a listagem informa para
# o MESMO período — a prova empírica pedida (fechar um período e conferir
# que o item congelado bate com o que a listagem informa). Roda AQUI, logo
# após o fechamento, enquanto a config v2 ainda é a vigente para id_empresa=6
# — mais abaixo no arquivo outras seções trocam a config vigente para testar
# outros cenários, o que faria hub_adiantamento_repasse (live) recusar com
# APURACAO_NAO_CONFIGURADA por motivo alheio a este teste.
APURACAO_ID_1301="$(psql_t -tAc "SELECT id FROM \"ApuracaoRepasse\" WHERE id_empresa=6 AND periodo_inicio='2026-01-01';")"
FROZEN_TOTAIS_1301="$(psql_t -tAc "SELECT COALESCE(sum(creditos),0)||'|'||COALESCE(sum(adiantamentos),0)||'|'||COALESCE(sum(debitos),0)||'|'||COALESCE(sum(remanescente),0) FROM \"ApuracaoRepasseItem\" WHERE apuracao_id=${APURACAO_ID_1301};")"
LISTAGEM_OUT_1301="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT COALESCE(sum(creditos),0)||'|'||COALESCE(sum(adiantamentos),0)||'|'||COALESCE(sum(debitos),0)||'|'||COALESCE(sum(remanescente),0)
FROM hub_adiantamento_repasse('2026-01-01'::date, NULL, false, 0, 1000);
COMMIT;
SQL
)"
LISTAGEM_TOTAIS_1301="$(echo "$LISTAGEM_OUT_1301" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
check "13.7: item congelado (ApuracaoRepasseItem, período 2026-01-01) bate com a listagem (hub_adiantamento_repasse)" \
  "$FROZEN_TOTAIS_1301" "$LISTAGEM_TOTAIS_1301"

REFECHAR_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_repasse_fechar('2026-01-01'::date);
ROLLBACK;
SQL
)"
check "D-23: 2ª tentativa do mesmo período -> APURACAO_JA_FECHADA" "$(echo "$REFECHAR_OUT" | grep -c 'APURACAO_JA_FECHADA')" "1"

SEM_PERM_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"999","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_encerrar_falha(14, 'motivo teste');
ROLLBACK;
SQL
)"
check "D-23: encerrar_falha sem RBAC -> PERMISSAO_NEGADA" "$(echo "$SEM_PERM_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"

COM_PERM_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_encerrar_falha(14, 'falha definitiva, cliente sem conta valida');
COMMIT;
SQL
)"
check "D-23: encerrar_falha com RBAC -> ENCERRADA (FALHOU->ENCERRADA)" "$(echo "$COM_PERM_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "ENCERRADA"

# --- 1.6.2: funções SQL do worker (sem GRANT a usuário comum; claim hub_adiantamento_worker) --
SEM_CLAIM_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_processar(10);
SELECT * FROM hub_adiantamento_lote_orfaos(5);
SELECT * FROM hub_adiantamento_expurgo_arquivos(90);
SQL
)"
check "1.6.2: as 3 RPCs do worker recusam sem a claim (3x PERMISSAO_NEGADA)" "$(echo "$SEM_CLAIM_OUT" | grep -c 'PERMISSAO_NEGADA')" "3"

# config versão 3: mesmo shape da v2, mas horario_corte='00:01' — usada só
# para simular "corte já passou" com uma solicitação ainda em
# AGUARDANDO_CORTE (a v2 tem corte 23:59, ou seja, quase o dia inteiro
# "corte ainda não passado" — útil para o cenário oposto, testado abaixo).
# 1.6.5 (dec-047): desde que hub_adiantamento_processar passou a considerar o
# DIA da solicitação, "corte ainda não passado" só é verdade para uma
# solicitação de HOJE — qualquer data fixa no passado (ex.: 2026-04-04) já
# teria seu corte vencido há muito. O caso de hoje reusa a solicitação
# capturada em ID_SOL_HOJE_AGUARDANDO_CORTE, criada pelo teste de
# concorrência 1.2.8 acima (não dá pra inserir outra linha de hoje para o
# mesmo motorista — unique conta_dia).
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/worker_seed1.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato)
VALUES (6, 3, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '00:01', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'entre 17h e 18h de hoje', 'Antecipação {data_producao:DD.MM.AA}_{nome}', 0, 2, 'data_lancamento', ARRAY['Corrida']);

-- edge #7: existe produção do dia para a empresa, mas nada para este
-- entregador na categoria configurada -> SEM_PRODUCAO.
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('g',64), 'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
VALUES (6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('g',64)),
  (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
  '2026-04-01', '2026-04-01', 'Credito', 50.00, 'Outro', repeat('i',64));

INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES
(301, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-04-02', '2026-04-01',
 repeat('a',64), 'AGUARDANDO_PRODUCAO', gen_random_uuid()),
(306, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=3 AND id_empresa=6), '2026-04-06', '2026-04-05',
 repeat('a',64), 'AGUARDANDO_CORTE', gen_random_uuid());
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed do worker (edge #7 / corte) deu erro"; cat "$TMP/worker_seed1.log"; exit 1; fi

PROCESSAR1_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT id, status_para FROM hub_adiantamento_processar(200) ORDER BY id;
COMMIT;
SQL
)"
check "1.6.2 edge #7: 301 processado -> INELEGIVEL (SEM_PRODUCAO)" "$(echo "$PROCESSAR1_OUT" | grep '^301|')" "301|INELEGIVEL"
N_301_MOTIVO="$(psql_t -tAc "SELECT status || '|' || motivo_status FROM \"AdiantamentoSolicitacao\" WHERE id=301;")"
check "1.6.2 edge #7: 301 motivo_status=SEM_PRODUCAO" "$N_301_MOTIVO" "INELEGIVEL|SEM_PRODUCAO"

check "1.6.5 corte ainda não passado (solicitação de hoje): não aparece no resultado do tick" "$(echo "$PROCESSAR1_OUT" | grep -c "^${ID_SOL_HOJE_AGUARDANDO_CORTE}|")" "0"
N_HOJE_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=${ID_SOL_HOJE_AGUARDANDO_CORTE};")"
check "1.6.5 corte ainda não passado (solicitação de hoje): continua AGUARDANDO_CORTE" "$N_HOJE_STATUS" "AGUARDANDO_CORTE"

N_306_STATUS="$(psql_t -tAc "SELECT status || '|' || tentativas_producao FROM \"AdiantamentoSolicitacao\" WHERE id=306;")"
check "1.6.2 corte já passou (306, config v3): sai de AGUARDANDO_CORTE, tentativas=1" "$N_306_STATUS" "AGUARDANDO_PRODUCAO|1"

# edge #23: importação em andamento -> espera (não derruba o lote inteiro).
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/worker_seed2.log" 2>&1
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('j',64), 'processing');
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    302, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-04-03', '2026-04-02',
    repeat('a',64), 'AGUARDANDO_PRODUCAO', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed do worker (edge #23) deu erro"; cat "$TMP/worker_seed2.log"; exit 1; fi

PROCESSAR2_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT id, status_para FROM hub_adiantamento_processar(200) ORDER BY id;
COMMIT;
SQL
)"
check "1.6.2 edge #23: 302 processado -> AGUARDANDO_PRODUCAO (espera)" "$(echo "$PROCESSAR2_OUT" | grep '^302|')" "302|AGUARDANDO_PRODUCAO"
N_302_TENTATIVAS="$(psql_t -tAc "SELECT tentativas_producao FROM \"AdiantamentoSolicitacao\" WHERE id=302;")"
check "1.6.2 edge #23: 302 tentativas_producao incrementada para 1" "$N_302_TENTATIVAS" "1"

# cleanup: a importação termina, não deve mais bloquear nada depois.
psql_t -c "UPDATE \"ImportacaoArquivo\" SET status='completed' WHERE hash_sha256=repeat('j',64);" >/dev/null

# --- 1.6.2 concorrência real: hub_adiantamento_processar pula linha travada
#     por outra sessão (FOR UPDATE SKIP LOCKED). Trava manual + sleep prova o
#     mecanismo de forma determinística (a alternativa, duas chamadas de
#     processar disparadas ao mesmo tempo, não garante overlap: a primeira
#     pode terminar e liberar a linha antes da segunda sequer começar).
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/worker_seed3.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    304, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-04-07', '2026-04-06',
    repeat('a',64), 'AGUARDANDO_PRODUCAO', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed do worker (concorrência 304) deu erro"; cat "$TMP/worker_seed3.log"; exit 1; fi

cat >"$TMP/lock_row.sql" <<'SQL'
BEGIN;
SELECT * FROM "AdiantamentoSolicitacao" WHERE id = 304 FOR UPDATE;
SELECT pg_sleep(2);
COMMIT;
SQL
psql_relaxed -f - <"$TMP/lock_row.sql" >"$TMP/lockrow.out" 2>&1 &
PLOCK=$!
sleep 0.5
PROC_RACE_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT id FROM hub_adiantamento_processar(200);
COMMIT;
SQL
)"
wait $PLOCK
N_304_PROCESSADO=$(echo "$PROC_RACE_OUT" | grep -c '^304$')
check "1.6.2 concorrência real: processar pula linha travada por outra sessão (SKIP LOCKED)" "$N_304_PROCESSADO" "0"
N_304_STATUS_POS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=304;")"
check "1.6.2 concorrência real: 304 continua AGUARDANDO_PRODUCAO (não processada)" "$N_304_STATUS_POS" "AGUARDANDO_PRODUCAO"

# --- 1.6.2: hub_adiantamento_lote_orfaos ------------------------------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/orfaos_seed.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id
) VALUES (
    305, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-04-05', '2026-04-04',
    repeat('a',64), 'EM_LOTE', gen_random_uuid(), 75.00,
    (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA')
);
INSERT INTO "AdiantamentoLote" (id, id_empresa, status, criado_por, criado_em, chave_idempotencia, quantidade, valor_total)
VALUES (901, 6, 'GERANDO', (SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), now() - interval '10 minutes', gen_random_uuid(), 1, 75.00);
INSERT INTO "AdiantamentoLoteItem" (lote_id, solicitacao_id, id_empresa, linha, col_nome, col_documento, col_banco, col_agencia, col_conta, col_digito, col_tipo_conta, valor, col_id_integracao, col_descricao_pix, conta_bancaria_id, situacao)
VALUES (901, 305, 6, 3, 'Fulano Teste', '**901', 'Banco do Brasil', '1234', '00012345', '6', 'Conta Corrente', 75.00, 'ADV-000305', 'Antecipação teste',
        (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA'), 'incluido');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de lote_orfaos deu erro"; cat "$TMP/orfaos_seed.log"; exit 1; fi

ORFAOS_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_orfaos(5);
COMMIT;
SQL
)"
check "1.6.2 lote_orfaos: lote 901 (GERANDO há 10min) devolvido pela RPC" "$(echo "$ORFAOS_OUT" | grep -c '^901|6$')" "1"
N_LOTE_901_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoLote\" WHERE id=901;")"
check "1.6.2 lote_orfaos: lote 901 -> CANCELADO (falha_geracao)" "$N_LOTE_901_STATUS" "CANCELADO"
N_SOL_305_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=305;")"
check "1.6.2 lote_orfaos: solicitação 305 volta a LIBERADA" "$N_SOL_305_STATUS" "LIBERADA"

# --- 1.6.2: hub_adiantamento_expurgo_arquivos -------------------------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/expurgo_seed.log" 2>&1
INSERT INTO "AdiantamentoLote" (id, id_empresa, status, criado_por, criado_em, chave_idempotencia, quantidade, valor_total, arquivo, arquivo_nome, arquivo_sha256, arquivo_bytes, gerado_em, concluido_em)
VALUES (902, 6, 'CONCLUIDO', (SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), now() - interval '120 days', gen_random_uuid(), 1, 50.00,
        decode('deadbeef','hex'), 'teste.xlsx', repeat('k',64), 4, now() - interval '115 days', now() - interval '95 days');
INSERT INTO "AdiantamentoLote" (id, id_empresa, status, criado_por, criado_em, chave_idempotencia, quantidade, valor_total, arquivo, arquivo_nome, arquivo_sha256, arquivo_bytes, cancelado_em, cancelado_motivo)
VALUES (903, 6, 'CANCELADO', (SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), now() - interval '200 days', gen_random_uuid(), 1, 30.00,
        decode('cafebabe','hex'), 'teste2.xlsx', repeat('l',64), 4, now() - interval '150 days', 'teste expurgo');
INSERT INTO "AdiantamentoLote" (id, id_empresa, status, criado_por, criado_em, chave_idempotencia, quantidade, valor_total, arquivo, arquivo_nome, arquivo_sha256, arquivo_bytes, gerado_em, concluido_em)
VALUES (904, 6, 'CONCLUIDO', (SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), now() - interval '10 days', gen_random_uuid(), 1, 20.00,
        decode('01020304','hex'), 'recente.xlsx', repeat('m',64), 4, now() - interval '9 days', now() - interval '5 days');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de expurgo_arquivos deu erro"; cat "$TMP/expurgo_seed.log"; exit 1; fi

EXPURGO_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_expurgo_arquivos(90);
COMMIT;
SQL
)"
N_EXPURGADOS=$(echo "$EXPURGO_OUT" | grep -cE '^90[23]\|6$')
check "1.6.2 expurgo_arquivos: 2 lotes expurgados (902 concluído, 903 cancelado, >90 dias)" "$N_EXPURGADOS" "2"
ARQ_902="$(psql_t -tAc "SELECT (arquivo IS NULL) || '|' || (arquivo_sha256 IS NOT NULL) || '|' || (arquivo_expurgado_em IS NOT NULL) FROM \"AdiantamentoLote\" WHERE id=902;")"
check "1.6.2 expurgo_arquivos: 902 zerou arquivo, manteve sha256, marcou expurgado_em" "$ARQ_902" "true|true|true"
ARQ_904="$(psql_t -tAc "SELECT arquivo IS NOT NULL FROM \"AdiantamentoLote\" WHERE id=904;")"
check "1.6.2 expurgo_arquivos: 904 (concluído há <90 dias) NÃO expurgado" "$ARQ_904" "t"

# --- 1.6.3: hub_adiantamento_repasse_fechar recusa PERIODO_EM_ABERTO --------
# fronteira via a função interna (instante injetável), config v2 (horario_corte=23:59):
# limite = (periodo_fim + 1) 23:59:00 America/Sao_Paulo.
FRONTEIRA_ANTES="$(psql_t -tAc "SELECT hub_adiantamento_repasse_pode_fechar(c, '2026-01-07'::date, '2026-01-08 23:58:59-03'::timestamptz) FROM \"AdiantamentoConfiguracao\" c WHERE c.versao=2 AND c.id_empresa=6;")"
check "1.6.3 fronteira: 1s antes do corte do dia seguinte -> não pode fechar (false)" "$FRONTEIRA_ANTES" "f"
FRONTEIRA_NO_CORTE="$(psql_t -tAc "SELECT hub_adiantamento_repasse_pode_fechar(c, '2026-01-07'::date, '2026-01-08 23:59:00-03'::timestamptz) FROM \"AdiantamentoConfiguracao\" c WHERE c.versao=2 AND c.id_empresa=6;")"
check "1.6.3 fronteira: no instante do corte do dia seguinte -> pode fechar (true)" "$FRONTEIRA_NO_CORTE" "t"

# fim-a-fim via a RPC pública, com now() real: período corrente (hoje) ainda
# não pode ter fechado — a produção de ontem ainda pode ser solicitada hoje.
ABERTO_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_repasse_fechar((current_date - 6)::date);
ROLLBACK;
SQL
)"
check "1.6.3: período corrente (hoje) -> PERIODO_EM_ABERTO" "$(echo "$ABERTO_OUT" | grep -c 'PERIODO_EM_ABERTO')" "1"

# --- 1.6.5 (dec-047): corte do tick deve considerar o DIA da solicitação ----
# fronteira via a função interna hub_adiantamento_corte_passou (mesmo padrão
# de 1.6.3), config v2 (horario_corte=23:59, timezone America/Sao_Paulo).
CORTE_ONTEM="$(psql_t -tAc "SELECT hub_adiantamento_corte_passou('2026-01-07'::date, '23:59'::time, 'America/Sao_Paulo', '2026-01-08 10:00:00-03'::timestamptz);")"
check "1.6.5 fronteira: solicitação de ontem é processada antes do corte de hoje" "$CORTE_ONTEM" "t"
CORTE_HOJE_ANTES="$(psql_t -tAc "SELECT hub_adiantamento_corte_passou('2026-01-08'::date, '23:59'::time, 'America/Sao_Paulo', '2026-01-08 10:00:00-03'::timestamptz);")"
check "1.6.5 fronteira: solicitação de hoje antes do corte não é processada" "$CORTE_HOJE_ANTES" "f"
CORTE_HOJE_NO_CORTE="$(psql_t -tAc "SELECT hub_adiantamento_corte_passou('2026-01-08'::date, '23:59'::time, 'America/Sao_Paulo', '2026-01-08 23:59:00-03'::timestamptz);")"
check "1.6.5 fronteira: solicitação de hoje exatamente no corte é processada" "$CORTE_HOJE_NO_CORTE" "t"

# fim-a-fim via hub_adiantamento_processar: 307 é de ONTEM (data_solicitacao =
# data de ontem no fuso da configuração, América/Sao_Paulo — dec-111/7.12:
# current_date puro é o fuso do container/UTC e diverge do fuso da config
# entre ~21h e meia-noite de Brasília) e continua AGUARDANDO_CORTE; com o
# defeito da dec-047 (comparação só de hora) só sairia desse estado às 23:59
# de HOJE — com a correção sai já nesta chamada, a qualquer hora, porque o
# corte DE ONTEM já passou. data_producao = ontem-1 não bate com nenhuma data
# fixa de produção seedada acima, então cai em AGUARDANDO_PRODUCAO (sem
# produção), igual ao 306.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/worker_seed4.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    307, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6),
    ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 2),
    repeat('a',64), 'AGUARDANDO_CORTE', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed do worker (1.6.5 corte de ontem) deu erro"; cat "$TMP/worker_seed4.log"; exit 1; fi

PROCESSAR3_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT id, status_para FROM hub_adiantamento_processar(200) ORDER BY id;
COMMIT;
SQL
)"
check "1.6.5 fim-a-fim: 307 (AGUARDANDO_CORTE de ontem) sai do estado na chamada de hoje" "$(echo "$PROCESSAR3_OUT" | grep -c '^307|')" "1"
N_307_STATUS="$(psql_t -tAc "SELECT status || '|' || tentativas_producao FROM \"AdiantamentoSolicitacao\" WHERE id=307;")"
check "1.6.5 fim-a-fim: 307 -> AGUARDANDO_PRODUCAO (sem produção na data), tentativas=1" "$N_307_STATUS" "AGUARDANDO_PRODUCAO|1"

# --- FASE 11 (converge onda-039, 11.2/migration 0075): hub_adiantamento_cancelar
# usa o corte DO DIA da solicitação, não o de hoje. 309 é AGUARDANDO_CORTE de
# ONTEM (mesmo padrão de 307 acima) com config v2 (horario_corte='23:59') —
# o corte de ONTEM já passou faz tempo, mas o corte de HOJE (23:59) ainda não.
# Com o defeito antigo (hub_adiantamento_janela(v_config, now())), o cancelamento
# seria aceito até 23:59 de hoje; com a correção, é recusado imediatamente.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/cancelar_ontem_seed.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    309, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6),
    -- -5 dias (não -1, como 307 acima) para não colidir com
    -- uniq_adiantamentosolicitacao_conta_dia (307 já ocupa a data de ontem
    -- para esta mesma conta_motorista_id).
    ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 5), ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 6),
    repeat('a',64), 'AGUARDANDO_CORTE', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de 309 (11.2) deu erro"; cat "$TMP/cancelar_ontem_seed.log"; exit 1; fi

CANCELAR_309_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_cancelar(309);
ROLLBACK;
SQL
)"
check "11.2: cancelar solicitação de ONTEM ainda AGUARDANDO_CORTE -> AFTER_CUTOFF (corte dela já passou, mesmo com o corte de HOJE longe)" \
  "$(echo "$CANCELAR_309_OUT" | grep -c 'AFTER_CUTOFF')" "1"
N_309_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=309;")"
check "11.2: 309 permanece AGUARDANDO_CORTE (cancelamento recusado, não CANCELADA)" "$N_309_STATUS" "AGUARDANDO_CORTE"

# --- 1.3: ramos novos da policy de INSERT de "Auditoria" (0069) -------------
# 1.3.1: motorista via app — id_empresa deve ser exatamente o do Entregador
# ativo vinculado ao CNPJ do claim (não um valor arbitrário do corpo).
AUD_MOTORISTA_OK_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101"}', true);
SET ROLE authenticated;
INSERT INTO "Auditoria" (id_empresa, acao, recurso, recurso_id, detalhes)
VALUES (6, 'adiantamento.solicitado', 'AdiantamentoSolicitacao', '999',
        jsonb_build_object('dataProducao', '2026-04-01', 'versaoConfiguracao', 1));
COMMIT;
SQL
)"
N_AUD_MOTORISTA_OK="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='adiantamento.solicitado' AND recurso_id='999';")"
check "1.3.1: motorista com id_empresa correto -> INSERT aceito" "$N_AUD_MOTORISTA_OK" "1"

AUD_MOTORISTA_FORJA_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101"}', true);
SET ROLE authenticated;
INSERT INTO "Auditoria" (id_empresa, acao, recurso, recurso_id, detalhes)
VALUES (999999, 'adiantamento.solicitado', 'AdiantamentoSolicitacao', '998', '{}'::jsonb);
COMMIT;
SQL
)"
check "1.3.1: motorista tentando forjar id_empresa de outra empresa -> RLS recusa" \
  "$(echo "$AUD_MOTORISTA_FORJA_OUT" | grep -c 'new row violates row-level security policy')" "1"

# 1.3.2: tick/worker com a claim hub_adiantamento_worker -> INSERT aceito
# (id_empresa vem do retorno real de hub_adiantamento_processar, não do corpo).
AUD_WORKER_OK_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
INSERT INTO "Auditoria" (id_empresa, acao, recurso, recurso_id, detalhes)
VALUES (6, 'adiantamento.calculado', 'AdiantamentoSolicitacao', '999',
        jsonb_build_object('valorLiquido', 129.00, 'motivo', 'OK'));
COMMIT;
SQL
)"
N_AUD_WORKER_OK="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='adiantamento.calculado' AND recurso_id='999';")"
check "1.3.2: worker com a claim -> INSERT aceito" "$N_AUD_WORKER_OK" "1"

# 1.3.3: INSERT de auditoria pelo worker SEM a claim é recusado pela RLS.
AUD_WORKER_SEM_CLAIM_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SET ROLE authenticated;
INSERT INTO "Auditoria" (id_empresa, acao, recurso, recurso_id, detalhes)
VALUES (6, 'adiantamento.calculado', 'AdiantamentoSolicitacao', '997', '{}'::jsonb);
COMMIT;
SQL
)"
check "1.3.3: INSERT de auditoria pelo worker sem a claim é recusado pela RLS" \
  "$(echo "$AUD_WORKER_SEM_CLAIM_OUT" | grep -c 'new row violates row-level security policy')" "1"

# 1.3.4: scan-auditoria-sensivel.sh não acusa achado nas novas ações (FR-047)
# — detalhes seedados só com ids/valores/datas, nunca documento/conta/bytes.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/auditoria_scan_seed.log" 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101"}', true);
SET ROLE authenticated;
INSERT INTO "Auditoria" (id_empresa, acao, recurso, recurso_id, detalhes) VALUES
  (6, 'conta_bancaria.solicitada', 'ContaBancariaMotorista', '1',
   jsonb_build_object('entregadorId', 1, 'motivo', 'CARGA_INICIAL'));
COMMIT;
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de auditoria (scan sensível) deu erro"; cat "$TMP/auditoria_scan_seed.log"; exit 1; fi
"$HUB_DIR/scripts/scan-auditoria-sensivel.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/scan_auditoria.log" 2>&1
SCAN_RC=$?
check "1.3.4: scan-auditoria-sensivel.sh sem achado nas novas ações" "$SCAN_RC" "0"
[ "$SCAN_RC" -eq 0 ] || cat "$TMP/scan_auditoria.log"

# --- 3.7: prévia (estimate), retrato gravado (contaMascarada/previsaoPagamento) e
#     versão de exibição vs identificador (dec-071, revisão da sessão pai sobre a
#     3.1 da onda-014) -------------------------------------------------------
# 3.7.1: hub_adiantamento_disponibilidade().estimate — config vigente aqui é a
# v3 (fonte financeiro_lancamento, categoria Corrida, percentual 60, taxa 0.35).
ESTIMATE_SEM_PRODUCAO_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (estimate->>'available'), (estimate->>'production') FROM hub_adiantamento_disponibilidade();
ROLLBACK;
SQL
)"
check "3.7.1: estimate.available=false sem produção D-1 ainda (production=null, nunca 0 fabricado)" \
  "$(echo "$ESTIMATE_SEM_PRODUCAO_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "false|"

psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/estimate_seed.log" 2>&1
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('n',64), 'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
VALUES (6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('n',64)),
  (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
  ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), 'Credito', 100.00, 'Corrida', repeat('o',64));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de produção D-1 (3.7.1) deu erro"; cat "$TMP/estimate_seed.log"; exit 1; fi

ESTIMATE_COM_PRODUCAO_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (estimate->>'available'), (estimate->>'production'), (estimate->>'gross'), (estimate->>'fee'), (estimate->>'net'), (estimate->>'final')
FROM hub_adiantamento_disponibilidade();
ROLLBACK;
SQL
)"
check "3.7.1: estimate com produção D-1 (100.00, 60%, taxa 0.35) -> bruto 60.00 / líquido 59.65" \
  "$(echo "$ESTIMATE_COM_PRODUCAO_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "true|100.00|60.00|0.35|59.65|false"

# 3.7.3: configuracao_id (PK) e configuracao_versao (exibição) são campos
# distintos — a config vigente aqui é a v3.
CONFIG_V3_ID="$(psql_t -tAc "SELECT id FROM \"AdiantamentoConfiguracao\" WHERE versao=3 AND id_empresa=6;")"
DISPONIB_VERSAO_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT configuracao_id, configuracao_versao FROM hub_adiantamento_disponibilidade();
ROLLBACK;
SQL
)"
check "3.7.3: disponibilidade separa configuracao_id (PK) de configuracao_versao (exibição)" \
  "$(echo "$DISPONIB_VERSAO_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "${CONFIG_V3_ID}|3"

# 3.7.2/3.7.3: hub_adiantamento_detalhe_motorista devolve o retrato GRAVADO
# (config e conta da solicitação), nunca o atual — config v4 na solicitação,
# v5 (com previsão DIFERENTE) vira a vigente depois, e a conta aprovada troca
# depois de gravado o snapshot 401.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/config_v4.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, previsao_pagamento_texto, descricao_pix_modelo)
VALUES (6, 4, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'PREVISAO_TESTE_A_v4', 'Antecipação {nome}');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de config v4 (3.7.2) deu erro"; cat "$TMP/config_v4.log"; exit 1; fi
CONFIG_V4_ID="$(psql_t -tAc "SELECT id FROM \"AdiantamentoConfiguracao\" WHERE versao=4 AND id_empresa=6;")"
CONTA_ANTIGA_ID="$(psql_t -tAc "SELECT id FROM \"ContaBancariaMotorista\" WHERE entregador_id=(SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA';")"

psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/snapshot_seed.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia,
    valor_liquido, conta_bancaria_id
) VALUES (
    401, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    ${CONFIG_V4_ID}, '2026-05-01', '2026-04-30', repeat('a',64), 'LIBERADA', gen_random_uuid(),
    59.65, ${CONTA_ANTIGA_ID}
);
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    402, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    ${CONFIG_V4_ID}, '2026-05-02', '2026-05-01', repeat('a',64), 'AGUARDANDO_CORTE', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de solicitações do snapshot (3.7.2) deu erro"; cat "$TMP/snapshot_seed.log"; exit 1; fi

# troca a conta aprovada DEPOIS de gravado o snapshot da 401 — o detalhe dela
# deve continuar mostrando a conta ANTIGA (agência 1234), nunca a nova (9999).
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/troca_conta.log" 2>&1
UPDATE "ContaBancariaMotorista" SET status='SUBSTITUIDA' WHERE id=${CONTA_ANTIGA_ID};
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')), 'APP', 'APROVADA', 'Fulano Teste', '12345678901', 'PF', '341', 'Itaú', '9999', '88887777', '1', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')), now());
SQL
if [ $? -ne 0 ]; then echo "FAIL: troca de conta aprovada (3.7.2) deu erro"; cat "$TMP/troca_conta.log"; exit 1; fi

# config v5, vigente a partir daqui, com previsão DIFERENTE — prova que o
# detalhe usa a config gravada na solicitação (v4), nunca a vigente atual.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/config_v5.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, previsao_pagamento_texto, descricao_pix_modelo)
VALUES (6, 5, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'PREVISAO_TESTE_B_v5_NUNCA_NO_DETALHE', 'Antecipação {nome}');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de config v5 (3.7.2) deu erro"; cat "$TMP/config_v5.log"; exit 1; fi

DETALHE_401_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (solicitacao->>'configuracao_versao'), (solicitacao->>'previsao_pagamento_texto'),
       (solicitacao->'conta_bancaria_mascarada'->>'agencia'), (solicitacao->'conta_bancaria_mascarada'->>'bancoNome')
FROM hub_adiantamento_detalhe_motorista(401);
ROLLBACK;
SQL
)"
check "3.7.2/3.7.3: detalhe LIBERADA mostra a config/conta GRAVADAS (v4/agência 1234), nunca as atuais (v5/9999)" \
  "$(echo "$DETALHE_401_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "4|PREVISAO_TESTE_A_v4|1234|Banco do Brasil"

DETALHE_402_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (solicitacao->>'previsao_pagamento_texto'), ((solicitacao->>'conta_bancaria_mascarada') IS NULL)
FROM hub_adiantamento_detalhe_motorista(402);
ROLLBACK;
SQL
)"
check "3.7.2: detalhe AGUARDANDO_CORTE (sem cálculo ainda) -> conta_bancaria_mascarada NULL, previsão já vem da config gravada" \
  "$(echo "$DETALHE_402_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "PREVISAO_TESTE_A_v4|t"

# --- FASE 11 (converge onda-039, 11.5/11.6/migration 0075): lote_previa/
# lote_criar não podem tratar como apta uma solicitação cuja conta gravada
# (401 -> CONTA_ANTIGA_ID, SUBSTITUIDA duas blocos acima) mudou depois da
# solicitação. FR-036 exige ação explícita do financeiro
# (hub_adiantamento_atualizar_conta) antes de incluir a solicitação em lote.
PREVIA_401_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT apta, motivo_pendencia FROM hub_adiantamento_lote_previa(ARRAY[401]::bigint[]);
COMMIT;
SQL
)"
check "11.5/11.6: lote_previa(401) com conta SUBSTITUIDA -> inapta/CONTA_ALTERADA" \
  "$(echo "$PREVIA_401_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "f|CONTA_ALTERADA"

LOTE_401_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_criar(ARRAY[401]::bigint[], 1, 59.65, gen_random_uuid());
ROLLBACK;
SQL
)"
check "11.6: lote_criar recusa solicitação com conta SUBSTITUIDA (PREVIA_DESATUALIZADA, não entra no lote/arquivo)" \
  "$(echo "$LOTE_401_OUT" | grep -c 'PREVIA_DESATUALIZADA')" "1"

# --- 3.2: hub_conta_bancaria_solicitar não derruba a conta aprovada anterior
#     (FR-017/edge #9-#10, US2 cenário 3) + hub_conta_bancaria_mascarar amplia
#     chavePixTipo/emailComprovante mascarado (3.2/dec-074) -----------------
CONTA_APROVADA_ANTES_ID="$(psql_t -tAc "SELECT id FROM \"ContaBancariaMotorista\" WHERE entregador_id=(SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA';")"

SOLICITAR_CONTA_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_conta_bancaria_solicitar(jsonb_build_object(
  'titularNome', 'Fulano Teste', 'titularDocumento', '12345678901',
  'bancoCodigo', '341', 'bancoNome', 'Itaú', 'agencia', '5555', 'conta', '99998888',
  'contaDigito', '2', 'tipoConta', 'CORRENTE',
  'chavePixTipo', 'EMAIL', 'chavePix', 'joana@gmail.com', 'emailComprovante', 'joana@gmail.com'));
COMMIT;
SQL
)"
check "3.2.5/FR-017/edge#9-10: nova solicitação de conta -> PENDENTE" \
  "$(echo "$SOLICITAR_CONTA_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "PENDENTE"

CONTA_APROVADA_STATUS_DEPOIS="$(psql_t -tAc "SELECT status FROM \"ContaBancariaMotorista\" WHERE id=${CONTA_APROVADA_ANTES_ID};")"
check "3.2.5/FR-017: conta APROVADA anterior continua APROVADA (a nova PENDENTE não derruba, US2 cenário 3)" \
  "$CONTA_APROVADA_STATUS_DEPOIS" "APROVADA"

DISPONIB_CONTA_APROVADA_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (conta_aprovada IS NOT NULL), (conta_pendente IS NOT NULL) FROM hub_adiantamento_disponibilidade();
ROLLBACK;
SQL
)"
check "3.2.5/FR-017: disponibilidade() continua vendo a conta aprovada mesmo com uma pendente nova" \
  "$(echo "$DISPONIB_CONTA_APROVADA_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "t|t"

CONTA_PENDENTE_MASCARADA_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (pendente->>'chavePixTipo'), (pendente->>'emailComprovante') FROM hub_conta_bancaria_motorista();
ROLLBACK;
SQL
)"
check "3.2/dec-074: hub_conta_bancaria_mascarar expõe chavePixTipo cru e emailComprovante mascarado (jo••••@•••.com)" \
  "$(echo "$CONTA_PENDENTE_MASCARADA_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "EMAIL|jo••••@•••.com"

# --- 3.8: prévia (estimate) e solicitação real concordam quando a produção
#     D-1 é menor que a taxa fixa (dec-076, revisão da sessão pai sobre a
#     3.7 da onda-015): antes desta correção, `estimate.net` saía negativo
#     mesmo quando a mesma produção, ao ser processada pelo tick, cairia em
#     INELEGIVEL/VALOR_INSUFICIENTE — categoria própria ('CorridaBaixa') e
#     config v6 isolam este teste da produção 'Corrida'=100.00 já semeada
#     acima para o mesmo entregador/dia (3.7.1). ------------------------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/insuficiente_seed.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo)
VALUES (6, 6, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '00:01', 60.00, 0.35, 'financeiro_lancamento', ARRAY['CorridaBaixa'], 'entre 17h e 18h de hoje', 'Antecipação {nome}');

INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('q',64), 'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
VALUES (6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('q',64)),
  (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
  ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 1), 'Credito', 0.30, 'CorridaBaixa', repeat('r',64));
-- mesma produção insuficiente (0.30), mas numa data fixa no passado — usada
-- pela solicitação real do 3.8.2 abaixo (corte já passado, ao contrário de
-- hoje, cujo corte só passaria às 00:01 — mesmo motivo de 306/307 usarem
-- datas fixas em vez de "hoje").
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
VALUES (6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('q',64)),
  (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
  '2026-04-19', '2026-04-19', 'Credito', 0.30, 'CorridaBaixa', repeat('s',64));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de produção insuficiente (3.8) deu erro"; cat "$TMP/insuficiente_seed.log"; exit 1; fi

# 3.8.1: config v6 (vigente_desde mais recente) vira a vigente — a prévia
# usa a produção 0.30 de 'CorridaBaixa': bruto 0.18 (60%), líquido -0.17
# (0.18 - 0.35) — exatamente o exemplo do tasks.md 3.8.1.
DISPONIB_INSUF_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT (estimate->>'available'), (estimate->>'production'), (estimate->>'gross'), (estimate->>'net'), (estimate->>'eligible')
FROM hub_adiantamento_disponibilidade();
ROLLBACK;
SQL
)"
check "3.8.1: produção 0.30 x taxa 0.35 (config v6) -> estimate.net NULL, eligible=false (nunca negativo)" \
  "$(echo "$DISPONIB_INSUF_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" \
  "true|0.30|0.18||false"

# 3.8.2: a MESMA produção, numa solicitação real processada pelo tick
# (corte já passado), cai em INELEGIVEL/VALOR_INSUFICIENTE — provando que a
# prévia e a solicitação concordam (mesma regra, hub_adiantamento_elegibilidade).
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/insuficiente_solicitacao.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
) VALUES (
    308, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=6 AND id_empresa=6),
    '2026-04-20', '2026-04-19', repeat('a',64), 'AGUARDANDO_CORTE', gen_random_uuid()
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed da solicitação 308 (3.8.2) deu erro"; cat "$TMP/insuficiente_solicitacao.log"; exit 1; fi

PROCESSAR_INSUF_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
SELECT id, status_para FROM hub_adiantamento_processar(200) ORDER BY id;
COMMIT;
SQL
)"
check "3.8.2: 308 processado -> INELEGIVEL (mesmo caso da prévia 3.8.1)" "$(echo "$PROCESSAR_INSUF_OUT" | grep '^308|')" "308|INELEGIVEL"
N_308_MOTIVO="$(psql_t -tAc "SELECT status || '|' || motivo_status || '|' || valor_liquido FROM \"AdiantamentoSolicitacao\" WHERE id=308;")"
check "3.8.2: 308 motivo_status=VALOR_INSUFICIENTE, valor_liquido=-0.17 (prévia e solicitar concordam)" "$N_308_MOTIVO" "INELEGIVEL|VALOR_INSUFICIENTE|-0.17"

# --- 4.3 (onda-017, dec-082): origem no jsonb mascarado/completo +
#     elegibilidade real de hub_conta_bancaria_aprovar_lote (Q-N5) — correção
#     empírica desta onda em 0067 (0067 só existiu em stacks efêmeros até
#     aqui, mesmo critério de dec-053/1.6). Motorista/entregador NOVO só para
#     este bloco: o de 33333333000101 já tem uma PENDENTE (origem APP,
#     criada em 3.2.5 acima) e o índice único parcial só permite 1 PENDENTE
#     por entregador — reusamos essa PENDENTE origem=APP como o caso
#     NEGATIVO (ORIGEM_INVALIDA) do lote. -------------------------------
echo ""
echo "--- 4.3 (onda-017): origem no jsonb + aprovar_lote elegibilidade (dec-082) ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/aprovar_lote_seed.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('44444444000101', 'Carga Inicial Teste');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
VALUES (6, gen_random_uuid(), 'Carga Inicial Teste', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000101'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta)
VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000101')), 'CARGA_INICIAL', 'PENDENTE', 'Carga Inicial Teste', '98765432100', 'PF', '341', 'Itaú', '1111', '22223333', '4', 'CORRENTE');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed do motorista/conta CARGA_INICIAL (4.3) deu erro"; cat "$TMP/aprovar_lote_seed.log"; exit 1; fi

CARGA_INICIAL_CONTA_ID="$(psql_t -tAc "SELECT id FROM \"ContaBancariaMotorista\" WHERE entregador_id=(SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='44444444000101'));")"
APP_PENDENTE_CONTA_ID="$(psql_t -tAc "SELECT id FROM \"ContaBancariaMotorista\" WHERE entregador_id=(SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='33333333000101')) AND status='PENDENTE' AND origem='APP';")"

ORIGEM_MASCARADA_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT hub_conta_bancaria_detalhe(${CARGA_INICIAL_CONTA_ID}, false)->>'origem';
ROLLBACK;
SQL
)"
check "4.3/dec-082: hub_conta_bancaria_detalhe(completo=false) expõe origem" \
  "$(echo "$ORIGEM_MASCARADA_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "CARGA_INICIAL"

ORIGEM_LISTAR="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT dados->>'origem' FROM hub_conta_bancaria_listar('PENDENTE', 1, 100) WHERE (dados->>'id')::bigint = ${CARGA_INICIAL_CONTA_ID};
ROLLBACK;
SQL
)"
check "4.3/dec-082: hub_conta_bancaria_listar expõe origem" \
  "$(echo "$ORIGEM_LISTAR" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "CARGA_INICIAL"

APROVAR_LOTE_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id, aprovada, motivo_ignorada FROM hub_conta_bancaria_aprovar_lote(ARRAY[${CARGA_INICIAL_CONTA_ID}, ${APP_PENDENTE_CONTA_ID}]::bigint[]) ORDER BY id;
COMMIT;
SQL
)"
RESULTADO_APROVAR="$(echo "$APROVAR_LOTE_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$')"
check "4.3.5/Q-N5/dec-082: CARGA_INICIAL+PENDENTE sem alertas -> aprovada" \
  "$(echo "$RESULTADO_APROVAR" | grep "^${CARGA_INICIAL_CONTA_ID}|")" "${CARGA_INICIAL_CONTA_ID}|t|"
check "4.3.5/Q-N5/dec-082: origem=APP -> ignorada com motivo ORIGEM_INVALIDA" \
  "$(echo "$RESULTADO_APROVAR" | grep "^${APP_PENDENTE_CONTA_ID}|")" "${APP_PENDENTE_CONTA_ID}|f|ORIGEM_INVALIDA"

STATUS_DEPOIS_LOTE="$(psql_t -tAc "SELECT status FROM \"ContaBancariaMotorista\" WHERE id=${CARGA_INICIAL_CONTA_ID};")"
check "4.3.5: conta CARGA_INICIAL realmente virou APROVADA (não só reportada)" "$STATUS_DEPOIS_LOTE" "APROVADA"
STATUS_APP_INTOCADA="$(psql_t -tAc "SELECT status FROM \"ContaBancariaMotorista\" WHERE id=${APP_PENDENTE_CONTA_ID};")"
check "4.3.5: conta origem=APP ignorada permanece PENDENTE (não tocada)" "$STATUS_APP_INTOCADA" "PENDENTE"

# --- 4.7.4/1.4.5 (paridade Node/SQL): JWT do PostgREST usado DIRETAMENTE
#     (sem passar pelo requirePermission do Node) ainda é barrado pela RPC.
#     `sub=999` já prova isso para `hub_adiantamento_encerrar_falha`
#     (D-23, bloco acima); aqui ampliamos a evidência para uma RPC nova
#     desta onda com uma permissão DIFERENTE ('configurar') — mesma barreira
#     `hub_adiantamento_tem_permissao`, chamada em toda RPC sensível das
#     rotas novas de FASE 4 (configuracao_salvar/lote_criar/repasse_fechar/
#     conta_bancaria_aprovar*/reprocessar/conta_bancaria_detalhe completo). --
SEM_PERM_CONFIG_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"999","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_configuracao_salvar(6, '{}'::jsonb);
ROLLBACK;
SQL
)"
check "4.7.4/1.4.5: hub_adiantamento_configuracao_salvar sem RBAC (permissão 'configurar') -> PERMISSAO_NEGADA mesmo sem o Node" \
  "$(echo "$SEM_PERM_CONFIG_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"

# --- 2.1.5: hub_adiantamento_janela (SQL) x janela() (JS) — mesmos vetores --
echo ""
echo "--- 2.1.5: hub_adiantamento_janela SQL x janela() JS (vetores compartilhados) ---"
VETORES_JSON="$(cd "$HUB_DIR/../.." && pwd)/app_homologacao/backend/tests/fixtures/adiantamento-janela-vetores.json"
if [ ! -f "$VETORES_JSON" ]; then
  echo "FAIL: 2.1.5 — fixture de vetores não encontrada: $VETORES_JSON"
  fails=$((fails + 1))
else
  # Config sintética via jsonb_populate_record — NÃO usa hub_adiantamento_config_vigente(6):
  # a essa altura do driver a empresa 6 já tem várias versões semeadas pelas seções
  # anteriores (1.6.x cria config v3 com corte propositalmente já passado para testar o
  # tick), então "a vigente agora" não é mais a v1 (seg-sáb 09:00-15:00) do vetores.json.
  # jsonb_populate_record cria um "AdiantamentoConfiguracao" isolado só com os 4 campos
  # que hub_adiantamento_janela lê, direto do MESMO "config" do fixture (zero duplicação).
  CONFIG_JSON="$(jq -c '.config' "$VETORES_JSON")"
  N_VETORES="$(jq '.vetores | length' "$VETORES_JSON")"
  for _i in $(seq 0 $((N_VETORES - 1))); do
    _desc="$(jq -r ".vetores[$_i].descricao" "$VETORES_JSON")"
    _instante="$(jq -r ".vetores[$_i].instante" "$VETORES_JSON")"
    _exp_ds="$(jq -r ".vetores[$_i].esperado.data_solicitacao" "$VETORES_JSON")"
    _exp_dp="$(jq -r ".vetores[$_i].esperado.data_producao" "$VETORES_JSON")"
    _exp_dh="$(jq -r ".vetores[$_i].esperado.dia_habilitado" "$VETORES_JSON")"
    _exp_aa="$(jq -r ".vetores[$_i].esperado.antes_abertura" "$VETORES_JSON")"
    _exp_ac="$(jq -r ".vetores[$_i].esperado.apos_corte" "$VETORES_JSON")"

    _resultado="$(psql_t -tAc "SELECT data_solicitacao, data_producao, dia_habilitado, antes_abertura, apos_corte FROM hub_adiantamento_janela(jsonb_populate_record(NULL::\"AdiantamentoConfiguracao\", '${CONFIG_JSON}'::jsonb), '${_instante}'::timestamptz);")"
    _obt_ds="$(echo "$_resultado" | cut -d'|' -f1)"
    _obt_dp="$(echo "$_resultado" | cut -d'|' -f2)"
    _obt_dh_raw="$(echo "$_resultado" | cut -d'|' -f3)"
    _obt_aa_raw="$(echo "$_resultado" | cut -d'|' -f4)"
    _obt_ac_raw="$(echo "$_resultado" | cut -d'|' -f5)"
    [ "$_obt_dh_raw" = "t" ] && _obt_dh=true || _obt_dh=false
    [ "$_obt_aa_raw" = "t" ] && _obt_aa=true || _obt_aa=false
    [ "$_obt_ac_raw" = "t" ] && _obt_ac=true || _obt_ac=false

    check "2.1.5 [$_desc] data_solicitacao" "$_obt_ds" "$_exp_ds"
    check "2.1.5 [$_desc] data_producao" "$_obt_dp" "$_exp_dp"
    check "2.1.5 [$_desc] dia_habilitado" "$_obt_dh" "$_exp_dh"
    check "2.1.5 [$_desc] antes_abertura" "$_obt_aa" "$_exp_aa"
    check "2.1.5 [$_desc] apos_corte" "$_obt_ac" "$_exp_ac"
  done
fi

# --- FASE 5 (5.2.1/5.2.3/SC-008): hub_adiantamento_notificar — todos os
# eventos do sistema geram NotificacaoMotorista visível mesmo sem push
# habilitado; 'criada' e evento desconhecido são no-op deliberado; a função
# é interna (REVOKE FROM PUBLIC). Seed isolado (CNPJ/config/versão próprios)
# para não depender do estado acumulado pelas seções anteriores. ------------
echo ""
echo "--- FASE 5 (5.2.1/5.2.3/SC-008): hub_adiantamento_notificar — eventos do sistema ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_f5.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo) VALUES ('55555555000101', 'F5 Sem Push', true);
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (6, gen_random_uuid(), 'F5 Sem Push', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000101'));
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato)
VALUES (6, 90, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'entre 17h e 18h de hoje', 'Antecipação {data_producao:DD.MM.AA}_{nome}', 0, 2, 'data_lancamento', ARRAY['Corrida']);
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id, data_solicitacao, data_producao, aceite_texto_sha256, status, motivo_status, chave_idempotencia)
VALUES (6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000101'), '55555555000101',
        (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000101')),
        (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 AND versao=90),
        current_date, current_date - 1, repeat('a',64), 'AGUARDANDO_CORTE', NULL, gen_random_uuid());
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed FASE5 deu erro"; cat "$TMP/seed_f5.log"; exit 1; fi

SOL_F5="$(psql_t -tAc "SELECT id FROM \"AdiantamentoSolicitacao\" WHERE cnpj_prestador='55555555000101'")"
ENTREGADOR_F5="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='55555555000101')")"

# Dispara os 10 eventos "reais" (exclui 'criada' e um evento desconhecido,
# ambos no-op deliberado) na mesma ordem do PLANO §19/D-23.
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/notificar_f5.log" 2>&1
SELECT hub_adiantamento_notificar($SOL_F5, 'liberada');
SELECT hub_adiantamento_notificar($SOL_F5, 'inelegivel');
SELECT hub_adiantamento_notificar($SOL_F5, 'rejeitada');
SELECT hub_adiantamento_notificar($SOL_F5, 'encerrada');
SELECT hub_adiantamento_notificar($SOL_F5, 'encerrada_sem_pagamento');
SELECT hub_adiantamento_notificar($SOL_F5, 'lote_exportado');
SELECT hub_adiantamento_notificar($SOL_F5, 'lote_pago');
SELECT hub_adiantamento_notificar($SOL_F5, 'lote_falhou');
SELECT hub_adiantamento_notificar(NULL, 'conta_aprovada', $ENTREGADOR_F5);
SELECT hub_adiantamento_notificar(NULL, 'conta_rejeitada', $ENTREGADOR_F5);
SELECT hub_adiantamento_notificar($SOL_F5, 'criada');
SELECT hub_adiantamento_notificar($SOL_F5, 'evento_desconhecido');
SQL
if [ $? -ne 0 ]; then echo "FAIL: chamadas hub_adiantamento_notificar deram erro"; cat "$TMP/notificar_f5.log"; exit 1; fi

N_NOTIF_F5="$(psql_t -tAc "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='55555555000101'")"
check "5.2.1/5.2.3: 10 eventos reais geram 10 NotificacaoMotorista ('criada'/evento desconhecido são no-op)" "$N_NOTIF_F5" "10"

N_ENTREGA_F5="$(psql_t -tAc "SELECT count(*) FROM \"AvisoEntrega\" WHERE cnpj_prestador='55555555000101'")"
check "5.2.3/SC-008: 0 AvisoEntrega (motorista sem push) — notificação ainda assim gravada em NotificacaoMotorista" "$N_ENTREGA_F5" "0"

MAPA_F5="$(psql_t -tAc "SELECT string_agg(categoria || ':' || titulo, '|' ORDER BY id) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='55555555000101'")"
check "5.2.1: categoria/título de cada evento batem com PLANO §19/D-23" "$MAPA_F5" \
  "adiantamento:Adiantamento liberado|adiantamento:Adiantamento inelegível|adiantamento:Solicitação rejeitada|adiantamento:Adiantamento inelegível|pagamento:Pagamento não realizado|pagamento:Pagamento em processamento|pagamento:Pagamento realizado|pagamento:Pagamento falhou|conta_bancaria:Conta bancária aprovada|conta_bancaria:Conta bancária rejeitada"

# Aviso sem nenhuma AvisoEntrega nasce 'concluido' (nada para o push-worker
# processar) — mesma regra de hub_aviso_criar (0068).
N_AVISO_NAO_CONCLUIDO_F5="$(psql_t -tAc "SELECT count(*) FROM \"Aviso\" a JOIN \"NotificacaoMotorista\" nm ON nm.aviso_id=a.id WHERE nm.cnpj_prestador='55555555000101' AND a.status <> 'concluido'")"
check "5.2.1: Aviso sem push nasce 'concluido'" "$N_AVISO_NAO_CONCLUIDO_F5" "0"

NEGADO_NOTIFICAR_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SET ROLE authenticated;
SELECT hub_adiantamento_notificar($SOL_F5, 'liberada');
ROLLBACK;
SQL
)"
check "5.2: hub_adiantamento_notificar é função interna — authenticated recebe permission denied" \
  "$(echo "$NEGADO_NOTIFICAR_OUT" | grep -c 'permission denied for function')" "1"

# --- 7.11.1 (dec-105): hub_conta_bancaria_listar aceita origem/semAlertas/
# busca/banco (cada um e combinados) — H06 do protótipo aprovado (0067 só
# existiu em stacks efêmeros até aqui, mesmo critério de dec-053/1.6/dec-082).
# Seed isolado com prefixo "Zeta Filtro" para não depender/colidir com o
# estado acumulado pelas seções 3.x/4.x acima. -----------------------------
echo ""
echo "--- 7.11.1 (dec-105): hub_conta_bancaria_listar — filtros origem/semAlertas/busca/banco ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_711.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES
  ('66666666000101', 'Zeta Filtro Um'), ('66666666000102', 'Zeta Filtro Dois'), ('66666666000103', 'Zeta Filtro Tres');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), nome, id FROM "ContaMotorista" WHERE cnpj_prestador IN ('66666666000101','66666666000102','66666666000103');
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, alertas)
VALUES
  (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='66666666000101')), 'APP', 'PENDENTE', 'Zeta Filtro Um', '66666666000101', 'PJ', '077', 'Banco Inter', '0001', '11110001', '0', 'CORRENTE', '[]'),
  (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='66666666000102')), 'CARGA_INICIAL', 'PENDENTE', 'Zeta Filtro Dois', '66666666000102', 'PJ', '260', 'Nu Pagamentos', '0001', '11110002', '0', 'CORRENTE', '["TITULAR_DIFERENTE"]'),
  (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='66666666000103')), 'CARGA_INICIAL', 'PENDENTE', 'Zeta Filtro Tres', '66666666000103', 'PJ', '077', 'Banco Inter', '0001', '11110003', '0', 'CORRENTE', '[]');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed 7.11.1 deu erro"; cat "$TMP/seed_711.log"; exit 1; fi

listar_711() { # listar_711 <args nomeados do RPC, ex: "p_origem:='APP'">
  psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT COALESCE(string_agg(dados->>'titularNome', ',' ORDER BY dados->>'titularNome'), '(nenhum)')
FROM hub_conta_bancaria_listar(p_pagina:=1, p_tamanho_pagina:=100, $1)
WHERE dados->>'titularNome' LIKE 'Zeta Filtro%';
ROLLBACK;
SQL
}
extrair_711() { echo "$1" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1; }

check "7.11.1: origem=APP -> só Um" "$(extrair_711 "$(listar_711 "p_origem:='APP'")")" "Zeta Filtro Um"
check "7.11.1: origem=CARGA_INICIAL -> Dois+Tres" "$(extrair_711 "$(listar_711 "p_origem:='CARGA_INICIAL'")")" "Zeta Filtro Dois,Zeta Filtro Tres"
check "7.11.1: semAlertas=true -> Tres+Um (sem alertas)" "$(extrair_711 "$(listar_711 "p_sem_alertas:=true")")" "Zeta Filtro Tres,Zeta Filtro Um"
check "7.11.1: semAlertas=false -> só Dois (TITULAR_DIFERENTE)" "$(extrair_711 "$(listar_711 "p_sem_alertas:=false")")" "Zeta Filtro Dois"
check "7.11.1: banco=077 -> Tres+Um" "$(extrair_711 "$(listar_711 "p_banco:='077'")")" "Zeta Filtro Tres,Zeta Filtro Um"
check "7.11.1: busca por nome (case-insensitive, hub_normaliza_nome) -> só Dois" "$(extrair_711 "$(listar_711 "p_busca:='ZETA FILTRO DOIS'")")" "Zeta Filtro Dois"
check "7.11.1: busca por documento com máscara (dígitos extraídos) -> só Dois" "$(extrair_711 "$(listar_711 "p_busca:='66.666666/0001-02'")")" "Zeta Filtro Dois"
check "7.11.1: combinado origem+semAlertas+banco -> só Tres" \
  "$(extrair_711 "$(listar_711 "p_origem:='CARGA_INICIAL', p_sem_alertas:=true, p_banco:='077'")")" "Zeta Filtro Tres"
check "7.11.1: combinado sem match (origem=APP + banco=260) -> vazio" \
  "$(extrair_711 "$(listar_711 "p_origem:='APP', p_banco:='260'")")" "(nenhum)"


# --- 10.2.1: hub_conta_bancaria_carga_inicial (migration 0072) — a 8.1.7 só
# verificou isso num postgres:13 avulso descartado; aqui é a corrida real
# contra o stack hub-test-* deste driver. --------------------------------
echo ""
echo "--- 10.2.1: hub_conta_bancaria_carga_inicial (RPC de carga inicial, migration 0072) ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_carga.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('77777777000101', 'Carga Inicial Teste');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
VALUES (6, gen_random_uuid(), 'Carga Inicial Teste', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000101'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed 10.2.1 (carga inicial) deu erro"; cat "$TMP/seed_carga.log"; exit 1; fi
ID_ENTREGADOR_CARGA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='77777777000101');")"
DADOS_CARGA='{"titularNome":"Carga Inicial Teste","titularDocumento":"77777777000101","titularTipo":"PJ","bancoCodigo":"001","bancoNome":"Banco do Brasil","agencia":"1234","conta":"00012345","contaDigito":"6","tipoConta":"CORRENTE"}'

NEGADO_CARGA_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SET ROLE authenticated;
SELECT * FROM hub_conta_bancaria_carga_inicial($ID_ENTREGADOR_CARGA, '$DADOS_CARGA'::jsonb);
ROLLBACK;
SQL
)"
check "10.2.1: sem claim hub_carga_inicial_worker -> PERMISSAO_NEGADA" \
  "$(echo "$NEGADO_CARGA_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"

CARGA1_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_carga_inicial_worker":true}', true);
SET ROLE authenticated;
SELECT id, criada FROM hub_conta_bancaria_carga_inicial($ID_ENTREGADOR_CARGA, '$DADOS_CARGA'::jsonb);
COMMIT;
SQL
)"
check "10.2.1: 1ª chamada cria conta (criada=t)" "$(echo "$CARGA1_OUT" | grep -c '|t$')" "1"
N_CONTAS_CARGA="$(psql_t -tAc "SELECT count(*) FROM \"ContaBancariaMotorista\" WHERE entregador_id=$ID_ENTREGADOR_CARGA;")"
check "10.2.1: exatamente 1 linha criada" "$N_CONTAS_CARGA" "1"
N_STATUS_ORIGEM="$(psql_t -tAc "SELECT status || '|' || origem FROM \"ContaBancariaMotorista\" WHERE entregador_id=$ID_ENTREGADOR_CARGA;")"
check "10.2.1: status=PENDENTE, origem=CARGA_INICIAL" "$N_STATUS_ORIGEM" "PENDENTE|CARGA_INICIAL"

CARGA2_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_carga_inicial_worker":true}', true);
SET ROLE authenticated;
SELECT id, criada FROM hub_conta_bancaria_carga_inicial($ID_ENTREGADOR_CARGA, '$DADOS_CARGA'::jsonb);
COMMIT;
SQL
)"
check "10.2.1: 2ª chamada (mesmo entregador) não duplica (criada=f)" "$(echo "$CARGA2_OUT" | grep -c '|f$')" "1"
N_CONTAS_CARGA2="$(psql_t -tAc "SELECT count(*) FROM \"ContaBancariaMotorista\" WHERE entregador_id=$ID_ENTREGADOR_CARGA;")"
check "10.2.1: ainda exatamente 1 linha (idempotência)" "$N_CONTAS_CARGA2" "1"

NEGADO_ENTREGADOR_OUT="$(psql_t -tA -F'|' <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_carga_inicial_worker":true}', true);
SET ROLE authenticated;
SELECT * FROM hub_conta_bancaria_carga_inicial(999999999, '{}'::jsonb);
ROLLBACK;
SQL
)"
check "10.2.1: entregador inexistente -> ENTREGADOR_NAO_ENCONTRADO" \
  "$(echo "$NEGADO_ENTREGADOR_OUT" | grep -c 'ENTREGADOR_NAO_ENCONTRADO')" "1"

NEGADO_SELECT_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SET ROLE authenticated;
SELECT count(*) FROM "ContaBancariaMotorista" WHERE entregador_id=$ID_ENTREGADOR_CARGA;
ROLLBACK;
SQL
)"
check "10.2.1: authenticated continua sem SELECT direto em ContaBancariaMotorista (dec-023)" \
  "$(echo "$NEGADO_SELECT_OUT" | grep -c 'permission denied')" "1"


# --- FASE 9 (tasks.md 9.1.7, dec-129): retorno da Transfeera aplicado sobre
# um lote real deste stack. `lib/adiantamento-retorno-transfeera.js` é PURO
# (9.1.1/9.1.2) e já tem cobertura sintética exaustiva em
# tests/adiantamento-retorno-transfeera-unit.test.js (9.1.6) — aqui o que
# falta provar é que o `p_falhas` que ele produz realmente move o estado
# via `hub_adiantamento_lote_confirmar` contra o Postgres/migrations reais
# (0066/0067), e que a solicitação que falhou continua reprocessável pelo
# fluxo já existente (D-23, hub_adiantamento_reprocessar) — 9.1.4. Roda o
# lib no HOST (Node puro, sem I/O de rede — não precisa do container
# `backend`) para computar `p_falhas` a partir de um CSV sintético com o
# MESMO shape usado no unit test, e alimenta esse JSON na RPC real. --------
echo ""
echo "--- FASE 9 (9.1.7): retorno da Transfeera — lib + hub_adiantamento_lote_confirmar sobre lote real ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_retorno.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('55555555000100', 'Retorno Transfeera Teste');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
VALUES (6, gen_random_uuid(), 'Retorno Transfeera Teste', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')), 'CARGA_INICIAL', 'APROVADA', 'Retorno Transfeera Teste', '98765432100', 'PF', '001', 'Banco do Brasil', '4321', '00098765', '3', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')), now());
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id
) VALUES
(601, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100'), '55555555000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-03-01', '2026-02-28',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 129.40,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')) AND status='APROVADA')),
(602, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100'), '55555555000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-03-02', '2026-03-01',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 80.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')) AND status='APROVADA'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed FASE 9 (retorno) deu erro"; cat "$TMP/seed_retorno.log"; exit 1; fi

LOTE_RETORNO_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id, status FROM hub_adiantamento_lote_criar(ARRAY[601,602]::bigint[], 2, 209.40, gen_random_uuid());
COMMIT;
SQL
)"
LOTE_RETORNO_ROW="$(echo "$LOTE_RETORNO_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
LOTE_RETORNO_ID="$(echo "$LOTE_RETORNO_ROW" | cut -d'|' -f1)"
check "9.1.7: lote real criado (GERANDO) para o cenário de retorno" "$(echo "$LOTE_RETORNO_ROW" | cut -d'|' -f2)" "GERANDO"

# GERANDO -> GERADO -> EXPORTADO/EXPORTADA (hub_adiantamento_lote_confirmar só
# aceita lote EXPORTADO — mesmo caminho que /lotes/:id/confirmacao percorre
# em produção via /lotes (gera arquivo) + GET /lotes/:id/arquivo (1º download)).
CONTEUDO_B64="$(printf 'conteudo-teste-retorno-fase9' | base64 -w0 2>/dev/null || printf 'conteudo-teste-retorno-fase9' | base64)"
SHA256_ARQUIVO="$(printf 'conteudo-teste-retorno-fase9' | sha256sum | cut -d' ' -f1)"
ARQUIVO_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_arquivo($LOTE_RETORNO_ID, '$CONTEUDO_B64', '$SHA256_ARQUIVO', 29, 'retorno-teste-fase9.xlsx');
COMMIT;
SQL
)"
check "9.1.7: lote_arquivo -> GERADO" "$(echo "$ARQUIVO_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "GERADO"

DOWNLOAD_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT arquivo_base64, sha256, nome, downloads FROM hub_adiantamento_lote_download($LOTE_RETORNO_ID);
COMMIT;
SQL
)"
DOWNLOAD1_LINE="$(echo "$DOWNLOAD_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
check "9.1.7: 1º download -> EXPORTADO/EXPORTADA (downloads=1)" "$(echo "$DOWNLOAD1_LINE" | cut -d'|' -f4)" "1"

# 10.5.19 edge#19: download repetido sempre devolve o MESMO conteúdo —
# 2ª chamada em transação NOVA (não reaproveita v_lote da 1ª), compara
# arquivo_base64/sha256/nome byte a byte contra a 1ª (não só downloads++).
DOWNLOAD2_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT arquivo_base64, sha256, nome, downloads FROM hub_adiantamento_lote_download($LOTE_RETORNO_ID);
COMMIT;
SQL
)"
DOWNLOAD2_LINE="$(echo "$DOWNLOAD2_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
check "10.5.19 edge#19: 2º download -> downloads=2 (contador avança)" "$(echo "$DOWNLOAD2_LINE" | cut -d'|' -f4)" "2"
check "10.5.19 edge#19: 2º download -> mesmo arquivo_base64 do 1º (byte a byte)" \
  "$(echo "$DOWNLOAD2_LINE" | cut -d'|' -f1)" "$(echo "$DOWNLOAD1_LINE" | cut -d'|' -f1)"
check "10.5.19 edge#19: 2º download -> mesmo sha256+nome do 1º" \
  "$(echo "$DOWNLOAD2_LINE" | cut -d'|' -f2,3)" "$(echo "$DOWNLOAD1_LINE" | cut -d'|' -f2,3)"

# `lib/adiantamento-retorno-transfeera.js` roda no HOST (puro, sem I/O de
# rede) contra um CSV sintético com o MESMO shape/contrato do unit test —
# nenhuma linha do arquivo real do operador entra aqui.
BACKEND_DIR="$HUB_DIR/../../app_homologacao/backend"
cat >"$TMP/calc_falhas_fase9.js" <<'JS'
'use strict';
// require() resolve caminho relativo pelo diretório do PRÓPRIO arquivo
// (este script vive em $TMP, não em backend/) — por isso o caminho é
// montado a partir de process.cwd() (backend/, setado pelo `cd` do bash
// abaixo), nunca um `./lib/...` relativo a este arquivo.
const { lerCsv, casarComItensDoLote } = require(`${process.cwd()}/lib/adiantamento-retorno-transfeera`);

const csv = [
  'ID da transferência,ID de integração,Status,Valor,Pago em,Criado em,Método de pagamento,Código Bancário,Nome do recebedor,CPF/CNPJ do recebedor,Tipo de chave Pix do recebedor,Chave Pix,Número da conta,Número da agência,Tipo de conta,Código do banco,Nome do banco,ID do lote,Nome do lote,Recibo bancário,Recibo Transfeera,Código de erro,Motivo da falha',
  'tr_9_1_7_a,ADV-000601,Finalizada,129.40,17/09/2026 10:00:00,16/09/2026 09:00:00,pix,001,Fulano Sintetico,00000000000,cpf,00000000000,00098765,4321,conta_corrente,001,Banco Sintetico,lote_teste,lote teste,,rec_9_1_7_a,,',
  'tr_9_1_7_b,ADV-000602,Devolvida,80.00,,16/09/2026 09:00:00,pix,001,Fulano Sintetico,00000000000,cpf,00000000000,00098765,4321,conta_corrente,001,Banco Sintetico,lote_teste,lote teste,,rec_9_1_7_b,receiver_account_closed,Conta do recebedor não existe ou foi encerrada.',
].join('\n') + '\n';

const itensLote = [
  { solicitacaoId: 601, colIdIntegracao: 'ADV-000601', situacao: 'incluido', valorCentavos: 12940 },
  { solicitacaoId: 602, colIdIntegracao: 'ADV-000602', situacao: 'incluido', valorCentavos: 8000 },
];

const linhas = lerCsv(csv);
const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhas, itensLote);
if (faltantes.length) { console.error('FALTANTES:' + JSON.stringify(faltantes)); process.exit(1); }
if (ignoradas.length) { console.error('IGNORADAS:' + JSON.stringify(ignoradas)); process.exit(1); }
const falhas = aplicaveis.filter((a) => a.status === 'Devolvida').map((a) => ({ id: a.solicitacaoId, motivo: a.motivo }));
process.stdout.write(JSON.stringify(falhas));
JS
P_FALHAS_JSON="$(cd "$BACKEND_DIR" && node "$TMP/calc_falhas_fase9.js" 2>"$TMP/calc_falhas_fase9.err")"
check "9.1.7: lib casou as 2 linhas sem ignoradas/faltantes (roda no host, fora do container)" "$([ -n "$P_FALHAS_JSON" ] && echo ok || cat "$TMP/calc_falhas_fase9.err")" "ok"
check "9.1.7: p_falhas computado pelo lib traz só a Devolvida (602) com motivo literal" \
  "$P_FALHAS_JSON" '[{"id":602,"motivo":"Conta do recebedor não existe ou foi encerrada."}]'

CONFIRMAR_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_confirmar($LOTE_RETORNO_ID, '$P_FALHAS_JSON'::jsonb);
COMMIT;
SQL
)"
check "9.1.7: hub_adiantamento_lote_confirmar (p_falhas do lib real) -> CONCLUIDO_COM_FALHAS" \
  "$(echo "$CONFIRMAR_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "CONCLUIDO_COM_FALHAS"

ITEM_601_OUT="$(psql_t -tAc "SELECT situacao || '|' || origem_situacao FROM \"AdiantamentoLoteItem\" WHERE lote_id=$LOTE_RETORNO_ID AND solicitacao_id=601;")"
check "9.1.7: item 601 (Finalizada) -> situacao=pago" "$ITEM_601_OUT" "pago|manual"
ITEM_602_OUT="$(psql_t -tAc "SELECT situacao || '|' || situacao_motivo FROM \"AdiantamentoLoteItem\" WHERE lote_id=$LOTE_RETORNO_ID AND solicitacao_id=602;")"
check "9.1.7: item 602 (Devolvida) -> situacao=falhou, motivo literal (sem tradução, 9.1.4)" \
  "$ITEM_602_OUT" "falhou|Conta do recebedor não existe ou foi encerrada."
SOL_601_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=601;")"
check "9.1.7: solicitação 601 -> PAGA" "$SOL_601_STATUS" "PAGA"
SOL_602_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=602;")"
check "9.1.7: solicitação 602 -> FALHOU" "$SOL_602_STATUS" "FALHOU"

# 10.5.12 edge#12: incluir num lote NOVO uma solicitação já paga (601, item
# situacao=pago desde o bloco acima) tem que gerar pendência
# (SOLICITACOES_EM_OUTRO_LOTE), nunca reprocessar/duplicar pagamento —
# hub_adiantamento_lote_criar consulta AdiantamentoLoteItem.situacao IN
# ('incluido','pago') independente do status atual da solicitação
# (0067_adiantamento_funcoes.sql ~1537).
LOTE_REINCLUI_OUT="$(psql_relaxed -tA -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id FROM hub_adiantamento_lote_criar(ARRAY[601]::bigint[], 1, 129.40, gen_random_uuid());
ROLLBACK;
SQL
)"
check "10.5.12 edge#12: incluir solicitação já paga (601) em lote novo -> SOLICITACOES_EM_OUTRO_LOTE" \
  "$(echo "$LOTE_REINCLUI_OUT" | grep -c 'SOLICITACOES_EM_OUTRO_LOTE')" "1"

# 9.1.4: a falha importada entra no fluxo já existente de reprocessar (D-23)
# — mesma RPC hub_adiantamento_reprocessar usada para falha manual, sem
# nenhum código novo: o status FALHOU não carrega a origem.
REPROC_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_reprocessar(602, 'reprocessando apos falha do retorno Transfeera (9.1.7)');
COMMIT;
SQL
)"
check "9.1.7/9.1.4: solicitação falhada (via retorno) fica reprocessável — FALHOU->LIBERADA" \
  "$(echo "$REPROC_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "LIBERADA"

# 9.1.5 (idempotência) — dois níveis, cada um provado no seu layer:
#  (a) lib: casarComItensDoLote() contra o estado ATUAL (601/602 já fora de
#      "incluido") devolve aplicaveis:[] -> a ROTA (routes/hub-adiantamentos.js
#      POST /lotes/:id/retorno) NUNCA chama a RPC de novo (ver `if
#      (aplicaveis.length > 0)` no handler) — já coberto por unit test
#      (adiantamento-retorno-transfeera-unit.test.js) e pelo rotas-unit
#      ("reimportação (item já pago) -> ... RPC não chamada de novo").
#  (b) RPC como backstop de defesa em profundidade: mesmo que algo chame
#      hub_adiantamento_lote_confirmar de novo sobre um lote que já saiu de
#      EXPORTADO, ela recusa (TRANSICAO_INVALIDA) — nunca reprocessa/perde
#      dinheiro por reimportação. Prova (a) rodando o MESMO lib usado pela
#      rota contra os itens já resolvidos do lote real, e (b) confirmando a
#      recusa da RPC.
cat >"$TMP/calc_reimport_fase9.js" <<'JS'
'use strict';
const { casarComItensDoLote } = require(`${process.cwd()}/lib/adiantamento-retorno-transfeera`);
const linhasCsvReimportadas = [
  { idIntegracao: 'ADV-000601', status: 'Finalizada', statusConhecido: true, valorCentavos: 12940, codigoErro: '', motivoFalha: '' },
  {
    idIntegracao: 'ADV-000602', status: 'Devolvida', statusConhecido: true, valorCentavos: 8000, codigoErro: 'receiver_account_closed', motivoFalha: 'Conta do recebedor não existe ou foi encerrada.',
  },
];
const itensLoteAgora = [
  { solicitacaoId: 601, colIdIntegracao: 'ADV-000601', situacao: 'pago', valorCentavos: 12940 },
  { solicitacaoId: 602, colIdIntegracao: 'ADV-000602', situacao: 'falhou', valorCentavos: 8000 },
];
const { aplicaveis, ignoradas, faltantes } = casarComItensDoLote(linhasCsvReimportadas, itensLoteAgora);
process.stdout.write(JSON.stringify({
  aplicaveisLen: aplicaveis.length, faltantesLen: faltantes.length,
  motivos: ignoradas.map((i) => i.motivo).sort(),
}));
JS
REIMPORT_LIB_OUT="$(cd "$BACKEND_DIR" && node "$TMP/calc_reimport_fase9.js")"
check "9.1.5(a): reimportar — lib devolve aplicaveis:[] e ambos JA_APLICADO (rota nunca rechama a RPC)" \
  "$REIMPORT_LIB_OUT" '{"aplicaveisLen":0,"faltantesLen":0,"motivos":["JA_APLICADO","JA_APLICADO"]}'

REIMPORT_RPC_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_confirmar($LOTE_RETORNO_ID, '$P_FALHAS_JSON'::jsonb);
ROLLBACK;
SQL
)"
check "9.1.5(b): backstop da RPC — reconfirmar lote fora de EXPORTADO -> TRANSICAO_INVALIDA (nunca reaplica)" \
  "$(echo "$REIMPORT_RPC_OUT" | grep -c 'TRANSICAO_INVALIDA')" "1"

# --- Revisão PR #182 (CRÍTICA/dinheiro, migration 0083): `p_falhas` vem do
# corpo da requisição e o UPDATE que marca FALHOU não era escopado por NADA
# (0067:1761-1762) — como a RPC é SECURITY DEFINER, RLS não protege e o id
# alcançava solicitação de OUTRO lote (e de outra empresa). Marcar FALHOU um
# adiantamento já pago o tira do desconto do repasse (0067:1841, 0082:113 só
# somam PAGA/EXPORTADA) e o devolve para `reprocessar` -> segundo pagamento.
# Prova as DUAS metades contra o SQL real: id de outro lote é RECUSADO e o
# fluxo normal do mesmo lote continua funcionando.
echo ""
echo "--- Revisão PR #182: hub_adiantamento_lote_confirmar escopa p_falhas ao lote ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_fora_do_lote.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id
) VALUES
(611, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100'), '55555555000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-03-06', '2026-03-05',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 50.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')) AND status='APROVADA')),
(612, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100'), '55555555000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-03-07', '2026-03-06',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 60.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000100')) AND status='APROVADA'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed (611/612) do cenário fora-do-lote deu erro"; cat "$TMP/seed_fora_do_lote.log"; exit 1; fi

# Dois lotes distintos, cada um com UMA solicitação, ambos levados a EXPORTADO.
lote_ate_exportado() { # $1 = id da solicitação, $2 = valor total
  local out id conteudo sha
  out="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id FROM hub_adiantamento_lote_criar(ARRAY[$1]::bigint[], 1, $2, gen_random_uuid());
COMMIT;
SQL
)"
  id="$(echo "$out" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
  conteudo="conteudo-lote-$1"
  sha="$(printf '%s' "$conteudo" | sha256sum | cut -d' ' -f1)"
  psql_t -tA >/dev/null <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_arquivo($id, '$(printf '%s' "$conteudo" | base64 -w0 2>/dev/null || printf '%s' "$conteudo" | base64)', '$sha', ${#conteudo}, 'lote-$1.xlsx');
SELECT downloads FROM hub_adiantamento_lote_download($id);
COMMIT;
SQL
  echo "$id"
}
LOTE_A="$(lote_ate_exportado 611 50.00)"
LOTE_B="$(lote_ate_exportado 612 60.00)"
check "revisão#182: dois lotes EXPORTADO para o cenário (A=$LOTE_A, B=$LOTE_B)" \
  "$(psql_t -tAc "SELECT count(*) FROM \"AdiantamentoLote\" WHERE id IN ($LOTE_A,$LOTE_B) AND status='EXPORTADO';")" "2"

# Metade 1: confirmar o lote A passando o id da solicitação do lote B.
FORA_DO_LOTE_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_confirmar($LOTE_A, '[{"id":612,"motivo":"conta encerrada"}]'::jsonb);
COMMIT;
SQL
)"
check "revisão#182: confirmar lote A com id de solicitação do lote B -> SOLICITACAO_FORA_DO_LOTE (recusa explícita, nunca silenciosa)" \
  "$(echo "$FORA_DO_LOTE_OUT" | grep -c 'SOLICITACAO_FORA_DO_LOTE')" "1"
check "revisão#182: solicitação 612 (outro lote) segue EXPORTADA — nunca marcada FALHOU" \
  "$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=612;")" "EXPORTADA"
check "revisão#182: item do lote B intacto (situacao=incluido)" \
  "$(psql_t -tAc "SELECT situacao FROM \"AdiantamentoLoteItem\" WHERE lote_id=$LOTE_B AND solicitacao_id=612;")" "incluido"
check "revisão#182: lote A não avançou de estado com o pedido recusado" \
  "$(psql_t -tAc "SELECT status FROM \"AdiantamentoLote\" WHERE id=$LOTE_A;")" "EXPORTADO"

# Metade 2: o fluxo normal do MESMO lote continua funcionando (a correção não
# fechou o caminho legítimo) — falha do próprio item do lote A.
CONFIRMA_OK_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_confirmar($LOTE_A, '[{"id":611,"motivo":"conta encerrada"}]'::jsonb);
COMMIT;
SQL
)"
check "revisão#182: fluxo normal — confirmar lote A com o id do PRÓPRIO item -> CONCLUIDO_COM_FALHAS" \
  "$(echo "$CONFIRMA_OK_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "CONCLUIDO_COM_FALHAS"
check "revisão#182: fluxo normal — solicitação 611 (item do lote A) -> FALHOU" \
  "$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=611;")" "FALHOU"

# p_falhas vazio no lote B continua marcando tudo como pago (caminho sem falha).
CONFIRMA_B_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_confirmar($LOTE_B, '[]'::jsonb);
COMMIT;
SQL
)"
check "revisão#182: fluxo normal — lote B sem falhas -> CONCLUIDO e solicitação 612 PAGA" \
  "$(echo "$CONFIRMA_B_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)|$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=612;")" \
  "CONCLUIDO|PAGA"

# --- FASE 11 (converge onda-039, 11.11/migration 0075): CAS de configuração
# compara contra a MAIOR versão gravada, não a "vigente" (vigente_desde<=now()).
# Self-contido (MAX(versao) dinâmico) para não depender de qual versão é a
# mais alta neste ponto do arquivo.
MAXV_ANTES="$(psql_t -tAc "SELECT COALESCE(MAX(versao),0) FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=6;")"
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/config_futura.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, previsao_pagamento_texto, descricao_pix_modelo)
VALUES (6, ${MAXV_ANTES} + 1, now() + interval '10 years', 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'FUTURO_11_11', 'Antecipação {nome}');
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de config futura (11.11) deu erro"; cat "$TMP/config_futura.log"; exit 1; fi

CAS_FUTURA_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT versao FROM hub_adiantamento_configuracao_salvar(${MAXV_ANTES}, '{"motivo":"teste-11.11"}'::jsonb);
ROLLBACK;
SQL
)"
check "11.11: CAS recusa versão esperada desatualizada mesmo quando a maior versão está agendada para o futuro (invisível a config_vigente)" \
  "$(echo "$CAS_FUTURA_OUT" | grep -c 'VERSAO_DESATUALIZADA')" "1"

# --- FASE 11 (converge onda-039, 11.22/migration 0075): reversões notificam
# o motorista (FR-042) — prova via contagem real de "NotificacaoMotorista"
# antes/depois de hub_adiantamento_reprocessar e hub_adiantamento_lote_cancelar.
N_NOTIF_ANTES="$(psql_t -tAc "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='33333333000101' AND categoria='adiantamento';")"
NOVO_ID_REPROC=310
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/reprocessar_11_22_seed.log" 2>&1
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia,
    valor_liquido, conta_bancaria_id
) VALUES (
    ${NOVO_ID_REPROC}, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'), '33333333000101',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 ORDER BY versao DESC LIMIT 1),
    '2026-01-01', '2025-12-31', repeat('a',64), 'FALHOU', gen_random_uuid(),
    42.00, (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101')) AND status='APROVADA')
);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed de ${NOVO_ID_REPROC} (11.22) deu erro"; cat "$TMP/reprocessar_11_22_seed.log"; exit 1; fi

psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/reprocessar_11_22.log" 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_reprocessar(${NOVO_ID_REPROC}, 'teste-11.22');
COMMIT;
SQL
if [ $? -ne 0 ]; then echo "FAIL: hub_adiantamento_reprocessar (11.22) deu erro"; cat "$TMP/reprocessar_11_22.log"; exit 1; fi
N_NOTIF_DEPOIS="$(psql_t -tAc "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='33333333000101' AND categoria='adiantamento';")"
check "11.22: hub_adiantamento_reprocessar (FALHOU->LIBERADA) gera NotificacaoMotorista nova" "$((N_NOTIF_DEPOIS - N_NOTIF_ANTES))" "1"

# --- FASE 11 (converge onda-041, 11.16/migration 0076): renderização da
# descrição Pix sai da SQL. `hub_adiantamento_lote_criar` agora grava o
# MODELO BRUTO (com placeholders) em col_descricao_pix; quem renderiza e
# valida é o Node (`renderizarDescricaoPix`, lib real, sem mock — mesmo
# padrão de invocação do lib no HOST do bloco FASE 9 acima), persistindo o
# resultado via o novo parâmetro `p_itens` de `hub_adiantamento_lote_arquivo`.
echo ""
echo "--- FASE 11 (11.16): descrição Pix — SQL só grava o modelo bruto; Node renderiza/valida/persiste ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_11_16.log" 2>&1
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, previsao_pagamento_texto, descricao_pix_modelo)
VALUES (6, 7, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'entre 17h e 18h de hoje', 'Antecip {data_producao}_{nome}');
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, previsao_pagamento_texto, descricao_pix_modelo)
VALUES (6, 8, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'entre 17h e 18h de hoje', 'Antecipacao {cpf}_{nome}');

INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('77777777000100', 'Descricao Pix Teste');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
VALUES (6, gen_random_uuid(), 'Descricao Pix Teste', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')), 'CARGA_INICIAL', 'APROVADA', 'Descricao Pix Teste', '11122233344', 'PF', '001', 'Banco do Brasil', '4321', '00011122', '3', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')), now());
INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id
) VALUES
(701, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100'), '77777777000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=7 AND id_empresa=6), '2026-05-11', '2026-05-10',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 50.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')) AND status='APROVADA')),
(702, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100'), '77777777000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=8 AND id_empresa=6), '2026-05-12', '2026-05-11',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 30.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')) AND status='APROVADA'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed 11.16 deu erro"; cat "$TMP/seed_11_16.log"; exit 1; fi

LOTE701_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id, status FROM hub_adiantamento_lote_criar(ARRAY[701]::bigint[], 1, 50.00, gen_random_uuid());
COMMIT;
SQL
)"
LOTE701_ROW="$(echo "$LOTE701_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
LOTE701_ID="$(echo "$LOTE701_ROW" | cut -d'|' -f1)"
check "11.16: lote(701) criado (GERANDO)" "$(echo "$LOTE701_ROW" | cut -d'|' -f2)" "GERANDO"

LOTE702_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id, status FROM hub_adiantamento_lote_criar(ARRAY[702]::bigint[], 1, 30.00, gen_random_uuid());
COMMIT;
SQL
)"
LOTE702_ROW="$(echo "$LOTE702_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
LOTE702_ID="$(echo "$LOTE702_ROW" | cut -d'|' -f1)"
check "11.16: lote(702) criado (GERANDO)" "$(echo "$LOTE702_ROW" | cut -d'|' -f2)" "GERANDO"

# 11.16.a: hub_adiantamento_lote_criar NÃO interpola mais — grava o modelo
# bruto tal-e-qual (prova de que a SQL parou de renderizar/validar).
check "11.16.a: col_descricao_pix do item 701 == modelo BRUTO (SQL não interpola mais)" \
  "$(psql_t -tAc "SELECT col_descricao_pix FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=701;")" \
  "Antecip {data_producao}_{nome}"
check "11.16.a: col_descricao_pix do item 702 == modelo BRUTO (placeholder desconhecido intacto, SQL não valida)" \
  "$(psql_t -tAc "SELECT col_descricao_pix FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=702;")" \
  "Antecipacao {cpf}_{nome}"

# 11.16.b: renderizarDescricaoPix (lib real, HOST, sem mock) resolve o
# placeholder bare {data_producao} (issue "a" do achado 11.16) e RECUSA
# {cpf} (issue "b") — mesma função que o Node do route usa de verdade.
ITEM701_ID="$(psql_t -tAc "SELECT id FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=701;")"
NOME701="$(psql_t -tAc "SELECT col_nome FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=701;")"
RENDER_701="$(cd "$BACKEND_DIR" && node -e '
const { renderizarDescricaoPix } = require("./lib/adiantamento-transfeera-xlsx");
process.stdout.write(renderizarDescricaoPix(process.argv[1], { nome: process.argv[2], dataProducaoISO: process.argv[3] }));
' "Antecip {data_producao}_{nome}" "$NOME701" "2026-05-10")"
check "11.16.b: renderizarDescricaoPix resolve {data_producao} bare (issue a)" "$RENDER_701" "Antecip 10.05.26_${NOME701}"

RENDER_702="$(cd "$BACKEND_DIR" && node -e '
const { renderizarDescricaoPix } = require("./lib/adiantamento-transfeera-xlsx");
try {
  renderizarDescricaoPix(process.argv[1], { nome: process.argv[2], dataProducaoISO: process.argv[3] });
  process.stdout.write("NAO_LANCOU");
} catch (e) {
  process.stdout.write("LANCOU:" + e.message);
}
' "Antecipacao {cpf}_{nome}" "Fulano" "2026-05-11")"
check "11.16.b: renderizarDescricaoPix RECUSA placeholder desconhecido {cpf} (issue b, defesa que a SQL não tinha)" \
  "$RENDER_702" 'LANCOU:descricao_pix_modelo: placeholder nao permitido "{cpf}"'

# 11.16.c: hub_adiantamento_lote_arquivo persiste a descrição já
# renderizada/validada (p_itens) — mesma transação que anexa o arquivo.
CONTEUDO_11_16_B64="$(printf 'conteudo-teste-11-16' | base64 -w0 2>/dev/null || printf 'conteudo-teste-11-16' | base64)"
SHA256_11_16="$(printf 'conteudo-teste-11-16' | sha256sum | cut -d' ' -f1)"
ARQUIVO_701_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_arquivo(${LOTE701_ID}, '${CONTEUDO_11_16_B64}', '${SHA256_11_16}', 21, 'teste-11-16.xlsx',
  jsonb_build_array(jsonb_build_object('id', ${ITEM701_ID}, 'descricao', '${RENDER_701}')));
COMMIT;
SQL
)"
check "11.16.c: lote_arquivo(701) -> GERADO" "$(echo "$ARQUIVO_701_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "GERADO"
check "11.16.c: col_descricao_pix do item 701 == valor RENDERIZADO após lote_arquivo (persistiu)" \
  "$(psql_t -tAc "SELECT col_descricao_pix FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=701;")" \
  "$RENDER_701"

# 11.16.d: escopo por lote_id — p_itens não pode alterar item de OUTRO lote
# (defesa em profundidade do novo parâmetro). Lote 701 já virou GERADO em
# 11.16.c (lote_arquivo só aceita GERANDO), então a tentativa "cruzada" usa
# o lote 702 (ainda GERANDO) tentando reescrever o item da solicitação 701.
CONTEUDO_11_16D_B64="$(printf 'conteudo-teste-11-16d' | base64 -w0 2>/dev/null || printf 'conteudo-teste-11-16d' | base64)"
SHA256_11_16D="$(printf 'conteudo-teste-11-16d' | sha256sum | cut -d' ' -f1)"
ARQUIVO_702_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
-- tenta, via o lote 702, sobrescrever a descrição do item da solicitação
-- 701 (que pertence ao lote ${LOTE701_ID}, não a este).
SELECT status FROM hub_adiantamento_lote_arquivo(${LOTE702_ID}, '${CONTEUDO_11_16D_B64}', '${SHA256_11_16D}', 22, 'teste-11-16d.xlsx',
  jsonb_build_array(jsonb_build_object('id', ${ITEM701_ID}, 'descricao', 'HACKEADO')));
COMMIT;
SQL
)"
check "11.16.d: lote_arquivo(702) segue OK mesmo com id de item de outro lote em p_itens" \
  "$(echo "$ARQUIVO_702_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "GERADO"
check "11.16.d: col_descricao_pix do item 701 permanece o RENDERIZADO (p_itens não atravessa lote_id de outro lote)" \
  "$(psql_t -tAc "SELECT col_descricao_pix FROM \"AdiantamentoLoteItem\" WHERE solicitacao_id=701;")" \
  "$RENDER_701"

# --- FASE 12 (converge onda-044, 12.3/migration 0079): CHECK de comprimento
# em descricao_pix_modelo — modelo > 140 não pode nem ser SALVO, fechando a
# lacuna que o left(modelo,140) de 0076 deixava (corte podia partir um
# placeholder ao meio e escapar da validação de renderizarDescricaoPix).
echo ""
echo "--- FASE 12 (12.3): CHECK de 140 chars em descricao_pix_modelo (migration 0079) ---"
MAXV_123="$(psql_t -tAc "SELECT COALESCE(MAX(versao),0) FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=6;")"
MODELO_141="$(printf 'Antecipacao %s{nome}' "$(printf 'x%.0s' $(seq 1 123))")" # 141 chars
check "12.3: sanity — modelo de 141 chars" "${#MODELO_141}" "141"
CONFIG_141_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_configuracao_salvar(${MAXV_123}, '{"descricaoPixModelo":"${MODELO_141}"}'::jsonb);
ROLLBACK;
SQL
)"
check "12.3: modelo de 141 chars é RECUSADO pelo CHECK (nunca chega a ser gravado)" \
  "$(echo "$CONFIG_141_OUT" | grep -c 'adiantamentoconfiguracao_pix_modelo_len_chk')" "1"
MODELO_140="$(printf 'Antecipacao %s{nome}' "$(printf 'x%.0s' $(seq 1 122))")" # exatamente 140 chars
check "12.3: sanity — modelo de exatamente 140 chars" "${#MODELO_140}" "140"
CONFIG_140_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT versao FROM hub_adiantamento_configuracao_salvar(${MAXV_123}, '{"descricaoPixModelo":"${MODELO_140}"}'::jsonb);
ROLLBACK;
SQL
)"
check "12.3: modelo de exatamente 140 chars é ACEITO (limite, não off-by-one)" \
  "$(echo "$CONFIG_140_OUT" | grep -c 'ERROR')" "0"

# --- FASE 11 (converge onda-041, 11.18/migration 0077): socorro de
# hub_adiantamento_lote_cancelar não pode depender de `adiantamentos.
# reprocessar` quando quem chama é o PRÓPRIO criador do lote (POST /lotes
# só garante `adiantamentos.lote_criar`) — papel novo, só com essa
# permissão, prova o cenário real (separação de funções legítima).
echo ""
echo "--- FASE 11 (11.18): lote_cancelar de socorro — criador com só lote_criar cancela o PRÓPRIO lote GERANDO ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_11_18.log" 2>&1
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES ('lote_criar_apenas_teste', 'entidade', false)
ON CONFLICT (nome) DO NOTHING;
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id FROM "Papel" p, "Permissao" perm
JOIN "Modulo" m ON m.id = perm.modulo_id AND m.codigo = 'adiantamentos'
WHERE p.nome = 'lote_criar_apenas_teste' AND perm.codigo = 'adiantamentos.lote_criar'
ON CONFLICT DO NOTHING;
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('lote-criar-apenas.teste@example.com', 'x', 'Lote Criar Apenas Teste');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email='lote-criar-apenas.teste@example.com'), 6,
          (SELECT id FROM "Papel" WHERE nome='lote_criar_apenas_teste'), true);

INSERT INTO "AdiantamentoSolicitacao" (
    id, id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id
) VALUES
(703, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100'), '77777777000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-05-16', '2026-05-15',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 40.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')) AND status='APROVADA')),
(704, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100'), '77777777000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-05-17', '2026-05-16',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 45.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')) AND status='APROVADA')),
(705, 6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100'), '77777777000100',
 (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')),
 (SELECT id FROM "AdiantamentoConfiguracao" WHERE versao=2 AND id_empresa=6), '2026-05-18', '2026-05-17',
 repeat('a',64), 'LIBERADA', gen_random_uuid(), 33.00,
 (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='77777777000100')) AND status='APROVADA'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed 11.18 deu erro"; cat "$TMP/seed_11_18.log"; exit 1; fi

SUB_RESTRITO="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='lote-criar-apenas.teste@example.com';")"
CLAIMS_RESTRITO="{\"sub\":\"${SUB_RESTRITO}\",\"empresa_ativa\":\"6\",\"escopo\":[6]}"

# lote 703: criado pelo próprio usuário restrito (só lote_criar).
LOTE703_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '${CLAIMS_RESTRITO}', true);
SET ROLE authenticated;
SELECT id, status FROM hub_adiantamento_lote_criar(ARRAY[703]::bigint[], 1, 40.00, gen_random_uuid());
COMMIT;
SQL
)"
LOTE703_ROW="$(echo "$LOTE703_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
LOTE703_ID="$(echo "$LOTE703_ROW" | cut -d'|' -f1)"
check "11.18: usuário só-lote_criar cria lote(703) (GERANDO)" "$(echo "$LOTE703_ROW" | cut -d'|' -f2)" "GERANDO"

# lote 704: criado pelo financeiro (sub=1) — pertence a OUTRO usuário.
LOTE704_OUT="$(psql_t -tA -F'|' <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id, status FROM hub_adiantamento_lote_criar(ARRAY[704]::bigint[], 1, 45.00, gen_random_uuid());
COMMIT;
SQL
)"
LOTE704_ROW="$(echo "$LOTE704_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)"
LOTE704_ID="$(echo "$LOTE704_ROW" | cut -d'|' -f1)"
check "11.18: financeiro cria lote(704) (GERANDO)" "$(echo "$LOTE704_ROW" | cut -d'|' -f2)" "GERANDO"

# lote 705: criado pelo usuário restrito, depois AVANÇADO p/ GERADO
# (hub_adiantamento_lote_arquivo não exige permissão extra) — testa que o
# socorro só vale enquanto GERANDO, mesmo sendo o próprio dono.
LOTE705_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '${CLAIMS_RESTRITO}', true);
SET ROLE authenticated;
SELECT id, status FROM hub_adiantamento_lote_criar(ARRAY[705]::bigint[], 1, 33.00, gen_random_uuid());
COMMIT;
SQL
)"
LOTE705_ID="$(echo "$LOTE705_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1 | cut -d'|' -f1)"
CONTEUDO_11_18_B64="$(printf 'conteudo-teste-11-18' | base64 -w0 2>/dev/null || printf 'conteudo-teste-11-18' | base64)"
SHA256_11_18="$(printf 'conteudo-teste-11-18' | sha256sum | cut -d' ' -f1)"
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/lote705_arquivo.log" 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '${CLAIMS_RESTRITO}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_arquivo(${LOTE705_ID}, '${CONTEUDO_11_18_B64}', '${SHA256_11_18}', 21, 'teste-11-18.xlsx');
COMMIT;
SQL
if [ $? -ne 0 ]; then echo "FAIL: lote_arquivo(705) deu erro"; cat "$TMP/lote705_arquivo.log"; exit 1; fi

# 11.18.a (o fix em si): socorro de POST /lotes — o PRÓPRIO criador,
# só com lote_criar, cancela o lote 703 (ainda GERANDO). Antes de 0077 isso
# SEMPRE dava PERMISSAO_NEGADA (exigia adiantamentos.reprocessar).
CANCELAR_703_OUT="$(psql_t -tA -F'|' <<SQL
BEGIN;
SELECT set_config('request.jwt.claims', '${CLAIMS_RESTRITO}', true);
SET ROLE authenticated;
SELECT status FROM hub_adiantamento_lote_cancelar(${LOTE703_ID}, 'falha_geracao', false);
COMMIT;
SQL
)"
check "11.18.a: usuário só-lote_criar cancela o PRÓPRIO lote(703) ainda GERANDO -> CANCELADO" \
  "$(echo "$CANCELAR_703_OUT" | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1)" "CANCELADO"
check "11.18.a: solicitação 703 volta a LIBERADA (não fica presa em EM_LOTE)" \
  "$(psql_t -tAc "SELECT status FROM \"AdiantamentoSolicitacao\" WHERE id=703;")" "LIBERADA"

# 11.18.b: NÃO pode cancelar o lote de OUTRO usuário, mesmo ainda GERANDO
# (a exceção é só autocancelamento, nunca abre `reprocessar` de fato).
CANCELAR_704_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '${CLAIMS_RESTRITO}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_cancelar(${LOTE704_ID}, 'falha_geracao', false);
ROLLBACK;
SQL
)"
check "11.18.b: usuário só-lote_criar NÃO cancela lote(704) de outro criador -> PERMISSAO_NEGADA" \
  "$(echo "$CANCELAR_704_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"
N_LOTE704_STATUS="$(psql_t -tAc "SELECT status FROM \"AdiantamentoLote\" WHERE id=${LOTE704_ID};")"
check "11.18.b: lote(704) permanece GERANDO (não foi cancelado)" "$N_LOTE704_STATUS" "GERANDO"

# 11.18.c: NÃO pode autocancelar o PRÓPRIO lote depois de sair de GERANDO
# (705 já está GERADO) — a exceção é estritamente "próprio + GERANDO".
CANCELAR_705_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<SQL 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '${CLAIMS_RESTRITO}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_cancelar(${LOTE705_ID}, 'falha_geracao', false);
ROLLBACK;
SQL
)"
check "11.18.c: usuário só-lote_criar NÃO autocancela o próprio lote(705) já GERADO -> PERMISSAO_NEGADA" \
  "$(echo "$CANCELAR_705_OUT" | grep -c 'PERMISSAO_NEGADA')" "1"

# --- FASE 13 (converge onda-046, dec-185: 13.3/migration 0080, 13.6/migration
# 0081) — 13.7/migration 0082 está mais acima, logo após o fechamento D-23,
# onde a config vigente ainda é a v2 (ver comentário lá). ------------------
echo ""
echo "--- FASE 13 (13.3/13.6): expurgo distinto de indisponível, recalcular notifica ---"

# 13.3: lote 902 já foi expurgado por retenção (seed do 1.6.2 acima,
# arquivo_expurgado_em setado) — a RPC agora distingue esse caso do genérico
# ARQUIVO_INDISPONIVEL.
EXPURGADO_902_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_download(902);
ROLLBACK;
SQL
)"
check "13.3: download do lote(902) expurgado -> ARQUIVO_EXPURGADO (não ARQUIVO_INDISPONIVEL genérico)" \
  "$(echo "$EXPURGADO_902_OUT" | grep -c 'ARQUIVO_EXPURGADO')" "1"

# regressão: lote sem arquivo por status inválido (nunca gerado, NÃO
# expurgado) continua caindo em ARQUIVO_INDISPONIVEL — expurgo não "engoliu"
# o outro ramo.
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_13_3_gerando.log" 2>&1
INSERT INTO "AdiantamentoLote" (id, id_empresa, status, criado_por, criado_em, chave_idempotencia, quantidade, valor_total)
VALUES (905, 6, 'GERANDO', (SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), now(), gen_random_uuid(), 1, 10.00);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed 13.3 (lote 905 GERANDO) deu erro"; cat "$TMP/seed_13_3_gerando.log"; exit 1; fi
GERANDO_905_OUT="$(psql_relaxed -v ON_ERROR_STOP=0 <<'SQL' 2>&1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT * FROM hub_adiantamento_lote_download(905);
ROLLBACK;
SQL
)"
check "13.3 regressão: lote(905) GERANDO (sem arquivo, não expurgado) -> ARQUIVO_INDISPONIVEL" \
  "$(echo "$GERANDO_905_OUT" | grep -c 'ARQUIVO_INDISPONIVEL')" "1"

# 13.6: a solicitação 103 (D-06/R-07 acima) foi recalculada de
# AGUARDANDO_PRODUCAO -> LIBERADA; agora deve ter gerado NotificacaoMotorista
# (mesmo evento que o tick já dispara para a idêntica transição, 0067:2106).
N_NOTIF_103="$(psql_t -tAc "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='33333333000101' AND categoria='adiantamento' AND titulo='Adiantamento liberado' AND corpo LIKE '%01/03/2026%';")"
check "13.6: hub_adiantamento_recalcular (AGUARDANDO_PRODUCAO->LIBERADA, solicitação 103) notifica o motorista (FR-013/FR-042)" "$N_NOTIF_103" "1"

# --- Revisão PR #182 (migration 0083): a janela semanal do motorista sai do
# fuso da CONFIGURAÇÃO (America/Sao_Paulo), nunca de `current_date` — que é a
# data na TimeZone da SESSÃO (UTC em produção). Domingo 21h BRT já é segunda
# em UTC: a janela virava 3 h antes e o motorista via a semana zerada das 21h
# à meia-noite, toda semana.
#
# Fixar o relógio do Postgres (`now()`) de fora não é possível sem
# libfaketime/root no container, então a prova é feita em dois níveis:
#  (a) a FÓRMULA, com relógio FIXO (domingo 23h30 BRT = segunda 02h30 UTC),
#      no SQL real — mostra que o defeito é a leitura do fuso, não outra coisa;
#  (b) a FUNÇÃO real, provando que o resultado NÃO depende da TimeZone da
#      sessão: `Etc/GMT+12` e `Etc/GMT-14` estão a 26 h de distância, então
#      suas datas locais SEMPRE diferem — sob o defeito as duas chamadas
#      divergem em 100% dos instantes; com a correção, as duas (e a sessão em
#      UTC) devolvem a semana corrente em São Paulo.
echo ""
echo "--- Revisão PR #182: janela semanal do motorista no fuso da configuração ---"

# Semana de apuração começando na SEGUNDA (apuracao_dia_inicio=1): é a
# configuração em que a virada indevida salta uma semana INTEIRA — domingo em
# SP cai na semana que começou na segunda anterior; lido como segunda (UTC), a
# janela pula para a semana seguinte.
FIXO_OUT="$(psql_t -tAc "WITH t AS (SELECT '2026-09-14 02:30:00+00'::timestamptz AS instante)
SELECT ((instante AT TIME ZONE 'America/Sao_Paulo')::date
          - ((extract(dow FROM (instante AT TIME ZONE 'America/Sao_Paulo'))::int - 1 + 7) % 7))::text
       || '|' ||
       ((instante AT TIME ZONE 'UTC')::date
          - ((extract(dow FROM (instante AT TIME ZONE 'UTC'))::int - 1 + 7) % 7))::text
FROM t;")"
check "revisão#182 (a): relógio fixo domingo 23h30 BRT -> janela em SP começa 2026-09-07 (semana corrente); pela leitura UTC começaria 2026-09-14 (uma semana adiante — o defeito)" \
  "$FIXO_OUT" "2026-09-07|2026-09-14"

# `Etc/GMT-14` é UTC+14 e `Etc/GMT+12` é UTC-12 (sinal invertido, POSIX): 26 h
# de distância, então as datas locais das duas sessões SEMPRE diferem. Para
# que essa diferença de data vire diferença de JANELA em qualquer dia do ano,
# o início da semana é fixado no dia-da-semana da data mais adiantada
# (UTC+14): sob o defeito a sessão UTC+14 abre a janela na SUA data de hoje e
# a UTC-12 na semana anterior, então pelo menos uma das duas diverge da semana
# de São Paulo em qualquer instante do ano; com a correção, as duas (e a
# sessão em UTC) devolvem a mesma janela — a da semana corrente em SP.
DIA_INICIO_TZ="$(TZ=Etc/GMT-14 date +%w)"
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/config_repasse_app.log" 2>&1
UPDATE "AdiantamentoConfiguracao"
SET repasse_visivel_app = true, apuracao_dia_inicio = ${DIA_INICIO_TZ}, apuracao_dias_ate_repasse = 2,
    apuracao_data_base = 'data_lancamento', categorias_extrato = ARRAY['Corrida']
WHERE id_empresa = 6;
SQL
if [ $? -ne 0 ]; then echo "FAIL: config para o teste de fuso deu erro"; cat "$TMP/config_repasse_app.log"; exit 1; fi

janela_motorista() { # $1 = TimeZone da SESSÃO psql
  psql_t -tA <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1
BEGIN;
SET LOCAL TIME ZONE '$1';
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT periodo_inicio || '|' || periodo_fim FROM hub_adiantamento_repasse_motorista();
COMMIT;
SQL
}

# Esperado = janela da semana corrente em São Paulo para o mesmo
# apuracao_dia_inicio configurado acima.
HOJE_SP="$(TZ=America/Sao_Paulo date +%F)"
DOW_SP="$(TZ=America/Sao_Paulo date +%w)"
INICIO_SP="$(date -u -d "$HOJE_SP - $(( (DOW_SP - DIA_INICIO_TZ + 7) % 7 )) days" +%F)"
FIM_SP="$(date -u -d "$INICIO_SP + 6 days" +%F)"

check "revisão#182 (b): sessão em UTC -> janela é a da semana CORRENTE em São Paulo ($INICIO_SP..$FIM_SP)" \
  "$(janela_motorista 'UTC')" "$INICIO_SP|$FIM_SP"
check "revisão#182 (b): sessão em Etc/GMT-14 (UTC+14) devolve a MESMA janela (independe do fuso da sessão)" \
  "$(janela_motorista 'Etc/GMT-14')" "$INICIO_SP|$FIM_SP"
check "revisão#182 (b): sessão em Etc/GMT+12 (UTC-12) devolve a MESMA janela — 26 h de distância da anterior, sob o defeito as duas SEMPRE divergiriam" \
  "$(janela_motorista 'Etc/GMT+12')" "$INICIO_SP|$FIM_SP"

# --- Revisão PR #182 (migration 0083): os totais do repasse são do PERÍODO,
# não da página. A RPC só devolvia `count(*) OVER ()`; o backend somava as
# linhas RECEBIDAS (20 por padrão) e exibia o resultado ao lado da contagem do
# período inteiro — "Total (N motorista(s)) · R$ <soma de 20>" na tela onde se
# decide fechar a apuração. Período próprio (2026-05-04, segunda) com 3
# entregadores, para não mexer no 2026-01-01 já congelado por
# hub_adiantamento_repasse_fechar mais acima.
echo ""
echo "--- Revisão PR #182: totais de hub_adiantamento_repasse são do período ---"
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed_totais_periodo.log" 2>&1
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('7',64), 'completed');
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES
  ('71111111000100', 'Totais Periodo A'), ('72222222000100', 'Totais Periodo B'), ('73333333000100', 'Totais Periodo C');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), cm.nome, cm.id FROM "ContaMotorista" cm
WHERE cm.cnpj_prestador IN ('71111111000100', '72222222000100', '73333333000100');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('7',64)), e.id,
       '2026-05-06', '2026-05-06', 'Credito', 100.00, 'Corrida', encode(sha256(e.id::text::bytea), 'hex')
FROM "Entregador" e
WHERE e.motorista_id IN (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador IN ('71111111000100', '72222222000100', '73333333000100'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed dos totais do período deu erro"; cat "$TMP/seed_totais_periodo.log"; exit 1; fi

repasse_periodo() { # $1 = p_limite
  psql_t -tA <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT count(*)::text || '|' || max(total)::text || '|' || max(total_creditos)::text || '|' || max(total_remanescente)::text
FROM hub_adiantamento_repasse('2026-05-04'::date, NULL, false, 0, $1);
COMMIT;
SQL
}
check "revisão#182: varredura completa do período vê 3 motoristas e 300.00 de crédito" \
  "$(repasse_periodo 1000)" "3|3|300.00|300.00"
check "revisão#182: página de 1 linha traz 1 linha mas os MESMOS totais do período (antes: soma da página)" \
  "$(repasse_periodo 1)" "1|3|300.00|300.00"

# --- revisão de segurança 2026-09-18 (migration 0084): alerta DOCUMENTO_DIFERENTE
#     `hub_conta_bancaria_solicitar` só alertava divergência de NOME. Conta com
#     o nome do próprio motorista e documento de terceiro nascia sem alerta —
#     e conta sem alerta é o que o fluxo de revisão trata como limpa.
#     LIMITE deliberado: o hub não guarda o CPF do motorista (só o CNPJ do
#     prestador), então só o caso PJ é verificável. Os três checks abaixo fixam
#     exatamente isso, inclusive o que NÃO alerta — para ninguém "melhorar"
#     depois e inundar a fila de alertas em toda conta pessoa física.
solicitar_conta_0084() {  # $1 = documento do titular
  psql_t -tA -F'|' <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^\$' | tail -n1
BEGIN;
SELECT set_config('request.jwt.claims', '{"motorista_cnpj":"33333333000101","escopo":[6]}', true);
SET ROLE authenticated;
SELECT id FROM hub_conta_bancaria_solicitar(jsonb_build_object(
  'titularNome', (SELECT nome FROM "ContaMotorista" WHERE cnpj_prestador='33333333000101'),
  'titularDocumento', '$1',
  'bancoCodigo', '341', 'bancoNome', 'Itaú', 'agencia', '5555', 'conta', '77776666',
  'contaDigito', '3', 'tipoConta', 'CORRENTE'));
COMMIT;
SQL
}
alertas_da_conta() { psql_t -tAc "SELECT COALESCE(alertas::text,'[]') FROM \"ContaBancariaMotorista\" WHERE id=$1;"; }

listar_sem_alertas_tem() {  # $1 = id da conta; devolve 1 se aparece na listagem "sem alertas"
  psql_t -tA <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":1,"escopo":[6],"permissoes":["adiantamentos.contas_revisar"]}', true);
SET ROLE authenticated;
SELECT count(*) FROM hub_conta_bancaria_listar('PENDENTE', 1, 500, NULL, true) WHERE (dados ->> 'id')::bigint = $1;
ROLLBACK;
SQL
}

CONTA_PJ_OUTRO="$(solicitar_conta_0084 '99999999000199')"
check "0084: titular PJ com CNPJ != o do prestador -> alerta DOCUMENTO_DIFERENTE" \
  "$(alertas_da_conta "$CONTA_PJ_OUTRO" | grep -c 'DOCUMENTO_DIFERENTE')" "1"
# ATENÇÃO à ordem: cada `hub_conta_bancaria_solicitar` CANCELA o PENDENTE
# anterior do mesmo entregador (0074:356). Se este check viesse depois das
# outras duas solicitações, a conta já estaria CANCELADA e sairia da listagem
# por esse motivo, não pelo alerta — passaria com a correção E sem ela (o
# controle negativo de 2026-09-18 pegou exatamente isso).
check "0084: conta com DOCUMENTO_DIFERENTE fica FORA da listagem 'sem alertas' (não entra em aprovação em massa)" \
  "$(listar_sem_alertas_tem "$CONTA_PJ_OUTRO")" "0"

CONTA_PJ_PROPRIO="$(solicitar_conta_0084 '33333333000101')"
check "0084: titular PJ com o PRÓPRIO CNPJ -> nenhum alerta de documento" \
  "$(alertas_da_conta "$CONTA_PJ_PROPRIO" | grep -c 'DOCUMENTO_DIFERENTE')" "0"
# Contraprova do check anterior: sem alerta, a conta APARECE na mesma listagem.
# Sem isto, o "0" acima poderia vir de qualquer outro motivo.
check "0084: conta SEM alerta aparece na listagem 'sem alertas' (contraprova)" \
  "$(listar_sem_alertas_tem "$CONTA_PJ_PROPRIO")" "1"

CONTA_PF="$(solicitar_conta_0084 '12345678901')"
check "0084: titular PF sem CPF cadastrado -> NÃO alerta (ausência de sinal, nunca falso positivo)" \
  "$(alertas_da_conta "$CONTA_PF" | grep -c 'DOCUMENTO_DIFERENTE')" "0"

# --- 0085: com o CPF do entregador em campo próprio, o caso PF passa a ser
#     verificável. Era a metade descoberta: no retorno real do parceiro, 2.008
#     de 3.843 pagamentos foram para conta PF.
ENTREGADOR_0085="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='33333333000101');")"

# `hub_adiantamento_tem_permissao` (0067:401) NÃO lê a lista `permissoes` da
# claim: ela exige `sub` + `empresa_ativa` e consulta o papel no banco. Por isso
# aqui vai o usuário do seed que tem o papel `financeiro`, no mesmo formato das
# demais chamadas do driver (:163).
gravar_cpf_0085() {  # $1 = cpf, $2 = origem
  psql_t -tA <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | tail -n1
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub', (SELECT id FROM "Usuario" WHERE email='financeiro.teste@example.com'), 'empresa_ativa', '6', 'escopo', jsonb_build_array(6))::text, true);
SET ROLE authenticated;
SELECT hub_entregador_documento_gravar(${ENTREGADOR_0085}, '$1', '$2');
COMMIT;
SQL
}

check "0085: grava o CPF do entregador (origem CARGA_INICIAL)" "$(gravar_cpf_0085 '52998224725' 'CARGA_INICIAL')" "t"

CONTA_PF_OUTRO="$(solicitar_conta_0084 '12345678901')"
check "0085: titular PF com CPF != o do entregador -> alerta DOCUMENTO_DIFERENTE (o caso que faltava)" \
  "$(alertas_da_conta "$CONTA_PF_OUTRO" | grep -c 'DOCUMENTO_DIFERENTE')" "1"
check "0085: e por isso fica FORA da listagem 'sem alertas'" \
  "$(listar_sem_alertas_tem "$CONTA_PF_OUTRO")" "0"

CONTA_PF_PROPRIO="$(solicitar_conta_0084 '52998224725')"
check "0085: titular PF com o PRÓPRIO CPF -> nenhum alerta (contraprova)" \
  "$(alertas_da_conta "$CONTA_PF_PROPRIO" | grep -c 'DOCUMENTO_DIFERENTE')" "0"

# A planilha é conferida pelo operador; o enriquecimento vem de portal de
# terceiro. Re-rodar o robô não pode sobrescrever o dado conferido por humano.
check "0085: ENRIQUECIMENTO não sobrescreve CPF de origem CARGA_INICIAL" \
  "$(gravar_cpf_0085 '11144477735' 'ENRIQUECIMENTO')" "f"
check "0085: e o CPF gravado continua o da carga" \
  "$(psql_t -tAc "SELECT cpf FROM \"EntregadorDocumento\" WHERE entregador_id=${ENTREGADOR_0085};")" "52998224725"

# A tabela nega tudo por RLS sem política: nem SELECT direto nem UPDATE passam,
# mesmo com o GRANT amplo que "Entregador" tem. É o que impede transformar o
# CPF em oráculo de filtro (a falha que a 0083 corrigiu em `de`/`ate`) e o que
# impede alterar o CPF para casar com a conta e anular a conferência.
# Sem GRANT algum, o Postgres barra ANTES do RLS: a mensagem é "permission
# denied for table", não "0 linhas". Melhor ainda — nem chega a avaliar
# política. O teste afirma a barreira, não uma contagem.
check "0085: SELECT direto na tabela de documento é BARRADO (sem GRANT, antes mesmo do RLS)" \
  "$(psql_t -tA <<'SQL' 2>&1 | grep -oE 'permission denied for table EntregadorDocumento' | head -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":1,"empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
SELECT count(*) FROM "EntregadorDocumento";
ROLLBACK;
SQL
)" "permission denied for table EntregadorDocumento"

# --- 0085: o gatilho alimenta sozinho a cada enriquecimento. O robô grava
#     `dados_entrego_json` por PATCH DIRETO (routes/hub-robo-entrego.js:249),
#     então é o gatilho — e não uma chamada de função — que garante cobertura.
ENTREGADOR_TRIGGER="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='66666666000102');")"
psql_t -tAc "UPDATE \"Entregador\" SET dados_entrego_json='{\"dadosPessoais\":{\"cpf\":\"11144477735\"}}'::jsonb WHERE id=${ENTREGADOR_TRIGGER};" >/dev/null
check "0085: gatilho grava o CPF sozinho quando o enriquecimento chega" \
  "$(psql_t -tAc "SELECT cpf||'|'||origem FROM \"EntregadorDocumento\" WHERE entregador_id=${ENTREGADOR_TRIGGER};")" "11144477735|ENRIQUECIMENTO"

# O entregador da carga já tem CPF de origem CARGA_INICIAL: um enriquecimento
# posterior NÃO pode sobrescrever o que o operador conferiu na planilha.
psql_t -tAc "UPDATE \"Entregador\" SET dados_entrego_json='{\"dadosPessoais\":{\"cpf\":\"11144477735\"}}'::jsonb WHERE id=${ENTREGADOR_0085};" >/dev/null
check "0085: gatilho NÃO rebaixa CPF de origem CARGA_INICIAL" \
  "$(psql_t -tAc "SELECT cpf||'|'||origem FROM \"EntregadorDocumento\" WHERE entregador_id=${ENTREGADOR_0085};")" "52998224725|CARGA_INICIAL"

# Enriquecimento sem CPF no pacote não pode quebrar o PATCH do robô.
psql_t -tAc "UPDATE \"Entregador\" SET dados_entrego_json='{\"dadosPessoais\":{\"nomeCompleto\":\"Sem Documento\"}}'::jsonb WHERE id=${ENTREGADOR_TRIGGER};" >/dev/null 2>&1
check "0085: enriquecimento sem CPF não quebra o PATCH nem apaga o que havia" \
  "$(psql_t -tAc "SELECT cpf FROM \"EntregadorDocumento\" WHERE entregador_id=${ENTREGADOR_TRIGGER};")" "11144477735"

check "0085: UPDATE direto também é barrado (ninguém altera o CPF para casar com a conta)" \
  "$(psql_t -tA <<'SQL' 2>&1 | grep -oE 'permission denied for table EntregadorDocumento' | head -1
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":1,"empresa_ativa":"6","escopo":[6]}', true);
SET ROLE authenticated;
UPDATE "EntregadorDocumento" SET cpf = '00000000000';
ROLLBACK;
SQL
)" "permission denied for table EntregadorDocumento"

echo ""
echo "===================================================================="
echo "RESULTADO: $fails falha(s)"
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
