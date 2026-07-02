# Garmin track pipeline

Turns a full Garmin Explore export into classified, **PII-free** GPX buckets.

## Run

```
scripts/garmin/build.sh
```

Drop a new export at `garmin-export/explore_<date>.gpx` first (GPX from
[explore.garmin.com](https://explore.garmin.com) -> Library -> Export). The
pipeline auto-selects the newest `explore_*.gpx`.

## Steps

1. **`enrich.mjs`** - snaps every track vertex to the nearest PCT mile marker
   (Mapbox tileset `shawnhoffman.32639qah`, harvested once and cached to
   `garmin-export/.markers.json`) to get each track's on-trail fraction and mile
   range. Writes `garmin-export/.enriched.json`. Needs a Mapbox token from
   `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`/`MAPBOX_TOKEN` or `.env.local`.
2. **`bucket.py`** - classifies each track (see below), runs `sanitize.strip_pii`
   on it, and writes `garmin-export/buckets/*.gpx` + `manifest.json`.
3. **`sanitize.py`** verifies each bucket has zero text fields; `build.sh` fails
   loudly if any survive.
4. **`pct_segments.py`** writes the map's web layers, one feature per track with
   a stable route id (`misc-03`, `trailcrew-01`, ...):
   - `snap` mode (`trail-crew`, `misc`) draws each track's covered mile range(s)
     as slices of the real PCT centerline (back-and-forth/spurs/driving drop
     away, and the line hugs the trail's curves) -> `public/trail-crew.geojson`,
     `public/misc.geojson` (committed + served). The centerline geometry comes
     from `centerline.mjs` (harvested from tileset `shawnhoffman.8efdsxdm`,
     scoped to the buckets' bbox, cached at `garmin-export/.centerline.json`);
     it falls back to connecting 0.5-mi markers if that cache is absent.
5. **`unknown_layer.py`** builds the local-only debug layer. Garmin's junk
   aggregate ("Madison Sites (0)": 432 points strung across 2018-2022 with huge
   teleports) is split at its distance/time gaps into ~40 small dated logical
   tracks (`unknown-01` ... with a `label` date) so it's explorable instead of
   one cross-state mess. Reads the ORIGINAL export for timestamps; writes
   `public/unknown.geojson`, which is **gitignored (local-only, never deployed)**.

Committed web-layer features carry geometry + `{role, id, fromMile, toMile}` only
(no dates). A local, gitignored `garmin-export/buckets/route-index.json` maps each
id -> `{date, miles/label}` for reference. The map shows the Unknown toggle and
the route-id hover popover **only in dev** (`process.env.NODE_ENV !== 'production'`).
`bucket_to_geojson.py` is an older raw-track variant without ids, kept for ad-hoc use.

To move a single mis-bucketed outing, hover it on the dev map (or read
`route-index.json`) to get its id/date/mile, then add an entry to `OVERRIDES` in
`bucket.py` keyed by `"<date>:<mileMin>"` and re-run `build.sh`.

## `sanitize.py`

Standalone too. Strips `desc`, `cmt`, `name`, `src`, `link`, `extensions`,
`metadata`, `wpt`, `rte` (anything that carries human-authored text) and keeps
only geometry (trkpt lat/lon, `ele`, `time`, `fix`).

```
python3 scripts/garmin/sanitize.py in.gpx out.gpx   # scrub a file
python3 scripts/garmin/sanitize.py file.gpx          # verify; exit 1 if PII found
```

## Classification

- Hike years 2018/2019/2023/2026 form continuous multi-day mile progressions ->
  `pct-<year>.gpx` for on-trail tracks, `non-pct.gpx` for off-trail.
- 2026 pre-season June day trips (northernmost, mi ~1220) -> `trail-crew.gpx`.
- 2020-2022 near-trail tracks (repeat visits to fixed segments) -> `misc.gpx`.
- A corrupt aggregate record with a huge mile span -> `pct-unknown.gpx`.
- To reclassify (e.g. a new hike season, or confirming a crew track), edit the
  year sets / rules in `bucket.py` and re-run `build.sh`.

## Privacy

`garmin-export/` is gitignored and must stay so - the raw exports contain
private inReach messages and third-party names. The buckets are sanitized, but
treat the whole directory as local-only. See the repo `CLAUDE.md` privacy rule.
