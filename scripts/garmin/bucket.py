#!/usr/bin/env python3
"""Step 2 of the Garmin bucket pipeline: classify each track and write clean,
per-bucket GPX files. Every track is run through sanitize.strip_pii first, so
NO private messages / names / metadata reach the output.

    python3 scripts/garmin/bucket.py     # after: node scripts/garmin/enrich.mjs

Reads garmin-export/.enriched.json + the newest garmin-export/explore_*.gpx,
writes garmin-export/buckets/*.gpx + manifest.json + README.md.
"""
import xml.etree.ElementTree as ET
import json, os, glob
from collections import defaultdict
from sanitize import strip_pii   # same dir

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
EXPORT = os.path.join(REPO, 'garmin-export')
OUT = os.path.join(EXPORT, 'buckets')
NS = 'http://www.topografix.com/GPX/1/1'
ET.register_namespace('', NS)

GPX = sorted(glob.glob(os.path.join(EXPORT, 'explore_*.gpx')))[-1]
enr = {t['idx']: t for t in json.load(open(os.path.join(EXPORT, '.enriched.json')))}
SEASON_2026 = '2026-06-30'   # GARMIN_2026_START; on-PCT tracks before this = crew

# Manual per-track bucket overrides, keyed by "<date>:<mileMin>" (both shown in
# the local garmin-export/buckets/route-index.json / the map's dev hover popover).
# Use to move an individual outing the rules mis-bucket, e.g.
#   '2021-08-08:1093.5': 'trail-crew'
OVERRIDES = {}

def classify(t):
    ov = OVERRIDES.get(f"{t['date']}:{t['mileMin']}")
    if ov:
        return ov
    y = t['year']
    if t['mileSpan'] > 300:                       # corrupt aggregate mega-track
        return 'pct-unknown'
    on_pct = t['onFrac'] >= 0.4 or t['distinctMiles'] >= 3
    near   = t['distinctMiles'] >= 2 or t['onFrac'] >= 0.2
    if y == 2026:
        if on_pct and t['date'] < SEASON_2026:    # pre-season June day trips = trail crew
            return 'trail-crew'
        return 'pct-2026' if on_pct else 'non-pct'
    if y in (2018, 2019, 2023):                   # continuous multi-day progressions = hikes
        return f'pct-{y}' if on_pct else 'non-pct'
    if (t['distinctMiles'] >= 3) or (near and t['onFrac'] >= 0.3):  # 2020-2022 near-trail
        return 'misc'                             # PCT-adjacent, non-hike, non-crew (uncertain)
    return 'non-pct'

def note_for(t):
    return (f"UNKNOWN: corrupt aggregate record ({t['date']}) with GPS teleport jumps spanning "
            f"mi {t['mileMin']}-{t['mileMax']} ({t['dist_km']:.0f} km of implausible distance); "
            f"likely a Garmin 'all trips' rollup, not a real outing.")

tree = ET.parse(GPX); root = tree.getroot()
trks = root.findall(f'{{{NS}}}trk')
seen = set(); buckets = defaultdict(list); meta = defaultdict(list)
for i, trk in enumerate(trks):
    if i not in enr:
        continue
    t = enr[i]
    key = (t['date'], t['npts'], tuple(t['bbox']))
    if key in seen:
        continue
    seen.add(key)
    strip_pii(trk)                                # <-- remove all messages/names/metadata
    b = classify(t)                               # per-track notes live in manifest.json, not the GPX
    buckets[b].append(trk)
    meta[b].append(t)

os.makedirs(OUT, exist_ok=True)
def write_bucket(name, trk_list):
    gpx = ET.Element(f'{{{NS}}}gpx', {'version': '1.1', 'creator': 'pct-tracker (sanitized)'})
    for trk in trk_list:
        gpx.append(trk)
    ET.ElementTree(gpx).write(f'{OUT}/{name}.gpx', xml_declaration=True, encoding='UTF-8')

manifest = {}
order = ['pct-2018','pct-2019','pct-2023','pct-2026','trail-crew','misc','pct-unknown','non-pct']
for name in order:
    if name not in buckets:
        continue
    write_bucket(name, buckets[name])
    ms = meta[name]
    dates = sorted({m['date'] for m in ms})
    miles = [m['mileMin'] for m in ms if m['mileMin'] is not None] + [m['mileMax'] for m in ms if m['mileMax'] is not None]
    manifest[name] = {
        'tracks': len(ms), 'days': len(dates),
        'date_range': [dates[0], dates[-1]] if dates else None,
        'pct_mile_range': [min(miles), max(miles)] if miles else None,
        'raw_km': round(sum(m['dist_km'] for m in ms), 1),
    }
    if name == 'pct-unknown':
        manifest[name]['notes'] = [note_for(m) for m in sorted(ms, key=lambda x: x['start'] or '')]

json.dump(manifest, open(f'{OUT}/manifest.json', 'w'), indent=2)

print(f"{'bucket':<16}{'trks':>5}{'days':>6}{'date range':>26}{'PCT miles':>16}")
for name in order:
    if name not in manifest: continue
    m = manifest[name]
    dr = f"{m['date_range'][0]}..{m['date_range'][1]}" if m['date_range'] else '-'
    pm = f"{m['pct_mile_range'][0]}-{m['pct_mile_range'][1]}" if m['pct_mile_range'] else '-'
    print(f"{name:<16}{m['tracks']:>5}{m['days']:>6}{dr:>26}{pm:>16}")
print(f"\n-> {OUT}/  (all tracks sanitized: no messages/names/metadata)")
