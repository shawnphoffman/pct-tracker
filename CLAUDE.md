# pct-tracker

A Next.js + mapbox-gl map of Madison's PCT hikes by year. See
`scripts/garmin/README.md` for the Garmin track pipeline.

## Privacy: strip PII before committing OR exposing on the site

**Everything derived from Madison's Garmin data must have private messages and
other PII stripped before it is committed to git or served on the site.** This
is a hard rule, not a nicety.

Garmin inReach exports embed **private messages** and **third-party names** in
per-point `<desc>` fields (GPX) and `<ExtendedData>` `Text` (KML), plus device
IDs and author/email metadata. Location itself is sensitive too.

Concretely:

- **`garmin-export/` is gitignored and must stay so.** It holds the raw exports
  (full messages + timestamps) and the sanitized buckets. Never commit anything
  from it. Never remove its `.gitignore`.
- **The public/delayed feed emits geometry only** - no `desc`, no message text,
  no timestamps (the public map must not reveal *when* Madison was somewhere).
  Keep it that way: never add message/desc/timestamp fields to the DELAYED
  `/api/track/[year]` payload or any popup shown to public (non-live) viewers.
- The sanctioned exceptions, BOTH gated on the secret-keyed live preview
  (`?live=<GARMIN_LIVE_SECRET>` on the site and on `/api/track/[year]`), for
  trusted viewers only:
  - **Safety delay:** the live key drops the location delay to zero.
  - **Timestamps:** with the key accepted, `garminKmlToGeoJSON`'s `includeTimes`
    emits per-fix times (hoverable `role: 'fix'` points), stamps the latest pin
    with its time, and returns a `daily` per-Pacific-day mileage summary. This
    reveals *when* Madison was at a location, so it is LIVE-ONLY. Never pass
    `includeTimes` (or surface `t`/`daily`) on the public/delayed path.
  Live responses are always `private, no-store` (never shared-cached). Never
  commit or log the secret; rotate it in the Vercel env vars if it leaks.
- **To share any track file, sanitize it first:**
  `python3 scripts/garmin/sanitize.py in.gpx out.gpx`. It strips all
  human-authored text and keeps only geometry. Verify with
  `python3 scripts/garmin/sanitize.py file.gpx` (exits non-zero if PII remains).
- Before committing or deploying anything touching Garmin/track data, ask: does
  this expose a message, a name, a precise location, or a timestamp? If unsure,
  strip it.
