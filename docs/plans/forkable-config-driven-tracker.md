# Make pct-tracker forkable: config-driven tracks, optional personal features

## Context

The user wants a version of this repo that other people can deploy themselves,
with a JSON config controlling the routes/layers by year — each sourced from
either a live Garmin feed or an existing GeoJSON — and without requiring the
newsletter functionality.

Today every year/route is hardcoded in ~7 places: track descriptor objects,
`YEAR_COLORS`, one `useState` per layer, hand-written load-handler source/layer
adds, the `trackStackBottomToTop` z-order array, hand-written JSX toggles in
`src/app/page.js` (~930 lines), and the `YEARS` map in
`src/app/api/track/[year]/route.js`. Both source kinds already normalize to the
same `{source, line, url, color}` descriptor and the same geometry-only GeoJSON
shape, so a single config can drive all of it.

**Approach (assumptions — the AskUserQuestion dialog failed to render twice, so
these are my recommended defaults, called out for review):**
1. **Refactor this repo in place.** Madison's site becomes the shipped default
   config; forkers use GitHub's fork/template + swap config & env. No divergent
   template copy.
2. **Progress panel is config-gated** (section absent → off, zero Tilequery).
3. **A third source type `styleLayer`** keeps Madison's style-baked 2018/2019
   working through the same config.
4. Newsletter/photos stay available but optional (config-/env-gated); nothing
   is deleted from Madison's deployment.

**Privacy hard rules preserved exactly** (CLAUDE.md): geometry-only feed output,
72h prod safety delay, `?live=<GARMIN_LIVE_SECRET>` bypass with `no-store`,
no secrets in the config file (env-var *names* only — the config is bundled
client-side and must be treated as public).

## Config design

New root file **`tracker.config.json`**, read only through a new wrapper
**`src/lib/config.js`** (sole importer; applies defaults, computes
`sourceId`/`lineId` per track, validates at module load — works for both the
client page and the server route via webpack JSON import).

Madison's shipped config (abridged; full version written during implementation):

```json
{
  "site": { "title": "Madison's PCT Tracker", "description": "…",
            "ogSubtitle": "…", "personName": "Madison", "attribution": "Map by Shawn" },
  "map": { "center": [-121.577, 41.369], "zoom": 4.25,
           "anchorLayer": "pct-miles", "hiddenStyleLayers": ["PCT - 2023"],
           "sectionMarkers": [ { "label": "Central", "coord": [-118.03951, 35.65813] }, … ] },
  "tracks": [
    { "id": "2026", "label": "2026", "color": "#84cc16", "defaultOn": true,
      "latestPin": true, "flyToLatest": true,
      "source": { "type": "garmin", "shareId": "madison", "shareIdEnv": "GARMIN_MAPSHARE_USER",
                  "start": "2026-06-30T00:00:00Z", "startEnv": "GARMIN_2026_START",
                  "passwordEnv": "GARMIN_MAPSHARE_PASSWORD" } },
    { "id": "2023", "label": "2023", "color": "#dc2626", "defaultOn": true,
      "source": { "type": "geojson", "url": "/pct-2023.geojson" } },
    { "id": "2019", "label": "2019", "color": "#2563eb", "defaultOn": false,
      "source": { "type": "styleLayer", "layerId": "PCT - 2019" } },
    { "id": "2018", "label": "2018", "color": "#9333ea", "defaultOn": true,
      "source": { "type": "styleLayer", "layerId": "PCT - 2018" } },
    { "id": "trail-crew", …geojson… }, { "id": "misc", …geojson… },
    { "id": "unknown", "devOnly": true, … }, { "id": "incomplete", "devOnly": true, … }
  ],
  "progress": { "mileMarkerTileset": "shawnhoffman.32639qah", "totalMiles": 2662,
                "includeHistory": true },
  "newsletter": { "years": [ { "year": "2026", "file": "/newsletters/pct-2026.json" },
                             { "year": "2023", "file": "/newsletters/pct-2023.json" } ] }
}
```

Key semantics:
- **Array order = toggle order = z-order** (first = top); reversed array
  reproduces today's `trackStackBottomToTop` exactly. No separate order field.
- **`*Env` pattern**: `shareIdEnv`/`startEnv`/`passwordEnv` name env vars that
  override/supply values; `passwordEnv` defaults to `GARMIN_MAPSHARE_PASSWORD`.
  Multi-feed = second garmin track with a different `passwordEnv`. **No secret
  values in config, ever.**
