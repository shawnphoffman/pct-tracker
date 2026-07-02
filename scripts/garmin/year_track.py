#!/usr/bin/env python3
"""Render a year's ACTUAL track as a privacy-clipped GeoJSON for the map.

The Garmin export contains off-trail spurs to town/roads/HOME (up to ~10 km off
the PCT). We keep the on-trail hike (A) plus near-trail *variant* excursions that
stay within CORRIDOR_KM (B, e.g. the JMT), and DROP any excursion that ever
leaves the corridor - the whole excursion, so no partial home-approach leaks.
Output is geometry only (no timestamps). A hard safety gate aborts if any kept
point exceeds the corridor.

This exists because the Mapbox tileset's 2023 layer hides an entire track feature
to protect the home (leaving a visible gap at mi 1100-1103); serving our own
clipped track fills that gap while keeping the home off the map.

    python3 scripts/garmin/year_track.py garmin-export/buckets/pct-2023.gpx public/pct-2023.geojson track2023
"""
import sys, json, math, os
import xml.etree.ElementTree as ET

NS = '{http://www.topografix.com/GPX/1/1}'
ON_KM = 0.5        # <= this from a marker = on trail
CORRIDOR_KM = 3.0  # a variant may wander this far; beyond = town/home spur -> drop the whole excursion
TOL = 0.0001       # RDP simplify (~11 m)

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
markers = json.load(open(f'{REPO}/garmin-export/.markers.json'))
midx = {}
for m in markers:
    midx.setdefault(round(m['lat'] * 10), []).append(m)
R = 6371; rad = math.radians
def hav(a, b):
    d1 = rad(b[1] - a[1]); d2 = rad(b[0] - a[0])
    x = math.sin(d1/2)**2 + math.cos(rad(a[1]))*math.cos(rad(b[1]))*math.sin(d2/2)**2
    return 2 * R * math.asin(math.sqrt(x))
def dist_to_trail(lon, lat):
    best = 1e9
    for k in (round(lat*10)-1, round(lat*10), round(lat*10)+1):
        for m in midx.get(k, []):
            best = min(best, hav((lon, lat), (m['lon'], m['lat'])))
    return best

def perp(p, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    if dx == 0 and dy == 0: return ((p[0]-a[0])**2 + (p[1]-a[1])**2) ** 0.5
    t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / (dx*dx + dy*dy)
    return ((p[0]-(a[0]+t*dx))**2 + (p[1]-(a[1]+t*dy))**2) ** 0.5
def rdp(pts, tol):
    if len(pts) <= 2: return pts
    keep = [False]*len(pts); keep[0] = keep[-1] = True; st = [(0, len(pts)-1)]
    while st:
        s, e = st.pop(); md, mi = 0, -1
        for i in range(s+1, e):
            d = perp(pts[i], pts[s], pts[e])
            if d > md: md, mi = d, i
        if md > tol and mi != -1:
            keep[mi] = True; st += [(s, mi), (mi, e)]
    return [p for p, k in zip(pts, keep) if k]

def clip_segment(pts):
    """pts: [(lon,lat,dist)]. Drop whole off-trail excursions that exceed the
    corridor; keep everything else. Returns list of kept runs (each a coord list)."""
    keep = [True] * len(pts)
    i = 0
    while i < len(pts):
        if pts[i][2] > ON_KM:
            j = i
            while j < len(pts) and pts[j][2] > ON_KM:
                j += 1
            if max(pts[k][2] for k in range(i, j)) > CORRIDOR_KM:   # town/home spur
                for k in range(i, j): keep[k] = False
            i = j
        else:
            i += 1
    runs, run = [], []
    for k in range(len(pts)):
        if keep[k]:
            run.append([round(pts[k][0], 5), round(pts[k][1], 5)])
        else:
            if len(run) >= 2: runs.append(run)
            run = []
    if len(run) >= 2: runs.append(run)
    return runs

def convert(src, dst, role):
    feats = []
    max_kept = 0.0
    for trk in ET.parse(src).getroot().iter(NS+'trk'):
        for seg in trk.iter(NS+'trkseg'):
            pts = []
            for p in seg.iter(NS+'trkpt'):
                lon, lat = float(p.get('lon')), float(p.get('lat'))
                pts.append((lon, lat, dist_to_trail(lon, lat)))
            for run in clip_segment(pts):
                for lon, lat in run:
                    max_kept = max(max_kept, dist_to_trail(lon, lat))
                simp = rdp(run, TOL)
                if len(simp) >= 2:
                    feats.append({'type': 'Feature', 'properties': {'role': role},
                                  'geometry': {'type': 'LineString', 'coordinates': simp}})
    # HARD SAFETY GATE: nothing beyond the corridor may ship.
    if max_kept > CORRIDOR_KM + 1e-6:
        sys.exit(f'ABORT: kept a point {max_kept:.1f} km off trail (> {CORRIDOR_KM} km corridor) - possible PII leak')
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(dst, 'w'), separators=(',', ':'))
    pts_total = sum(len(f['geometry']['coordinates']) for f in feats)
    print(f'{src} -> {dst}: {len(feats)} segments, {pts_total} points, '
          f'max {max_kept:.2f} km off trail (corridor {CORRIDOR_KM} km), {os.path.getsize(dst)//1024} KB')

if __name__ == '__main__':
    convert(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'year')
