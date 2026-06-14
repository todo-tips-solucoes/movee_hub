#!/usr/bin/env bash
# =============================================================================
# Roteiro E2E — Validação de XML em Lote Idempotente
# Feature: validacao-xml-lote
# Referência: docs/specs/validacao-xml-lote/quickstart.md (7 cenários)
#             docs/specs/validacao-xml-lote/contracts/validate-xml-batch.md
#
# EXECUTAR: APÓS merge na main + deploy da imagem backend + deploy da imagem frontend.
# AMBIENTE: produção (app.moveelog.com.br / banco chatmasterveloz).
# OPERADOR: executor humano — agente NUNCA toca produção (cláusula pétrea).
#
# Pré-requisitos:
#   - curl, jq instalados na máquina do operador
#   - Token JWT válido de um usuário da empresa Movee (id_empresa=6 ou grupo)
#   - Token JWT válido de um usuário de outra empresa (para INV-3)
#   - 3 XMLs reais em docs/nota_entrego/:
#       35503082243568174000168000000000009826065650835650.xml  (cnpj=43568174000168, nota=98)
#       35503082244890502000100000000000014626068428829820.xml  (cnpj=44890502000100, nota=146)
#       35503082255330677000180000000000011426063133427076.xml  (cnpj=55330677000180, nota=114)
#   - Movimentos abertos no banco para os CNPJs/notas acima (empresa Movee)
#     (caso não existam, criar via INSERT ou upload de lote CSV)
#
# Uso:
#   export TOKEN_MOVEE="Bearer <jwt-movee>"
#   export TOKEN_OUTRO_TENANT="Bearer <jwt-outra-empresa>"
#   export API_BASE="https://app.moveelog.com.br"         # via proxy frontend
#   # OU (acesso direto ao backend em dev):
#   # export API_BASE="http://localhost:3001"
#   bash e2e-validacao-xml-lote.sh
# =============================================================================

set -euo pipefail

API="${API_BASE:-https://app.moveelog.com.br}"
TOKEN="${TOKEN_MOVEE:?TOKEN_MOVEE nao definido}"
TOKEN_OUTRO="${TOKEN_OUTRO_TENANT:-}"
FIXTURES_DIR="$(cd "$(dirname "$0")/../../.." && pwd)/docs/nota_entrego"

XML1="${FIXTURES_DIR}/35503082243568174000168000000000009826065650835650.xml"
XML2="${FIXTURES_DIR}/35503082244890502000100000000000014626068428829820.xml"
XML3="${FIXTURES_DIR}/35503082255330677000180000000000011426063133427076.xml"

# Endpoint: via proxy Next.js (produção) ou backend direto (dev)
# O proxy Next.js em /api/* remove o prefixo e repassa ao backend.
ENDPOINT="${API}/api/validate-xml-batch"

echo "============================================================"
echo " Roteiro E2E — validacao-xml-lote"
echo " API: ${ENDPOINT}"
echo " Fixtures: ${FIXTURES_DIR}"
echo "============================================================"
echo ""

PASS=0
FAIL=0

check() {
  local label="$1"
  local condition="$2"
  if eval "$condition" >/dev/null 2>&1; then
    echo "[PASS] ${label}"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] ${label}"
    FAIL=$((FAIL + 1))
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 1: Lote nunca validado → status=validada (ou revalidada se já tinha)
# Quickstart §Cenário 1
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 1: lote nunca validado ---"
echo "PRÉ-CONDIÇÃO: nota_ok e erro_validacao dos movimentos dos 3 XMLs devem estar NULL."
echo "Se não estiverem, zerar com:"
echo "  UPDATE \"EnvioMassa\" SET nota_ok=NULL, erro_validacao=NULL WHERE numnota IN ('98','146','114') AND id_empresa IN (<ids-movee>);"
echo "(executar no pgadmin_db/chatmasterveloz antes deste cenário)"
echo ""

# SELECT antes para provar estado inicial
echo "SELECT (antes):"
cat <<'PSQL'
-- Rodar no banco chatmasterveloz (pgadmin_db):
SELECT id, cnpj_prestador, numnota, nota_ok, erro_validacao
FROM "EnvioMassa"
WHERE cnpj_prestador IN ('43568174000168','44890502000100','55330677000180')
  AND mov_fechado = false
ORDER BY cnpj_prestador;
PSQL
echo ""

RESP1=$(curl -s -X POST "${ENDPOINT}" \
  -H "Authorization: ${TOKEN}" \
  -F "xmlFiles=@${XML1}" \
  -F "xmlFiles=@${XML2}" \
  -F "xmlFiles=@${XML3}")
echo "Resposta Cenário 1:"
echo "${RESP1}" | jq .

