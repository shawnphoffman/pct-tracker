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

# Web layers: the two PCT-adjacent buckets drawn as clean PCT-trail segments
# (follows the mile marks; drops back-and-forth/spurs). These land in public/
# and are committed + served on the site.
python3 scripts/garmin/pct_segments.py garmin-export/buckets/trail-crew.gpx public/trail-crew.geojson trailcrew
python3 scripts/garmin/pct_segments.py garmin-export/buckets/misc.gpx       public/misc.geojson       misc
# Unknown: LOCAL-ONLY debug layer. Splits Garmin's junk aggregate track at its
# teleport gaps into many small dated tracks (needs the original export's
# timestamps). public/unknown.geojson is gitignored -> never deployed; the map's
# Unknown toggle only renders in dev.
python3 scripts/garmin/unknown_layer.py
