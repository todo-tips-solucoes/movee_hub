#!/usr/bin/env bash
# =============================================================================
# hub-repasse-saldo-minimo-roundtrip-integration.sh — tasks.md 3.8.5 + 3.3.7
# (resto) + F1 1.2.5/1.4.1/1.4.2 (feature repasse-saldo-minimo). Cenário
# F3.13 — roundtrip end-to-end REAL (nunca mockado) num projeto hub-test
# EFÊMERO (db+postgrest+backend, mesmo molde de
# hub-adiantamentos-smoke-full-chain-integration.sh). NUNCA toca
# chatmasterveloz/produção nem o hub-homolog (que hoje está em 0091 — sem
# 0097/0098; por isso o roundtrip real só é possível aqui).
#
# Cobre, tudo via HTTP real (Express -> PostgREST -> Postgres):
#   - login hub (papel `financeiro_aprovador`, 0097 — único papel de entidade,
#     junto de admin_plataforma, com `adiantamentos.pagamento_confirmar` após
#     a trava F2 desta feature) + troca de entidade (empresa 6)
#   - GET /api/v1/adiantamentos/repasse e /repasse/exportar da semana ABERTA
#     (F1 1.2.5): idExterno presente, CSV com "Identificador" na 1ª coluna
#   - POST /api/v1/adiantamentos/repasse/:periodo/fechar real, fechando uma
#     semana com 1 motorista abaixo do piso (retido)
#   - GET /api/v1/adiantamentos/repasse?periodo=... real, pós-fechamento:
#     confere o shape contra contracts/hub-repasse-api.md (idExterno,
#     saldoAnterior, aPagar, transportado, retido) + /repasse/exportar da
#     semana FECHADA (F1 1.2.5)
#   - cross-check: idExterno de GET /repasse bate com idExterno de
#     GET /motoristas (tela de Motoristas) para o mesmo entregador — via
#     usuário `admin_entidade` à parte, já que `financeiro_aprovador` não tem
#     `motoristas.listar` (F1 1.2.5/quickstart F1.1)
#   - POST /repasse/:periodo/movimentos (3.3.7 resto): motorista retido é
#     RECUSADO com motivo `RETIDO`, sem gerar movimento; motorista pago numa
#     semana seguinte, com saldo carregado da semana retida anterior, gera
#     UMA nota só somando os componentes (valor_nota + saldo_anterior_nota)
#   - login do app motorista via ContaMotorista (HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true,
#     mesmo gate de hub-motorista-canonico-credencial-integration.sh)
#   - GET /motorista/repasse real: confere `ultimoFechado` contra
#     contracts/motorista-repasse-api.md (saldoAnterior, aPagar, retido,
#     transportado) para o MESMO motorista/semana fechados no lado hub
#
# Uso: infra/hub/testes/hub-repasse-saldo-minimo-roundtrip-integration.sh
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
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

# tasks.md 5.4 (hub-motorista-canonico) — liga o gate do login do app
# motorista via ContaMotorista SÓ neste projeto efêmero: um único
# ContaMotorista serve login E RPCs (hub_jwt_motorista_cnpj), sem precisar
# duplicar fixture na tabela `Motorista` legada.
export HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true

echo "subindo db+postgrest+backend efêmeros ($PROJECT, HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true)…"
dc up -d --wait db
dc up -d --wait postgrest
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (série completa, até 0098)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0098_repasse_saldo_minimo.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas até 0098"; cat "$TMP/migrate.log"; exit 1; }