check "C1: stats.total=3"       "echo '${RESP1}' | jq -e '.stats.total == 3'"
check "C1: stats.validada>=1"   "echo '${RESP1}' | jq -e '.stats.validada >= 1'"
check "C1: stats.erro=0"        "echo '${RESP1}' | jq -e '.stats.erro == 0'"
check "C1: results tem status snake_case (sem 'valid')" \
  "echo '${RESP1}' | jq -e '[.results[].status] | all(. != null)' && ! echo '${RESP1}' | jq -e '.results[0] | has(\"valid\")'"
check "C1: results tem match_criterio e movimento_id" \
  "echo '${RESP1}' | jq -e '.results[0] | has(\"match_criterio\") and has(\"movimento_id\")'"

# SELECT depois para confirmar gravação
echo ""
echo "SELECT (depois — confirmar nota_ok e erro_validacao preenchidos):"
cat <<'PSQL'
SELECT id, cnpj_prestador, numnota,
       length(nota_ok) as nota_ok_len,
       erro_validacao
FROM "EnvioMassa"
WHERE cnpj_prestador IN ('43568174000168','44890502000100','55330677000180')
  AND mov_fechado = false
ORDER BY cnpj_prestador;
PSQL
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 2: Reenvio idêntico → tudo ja_validada + NADA muda no banco (INV-1)
# Quickstart §Cenário 2 — prova de idempotência
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 2: reenvio idêntico → idempotência (INV-1) ---"
echo "PRÉ-CONDIÇÃO: Cenário 1 completado (notas aprovadas no banco)."
echo ""

# Capturar snapshot do banco antes do reenvio
echo "SELECT snapshot antes do reenvio (anotar nota_ok e updated_at):"
cat <<'PSQL'
SELECT id, cnpj_prestador, numnota, nota_ok, erro_validacao, updated_at
FROM "EnvioMassa"
WHERE cnpj_prestador IN ('43568174000168','44890502000100','55330677000180')
  AND mov_fechado = false
ORDER BY cnpj_prestador;
PSQL
echo ""

RESP2=$(curl -s -X POST "${ENDPOINT}" \
  -H "Authorization: ${TOKEN}" \
  -F "xmlFiles=@${XML1}" \
  -F "xmlFiles=@${XML2}" \
  -F "xmlFiles=@${XML3}")
echo "Resposta Cenário 2 (reenvio):"
echo "${RESP2}" | jq .

check "C2: stats.ja_validada=3"     "echo '${RESP2}' | jq -e '.stats.ja_validada == 3'"
check "C2: stats.validada=0"        "echo '${RESP2}' | jq -e '.stats.validada == 0'"
check "C2: stats.revalidada=0"      "echo '${RESP2}' | jq -e '.stats.revalidada == 0'"
check "C2: stats.erro=0"            "echo '${RESP2}' | jq -e '.stats.erro == 0'"

# Diferencial banco: updated_at deve ser IDÊNTICO ao snapshot anterior (sem PATCH)
echo ""
echo "SELECT snapshot após reenvio (updated_at deve ser IGUAL ao anterior — sem PATCH):"
cat <<'PSQL'
SELECT id, cnpj_prestador, numnota, nota_ok, erro_validacao, updated_at
FROM "EnvioMassa"
WHERE cnpj_prestador IN ('43568174000168','44890502000100','55330677000180')
  AND mov_fechado = false
ORDER BY cnpj_prestador;
PSQL
echo "VALIDAR MANUALMENTE: os updated_at dos Cenários 1 e 2 devem ser IGUAIS (sem escrita no banco)."
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 3: Reprovada + XML novo → revalidada
# Quickstart §Cenário 3
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 3: reprovada → revalidada ---"
echo "PRÉ-CONDIÇÃO: setar um dos movimentos como reprovado:"
cat <<'PSQL'
-- Substituir <id> pelo id do movimento com cnpj_prestador=43568174000168
UPDATE "EnvioMassa"
SET nota_ok='ARQUIVO_FAKE.xml', erro_validacao='Nota fiscal reprovada: CNPJ não encontrado'
WHERE id = <id-do-movimento-numnota-98>;
PSQL
echo ""

RESP3=$(curl -s -X POST "${ENDPOINT}" \
  -H "Authorization: ${TOKEN}" \
  -F "xmlFiles=@${XML1}")
echo "Resposta Cenário 3:"
echo "${RESP3}" | jq .

check "C3: status=revalidada para o XML da nota reprovada" \
  "echo '${RESP3}' | jq -e '.results[0].status == \"revalidada\"'"
check "C3: stats.revalidada>=1" \
  "echo '${RESP3}' | jq -e '.stats.revalidada >= 1'"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 4: Mesmo XML 2x no lote → 1 validada + 1 duplicada_no_lote
