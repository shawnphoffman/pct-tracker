# Photos: setup & migration (Cloudflare R2)

How to bring the trail-photo feature back **without** the Vercel bill that got it
removed. Infra setup, image migration, and the code state in this repo.

**Status:** the app code is already wired for this and **gated on one env var**
(`NEXT_PUBLIC_PHOTO_CDN`). While that var is unset, the photo feature is fully
off (no toggle, no markers, no image loads) — zero risk to the Vercel budget.
Set the var (after the steps below) and it turns on.

---

## What went wrong, and the fix

The 293 photos were committed to the repo as **full-resolution JPEGs**
(`src/images/<region>/`, 300–900KB each, **164MB total**) and deleted in commit
`5a596d7` ("Remove images"). Served at full size through Vercel (the lightbox
proxied them via Gumlet, whose origin was the Vercel-hosted files), they ran up
**Vercel image bandwidth/optimization** charges.

The fix, and why it's cheap:

- Images move to a **Cloudflare R2** bucket — **zero egress fees** (the exact
  thing Vercel bills for is free on R2).
- A **custom `next/image` loader** ([`NextJsImage.js`](../src/components/NextJsImage.js))
  points straight at R2, so images never touch Vercel's optimizer or egress.
- The **map** draws only cheap circle markers — no images. Full images load
  **only in the lightbox, on demand**. Browsing the map costs ~nothing.
- Originals are **recompressed to ~1600px** and EXIF/GPS **stripped** by the
  migration script below (**164MB → 74MB**, ~55% smaller).

```
 Cloudflare R2 (public, zero egress)        Vercel (app only, no image egress)
 └─ web/<filename>.jpeg  ◄── custom next/image loader ── PhotoLightbox
                                            map = circle markers only
```

---

## Step 1 — Migrate the images (recover from git + resize)

The originals are still in git history (commit `e8bd520`). The script recovers
and recompresses them — no need to find files anywhere.

Requires ImageMagick: `brew install imagemagick`.

```bash
scripts/migrate-photos.sh          # all 293 images -> photos-dist/web/
scripts/migrate-photos.sh 8        # quick test on 8
```

Output lands in `photos-dist/web/` (gitignored). Tunables via env:
`PHOTO_MAX_EDGE` (default 1600), `PHOTO_QUALITY` (default 72). All filenames
match `photos.json` exactly (verified: 0 missing).

> Want them even smaller? Re-run with `PHOTO_QUALITY=65`, or switch the encoder
> to WebP (`cwebp`) for another ~30%. 72/JPEG is a safe quality-preserving
> default.

---

## Step 2 — Create the R2 bucket

1. Cloudflare dashboard → **R2** → **Create bucket** → `pct-tracker-photos`.
   (R2 needs a card on file; free tier is 10 GB storage + zero egress.)
2. **Settings → Public access**: either
   - enable the managed **`r2.dev`** subdomain (quick, rate-limited — fine for a
     hobby site), **or**
   - **Connect a custom domain** e.g. `photos.pct-tracker.<yourdomain>` (adds
     Cloudflare edge caching, no rate limit — recommended if you have a domain).
3. **CORS** (Settings → CORS) so `next/image` can load cross-origin:

   ```json
   [
     {
       "AllowedOrigins": ["https://<prod-domain>", "http://localhost:3000"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

Note the public base URL, e.g. `https://pub-xxxx.r2.dev` or
`https://photos.pct-tracker.example.com`.

---

## Step 3 — Upload

Upload the **contents** of the local `web/` folder to the **bucket root** (no
key prefix). The live CDN serves images from the bucket root, e.g.
`https://photos.madison.rocks/sierras%20-%209.jpeg` — the local folder is named
`web/` but the R2 keys are bare basenames. With wrangler (`npm i -g wrangler`):

```bash
# single file
wrangler r2 object put "pct-tracker-photos/<filename>.jpeg" --file "./photos-dist/web/<filename>.jpeg" --remote
```

Or rclone (configure an `r2` remote with your R2 S3 credentials first):

```bash
rclone copy ./photos-dist/web r2:pct-tracker-photos --progress \
  --header-upload "Cache-Control: public, max-age=31536000, immutable"
```

Verify one loads: open `<PUBLIC_BASE_URL>/sierras%20-%2023.jpeg`.

---

## Step 4 — Flip it on

Set the CDN base (the folder that directly contains the image files, i.e. the
bucket root) in `.env.local` and in the Vercel project env:

```
NEXT_PUBLIC_PHOTO_CDN=https://<PUBLIC_BASE_URL>
```

`NEXT_PUBLIC_` because the loader runs in the browser. Redeploy (or restart
`next dev`). The Photos toggle, map markers, and lightbox turn on automatically.

That's it — no code changes needed. For reference, the wiring that's already in
place and gated on this var:

- [`NextJsImage.js`](../src/components/NextJsImage.js) — `next/image` loader
  builds `${NEXT_PUBLIC_PHOTO_CDN}/<filename>`.
- [`PhotoLightbox.js`](../src/components/PhotoLightbox.js) — slides from
  `photos.json`; lazy-loaded so the library + 107KB JSON stay out of first load.
- [`page.js`](../src/app/page.js) — `photosEnabled = !!NEXT_PUBLIC_PHOTO_CDN`
  gates the Photos control, the (dynamically imported) `photo-points` marker
  layer, and click → lightbox.

---

## Adding a new photo later

Steps 1–4 above are the one-time migration. To add a single new photo once the
feature is live, use [`scripts/add-photo.py`](../scripts/add-photo.py) — it reads
the photo's GPS, recompresses + **strips EXIF/GPS** (required, see CLAUDE.md),
appends the feature to `photos.json`, and prints the upload + commit commands.
Needs `exiftool` + ImageMagick.

```bash
scripts/add-photo.py IMG_4521.jpg --name "pct26 - 2"           # process + register
scripts/add-photo.py IMG_4521.jpg --name "pct26 - 2" --upload  # also rclone to R2
```

Then commit `photos.json` and push (the printed command). Use `--coords LON,LAT`
if the photo has no embedded GPS. R2 keys are bare basenames at the bucket root
(no `web/` prefix) — the script already targets the right key.

---

## Cost guardrails

- **Never** commit originals to the repo or `/public` again — that was the trap.
  `photos-dist/` is gitignored; images live only on R2.
- Long cache headers on R2 objects (the rclone command above sets them) → the
  edge serves repeats for free.
- Map layer stays image-free (circles). Images are lightbox-only.
- A custom `next/image` loader means Vercel's optimizer is bypassed entirely, so
  no Image Optimization units are consumed.

## Rollback

Unset `NEXT_PUBLIC_PHOTO_CDN` and redeploy — the feature disappears cleanly, no
data loss (R2 keeps the images).