SENHA_HUB='SenhaSinteticaRepasseHub#1'
SENHA_MOTORISTA='SenhaSinteticaRepasseMoto#1'
SENHA_ADMIN='SenhaSinteticaRepasseAdmin#1'
HASH_HUB="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_HUB" 2>"$TMP/hash-hub.log" | tr -d '[:space:]')"
[ -n "$HASH_HUB" ] || { echo "FAIL: geração do hash bcrypt (hub) falhou"; cat "$TMP/hash-hub.log"; exit 1; }
HASH_MOTORISTA="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_MOTORISTA" 2>"$TMP/hash-moto.log" | tr -d '[:space:]')"
[ -n "$HASH_MOTORISTA" ] || { echo "FAIL: geração do hash bcrypt (motorista) falhou"; cat "$TMP/hash-moto.log"; exit 1; }
# admin_entidade à parte (F1 1.2.5): financeiro_aprovador não tem
# `motoristas.listar` (0097 copia só as permissões de `financeiro`, que nunca
# teve esse módulo) — precisa de outro papel para o cross-check com
# GET /motoristas.
HASH_ADMIN="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_ADMIN" 2>"$TMP/hash-admin.log" | tr -d '[:space:]')"
[ -n "$HASH_ADMIN" ] || { echo "FAIL: geração do hash bcrypt (admin) falhou"; cat "$TMP/hash-admin.log"; exit 1; }

PERIODO='2026-01-05'   # segunda-feira (dow=1) — bate com apuracao_dia_inicio=1 abaixo
PERIODO2='2026-01-12'  # semana seguinte (periodo_inicio+7 — ordem estrita de hub_adiantamento_repasse_fechar)

# --- fixtures: config nova (apuração semanal + piso ligados), financeiro,
# ContaMotorista+Entregador vinculados, 1 crédito ABAIXO do piso (retido) ----
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/seed.log" 2>&1
DO \$\$
DECLARE v_ver int; v_imp int;
BEGIN
  SELECT COALESCE(max(versao), 0) + 1 INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  INSERT INTO "AdiantamentoConfiguracao" (
      id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base,
      categorias_extrato, categorias_nota, desconto_adiantamentos, desconto_debitos, repasse_visivel_app)
  SELECT 6, v_ver, now(), timezone, dias_habilitados, horario_abertura, horario_corte,
      percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto,
      descricao_pix_modelo, 1, 3, 'data_lancamento',
      ARRAY['Corridas concluidas'], ARRAY['Corridas concluidas'], true, true, true
  FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;

  INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status)
  VALUES (6, 'faturamento', repeat('9', 64), 'completed') RETURNING id INTO v_imp;

  -- 3.3.7 resto: POST /repasse/:periodo/movimentos busca o CNPJ do TOMADOR em
  -- Empresa.cnpj (id=6) — hub-test é banco novo/vazio (schema só, 0033),
  -- sem seed de Empresa nenhuma (0034 semeia só 9001/9010); sem esta linha a
  -- rota devolve 409 EMPRESA_SEM_CNPJ em vez de 201.
  INSERT INTO "Empresa" (id, nome_empresa, email, cnpj) VALUES
    (6, 'Movee Roundtrip F3.13', 'movee.roundtrip@example.test', '12345678000199')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
    ('financeiro.roundtrip@example.test', '$HASH_HUB', 'Financeiro Roundtrip F3.13', true);
  INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
    VALUES ((SELECT id FROM "Usuario" WHERE email='financeiro.roundtrip@example.test'), 6,
            (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true);

  -- admin_entidade à parte (F1 1.2.5) — só para GET /motoristas.
  INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
    ('admin.roundtrip@example.test', '$HASH_ADMIN', 'Admin Roundtrip F3.13', true);
  INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
    VALUES ((SELECT id FROM "Usuario" WHERE email='admin.roundtrip@example.test'), 6,
            (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true);

  INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo, senha) VALUES
    ('55555555000103', 'Roundtrip F3.13 Retido', true, '$HASH_MOTORISTA');
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id) VALUES
    (6, gen_random_uuid(), 'Roundtrip F3.13 Retido', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000103'));

  -- Crédito de 3,00 na semana do fechamento — abaixo do piso (5,50 default) => retido.
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='55555555000103')),
          date '$PERIODO', date '$PERIODO', 'Credito', 3.00, 'Corridas concluidas', md5('roundtrip-f313')||md5('x'));

  -- Segundo motorista (3.3.7 resto): retido na semana 1 (2,00 < piso) e
  -- pago na semana 2 (8,00 na semana + 2,00 carregados = 10,00 >= piso) —
  -- cenário "pago com saldo carregado" de POST /repasse/:periodo/movimentos.
  INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo, senha) VALUES
    ('66666666000104', 'Roundtrip F3.13 Saldo', true, '$HASH_MOTORISTA');
  INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id) VALUES
    (6, gen_random_uuid(), 'Roundtrip F3.13 Saldo', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='66666666000104'));

  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='66666666000104')),
          date '$PERIODO', date '$PERIODO', 'Credito', 2.00, 'Corridas concluidas', md5('roundtrip-f313-saldo')||md5('semana1'));
  INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  VALUES (6, v_imp, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='66666666000104')),
          date '$PERIODO2', date '$PERIODO2', 'Credito', 8.00, 'Corridas concluidas', md5('roundtrip-f313-saldo')||md5('semana2'));
