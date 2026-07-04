#!/usr/bin/env python3
"""Add a new trail photo to the map: process + register + upload in one step.

For each image you point it at, this script:
  1. reads GPS + capture time from the image's EXIF          (needs exiftool)
  2. recompresses it to <=1600px @ q72 and STRIPS EXIF/GPS   (needs ImageMagick)
     into photos-dist/web/<name>.jpeg  (the R2 upload staging dir, gitignored)
  3. appends a feature (filename + coordinates) to src/data/photos.json, which
     drives the map marker + lightbox slide.

Then it prints the R2 upload + git commit commands, or runs the upload for you
with --upload. The strip in step 2 is a privacy requirement, not a nicety:
originals embed Madison's precise location + timestamp (see CLAUDE.md).

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
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "photos-dist" / "web"
PHOTOS_JSON = ROOT / "src" / "data" / "photos.json"

MAX_EDGE = os.environ.get("PHOTO_MAX_EDGE", "1600")
QUALITY = os.environ.get("PHOTO_QUALITY", "72")
BUCKET = os.environ.get("R2_BUCKET", "pct-tracker-photos")
CACHE = "public, max-age=31536000, immutable"

# Trailing-style feature block (tabs), matching the tail of photos.json so the
# append is a clean 1-feature diff rather than a full reserialize.
FEATURE = """\t\t{{
\t\t\t"type": "Feature",
\t\t\t"properties": {{
\t\t\t\t"filename": "{filename}",
\t\t\t\t"createDate": "{create_date}"
\t\t\t}},
\t\t\t"geometry": {{
\t\t\t\t"coordinates": [
\t\t\t\t\t{lon:.8f},
\t\t\t\t\t{lat:.8f}
\t\t\t\t],
\t\t\t\t"type": "Point"
\t\t\t}}
\t\t}}"""


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def read_exif(path):
    """Return (lon, lat_or_None, create_date_iso). GPS via -n is signed decimal."""
    out = subprocess.run(
        ["exiftool", "-j", "-n",
         "-GPSLatitude", "-GPSLongitude",
         "-DateTimeOriginal", "-CreateDate", "-OffsetTimeOriginal", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    tags = json.loads(out)[0]
    lat = tags.get("GPSLatitude")
    lon = tags.get("GPSLongitude")
    stamp = tags.get("DateTimeOriginal") or tags.get("CreateDate")
    return lon, lat, iso_utc(stamp, tags.get("OffsetTimeOriginal"))


def iso_utc(stamp, offset):
    """EXIF 'YYYY:MM:DD HH:MM:SS' (+ optional '-07:00') -> UTC ISO 'Z' string.
    createDate is not read by the app; if the offset is absent the wall-clock
    time is stored as-is with a 'Z', which is only approximate. It exists purely
    to match the schema of the other 293 features."""
    if not stamp:
        return ""
    try:
        dt = datetime.strptime(stamp, "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return ""
    if offset and len(offset) == 6:  # e.g. -07:00
        sign = 1 if offset[0] == "+" else -1
        dt = dt - sign * timedelta(hours=int(offset[1:3]), minutes=int(offset[4:6]))
    return dt.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


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


def add_feature(filename, lon, lat, create_date):
    """Text-append one feature before the closing ']}' of photos.json.
    Returns False (no-op) if the filename is already registered."""
    text = PHOTOS_JSON.read_text()
    data = json.loads(text)  # also validates the file parses
    if any(f["properties"]["filename"] == filename for f in data["features"]):
        return False
    block = FEATURE.format(filename=filename, create_date=create_date, lon=lon, lat=lat)
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

        lon, lat, create_date = read_exif(src)
        if override:
            lon, lat = override
        if lon is None or lat is None:
            die(f"{src.name} has no GPS; pass --coords LON,LAT")

        process_image(src, dest)
        added = add_feature(filename, lon, lat, create_date)
        status = "registered" if added else "already in photos.json (image refreshed)"
        print(f"  {filename}: [{lon:.5f}, {lat:.5f}]  {create_date or 'no date'}  -> {status}")
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
