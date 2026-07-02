#!/usr/bin/env python3
"""Suggest which pending PCT gaps were actually WALKED (as a variant/alternate)
rather than hitched, so you can set their status to "complete" in
src/data/pct-gaps.json.

Rule: a gap is walked if ONE continuous walking-pace segment of a hike touches
the PCT on both sides of it. Segments break only on a >BREAK_KM position jump
between consecutive fixes (a hitch, or moving with the device off) - overnight
camps (same spot, long time) and normal GPS jitter do NOT break. A JMT-style
variant just runs off the official line in the middle, where snapping is moot;
what matters is that the trace is one unbroken walk from before to after.

Report-only (never edits pct-gaps.json - that stays the manual source of truth).

    python3 scripts/garmin/adjudicate_gaps.py
"""
import xml.etree.ElementTree as ET, json, math, os, glob
from collections import defaultdict

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
NS = '{http://www.topografix.com/GPX/1/1}'
SNAP_KM = 0.5
BREAK_KM = 3.0   # a walk never jumps this far between fixes; a vehicle does

markers = json.load(open(f'{REPO}/garmin-export/.markers.json'))
midx = defaultdict(list)
for m in markers:
    midx[round(m['lat'] * 10)].append(m)
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

enr = json.load(open(f'{REPO}/garmin-export/.enriched.json'))
junk = set(t['idx'] for t in enr if t['mileSpan'] > 300)
by_idx = {t['idx']: t for t in enr}
SRC = sorted(glob.glob(f'{REPO}/garmin-export/explore_*.gpx'))[-1]
trks = ET.parse(SRC).getroot().findall(NS+'trk')

years = defaultdict(dict)
for i, trk in enumerate(trks):
    if i in junk: continue
    y = by_idx.get(i, {}).get('year')
    if y not in (2018, 2019, 2023, 2026): continue
    for p in trk.iter(NS+'trkpt'):
        t = p.find(NS+'time')
        if t is not None: years[y][t.text] = (float(p.get('lon')), float(p.get('lat')))

segments = []   # (year, minMile, maxMile) per continuous walk
for y, d in years.items():
    P = [d[k] for k in sorted(d)]
    seg = []
    def flush():
        ons = [snap(lon, lat) for lon, lat in seg]
        ons = [m for m in ons if m is not None]
        if ons: segments.append((y, min(ons), max(ons)))
    for q in P:
        if seg and hav(seg[-1], q) > BREAK_KM:
            flush(); seg = []
        seg.append(q)
    flush()

gaps = json.load(open(f'{REPO}/src/data/pct-gaps.json'))['gaps']
print(f"{'gap (mi)':<15}{'len':>6} {'status':<9} verdict")
walked = []
for g in sorted(gaps, key=lambda x: x['from']):
    a, b = g['from'], g['to']
    hit = sorted(set(s[0] for s in segments if s[1] <= a and s[2] >= b))
    if hit:
        walked.append([a, b])
        print(f"{str(a)+'-'+str(b):<15}{g['miles']:>6} {g['status']:<9} WALKED (continuous {hit} spans it) -> set complete")
    else:
        print(f"{str(a)+'-'+str(b):<15}{g['miles']:>6} {g['status']:<9} not spanned by a continuous walk (hitch/skip)")
print(f"\nsuggested complete: {walked}")