END \$\$;
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed deu erro"; cat "$TMP/seed.log"; exit 1; fi
ID_EXTERNO="$(psql_t -tAc "SELECT id_externo FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='55555555000103');" | tr -d '[:space:]')"
[ -n "$ID_EXTERNO" ] || { echo "FAIL: Entregador de fixture não foi criado"; exit 1; }
ID_EXTERNO_SALDO="$(psql_t -tAc "SELECT id_externo FROM \"Entregador\" WHERE motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='66666666000104');" | tr -d '[:space:]')"
[ -n "$ID_EXTERNO_SALDO" ] || { echo "FAIL: Entregador de fixture (saldo) não foi criado"; exit 1; }
check "seed: Entregador/ContaMotorista/config/crédito criados (id_externo=$ID_EXTERNO, id_externo_saldo=$ID_EXTERNO_SALDO)" "0" "0"

# --- cadeia HTTP real, dentro do container backend ---------------------------
SMOKE_OUT="$(dc exec -T backend node - "$SENHA_HUB" "$SENHA_MOTORISTA" "$PERIODO" "$ID_EXTERNO" "$SENHA_ADMIN" "$ID_EXTERNO_SALDO" "$PERIODO2" <<'JS' 2>&1
'use strict';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

const CABECALHO_CSV_ESPERADO = 'Identificador,Entregador,Créditos,Adiantamentos,Débitos,Remanescente,Saldo anterior,A pagar,Passou para a próxima semana';

