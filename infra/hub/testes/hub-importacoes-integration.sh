#!/usr/bin/env bash
# =============================================================================
# hub-importacoes-integration.sh — tasks.md FASE 3 (3.1.5/3.2.3/3.3.4/3.4.2):
# prova E2E de POST /api/v1/importacoes contra um projeto hub-test EFÊMERO e
# descartável. Mesmo padrão de isolamento de infra/hub/testes/hub-auth-
# integration.sh / hub-rbac-integration.sh — nunca toca chatmasterveloz/produção.
#
# Cobre:
#   (a) validações imediatas -> 422 INVALIDO com motivo: extensão errada,
#       tipo desconhecido, conteúdo vazio, ZIP com >1 entrada
#   (b) sem permissão 'importacoes.criar' (papel leitura) -> 403 PERMISSAO_NEGADA
#   (c) happy path CSV faturamento -> 201 { id, status: pending }; registro
#       ImportacaoArquivo criado (status=pending, hash correto); arquivo
#       original persistido em uploads/importacoes/<id>; Auditoria
#       'importacao.criada' registrada
#   (d) reenvio do MESMO arquivo (mesma entidade+tipo) -> 409 CONFLITO com
#       importacaoOriginalId correto; nenhuma linha nova em ImportacaoArquivo
#   (e) mesmo arquivo, entidade ou tipo DIFERENTE -> 201 (dedupe é por
#       id_empresa+tipo+hash, não só hash)
#   (f) upload via ZIP de 1 entrada -> 201 (reusa hub-import-zip.js)
#
# Uso: infra/hub/testes/hub-importacoes-integration.sh
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
# Cap de memória obrigatório no build (RUNBOOK.md §Build do backend do hub —
# lição de starvation 2026-06-11): DOCKER_BUILDKIT=0 + --memory=2g.
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (0002..0018)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0018_dedupe_erro_recuperacao_orfa.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 2 Usuarios (operador com importacoes.criar; leitura, SEM) --------
SENHA_OK='SenhaSinteticaImport#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_OP=930001
E_LEITURA=930002
E_OUTRA=930003

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('import-operador@example.test', '$HASH_OK', 'Usuario Teste Import Operador', true),
  ('import-leitura@example.test', '$HASH_OK', 'Usuario Teste Import Leitura', true);