# Quickstart §Cenário 4
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 4: dedup intra-lote (duplicada_no_lote) ---"
echo "PRÉ-CONDIÇÃO: zerar nota_ok do movimento numnota=98 para forçar novo processamento."
cat <<'PSQL'
UPDATE "EnvioMassa" SET nota_ok=NULL, erro_validacao=NULL WHERE id = <id-numnota-98>;
PSQL
echo ""

RESP4=$(curl -s -X POST "${ENDPOINT}" \
  -H "Authorization: ${TOKEN}" \
  -F "xmlFiles=@${XML1}" \
  -F "xmlFiles=@${XML1}")   # mesmo XML enviado 2x
echo "Resposta Cenário 4 (mesmo XML 2x):"
echo "${RESP4}" | jq .

check "C4: stats.total=2"               "echo '${RESP4}' | jq -e '.stats.total == 2'"
check "C4: stats.duplicada_no_lote=1"   "echo '${RESP4}' | jq -e '.stats.duplicada_no_lote == 1'"
check "C4: 1ª linha não é duplicada"    "echo '${RESP4}' | jq -e '.results[0].status != \"duplicada_no_lote\"'"
check "C4: 2ª linha é duplicada_no_lote" "echo '${RESP4}' | jq -e '.results[1].status == \"duplicada_no_lote\"'"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 5: XML sem movimento → sem_movimento
# Quickstart §Cenário 5
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 5: XML sem movimento correspondente → sem_movimento ---"
echo "Criar um XML dummy com CNPJ/nota que NÃO existe em EnvioMassa:"

DUMMY_XML="/tmp/sem_movimento_dummy.xml"
cat > "${DUMMY_XML}" <<'XMLEOF'
<?xml version="1.0" encoding="UTF-8"?>
<CompNFSe xmlns="http://www.abrasf.org.br/nfse.xsd">
  <NFSe>
    <infNFSe Id="NFS99999999999999999999999999999999999999999999999999">
      <nNFSe>9999</nNFSe>
      <emit>
        <CNPJ>99999999000199</CNPJ>
        <xNome>Empresa Inexistente</xNome>
      </emit>
      <dhEmi>2024-01-01T00:00:00-03:00</dhEmi>
      <valores>
        <vLiq>100.00</vLiq>
      </valores>
    </infNFSe>
  </NFSe>
</CompNFSe>
XMLEOF

RESP5=$(curl -s -X POST "${ENDPOINT}" \
  -H "Authorization: ${TOKEN}" \
  -F "xmlFiles=@${DUMMY_XML}")
echo "Resposta Cenário 5:"
echo "${RESP5}" | jq .

check "C5: status=sem_movimento"      "echo '${RESP5}' | jq -e '.results[0].status == \"sem_movimento\"'"
check "C5: stats.sem_movimento=1"     "echo '${RESP5}' | jq -e '.stats.sem_movimento == 1'"
check "C5: movimento_id=null"         "echo '${RESP5}' | jq -e '.results[0].movimento_id == null'"

# Confirmar que NENHUMA linha foi inserida no banco
echo ""
echo "SELECT (confirmar que não foi inserido nada para o dummy CNPJ=99999999000199):"
cat <<'PSQL'
SELECT COUNT(*) FROM "EnvioMassa" WHERE cnpj_prestador = '99999999000199';
-- Deve retornar 0
PSQL
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 6: Tenant errada → não casa, não vaza (INV-3)
# Quickstart §Cenário 6
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 6: tenant errada → isolamento (INV-3) ---"
if [ -z "${TOKEN_OUTRO}" ]; then
  echo "[SKIP] TOKEN_OUTRO_TENANT não definido. Para testar INV-3, definir e re-executar."
  echo "       Os movimentos do XML1 pertencem à empresa Movee (id_empresa=6 ou grupo)."
  echo "       Usando token de empresa diferente, a resposta deve ser sem_movimento (não vaza dados)."
else
  RESP6=$(curl -s -X POST "${ENDPOINT}" \
    -H "Authorization: ${TOKEN_OUTRO}" \
    -F "xmlFiles=@${XML1}" \
    -F "xmlFiles=@${XML2}" \
    -F "xmlFiles=@${XML3}")
  echo "Resposta Cenário 6 (token de outra empresa):"
  echo "${RESP6}" | jq .

  check "C6: sem_movimento=3 (movimentos de outra empresa não vazam)" \
    "echo '${RESP6}' | jq -e '.stats.sem_movimento == 3'"
  check "C6: stats.validada=0 (não gravou nada na empresa errada)" \
    "echo '${RESP6}' | jq -e '.stats.validada == 0 and .stats.revalidada == 0'"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# CENÁRIO 7: FastAPI infra down → erro (resiliência, FR-014/FR-015)