async function main() {
  const senhaHub = process.argv[2];
  const senhaMotorista = process.argv[3];
  const periodo = process.argv[4];
  const idExterno = process.argv[5];
  const senhaAdmin = process.argv[6];
  const idExternoSaldo = process.argv[7];
  const periodo2 = process.argv[8];
  const out = {};

  // --- lado HUB: login + troca de entidade ---------------------------------
  const rLogin = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'financeiro.roundtrip@example.test', senha: senhaHub }),
  });
  out.hub_login_status = rLogin.status;
  let jar = parseSetCookie(rLogin);

  const rTroca = await fetch('http://localhost:3000/api/v1/me/entidade', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ empresa_id: 6 }),
  });
  out.hub_troca_status = rTroca.status;
  jar = { ...jar, ...parseSetCookie(rTroca) };

  // --- F1 1.2.5: semana ABERTA (antes de fechar) — tela + CSV --------------
  const rRepasseAberta = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse?periodo=${periodo}`, {
    headers: { Cookie: cookieHeader(jar) },
  });
  const bRepasseAberta = await rRepasseAberta.json();
  out.hub_repasse_aberta_status = rRepasseAberta.status;
  out.hub_repasse_aberta_situacao = bRepasseAberta.periodo && bRepasseAberta.periodo.situacao;
  const itemAberta = (bRepasseAberta.itens || []).find((i) => i.idExterno === idExterno);
  out.hub_item_aberta_tem_id_externo = itemAberta && typeof itemAberta.idExterno === 'string' && itemAberta.idExterno.length > 0 ? 'true' : 'false';

  const rExportarAberta = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse/exportar?periodo=${periodo}`, {
    headers: { Cookie: cookieHeader(jar) },
  });
  const textoExportarAberta = await rExportarAberta.text();
  out.hub_exportar_aberta_status = rExportarAberta.status;
  out.hub_exportar_aberta_header_ok = textoExportarAberta.split('\r\n')[0] === CABECALHO_CSV_ESPERADO ? 'true' : 'false';

  // --- fechar semana 1 + GET pós-fechamento ---------------------------------
  const rFechar = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse/${periodo}/fechar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ confirmacao: true }),
  });
  const bFechar = await rFechar.json();
  out.hub_fechar_status = rFechar.status;
  out.hub_fechar_apuracao_id = bFechar.apuracaoId;

  const rRepasse = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse?periodo=${periodo}`, {
    headers: { Cookie: cookieHeader(jar) },
  });
  const bRepasse = await rRepasse.json();
  out.hub_repasse_status = rRepasse.status;
  out.hub_repasse_situacao = bRepasse.periodo && bRepasse.periodo.situacao;
  const item = (bRepasse.itens || []).find((i) => i.idExterno === idExterno);
  out.hub_item_encontrado = item ? 'true' : 'false';
  if (item) {
    // contracts/hub-repasse-api.md — shape exato do item de semana fechada.
    out.hub_item_tem_todas_chaves = ['entregadorId','idExterno','nome','creditos','adiantamentos','debitos',
      'remanescente','negativo','emProcessamento','saldoAnterior','aPagar','transportado','retido']
      .every((k) => Object.prototype.hasOwnProperty.call(item, k)) ? 'true' : 'false';
    out.hub_item_retido = item.retido;
    out.hub_item_a_pagar = item.aPagar;
    out.hub_item_transportado = item.transportado;
    out.hub_item_saldo_anterior = item.saldoAnterior;
  }
  const itemSaldo1 = (bRepasse.itens || []).find((i) => i.idExterno === idExternoSaldo);
  out.hub_item_saldo1_retido = itemSaldo1 && itemSaldo1.retido;
  out.hub_item_saldo1_transportado = itemSaldo1 && itemSaldo1.transportado;

  // --- F1 1.2.5: CSV da semana FECHADA --------------------------------------
  const rExportarFechada = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse/exportar?periodo=${periodo}`, {
    headers: { Cookie: cookieHeader(jar) },
  });
  const textoExportarFechada = await rExportarFechada.text();
  out.hub_exportar_fechada_status = rExportarFechada.status;
  out.hub_exportar_fechada_header_ok = textoExportarFechada.split('\r\n')[0] === CABECALHO_CSV_ESPERADO ? 'true' : 'false';

  // --- 3.3.7 resto: POST /repasse/:periodo1/movimentos — motorista retido
  //     é RECUSADO com motivo RETIDO, sem gerar movimento nenhum. ----------
  const rMov1 = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse/${periodo}/movimentos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ confirmacao: true }),
  });
  const bMov1 = await rMov1.json();
  out.hub_mov1_status = rMov1.status;
  out.hub_mov1_gerados = bMov1.gerados;
  const recusaRetido = (bMov1.recusados || []).find((r) => item && r.entregadorId === item.entregadorId);
  out.hub_mov1_motivo_retido = recusaRetido ? recusaRetido.motivo : null;

  // --- fechar semana 2 (saldo carregado da semana 1 retida) -----------------
  const rFechar2 = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse/${periodo2}/fechar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ confirmacao: true }),
  });
  const bFechar2 = await rFechar2.json();
  out.hub_fechar2_status = rFechar2.status;
  out.hub_fechar2_apuracao_id = bFechar2.apuracaoId;

  const rRepasse2 = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse?periodo=${periodo2}`, {
    headers: { Cookie: cookieHeader(jar) },
  });
  const bRepasse2 = await rRepasse2.json();
  out.hub_repasse2_status = rRepasse2.status;
  const itemSaldo2 = (bRepasse2.itens || []).find((i) => i.idExterno === idExternoSaldo);
  out.hub_item_saldo2_encontrado = itemSaldo2 ? 'true' : 'false';
  if (itemSaldo2) {
    out.hub_item_saldo2_retido = itemSaldo2.retido;
    out.hub_item_saldo2_saldo_anterior = itemSaldo2.saldoAnterior;
    out.hub_item_saldo2_a_pagar = itemSaldo2.aPagar;
    out.hub_item_saldo2_transportado = itemSaldo2.transportado;
  }

  // --- 3.3.7 resto: POST /repasse/:periodo2/movimentos — pago com saldo
  //     carregado soma os componentes numa nota só (conferido no Postgres
  //     depois, via EnvioMassa, porque a resposta só traz a contagem). -----
  const rMov2 = await fetch(`http://localhost:3000/api/v1/adiantamentos/repasse/${periodo2}/movimentos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ confirmacao: true }),
  });
  const bMov2 = await rMov2.json();
  out.hub_mov2_status = rMov2.status;
  out.hub_mov2_gerados = bMov2.gerados;

  // --- F1 1.2.5: cross-check idExterno com GET /motoristas (admin_entidade,
  //     financeiro_aprovador não tem `motoristas.listar`) -------------------
  const rLoginAdmin = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin.roundtrip@example.test', senha: senhaAdmin }),
  });
  out.admin_login_status = rLoginAdmin.status;
  let jarAdmin = parseSetCookie(rLoginAdmin);
  const rTrocaAdmin = await fetch('http://localhost:3000/api/v1/me/entidade', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAdmin) },
    body: JSON.stringify({ empresa_id: 6 }),
  });
  jarAdmin = { ...jarAdmin, ...parseSetCookie(rTrocaAdmin) };
  out.admin_troca_status = rTrocaAdmin.status;

  const rMotoristas = await fetch('http://localhost:3000/api/v1/motoristas?pageSize=200', {
    headers: { Cookie: cookieHeader(jarAdmin) },
  });
  const bMotoristas = await rMotoristas.json();
  out.motoristas_status = rMotoristas.status;
  const motoristaNaTela = item && (bMotoristas.items || []).find((m) => m.id === item.entregadorId);
  out.motoristas_id_externo_bate = motoristaNaTela && motoristaNaTela.idExterno === idExterno ? 'true' : 'false';

  // --- lado MOTORISTA: login via ContaMotorista + GET /motorista/repasse ---
  const rLoginMoto = await fetch('http://localhost:3000/motorista/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpjPrestador: '55555555000103', senha: senhaMotorista }),
  });
  out.moto_login_status = rLoginMoto.status;
  const jarMoto = parseSetCookie(rLoginMoto);

  const rRepasseMoto = await fetch('http://localhost:3000/motorista/repasse', {
    headers: { Cookie: cookieHeader(jarMoto) },
  });
  const bRepasseMoto = await rRepasseMoto.json();
  out.moto_repasse_status = rRepasseMoto.status;
  out.moto_tem_ultimo_fechado = bRepasseMoto.ultimoFechado ? 'true' : 'false';
  if (bRepasseMoto.ultimoFechado) {
    // contracts/motorista-repasse-api.md — shape exato de `ultimoFechado`.
    out.moto_ultimo_fechado_tem_todas_chaves = ['periodoInicio','periodoFim','dataRepasse','fechadoEm',
      'creditos','adiantamentos','debitos','remanescente','negativo','saldoAnterior','aPagar','transportado','retido']
      .every((k) => Object.prototype.hasOwnProperty.call(bRepasseMoto.ultimoFechado, k)) ? 'true' : 'false';
    out.moto_ultimo_fechado_retido = bRepasseMoto.ultimoFechado.retido;
    out.moto_ultimo_fechado_a_pagar = bRepasseMoto.ultimoFechado.aPagar;
    out.moto_ultimo_fechado_transportado = bRepasseMoto.ultimoFechado.transportado;
    out.moto_ultimo_fechado_saldo_anterior = bRepasseMoto.ultimoFechado.saldoAnterior;
  }

  process.stdout.write(JSON.stringify(out));
}
main().catch((e) => { console.error('ERRO:', e && e.stack || e); process.exit(1); });
JS
)"
echo "$SMOKE_OUT" > "$TMP/smoke.json"
SMOKE_JSON="$(tail -n1 "$TMP/smoke.json")"