SQL
UID_OP="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='import-operador@example.test'" | tr -d '[:space:]')"
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='import-leitura@example.test'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] && [ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou os papéis esperados"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_OP, $E_OP, $PAPEL_OPERADOR, true),
  ($UID_OP, $E_OUTRA, $PAPEL_OPERADOR, true),
  ($UID_LEITURA, $E_LEITURA, $PAPEL_LEITURA, true);
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + uploads via FormData nativo
# (Node 20 expõe FormData/Blob globais, mesma stack undici do fetch).
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_OP" "$E_OUTRA" "$E_LEITURA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function upload(jar, { tipo, nomeArquivo, conteudo, mime }) {
  // `conteudo` pode ser string (CSV texto) ou Buffer (ZIP binário) — passar
  // SEMPRE como Buffer para o Blob evita reencode UTF-8 corrompendo bytes
  // >=128 de um ZIP (Blob([string]) usa TextEncoder/UTF-8, não latin1).
  const bytes = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8');
  const fd = new FormData();
  fd.append('tipo', tipo);
  fd.append('file', new Blob([bytes], { type: mime || 'text/csv' }), nomeArquivo);
  const r = await fetch(`${BASE}/importacoes`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

// Fixture ZIP mínimo (STORE, sem compressão) com 1 entrada "dados.csv" —
// formato PKZIP manual (mesma técnica de tests/hub-import-parser.test.js).
function construirZipUmaEntrada(nomeEntrada, conteudoTexto) {
  const conteudo = Buffer.from(conteudoTexto, 'utf8');
  const nomeBuf = Buffer.from(nomeEntrada, 'utf8');
  // CRC32 gravado como 0: hub-import-zip.js (extractSingleEntryZip) não
  // valida o CRC da entrada (só STORE/DEFLATE + tamanho) — checado no
  // próprio código-fonte antes de escrever este fixture.
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(0, 8); // method = STORE
  localHeader.writeUInt16LE(0, 10); // time
  localHeader.writeUInt16LE(0, 12); // date
  localHeader.writeUInt32LE(0, 14); // crc32 (0 — não validado pelo extractor)
  localHeader.writeUInt32LE(conteudo.length, 18); // compressed size
  localHeader.writeUInt32LE(conteudo.length, 22); // uncompressed size
  localHeader.writeUInt16LE(nomeBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(0, 16);
  centralHeader.writeUInt32LE(conteudo.length, 20);
  centralHeader.writeUInt32LE(conteudo.length, 24);
  centralHeader.writeUInt16LE(nomeBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // offset do local header = 0

  const localEntry = Buffer.concat([localHeader, nomeBuf, conteudo]);
  const centralEntry = Buffer.concat([centralHeader, nomeBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); // entradas neste disco
  eocd.writeUInt16LE(1, 10); // total de entradas
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16); // offset do central dir
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

async function main() {
  const senha = process.argv[2];
  const empresaOp = Number(process.argv[3]);
  const empresaOutra = Number(process.argv[4]);
  const empresaLeitura = Number(process.argv[5]);
  const out = {};

  // ── sem autenticação: 401 ────────────────────────────────────────────────
  const rSemAuth = await fetch(`${BASE}/importacoes`, { method: 'POST', body: new FormData() });
  out.sem_auth_status = rSemAuth.status;

  // ── login operador + entidade ativa ──────────────────────────────────────
  let jarOp = await login('import-operador@example.test', senha);
  jarOp = await trocarEntidade(jarOp, empresaOp);

  // ── login leitura + entidade ativa (SEM importacoes.criar) ──────────────
  let jarLeitura = await login('import-leitura@example.test', senha);
  jarLeitura = await trocarEntidade(jarLeitura, empresaLeitura);

  const csvValido = 'nome_completo;praca\nJoao;SP\n';

  // (a) validações imediatas
  const rExtInvalida = await upload(jarOp, { tipo: 'faturamento', nomeArquivo: 'dados.txt', conteudo: csvValido, mime: 'text/plain' });
  out.ext_invalida_status = rExtInvalida.status;
  out.ext_invalida_motivo = rExtInvalida.body && rExtInvalida.body.motivo;

  const rTipoInvalido = await upload(jarOp, { tipo: 'envio_massa', nomeArquivo: 'dados.csv', conteudo: csvValido });
  out.tipo_invalido_status = rTipoInvalido.status;
  out.tipo_invalido_motivo = rTipoInvalido.body && rTipoInvalido.body.motivo;

  const rVazio = await upload(jarOp, { tipo: 'faturamento', nomeArquivo: 'vazio.csv', conteudo: '' });
  out.conteudo_vazio_status = rVazio.status;
  out.conteudo_vazio_motivo = rVazio.body && rVazio.body.motivo;

  const zipMultiplasEntradas = Buffer.concat([
    construirZipUmaEntrada('a.csv', 'x;y\n1;2\n'),
    // corrompe o total de entradas do EOCD gerado para simular >1 (achado
    // rápido: reusar o builder e sobrescrever o campo de contagem)
  ]);
  // Ajusta o campo "total de entradas" do EOCD (22 bytes fixos no fim do
  // arquivo; campo de 2 bytes no offset 10 dentro do EOCD == length-12 no
  // buffer completo) para 2, sem duplicar o central directory de verdade —
  // suficiente para o extractor (que lê exatamente esse campo) rejeitar
  // antes de tentar ler uma 2ª entrada inexistente.
  zipMultiplasEntradas.writeUInt16LE(2, zipMultiplasEntradas.length - 12);
  const rZipMultiplo = await upload(jarOp, { tipo: 'faturamento', nomeArquivo: 'multiplas.zip', conteudo: zipMultiplasEntradas, mime: 'application/zip' });
  out.zip_multiplo_status = rZipMultiplo.status;
  out.zip_multiplo_motivo = rZipMultiplo.body && rZipMultiplo.body.motivo;

  // (b) sem permissão
  const rSemPermissao = await upload(jarLeitura, { tipo: 'faturamento', nomeArquivo: 'dados.csv', conteudo: csvValido });
  out.sem_permissao_status = rSemPermissao.status;
  out.sem_permissao_erro = rSemPermissao.body && rSemPermissao.body.erro;

  // (c) happy path CSV
  const conteudoUnico = `nome_completo;praca\nFulano-${Date.now()};SP\n`;
  const rOk = await upload(jarOp, { tipo: 'faturamento', nomeArquivo: 'faturamento.csv', conteudo: conteudoUnico });
  out.ok_status = rOk.status;
  out.ok_tem_id = rOk.body && Number.isInteger(rOk.body.id) ? 'true' : 'false';
  out.ok_status_pending = rOk.body && rOk.body.status;
  out.ok_id = rOk.body && rOk.body.id;

  // (d) reenvio do MESMO arquivo -> 409
  const rDup = await upload(jarOp, { tipo: 'faturamento', nomeArquivo: 'faturamento-outro-nome.csv', conteudo: conteudoUnico });
  out.dup_status = rDup.status;
  out.dup_erro = rDup.body && rDup.body.error;
  out.dup_id_correto = rDup.body && rDup.body.importacaoOriginalId === out.ok_id ? 'true' : 'false';

  // (e) mesmo hash, TIPO diferente -> 201 (dedupe é (id_empresa,tipo,hash))
  const rTipoDiferente = await upload(jarOp, { tipo: 'performance', nomeArquivo: 'faturamento.csv', conteudo: conteudoUnico });
  out.tipo_diferente_status = rTipoDiferente.status;

  // (e.2) mesmo hash, ENTIDADE diferente -> 201
  let jarOutraEntidade = await trocarEntidade(jarOp, empresaOutra);
  const rEntidadeDiferente = await upload(jarOutraEntidade, { tipo: 'faturamento', nomeArquivo: 'faturamento.csv', conteudo: conteudoUnico });
  out.entidade_diferente_status = rEntidadeDiferente.status;

  // (f) upload via ZIP de 1 entrada válido -> 201
  const csvZip = `nome_completo;praca\nZipado-${Date.now()};RJ\n`;
  const zipValido = construirZipUmaEntrada('faturamento.csv', csvZip);
  const rZipOk = await upload(jarOp, { tipo: 'faturamento', nomeArquivo: 'lote.zip', conteudo: zipValido, mime: 'application/zip' });
  out.zip_ok_status = rZipOk.status;
  out.zip_ok_id = rZipOk.body && rZipOk.body.id;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "POST /importacoes sem cookie -> 401" "$(jget sem_auth_status)" "401"
check "extensão .txt -> 422 INVALIDO" "$(jget ext_invalida_status)" "422"
check "extensão .txt -> motivo extensao_invalida" "$(jget ext_invalida_motivo)" "extensao_invalida"
check "tipo desconhecido (envio_massa não suportado aqui) -> 422" "$(jget tipo_invalido_status)" "422"
check "tipo desconhecido -> motivo tipo_invalido" "$(jget tipo_invalido_motivo)" "tipo_invalido"
check "conteúdo vazio -> 422" "$(jget conteudo_vazio_status)" "422"
# buffer.length===0 é pego pelo checkpoint de tamanho ANTES de chegar em
# validarConteudo (route: "3.1.3 — tamanho" roda antes de "3.1.4 — conteúdo").
check "conteúdo vazio -> motivo arquivo_vazio" "$(jget conteudo_vazio_motivo)" "arquivo_vazio"
check "ZIP com >1 entrada -> 422" "$(jget zip_multiplo_status)" "422"
check "ZIP com >1 entrada -> motivo zip_multiplas_entradas" "$(jget zip_multiplo_motivo)" "zip_multiplas_entradas"
check "sem permissão importacoes.criar (papel leitura) -> 403" "$(jget sem_permissao_status)" "403"
check "sem permissão -> erro PERMISSAO_NEGADA" "$(jget sem_permissao_erro)" "PERMISSAO_NEGADA"
check "happy path CSV -> 201" "$(jget ok_status)" "201"
check "happy path -> id inteiro presente" "$(jget ok_tem_id)" "true"
check "happy path -> status=pending" "$(jget ok_status_pending)" "pending"
check "reenvio do mesmo arquivo -> 409 CONFLITO" "$(jget dup_status)" "409"
check "reenvio -> error=CONFLITO" "$(jget dup_erro)" "CONFLITO"
check "reenvio -> importacaoOriginalId = id original" "$(jget dup_id_correto)" "true"
check "mesmo hash, tipo diferente -> 201 (dedupe por id_empresa+tipo+hash)" "$(jget tipo_diferente_status)" "201"
check "mesmo hash, entidade diferente -> 201" "$(jget entidade_diferente_status)" "201"
check "upload via ZIP de 1 entrada -> 201" "$(jget zip_ok_status)" "201"

# ─────────────────────────────────────────────────────────────────────────────
# Validações no banco (DB) — registro criado, hash correto, sem duplicata
# ─────────────────────────────────────────────────────────────────────────────
OK_ID="$(jget ok_id)"
N_REGISTROS_OK="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoArquivo\" WHERE id=$OK_ID" | tr -d '[:space:]')"
check "DB: exatamente 1 registro ImportacaoArquivo para o id retornado" "$N_REGISTROS_OK" "1"

STATUS_DB="$(psql_t -tAc "SELECT status FROM \"ImportacaoArquivo\" WHERE id=$OK_ID" | tr -d '[:space:]')"
if [ "$STATUS_DB" != "pending" ]; then
  echo "DEBUG: status inesperado='$STATUS_DB' para id=$OK_ID — erro_resumo:"
  psql_t -tAc "SELECT erro_resumo FROM \"ImportacaoArquivo\" WHERE id=$OK_ID"
  echo "DEBUG: logs do backend (últimas 40 linhas):"
  dc logs --tail 40 backend
fi
check "DB: status=pending" "$STATUS_DB" "pending"

# Conta só pelo MESMO hash do upload original (não pelo total empresa+tipo —
# os cenários (e)/(f) legitimamente criam OUTROS registros faturamento/E_OP
# com hash DIFERENTE): reenviar o hash idêntico não pode duplicar a linha.
N_MESMO_HASH="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoArquivo\" a WHERE a.id_empresa=$E_OP AND a.tipo='faturamento' AND a.hash_sha256 = (SELECT hash_sha256 FROM \"ImportacaoArquivo\" WHERE id=$OK_ID)" | tr -d '[:space:]')"
check "DB: reenvio do mesmo arquivo NAO criou 2º registro (só 1 p/ empresa+tipo+hash)" "$N_MESMO_HASH" "1"

N_AUDITORIA="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='importacao.criada' AND recurso_id='$OK_ID'" | tr -d '[:space:]')"
check "DB: Auditoria 'importacao.criada' registrada para o id" "$([ "${N_AUDITORIA:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

# Arquivo original persistido no container backend (volume/filesystem do hub)
ARQ_EXISTE="$(dc exec -T backend node -e "
  const fs = require('fs');
  const path = require('path');
  const p = path.join('/var/lib/envioMassa_homologacao/app_homologacao', 'uploads', 'importacoes', process.argv[1], 'original.csv');
  process.stdout.write(fs.existsSync(p) ? 'sim' : 'nao');
" "$OK_ID" | tr -d '[:space:]')"
check "arquivo original persistido em uploads/importacoes/<id>/original.csv" "$ARQ_EXISTE" "sim"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-IMPORTACOES-INTEGRATION: OK — todos os asserts passaram (FASE 3: 3.1/3.2/3.3/3.4)"
else
  echo "HUB-IMPORTACOES-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi
