#!/usr/bin/env python3
"""Build the LOCAL-ONLY 'incomplete' debug layer: the PCT sections that do NOT
count toward coverage yet - the pending gaps in src/data/pct-gaps.json (any
status other than "complete"), plus the "remaining" stretch from her furthest
point on to the Canadian terminus. Drawn along the PCT mile markers so you can
see, and hover, exactly which stretches are still open (e.g. JMT-variant holes).

Local-only: writes public/incomplete.geojson (gitignored, never deployed); the
map's Incomplete toggle only renders in dev.

    python3 scripts/garmin/incomplete_layer.py
"""
import json, os

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
gapsdata = json.load(open(f'{REPO}/src/data/pct-gaps.json'))
gaps = gapsdata.get('gaps', [])
remaining = gapsdata.get('remaining')
markers = json.load(open(f'{REPO}/garmin-export/.markers.json'))

by_mile = {}
for m in markers:
    by_mile.setdefault(round(m['mile'] * 2) / 2, (m['lon'], m['lat']))
spine = sorted(by_mile.items())

pending = sorted((g for g in gaps if g.get('status') != 'complete'), key=lambda g: g['from'])
feats = []
index = {}

def add(rid, a, b, label, status, miles, region):
    coords = [[round(lo, 5), round(la, 5)] for mile, (lo, la) in spine if a <= mile <= b]
    if len(coords) < 2:
        return
    feats.append({'type': 'Feature',
                  'properties': {'role': 'incomplete', 'id': rid, 'fromMile': a, 'toMile': b,
                                 'label': label},
                  'geometry': {'type': 'LineString', 'coordinates': coords}})
    index[rid] = {'from': a, 'to': b, 'miles': miles, 'region': region, 'status': status}

for n, g in enumerate(pending, 1):
    add(f'incomplete-{n:02d}', g['from'], g['to'], f"{g['miles']} mi · {g['region']}",
        g['status'], g['miles'], g['region'])

# The stretch from her furthest point on to the Canadian terminus.
if remaining:
    add('incomplete-remaining', remaining['from'], remaining['to'],
        f"{remaining['miles']} mi · to Canada", 'remaining', remaining['miles'], remaining['region'])

json.dump({'type': 'FeatureCollection', 'features': feats},
          open(f'{REPO}/public/incomplete.geojson', 'w'), separators=(',', ':'))
sidecar = f'{REPO}/garmin-export/buckets/route-index.json'
allidx = json.load(open(sidecar)) if os.path.exists(sidecar) else {}
allidx['incomplete'] = index
json.dump(allidx, open(sidecar, 'w'), indent=1)
miles = sum(g['to'] - g['from'] for g in pending)
tail = f" + {remaining['miles']:.1f} mi to Canada" if remaining else ''
print(f'{len(feats)} incomplete sections ({miles:.1f} mi pending{tail}) -> public/incomplete.geojson')
