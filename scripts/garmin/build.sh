#!/usr/bin/env bash
# Rebuild the classified, PII-free Garmin track buckets from the newest
# garmin-export/explore_*.gpx. Idempotent; safe to re-run after a new export.
#
#   scripts/garmin/build.sh
#
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/garmin/enrich.mjs        # snap tracks to PCT mile markers -> .enriched.json
python3 scripts/garmin/bucket.py      # classify + sanitize -> garmin-export/buckets/
# Verify no PII survived in any bucket (fails loudly if it did).
fail=0
for f in garmin-export/buckets/*.gpx; do
  python3 scripts/garmin/sanitize.py "$f" || fail=1
done
[ "$fail" = 0 ] && echo "verified: all buckets clean" || { echo "PII LEAK - do not commit/expose"; exit 1; }

# Harvest the real PCT centerline around these buckets so the segments hug the
# trail (instead of chording between 0.5-mi markers). Cached; scoped to bbox.
node scripts/garmin/centerline.mjs

# Web layers: the two PCT-adjacent buckets drawn as clean PCT-trail segments
# (follows the mile marks; drops back-and-forth/spurs). These land in public/
# and are committed + served on the site.
# 2023: our own home-safe track (clipped to the trail corridor; town/home spurs
# dropped) - replaces the Mapbox tileset's 2023 layer, which hid a whole track to
# protect the home and left a gap at mi 1100-1103. Committed + served.
python3 scripts/garmin/year_track.py garmin-export/buckets/pct-2023.gpx public/pct-2023.geojson track2023
python3 scripts/garmin/pct_segments.py garmin-export/buckets/trail-crew.gpx public/trail-crew.geojson trailcrew
python3 scripts/garmin/pct_segments.py garmin-export/buckets/misc.gpx       public/misc.geojson       misc
# Unknown: LOCAL-ONLY debug layer. Splits Garmin's junk aggregate track at its
# teleport gaps into many small dated tracks (needs the original export's
# timestamps). public/unknown.geojson is gitignored -> never deployed; the map's
# Unknown toggle only renders in dev.
python3 scripts/garmin/unknown_layer.py

# Coverage: union the export-only buckets (2026/trail-crew/misc) into progress
# and the gap list, then regenerate gaps (preserves manual status) so they
# reflect ALL of Madison's PCT miles - not just the baked historical years.
python3 scripts/garmin/bucket_coverage.py
node scripts/build-gaps.mjs
# Incomplete: LOCAL-ONLY debug layer of the pending (non-"complete") gaps from
# src/data/pct-gaps.json - the sections that don't count toward coverage yet.
python3 scripts/garmin/incomplete_layer.py
