#!/usr/bin/env python3
"""Add a new trail photo to the map: process + register + upload in one step.

For each image you point it at, this script:
  1. reads GPS coordinates from the image's EXIF             (needs exiftool)
  2. recompresses it to <=1600px @ q72 and STRIPS EXIF/GPS   (needs ImageMagick)
     into photos-dist/web/<name>.jpeg  (the R2 upload staging dir, gitignored)
  3. appends a feature (filename + coordinates ONLY) to src/data/photos.json,
     which drives the map marker + lightbox slide.

Then it prints the R2 upload + git commit commands, or runs the upload for you
with --upload. The strip in step 2 is a privacy requirement, not a nicety:
originals embed Madison's precise location + timestamp (see CLAUDE.md). Only the
location (coordinates) is kept in photos.json -- no timestamp, altitude,
bearing, or device/lens metadata.

Usage:
  scripts/add-photo.py IMG_4521.jpg --name "pct26 - 2"      # one photo, nice name
  scripts/add-photo.py ~/Desktop/trail/*.jpg                # many (keeps basenames)
  scripts/add-photo.py IMG_4521.jpg --name "pct26 - 2" --upload

Options:
  --name NAME     R2 key / photos.json filename (without extension). Single image
                  only. Defaults to the input's basename. Output is always .jpeg.
  --upload        Run the rclone upload to R2 after processing (needs an `r2`
                  rclone remote). Without it, the upload command is only printed.
  --coords LON,LAT  Override GPS (use when the photo has no embedded location).

Tunables via env (match migrate-photos.sh): PHOTO_MAX_EDGE (1600),
PHOTO_QUALITY (72), R2_BUCKET (pct-tracker-photos).
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "photos-dist" / "web"
PHOTOS_JSON = ROOT / "src" / "data" / "photos.json"

MAX_EDGE = os.environ.get("PHOTO_MAX_EDGE", "1600")
QUALITY = os.environ.get("PHOTO_QUALITY", "72")
BUCKET = os.environ.get("R2_BUCKET", "pct-tracker-photos")
CACHE = "public, max-age=31536000, immutable"

# Trailing-style feature block (tabs), matching the tail of photos.json so the
# append is a clean 1-feature diff rather than a full reserialize. Properties are
# deliberately filename-only -- no timestamp/device metadata (see CLAUDE.md).
FEATURE = """\t\t{{
\t\t\t"type": "Feature",
\t\t\t"properties": {{
\t\t\t\t"filename": "{filename}"
\t\t\t}},
\t\t\t"geometry": {{
\t\t\t\t"type": "Point",
\t\t\t\t"coordinates": [
\t\t\t\t\t{lon:.8f},
\t\t\t\t\t{lat:.8f}
\t\t\t\t]
\t\t\t}}
\t\t}}"""


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def read_coords(path):
    """Return (lon, lat) or (None, None). GPS via -n is signed decimal.
    Only location is read -- capture time / device metadata are intentionally
    ignored so they never reach photos.json (see CLAUDE.md)."""
    out = subprocess.run(
        ["exiftool", "-j", "-n", "-GPSLatitude", "-GPSLongitude", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    tags = json.loads(out)[0]
    return tags.get("GPSLongitude"), tags.get("GPSLatitude")


def process_image(src, dest):
    """Recompress to <=MAX_EDGE and strip all metadata (EXIF, incl. GPS)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["magick", str(src), "-auto-orient", "-strip",
         "-resize", f"{MAX_EDGE}x{MAX_EDGE}>",
         "-interlace", "JPEG", "-sampling-factor", "4:2:0",
         "-quality", QUALITY, str(dest)],
        check=True,
    )
    # Belt-and-suspenders: fail loudly if any GPS survived the strip.
    leftover = subprocess.run(
        ["exiftool", "-s", "-GPSLatitude", "-GPSLongitude", str(dest)],
        capture_output=True, text=True,
    ).stdout.strip()
    if leftover:
        die(f"GPS survived strip on {dest.name}: {leftover!r}")


def add_feature(filename, lon, lat):
    """Text-append one feature before the closing ']}' of photos.json.
    Returns False (no-op) if the filename is already registered."""
    text = PHOTOS_JSON.read_text()
    data = json.loads(text)  # also validates the file parses
    if any(f["properties"]["filename"] == filename for f in data["features"]):
        return False
    block = FEATURE.format(filename=filename, lon=lon, lat=lat)
    body = text.rstrip("\n")
    close = body.rfind("\n\t]")  # start of the features-array closer
    if close == -1:
        die("could not find the end of the features array in photos.json")
    PHOTOS_JSON.write_text(body[:close] + ",\n" + block + body[close:] + "\n")
    return True


def main():
    ap = argparse.ArgumentParser(description="Add trail photo(s) to the map.")
    ap.add_argument("images", nargs="+", type=Path)
    ap.add_argument("--name", help="output name (no extension); single image only")
    ap.add_argument("--coords", help="LON,LAT override when EXIF has no GPS")
    ap.add_argument("--upload", action="store_true", help="rclone to R2 after processing")
    args = ap.parse_args()

    if args.name and len(args.images) > 1:
        die("--name works with a single image only")

    override = None
    if args.coords:
        lon_s, lat_s = args.coords.split(",")
        override = (float(lon_s), float(lat_s))

    uploaded = []
    for src in args.images:
        if not src.is_file():
            die(f"not a file: {src}")
        name = args.name or src.stem
        filename = f"{name}.jpeg"
        dest = OUT / filename

        lon, lat = read_coords(src)
        if override:
            lon, lat = override
        if lon is None or lat is None:
            die(f"{src.name} has no GPS; pass --coords LON,LAT")

        process_image(src, dest)
        added = add_feature(filename, lon, lat)
        status = "registered" if added else "already in photos.json (image refreshed)"
        print(f"  {filename}: [{lon:.5f}, {lat:.5f}]  -> {status}")
        uploaded.append(filename)

    print("\nProcessed into photos-dist/web/ (gitignored). Next:")
    print("\n1. Upload to R2 (bucket root, bare basenames):")
    for filename in uploaded:
        cmd = ["rclone", "copyto",
               f"photos-dist/web/{filename}", f"r2:{BUCKET}/{filename}",
               "--header-upload", f"Cache-Control: {CACHE}"]
        if args.upload:
            print(f"   uploading {filename} ...")
            subprocess.run(cmd, check=True)
        else:
            printable = " ".join(f'"{c}"' if " " in c else c for c in cmd)
            print(f"   {printable}")

    print("\n2. Commit + push (triggers the Vercel deploy):")
    names = ", ".join(f.removesuffix(".jpeg") for f in uploaded)
    print(f'   git add src/data/photos.json && git commit -S -m "feat(photos): add {names}" && git push')


if __name__ == "__main__":
    main()