G() { printf '%s' "$SMOKE_JSON" | jq -r --arg k "$1" 'if .[$k] == null then "null" else (.[$k] | tostring) end'; }

check "F3.13: login hub real -> 200" "$(G hub_login_status)" "200"
check "F3.13: troca de entidade real -> 200" "$(G hub_troca_status)" "200"

# --- F1 1.2.5/1.4.1/1.4.2: semana ABERTA (tela + CSV), sem mock -------------
check "F1.1: GET /repasse (semana aberta) real -> 200" "$(G hub_repasse_aberta_status)" "200"
check "F1.1: GET /repasse (semana aberta) -> periodo.situacao=aberto" "$(G hub_repasse_aberta_situacao)" "aberto"
check "F1.1: item da semana aberta tem idExterno (string não-vazia)" "$(G hub_item_aberta_tem_id_externo)" "true"
check "F1.1: GET /repasse/exportar (semana aberta) real -> 200" "$(G hub_exportar_aberta_status)" "200"
check "F1.1: CSV (semana aberta) começa por Identificador,Entregador,…" "$(G hub_exportar_aberta_header_ok)" "true"

check "F3.13: POST /repasse/:periodo/fechar real -> 201" "$(G hub_fechar_status)" "201"
check "F3.13: GET /repasse (pós-fechamento real) -> 200" "$(G hub_repasse_status)" "200"
check "F3.13: GET /repasse -> periodo.situacao=fechado" "$(G hub_repasse_situacao)" "fechado"
check "F3.13: item do motorista retido presente na resposta real" "$(G hub_item_encontrado)" "true"
check "F3.13: item real tem todas as chaves do contracts/hub-repasse-api.md" "$(G hub_item_tem_todas_chaves)" "true"
check "F3.13: item real -> retido=true" "$(G hub_item_retido)" "true"
check "F3.13: item real -> A pagar=0.00" "$(G hub_item_a_pagar)" "0.00"
check "F3.13: item real -> transportado=3.00" "$(G hub_item_transportado)" "3.00"
check "F1.1: GET /repasse/exportar (semana fechada) real -> 200" "$(G hub_exportar_fechada_status)" "200"
check "F1.1: CSV (semana fechada) começa por Identificador,Entregador,…" "$(G hub_exportar_fechada_header_ok)" "true"