- Safety-delay / live-secret / revalidate stay **env-only** (deliberately not
  per-track config so the privacy delay can't be weakened by a config edit).
- Optional sections: `progress` absent → no panel, no Tilequery; `newsletter`
  absent → no dots/dialog/admin; photos stay gated on `NEXT_PUBLIC_PHOTO_CDN`
  (existing pattern); `devOnly` tracks render only in dev.

## Changes by file

**New**
- `tracker.config.json` — Madison's config (shipped default & living example).
- `src/lib/config.js` — normalize + validate + export `config`, `tracks`,
  `garminTracks`, `newsletterEnabled`, `progressEnabled`.
- `src/lib/validate-config.js` — plain-JS `validateConfig(raw) -> errors[]`:
  unique slug ids, hex colors, source-type field checks, newsletter paths,
  numeric progress fields, and a **reject-inline-secrets guard** (any
  `password`/`secret`-named key carrying a value).
- `src/lib/validate-config.test.mjs` — `node --test` coverage (shipped config
  clean + each error class), joins existing `yarn test`.
- `scripts/validate-config.mjs` — CLI; wired as `"prebuild"` in package.json so
  `yarn build`/Vercel fail loudly on bad config.
- `DEPLOY.md` — fork & deploy guide (see below).
- `public/newsletters/pct-2023.json`, `pct-2026.json` — newsletter points moved
  from `src/data/PCT - Madison - * - Newsletter Points.json` (same data, already
  public in the client bundle today; space-free names).

**Modified**
- `src/app/page.js` — the core refactor:
  - Delete `Layers`, the six track objects, `YEAR_COLORS`, `SECTION_STARTS`,
    `defaults`, newsletter static imports → all from `@/lib/config`.
  - Replace 8 per-year `useState`s + 5 `loadedRef`s with one
    `visible` map (`id → bool`, seeded from `defaultOn`) and one
    `loadedRef = useRef({})`.
  - One `toggleTrack(track)`: `styleLayer` → today's `toggleLayer`;
    geojson/garmin → today's `toggleLazyLine` (fetch-on-first-show). Keep the
    `getLayer` guards (toggle-before-load race).
  - Load handler: loop tracks — geojson/garmin get `addSource`/`addLayer`
    (garmin keeps `role === 'track'` filter, `/api/track/<id>` URL + `?live=`
    passthrough, latest-pin/fly-to per `latestPin`/`flyToLatest`); styleLayer
    tracks get visibility + `setPaintProperty` color if present in the style
    (missing → silent no-op for forkers); force-hide `map.hiddenStyleLayers`
    (keeps the home-safe 2023 tileset layer hidden — move that privacy comment
    with it). Replaces the `'PCT -'` id-scan heuristic.
  - **Z-anchor fix** (newsletter can be absent): add one empty `overlay-anchor`
    line layer right after load, inserted before `config.map.anchorLayer` if it
    exists (Madison: `pct-miles` → stacking bit-identical), else before the
    first symbol layer, else on top. All ~10 `'newsletter-points'` beforeIds
    become `'overlay-anchor'`; one deterministic `moveLayer` pass over
    `[...tracks].reverse()` (+ newsletter dot layers when enabled) replaces
    `trackStackBottomToTop`.
  - JSX toggles: the eight hand-written divs collapse into one
    `visibleTracks.map(...)` loop (`id={'toggle-'+t.id}`, swatch color via
    inline `--track-color` custom property); CustomControl registration loops
    the same list. Newsletter toggle/dialog/dots/throb wrapped in
    `if (newsletterEnabled)`; newsletter data now fetched from the config-listed
    files and passed to the dialog as a prop.
  - `personName` drives "Madison was here" popup + aria-label; attribution from
    `config.site.attribution`; section markers loop `config.map.sectionMarkers`.
- `src/app/api/track/[year]/` → **`[id]/route.js`** (git mv): `YEARS` literal →
  garmin tracks from config with the `*Env` override scheme; 404 note
  `unknown-track`. **Delay/live-key/caching/geometry-only semantics unchanged.**
  Progress block runs only when `config.progress` present (absent →
  `emptyWithHistory()` collapses to plain empty, zero Tilequery); tileset/total
  from config with existing `PCT_*` env overrides still winning;
  `HISTORY`/`GAPS` passed only when `includeHistory !== false` (shipped files
  are Madison's coverage — DEPLOY.md caveat for forkers).
- `src/components/NewsletterDialog.js` — drop static JSON imports; take fetched
  per-year collections as a prop, keep newest-first ordering.
- `src/app/api/admin/newsletters/[year]/route.js` — `FILES` allowlist derived
  from `config.newsletter.years`, writes `public/newsletters/…`; dev-only guard
  verbatim.
- `src/app/layout.js` + `src/app/opengraph-image.js` — title/description/OG
  text from `config.site` (no more hardcoded "Madison's PCT Tracker").
- `src/app/globals.css` — delete the eight per-key swatch rules; one
  `var(--track-color)` fill rule. Keep `year-visible-false … !important`
  gray-out (still wins over the custom property).
- `next.config.js` — Sentry org/project from `SENTRY_ORG`/`SENTRY_PROJECT` env
  with current literals as fallback (no-op for Madison, ignorable for forkers).
- `package.json` — `"prebuild": "node scripts/validate-config.mjs"`.
- `CLAUDE.md` — `[year]` → `[id]` references; pointer to config + DEPLOY.md.

**Deleted:** the two `src/data/*Newsletter Points*.json` (moved to public/).

**Untouched:** `src/lib/garmin.js`, `src/lib/pct-progress.js`, coverage JSONs,
photos pipeline, CoolStuffDialog (`?debug`-only), sentry.*.config.js,
`scripts/garmin/` pipeline.

## DEPLOY.md contents

Fork & clone → env-var table (required: Mapbox token/style; per-feed Garmin
password vars; optional: live secret, delay/revalidate tuning, photo CDN, site
URL, Sentry) → full config schema reference (`*Env` pattern,
array-order-is-z-order) → minimal forker example (one garmin + one geojson
track, no optional sections) → Garmin MapShare setup (enable share, get share
id, set MapShare password) → **Privacy & safety-delay section** (why the 72h
delay exists, keep it; `?live=` mechanics + secret rotation; geometry-only
guarantee) → styleLayer/`anchorLayer`/`hiddenStyleLayers` for custom Studio
styles → progress caveats (needs own mile-marker tileset; shipped history is
Madison's → `includeHistory: false` or regenerate) → newsletter/photos setup →
Vercel steps.

## Implementation order (one commit each)

1. Config + validation foundation (nothing consumes it yet; tests green).
2. API route rename + config-driven feeds + progress gating.
3. page.js track refactor (state/toggles/layers/JSX/CSS) — newsletter still
   hardcoded this commit for a reviewable diff.
4. `overlay-anchor` z-order pass; remove `'newsletter-points'` beforeIds.
5. Newsletter: move files to `public/newsletters/`, config-gate everything,
   prop-driven dialog.
6. Metadata from `config.site`; Sentry env parameterization.
7. DEPLOY.md + CLAUDE.md updates.

## Verification

- `yarn test` after each step (garmin tests + new config tests);
  `node scripts/validate-config.mjs` clean, then corrupt config (dup id, inline
  secret) → readable failure and `yarn build` aborts.
- API: `curl -sD- localhost:3000/api/track/2026` → `X-Track-Status: ok-…`,
  `s-maxage` header; `/api/track/nope` → 404 `unknown-track`; `?live=<secret>`
  → `no-store` + `"live":true`; unset password → `no-credentials`; **grep the
  body for timestamps/desc — must be geometry-only**.
- Gating: temporarily delete `progress` section → no `progress` in body, no
  Tilequery, no panel; delete `newsletter` section → clean map, correct
  z-order (anchor test), no console errors.
- `yarn dev` visual parity vs production: toggle order/colors/defaults
  (2019 off, rest on), gray-out, z-order at overlaps, newsletter dots + throb +
  popup + dialog ordering, latest pin + fly-to + "Madison was here", LIVE badge,
  progress numbers identical, dev-only Unknown/Incomplete + hover ids,
  `/admin/newsletters` save round-trip, reset, `?debug`.
- `yarn build` (prebuild validation, Sentry wrapper, OG image).
- Fork simulation: stock Mapbox style + one-geojson-track config → renders,
  styleLayer tracks silently absent, anchor falls back to first symbol layer.

## Known gotchas
- Config is client-bundled → public; validator's no-secrets guard is the
  backstop and DEPLOY.md states it.
- Don't convert `next: { revalidate }` to route-segment `export const
  revalidate` (must be literal; current dynamic form already works).
- CSS swatch rule must land in the same commit as the JSX loop.
- The live 2026 geojson layer currently reuses style-layer id `'PCT - 2026'`;
  renaming to `track-2026-line` is fine (nothing else references it) but verify
  no id collision/reference during step 3.
- Keep the effect dependency array honest for `next lint` after the state
  consolidation.
