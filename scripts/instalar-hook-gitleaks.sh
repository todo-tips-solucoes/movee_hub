#!/usr/bin/env bash
# =============================================================================
# instalar-hook-gitleaks.sh — instala o gitleaks (versão pinada, checksum
# conferido) e o hook `pre-commit` que barra segredo antes de entrar no git.
#
# Este repositório é PÚBLICO: um segredo commitado está público para sempre
# (reescrever histórico não resolve — o blob já foi indexado). A única defesa
# que funciona é não deixar entrar; a segunda é trocar a credencial.
#
# Uso:  scripts/instalar-hook-gitleaks.sh
#       SKIP_DOWNLOAD=1 scripts/instalar-hook-gitleaks.sh   # só (re)instala o hook
#
# Para pular o hook num commit específico (use com parcimônia, e saiba por quê):
#       git commit --no-verify
# =============================================================================
set -euo pipefail

VERSAO="8.30.1"
SHA256_TGZ="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
DESTINO="${DESTINO:-/usr/local/bin/gitleaks}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${SKIP_DOWNLOAD:-0}" != "1" ] && ! "$DESTINO" version 2>/dev/null | grep -qx "$VERSAO"; then
  echo "==> baixando gitleaks $VERSAO"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  TGZ="gitleaks_${VERSAO}_linux_x64.tar.gz"
  curl -fsSL -o "$TMP/$TGZ" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${VERSAO}/${TGZ}"
  echo "$SHA256_TGZ  $TMP/$TGZ" | sha256sum -c - \
    || { echo "ABORTA: checksum do release não conferiu"; exit 1; }
  tar -xzf "$TMP/$TGZ" -C "$TMP" gitleaks
  install -m 0755 "$TMP/gitleaks" "$DESTINO"
fi
echo "==> gitleaks: $("$DESTINO" version) em $DESTINO"

HOOK="$(git -C "$RAIZ" rev-parse --git-path hooks/pre-commit)"
[ -e "$HOOK" ] && [ ! -e "$HOOK.bak" ] && cp "$HOOK" "$HOOK.bak" && echo "==> hook anterior salvo em $HOOK.bak"
cat > "$HOOK" <<'HOOKSH'
#!/usr/bin/env bash
# Instalado por scripts/instalar-hook-gitleaks.sh. Barra segredo no índice.
GL="$(command -v gitleaks || echo /usr/local/bin/gitleaks)"
[ -x "$GL" ] || { echo "pre-commit: gitleaks ausente — rode scripts/instalar-hook-gitleaks.sh"; exit 1; }
"$GL" git --staged --redact --no-banner --log-level error . || {
  echo
  echo "pre-commit ABORTOU: o índice tem o que parece ser um segredo (acima, redigido)."
  echo "  falso positivo  -> allowlist em .gitleaks.toml, com o motivo conferido"
  echo "  segredo real    -> tire do índice, TROQUE a credencial, e só então commite"
  exit 1
}
HOOKSH
chmod +x "$HOOK"
echo "==> hook instalado em $HOOK"

echo
echo "==> prova (controle negativo): um segredo falso no índice deve ABORTAR"
PROVA="$(mktemp -d)"; trap 'rm -rf "$PROVA"' EXIT
git -C "$PROVA" init -q .
git -C "$PROVA" -c user.email=prova@local -c user.name=prova commit -qm base --allow-empty
# AKIA + 16 chars BASE32 ([A-Z2-7]): é o formato que a regra aws-access-token
# exige. Com 0/1/8/9 no meio ela não casa e esta prova passaria sem provar nada.
echo "AWS_ACCESS_KEY_ID=AKIA$(tr -dc 'A-Z2-7' </dev/urandom | head -c16)" > "$PROVA/x.env"
git -C "$PROVA" add x.env
if "$DESTINO" git --staged --redact --no-banner --log-level error "$PROVA" >/dev/null 2>&1; then
  echo "FALHOU: o gitleaks NÃO pegou um segredo óbvio — hook estaria oco"; exit 1
fi
echo "OK: pegou. (não-prova conhecida: valores de exemplo da própria AWS são"
echo "    allowlist da ferramenta; a varredura reduz risco, não o zera)"
