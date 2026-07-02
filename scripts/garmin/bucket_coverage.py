#!/usr/bin/env python3
"""Compute covered PCT mile-intervals for the export-only buckets (2026,
trail-crew, misc) by snapping their tracks to the mile markers, and write them
to src/data/pct-export-coverage.json.

This is unioned into the coverage/progress calc (src/app/api/track/[year]) and
the gap generator (scripts/build-gaps.mjs) alongside the tileset-derived
pct-history-coverage.json (2018/2019/2023) and the live 2026 feed - so progress
% and the pending-gap list account for ALL of Madison's PCT miles, not just the
baked historical years.

    python3 scripts/garmin/bucket_coverage.py
"""
import json, math, os
import xml.etree.ElementTree as ET

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
NS = '{http://www.topografix.com/GPX/1/1}'
BUCKETS = {'2026': 'pct-2026.gpx', 'trail-crew': 'trail-crew.gpx', 'misc': 'misc.gpx'}
SNAP_KM = 0.5
FILL_GAP = 3.0   # matches scripts/build-history-coverage.mjs

markers = json.load(open(f'{REPO}/garmin-export/.markers.json'))
midx = {}
for m in markers:
    midx.setdefault(round(m['lat'] * 10), []).append(m)
R = 6371; rad = math.radians
def hav(a, b):
    d1 = rad(b[1] - a[1]); d2 = rad(b[0] - a[0])
    x = math.sin(d1/2)**2 + math.cos(rad(a[1]))*math.cos(rad(b[1]))*math.sin(d2/2)**2
    return 2 * R * math.asin(math.sqrt(x))
def snap(lon, lat):
    best = None; bd = 1e9
    for k in (round(lat*10)-1, round(lat*10), round(lat*10)+1):
        for m in midx.get(k, []):
            d = hav((lon, lat), (m['lon'], m['lat']))
            if d < bd: bd = d; best = m['mile']
    return best if bd <= SNAP_KM else None
def intervals(miles):
    s = sorted(miles); out = []
    for m in s:
        if out and m - out[-1][1] <= FILL_GAP: out[-1][1] = m
        else: out.append([m, m])
    return [[a, b] for a, b in out if b > a]

result = {'_comment': 'Covered PCT mile-intervals for the export-only buckets (2026/trail-crew/misc), '
                      'snapped from garmin-export/buckets. Unioned into coverage + gaps alongside '
                      'pct-history-coverage.json. Regenerate with scripts/garmin/bucket_coverage.py.'}
for key, fname in BUCKETS.items():
    path = f'{REPO}/garmin-export/buckets/{fname}'
    if not os.path.exists(path):
        continue
    ms = set()
    for pt in ET.parse(path).getroot().iter(NS+'trkpt'):
        mi = snap(float(pt.get('lon')), float(pt.get('lat')))
        if mi is not None: ms.add(round(mi * 2) / 2)
    result[key] = intervals(ms)
    covered = sum(b - a for a, b in result[key])
    print(f'  {key:<11} {len(result[key])} intervals, {covered:.1f} mi')

out = f'{REPO}/src/data/pct-export-coverage.json'
json.dump(result, open(out, 'w'), indent='\t')
open(out, 'a').write('\n')
print(f'-> {out}')
