#!/usr/bin/env bash
# Gera os ícones do app e as imagens da loja a partir dos SVGs de assets/brand/ (rsvg-convert + ImageMagick).
#
#   scripts/make-icons.sh [pasta-da-loja]     padrão da loja: dist/store
#
# App (assets/images/): icon.png (1024, quadrado cheio e sem alfa — iOS exige; Android legado usa),
# adaptive-{foreground,background,monochrome}.png (ícone adaptativo; o balão fica na zona segura de 66%),
# splash-icon.png (abertura). Loja: play-icon-512.png e feature-graphic.png (1024×500, sem alfa).
# O banner embute um print da lista de chats (base64 no próprio SVG); para trocar, edite o <image>.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v rsvg-convert >/dev/null || { echo "falta o rsvg-convert (librsvg)" >&2; exit 1; }
command -v magick >/dev/null || { echo "falta o ImageMagick 7 (magick)" >&2; exit 1; }
B=assets/brand
I=assets/images
STORE="${1:-dist/store}"
mkdir -p "$STORE"

png() { rsvg-convert -w "$2" -h "$3" "$B/$1.svg"; }   # SVG → PNG na saída padrão
opaque() { magick - -background "$1" -alpha remove -alpha off -type TrueColor "$2"; }

png icon 1024 1024 | opaque '#6a4be0' "$I/icon.png"
png adaptive-foreground 1024 1024 > "$I/adaptive-foreground.png"
png adaptive-background 1024 1024 | opaque '#6a4be0' "$I/adaptive-background.png"
png adaptive-monochrome 1024 1024 > "$I/adaptive-monochrome.png"
png splash-icon 1024 1024 > "$I/splash-icon.png"
png icon 512 512 | magick - -alpha set -type TrueColorAlpha "PNG32:$STORE/play-icon-512.png"   # a Play pede PNG de 32 bits
png feature-graphic 1024 500 | opaque '#0b0b0f' "$STORE/feature-graphic.png"
echo "ícones em $I/ · loja em $STORE/ (play-icon-512.png, feature-graphic.png)"
