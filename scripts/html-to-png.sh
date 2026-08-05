#!/usr/bin/env bash
# HTML -> PNG em dimensões exatas, sem instalar browser no host.
#
# Substitui o `chrome-devtools/scripts/screenshot.js` que as skills
# ui-ux-pro-max:banner-design / :slides / :design (social photos) mandam usar e
# que NÃO existe neste host. Reusa a imagem Playwright oficial já baixada e o
# binário do frontend_v2 (mesma versão), como os drivers de infra/hub/testes/.
#
# Uso:
#   scripts/html-to-png.sh <entrada.html> <largura> <altura> <saida.png> [escala]
#
#   escala = device scale factor (default 1). Use 1 para dimensão exata exigida
#   pelas plataformas (ex.: 1500x500 no LinkedIn) e 2 para retina/2x.
#
# Entrada e saída precisam estar sob o diretório atual (é ele que é montado).
# Exemplo:
#   scripts/html-to-png.sh assets/banner.html 1500 500 assets/banner.png
set -euo pipefail

[ $# -ge 4 ] || { sed -n '2,20p' "$0"; exit 2; }

HTML=$1; W=$2; H=$3; OUT=$4; SCALE=${5:-1}
WAIT_MS=${HTML_TO_PNG_WAIT_MS:-1500}   # tempo p/ webfonts e Chart.js renderizarem
IMAGE=${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.61.1-jammy}
FRONTEND_V2=${FRONTEND_V2:-$(cd "$(dirname "$0")/.." && pwd)/app_homologacao/frontend_v2}

[ -f "$HTML" ] || { echo "erro: não encontrei $HTML" >&2; exit 1; }
[ -d "$FRONTEND_V2/node_modules/playwright" ] || {
  echo "erro: $FRONTEND_V2/node_modules/playwright ausente — rode 'npm ci' no frontend_v2" >&2
  exit 1
}

mkdir -p "$(dirname "$OUT")"

# A CLI `playwright screenshot` não expõe deviceScaleFactor — daí a API direta.
# --memory=1g: rito anti-starvation (incidente 2026-06-11).
docker run --rm --memory=1g \
  -v "$PWD:/w" -w /w \
  -v "$FRONTEND_V2:/fe:ro" \
  "$IMAGE" \
  node -e '
    const { chromium } = require("/fe/node_modules/playwright");
    const [file, w, h, out, scale, wait] = process.argv.slice(1);
    (async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: +w, height: +h },
        deviceScaleFactor: +scale,
      });
      await page.goto("file://" + file, { waitUntil: "networkidle" });
      await page.waitForTimeout(+wait);
      await page.screenshot({ path: out });
      await browser.close();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "/w/${HTML#./}" "$W" "$H" "/w/${OUT#./}" "$SCALE" "$WAIT_MS"

# Confere as dimensões reais lendo o cabeçalho IHDR do PNG (stdlib, sem deps).
python3 - "$OUT" "$W" "$H" "$SCALE" <<'PY'
import struct, sys
out, w, h, scale = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
with open(out, 'rb') as f:
    data = f.read(24)
assert data[:8] == b'\x89PNG\r\n\x1a\n', f"{out} não é PNG"
got_w, got_h = struct.unpack('>II', data[16:24])
want = (w * scale, h * scale)
if (got_w, got_h) != want:
    sys.exit(f"ERRO: {out} saiu {got_w}x{got_h}, esperado {want[0]}x{want[1]}")
print(f"{out}: {got_w}x{got_h} OK")
PY
