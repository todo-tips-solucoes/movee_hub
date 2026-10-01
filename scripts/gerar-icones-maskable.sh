#!/usr/bin/env bash
# =============================================================================
# gerar-icones-maskable.sh — refaz os ícones `maskable` do painel a partir do
# logo `public/brand/go-512.png`.
#
# POR QUE ISTO EXISTE: na primeira entrega do PWA (PR #248) o manifest declarou
# o próprio `go-512.png` como `maskable`, e no Android o logo saiu com as bordas
# cortadas. Um ícone maskable é recortado pelo launcher em círculo/squircle: só
# o que está dentro de um círculo de 80% do lado (raio 205 em 512) sobrevive —
# o resto é moldura descartável. O `go-512.png` tem o logo ocupando quase toda a
# largura, então estourava.
#
# A conta: o logo é retangular, logo o que importa é a DIAGONAL. Com o conteúdo
# recortado (`-trim`), a metade da diagonal precisa caber no raio seguro:
#
#     escala = 2 * raio_seguro / hypot(largura, altura)
#
# Uso: scripts/gerar-icones-maskable.sh   (exige imagemagick)
# Depois: `npx vitest run app/manifest.test.ts` confirma dimensões e ausência de
# alpha — maskable com transparência deixa o launcher pintar o fundo dele atrás.
# =============================================================================
set -euo pipefail

BRAND="$(cd "$(dirname "$0")/.." && pwd)/app_homologacao/frontend_v2/public/brand"
ORIGEM="$BRAND/go-512.png"
RAIO_SEGURO=200   # 205 é o limite; 200 deixa 5px de folga

command -v convert >/dev/null || { echo "ABORTA: imagemagick (convert) não encontrado"; exit 1; }

read -r W H < <(convert "$ORIGEM" -trim +repage -format '%w %h\n' info:)
read -r NW NH < <(python3 -c "
import math
w, h = $W, $H
e = 2 * $RAIO_SEGURO / math.hypot(w, h)
print(int(w*e), int(h*e))
")
echo "logo recortado: ${W}x${H} -> ${NW}x${NH} (cabe no círculo de raio $RAIO_SEGURO)"

# `-alpha remove -alpha off`: maskable NÃO pode ter transparência.
convert -size 512x512 xc:white \( "$ORIGEM" -trim +repage -resize "${NW}x${NH}" \) \
  -gravity center -composite -alpha remove -alpha off -strip "$BRAND/go-512-maskable.png"
convert "$BRAND/go-512-maskable.png" -resize 192x192 -strip "$BRAND/go-192-maskable.png"

python3 -c "
import subprocess, math, sys
o = subprocess.check_output(['convert','$BRAND/go-512-maskable.png','-fuzz','5%','-trim','+repage','-format','%w %h','info:']).decode().split()
w, h = int(o[0]), int(o[1])
d = math.hypot(w/2, h/2)
print(f'conteúdo final {w}x{h} — canto a {d:.0f}px do centro (limite 205)')
sys.exit(0 if d < 205 else 1)
" || { echo "ABORTA: o conteúdo estourou a safe zone"; exit 1; }
echo "OK: go-512-maskable.png e go-192-maskable.png gerados"