# --- F1 1.2.5: cross-check idExterno com GET /motoristas -------------------
check "F1.1: login admin_entidade real -> 200" "$(G admin_login_status)" "200"
check "F1.1: troca de entidade (admin) real -> 200" "$(G admin_troca_status)" "200"
check "F1.1: GET /motoristas real -> 200" "$(G motoristas_status)" "200"
check "F1.1: idExterno de GET /repasse bate com idExterno de GET /motoristas" "$(G motoristas_id_externo_bate)" "true"

# --- 3.3.7 resto: POST /repasse/:periodo/movimentos — retido é RECUSADO ----
check "3.3.7: 2º motorista (saldo) também retido na semana 1 (2,00 < piso)" "$(G hub_item_saldo1_retido)" "true"
check "3.3.7: POST /repasse/:periodo1/movimentos real -> 201" "$(G hub_mov1_status)" "201"
check "3.3.7: nenhum movimento gerado na semana 1 (só retido)" "$(G hub_mov1_gerados)" "0"
check "3.3.7: motorista retido recusado com motivo RETIDO" "$(G hub_mov1_motivo_retido)" "RETIDO"

# --- 3.3.7 resto: semana 2 — pago com saldo carregado ----------------------
check "3.3.7: POST /repasse/:periodo2/fechar real -> 201" "$(G hub_fechar2_status)" "201"
check "3.3.7: GET /repasse (semana 2, pós-fechamento) -> 200" "$(G hub_repasse2_status)" "200"
check "3.3.7: item do motorista com saldo presente na semana 2" "$(G hub_item_saldo2_encontrado)" "true"
check "3.3.7: item da semana 2 -> retido=false (saldo+produção cobre o piso)" "$(G hub_item_saldo2_retido)" "false"
check "3.3.7: item da semana 2 -> saldoAnterior=2.00 (carregado da semana 1)" "$(G hub_item_saldo2_saldo_anterior)" "2.00"
check "3.3.7: item da semana 2 -> A pagar=10.00 (8,00 da semana + 2,00 carregados)" "$(G hub_item_saldo2_a_pagar)" "10.00"
check "3.3.7: item da semana 2 -> transportado=0.00 (nada mais fica retido)" "$(G hub_item_saldo2_transportado)" "0.00"
check "3.3.7: POST /repasse/:periodo2/movimentos real -> 201" "$(G hub_mov2_status)" "201"
check "3.3.7: 1 movimento gerado na semana 2 (motorista pago com saldo)" "$(G hub_mov2_gerados)" "1"