# Quickstart §Cenário 7
# ─────────────────────────────────────────────────────────────────────────────
echo "--- CENÁRIO 7: FastAPI indisponível → status=erro (resiliência) ---"
echo "NOTA: Este cenário requer simular a FastAPI fora do ar."
echo "      Opções:"
echo "      a) Zerar FASTAPI_VALIDATION_TOKEN no ambiente do container (causa 401→erro de infra)."
echo "      b) Usar iptables para bloquear temporariamente o endpoint FastAPI."
echo "      c) Verificar logs do backend para linha '[validate-xml-batch][FASTAPI] infra' quando"
echo "         FastAPI retornar 5xx ou timeout."
echo ""
echo "PRÉ-CONDIÇÃO: zerar nota_ok de um movimento para que o handler tente chamar a FastAPI:"
cat <<'PSQL'
UPDATE "EnvioMassa" SET nota_ok=NULL, erro_validacao=NULL WHERE id = <id-numnota-98>;
PSQL
echo ""
echo "Com FastAPI inacessível, enviar XML1 e verificar:"
echo "  - status = 'erro'"
echo "  - erro_validacao = 'serviço de validação indisponível'"
echo "  - NÃO gravou nota_ok falsa no banco"
echo ""
echo "Verificação no banco após o cenário 7:"
cat <<'PSQL'
SELECT id, nota_ok, erro_validacao
FROM "EnvioMassa"
WHERE id = <id-numnota-98>;
-- nota_ok deve permanecer NULL (não gravou resultado falso)
PSQL
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# VERIFICAÇÃO DE INV-4: valor nunca alterado pelo PATCH
# ─────────────────────────────────────────────────────────────────────────────
echo "--- INV-4: valor não deve ter sido alterado em nenhum cenário ---"
echo "Comparar SELECT de valor antes (anotar durante pré-condição do Cenário 1) e depois:"
cat <<'PSQL'
SELECT id, cnpj_prestador, numnota, valor
FROM "EnvioMassa"
WHERE cnpj_prestador IN ('43568174000168','44890502000100','55330677000180')
  AND mov_fechado = false
ORDER BY cnpj_prestador;
-- valor deve ser IDÊNTICO ao início (o PATCH nunca toca a coluna valor)
PSQL
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# VERIFICAÇÃO DE ROTEAMENTO (não-regressão)
# ─────────────────────────────────────────────────────────────────────────────
echo "--- Verificação de roteamento FastAPI Movee×nexus ---"
echo "Verificar nos logs do container backend após os cenários:"
echo "  - Empresa Movee (id_empresa=6 ou grupo): URL deve conter 'fastapihomologacao'"
echo "    grep '[validate-xml-batch][FASTAPI]' backend.log | grep fastapihomologacao"
echo "  - Empresa nexus (outra): URL deve conter 'fastapihomologacaonexus'"
echo "    grep '[validate-xml-batch][FASTAPI]' backend.log | grep fastapihomologacaonexus"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# VERIFICAÇÃO FRONTEND (visual)
# ─────────────────────────────────────────────────────────────────────────────
echo "--- Verificação visual do frontend ---"
echo "Acessar app.moveelog.com.br e navegar até a página de Validação XML:"
echo "  1. Fazer upload dos 3 XMLs reais."
echo "  2. Verificar que a tabela exibe badges coloridos por status (não flags booleanas)."
echo "  3. Verificar resumo agregado no topo do card: Total, Já validadas, Validadas, Revalidadas, Duplicadas, Sem mov., Erros."
echo "  4. Verificar que o badge 'Ja validada' usa ícone CheckCircle + texto (não só cor)."
echo "  5. Verificar coluna 'Rastreabilidade' com match_criterio e movimento_id."
echo "  6. Verificar responsividade em mobile (R001-R012 preservados)."
echo "  7. Verificar que o botão 'Exportar CSV' inclui os novos campos: status, match_criterio, movimento_id."
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# SUMÁRIO
# ─────────────────────────────────────────────────────────────────────────────
echo "============================================================"
echo " Sumário automático (verificações via curl/jq)"
echo "   PASS: ${PASS}"
echo "   FAIL: ${FAIL}"
echo ""
echo " Verificações manuais pendentes (requerem banco + logs):"
echo "   - INV-1: updated_at igual antes/depois do reenvio (Cenário 2)"
echo "   - INV-2: NUNCA houve PATCH em movimento aprovado (inspecionar logs)"
echo "   - INV-4: valor idêntico antes/depois em todos os cenários"
echo "   - C7:    FastAPI infra down → nota_ok permanece NULL no banco"
echo "   - Roteamento FastAPI Movee×nexus nos logs"
echo "   - Frontend: badges, resumo, responsividade, CSV"
echo "============================================================"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
