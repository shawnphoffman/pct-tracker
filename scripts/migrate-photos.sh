#!/usr/bin/env bash
# Recover the trail photos from git history and produce web-sized copies ready
# to upload to Cloudflare R2. Zero dependencies (uses macOS `sips`).
#
# Usage:
#   scripts/migrate-photos.sh            # all images
#   scripts/migrate-photos.sh 10         # first 10 (quick test)
#
# Output: photos-dist/web/<filename>  (flat, basenames matching photos.json)

set -euo pipefail

# Commit that still had src/images (parent of "Remove images").
SRC_COMMIT="${PHOTO_SRC_COMMIT:-e8bd520}"
MAX_EDGE="${PHOTO_MAX_EDGE:-1600}"   # long-edge pixels (only shrinks if larger)
QUALITY="${PHOTO_QUALITY:-72}"       # jpeg quality
LIMIT="${1:-0}"                      # 0 = all

command -v magick >/dev/null 2>&1 || { echo "Needs ImageMagick: brew install imagemagick" >&2; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/photos-dist/web"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Recovering images from $SRC_COMMIT ..."
git -C "$ROOT" archive "$SRC_COMMIT" -- src/images | tar -x -C "$TMP"

mkdir -p "$OUT"
# bash 3.2 compatible (no mapfile)
FILES=()
while IFS= read -r line; do FILES+=("$line"); done < <(find "$TMP/src/images" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | sort)
[ "$LIMIT" -gt 0 ] && FILES=("${FILES[@]:0:$LIMIT}")

echo "Recompressing ${#FILES[@]} images to <= ${MAX_EDGE}px @ q${QUALITY} (EXIF stripped) ..."
in_bytes=0
for f in "${FILES[@]}"; do
	base="$(basename "$f")"
	in_bytes=$((in_bytes + $(stat -f%z "$f")))
	# -auto-orient before -strip so rotation bakes in; -strip drops EXIF (incl GPS);
	# progressive JPEG + 4:2:0 subsampling for smallest size.
	magick "$f" -auto-orient -strip -resize "${MAX_EDGE}x${MAX_EDGE}>" \
		-interlace JPEG -sampling-factor 4:2:0 -quality "$QUALITY" "$OUT/$base"
done

out_bytes=$(find "$OUT" -type f -exec stat -f%z {} + | awk '{s+=$1} END{print s}')
printf "\nDone. %d files\n  originals: %.1f MB\n  web-sized: %.1f MB  (%.0f%% smaller)\n" \
	"${#FILES[@]}" "$(echo "$in_bytes/1048576" | bc -l)" \
	"$(echo "$out_bytes/1048576" | bc -l)" \
	"$(echo "(1-$out_bytes/$in_bytes)*100" | bc -l)"
echo "Output: $OUT"