check "F3.13: login app motorista (ContaMotorista) real -> 200" "$(G moto_login_status)" "200"
check "F3.13: GET /motorista/repasse real -> 200" "$(G moto_repasse_status)" "200"
check "F3.13: GET /motorista/repasse -> ultimoFechado presente" "$(G moto_tem_ultimo_fechado)" "true"
check "F3.13: ultimoFechado real tem todas as chaves do contracts/motorista-repasse-api.md" "$(G moto_ultimo_fechado_tem_todas_chaves)" "true"
check "F3.13: ultimoFechado real -> retido=true (mesmo motorista/semana do lado hub)" "$(G moto_ultimo_fechado_retido)" "true"
check "F3.13: ultimoFechado real -> aPagar=0.00" "$(G moto_ultimo_fechado_a_pagar)" "0.00"
check "F3.13: ultimoFechado real -> transportado=3.00 (bate com o lado hub)" "$(G moto_ultimo_fechado_transportado)" "3.00"
check "F3.13: ultimoFechado real -> saldoAnterior=3.00 (semana 2 é a última fechada; A segue retido, arrasta o mesmo saldo)" "$(G moto_ultimo_fechado_saldo_anterior)" "3.00"

# --- 3.3.7 resto: confere no Postgres o que POST /repasse/:periodo/movimentos
#     de fato gravou — a resposta HTTP só traz contagem, não a lista de quem
#     foi gerado (routes/hub-adiantamentos.js:1858-1863).
COUNT_ENVIOMASSA_RETIDO="$(psql_t -tAc "SELECT count(*) FROM \"EnvioMassa\" WHERE cnpj_prestador='55555555000103';" | tr -d '[:space:]')"
check "3.3.7: nenhum EnvioMassa gerado para o motorista retido (nunca saiu do retido)" "$COUNT_ENVIOMASSA_RETIDO" "0"

VALOR_ENVIOMASSA_SALDO="$(psql_t -tAc "SELECT valor::numeric(12,2) FROM \"EnvioMassa\" WHERE cnpj_prestador='66666666000104' ORDER BY id DESC LIMIT 1;" | tr -d '[:space:]')"
check "3.3.7: EnvioMassa.valor do motorista pago = 10.00 (nota soma valor_nota+saldo_anterior_nota)" "$VALOR_ENVIOMASSA_SALDO" "10.00"

GORJETA_ENVIOMASSA_SALDO="$(psql_t -tAc "SELECT gorjeta FROM \"EnvioMassa\" WHERE cnpj_prestador='66666666000104' ORDER BY id DESC LIMIT 1;" | tr -d '[:space:]')"
check "3.3.7: EnvioMassa.gorjeta do motorista pago vazia (sem produção fora-nota)" "$GORJETA_ENVIOMASSA_SALDO" ""

echo ""
echo "===================================================================="
echo "RESULTADO: $fails falha(s)"
echo "===================================================================="
echo "$SMOKE_JSON"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)
