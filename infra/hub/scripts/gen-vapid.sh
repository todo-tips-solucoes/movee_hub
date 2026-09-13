#!/usr/bin/env bash
# =============================================================================
# gen-vapid.sh — gera um par de chaves VAPID (EC P-256) para Web Push.
#
# Usa node:crypto puro (research.md Decision 3 — "par EC P-256 via node:crypto"),
# sem depender do pacote npm `web-push` (que só entra como dependência do
# backend para enviar pushes, não para gerar a chave — FASE 2.3/5).
#
# Grava em <SECRETS_DIR>/vapid.json (padrão /var/lib/hub_secrets, chmod 600):
#   chavePublica, chavePrivada, keyId, geradoPor, geradoEm, subject
# (nomes de campo = contracts/motorista-push.md + tasks.md 1.1.1).
# keyId = 16 hex de sha256(chavePublica) (mesma fórmula de data-model.md
# PushChaveVapid.key_id).
#
# `--subject` é OBRIGATÓRIO: contato do operador (`mailto:...` ou
# `https://...`) exigido pela lib `web-push` para assinar os envios
# (research.md Decision 1/2 — "o subject é fornecido pelo operador no
# arquivo — não é inventado" na implementação; FASE 5, lib/hub-push-worker.js).
#
# Idempotente: não sobrescreve sem --force. Molde: gen-secrets.sh.
# A chave privada NUNCA é impressa em stdout/stderr — só gravada no arquivo.
#
# Uso: gen-vapid.sh --subject <mailto:...|https:...> [--force] [--gerado-por <nome>] [--dest <arquivo>]
# =============================================================================
set -euo pipefail

SECRETS_DIR="${HUB_SECRETS_DIR:-/var/lib/hub_secrets}"
DEST="$SECRETS_DIR/vapid.json"
FORCE=""
GERADO_POR="${USER:-desconhecido}"
SUBJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE="--force" ;;
    --gerado-por) GERADO_POR="${2:?--gerado-por exige valor}"; shift ;;
    --dest) DEST="${2:?--dest exige valor}"; shift ;;
    --subject) SUBJECT="${2:?--subject exige valor}"; shift ;;
    -h|--help)
      echo "Uso: gen-vapid.sh --subject <mailto:...|https:...> [--force] [--gerado-por <nome>] [--dest <arquivo>]"
      exit 0
      ;;
    *)
      echo "gen-vapid.sh: opção desconhecida: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [ -f "$DEST" ] && [ "$FORCE" != "--force" ]; then
  echo "mantido (já existe): $DEST"
  exit 0
fi

case "$SUBJECT" in
  mailto:*|https:*) ;;
  *)
    echo "gen-vapid.sh: --subject é obrigatório e deve começar com 'mailto:' ou 'https:'" >&2
    exit 1
    ;;
esac

mkdir -p "$(dirname "$DEST")"
umask 077

KEY_ID="$(node -e '
const crypto = require("crypto");
const fs = require("fs");
// node -e "codigo" arg1 arg2  =>  process.argv = [nodeBin, arg1, arg2]
// (SEM placeholder para o proprio trecho -e, diferente de node script.js arg1 arg2)
const [, dest, geradoPor, subject] = process.argv;

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubJwk = publicKey.export({ format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });

const x = Buffer.from(pubJwk.x, "base64url");
const y = Buffer.from(pubJwk.y, "base64url");
if (x.length !== 32 || y.length !== 32) {
  throw new Error("ponto publico com tamanho inesperado (x=" + x.length + " y=" + y.length + ")");
}
// Formato "uncompressed point" (0x04 || X || Y), 65 bytes — o que o Web Push
// espera como applicationServerKey (contracts/motorista-push.md).
const chavePublica = Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");

const d = Buffer.from(privJwk.d, "base64url");
if (d.length !== 32) {
  throw new Error("chave privada com tamanho inesperado (d=" + d.length + ")");
}
const chavePrivada = d.toString("base64url");

const keyId = crypto.createHash("sha256").update(chavePublica).digest("hex").slice(0, 16);

const out = {
  chavePublica,
  chavePrivada,
  keyId,
  geradoPor,
  geradoEm: new Date().toISOString(),
  subject,
};

fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
// Só o keyId (público, derivado) vai para stdout — nunca a chave privada.
console.log(keyId);
' "$DEST" "$GERADO_POR" "$SUBJECT")"

chmod 600 "$DEST"
echo "gerado: $DEST (0600, keyId=$KEY_ID)"
