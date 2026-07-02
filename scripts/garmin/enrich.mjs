// Step 1 of the Garmin bucket pipeline. For every track in the newest
// garmin-export/explore_*.gpx, snap each vertex to the nearest PCT mile marker
// (Mapbox tileset shawnhoffman.32639qah) to measure how much of the track is on
// the trail and which miles it touches. Writes garmin-export/.enriched.json.
//
//   node scripts/garmin/enrich.mjs
//
// Mapbox token read from env (NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN / MAPBOX_TOKEN)
// or parsed from .env.local. Markers are cached to garmin-export/.markers.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader as Pbf } from 'pbf'
import { XMLParser } from 'fast-xml-parser'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXPORT_DIR = path.join(REPO, 'garmin-export')
const MARKER_CACHE = path.join(EXPORT_DIR, '.markers.json')

const newest = fs.readdirSync(EXPORT_DIR).filter(f => /^explore_.*\.gpx$/.test(f)).sort().pop()
if (!newest) { console.error('no garmin-export/explore_*.gpx found'); process.exit(1) }
const GPX = path.join(EXPORT_DIR, newest)

let TOKEN = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN
if (!TOKEN) {
	for (const line of fs.readFileSync(path.join(REPO, '.env.local'), 'utf8').split('\n')) {
		const m = line.match(/^\s*(?:NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN|MAPBOX_TOKEN)\s*=\s*(.*)\s*$/)
		if (m) { TOKEN = m[1].replace(/^["']|["']$/g, ''); break }
	}
}
if (!TOKEN) { console.error('no mapbox token (env or .env.local)'); process.exit(1) }

const MARKER = { tileset: 'shawnhoffman.32639qah', layer: 'Full_PCT_Mile_Marker_shapefil-9o39kw', z: 10, bounds: [-123.258, 32.5958, -116.4127, 49.058] }
const N = z => 2 ** z
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * N(z))
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N(z)) }
const R_KM = 6371, toRad = d => (d * Math.PI) / 180
const hav = (lon1, lat1, lon2, lat2) => { const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2; return 2 * R_KM * Math.asin(Math.sqrt(a)) }

async function harvestMarkers() {
	if (fs.existsSync(MARKER_CACHE)) return JSON.parse(fs.readFileSync(MARKER_CACHE))
	const { z, bounds, tileset, layer } = MARKER
	const x0 = lon2x(bounds[0], z), x1 = lon2x(bounds[2], z), y0 = lat2y(bounds[3], z), y1 = lat2y(bounds[1], z)
	const markers = []
	for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
		const res = await fetch(`https://api.mapbox.com/v4/${tileset}/${z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`)
		if (!res.ok) continue
		const buf = Buffer.from(await res.arrayBuffer())
		if (!buf.length) continue
		const lyr = new VectorTile(new Pbf(buf)).layers[layer]
		if (!lyr) continue
		for (let i = 0; i < lyr.length; i++) {
			const f = lyr.feature(i)
			const g = f.toGeoJSON(x, y, z).geometry
			if (g.type === 'Point' && Number.isFinite(f.properties.Mile)) markers.push({ lon: g.coordinates[0], lat: g.coordinates[1], mile: f.properties.Mile })
		}
	}
	fs.writeFileSync(MARKER_CACHE, JSON.stringify(markers))
	return markers
}

const markers = await harvestMarkers()
console.error(`markers: ${markers.length}  source: ${newest}`)
const idx = new Map()
for (const m of markers) { const k = Math.round(m.lat * 10); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(m) }
const snap = (lon, lat) => {
	const base = Math.round(lat * 10); let best = null, bestD = Infinity
	for (let k = base - 1; k <= base + 1; k++) for (const m of idx.get(k) || []) { const d = hav(lon, lat, m.lon, m.lat); if (d < bestD) { bestD = d; best = m } }
	return { mile: best ? best.mile : null, dist: bestD }
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(fs.readFileSync(GPX, 'utf8'))
const asArr = v => v == null ? [] : Array.isArray(v) ? v : [v]
const trks = asArr(xml.gpx.trk)

const ON_KM = 0.5
const out = []
trks.forEach((trk, i) => {
	const pts = [], times = []
	for (const seg of asArr(trk.trkseg)) for (const p of asArr(seg.trkpt)) {
		const lat = parseFloat(p['@_lat']), lon = parseFloat(p['@_lon'])
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
		pts.push([lon, lat]); if (p.time) times.push(p.time)
	}
	if (!pts.length) return
	let total = 0
	for (let j = 1; j < pts.length; j++) total += hav(pts[j-1][0], pts[j-1][1], pts[j][0], pts[j][1])
	const net = hav(pts[0][0], pts[0][1], pts[pts.length-1][0], pts[pts.length-1][1])
	const lats = pts.map(p => p[1]), lons = pts.map(p => p[0])
	let onCount = 0; const milesOn = []; let nearSum = 0
	for (const [lon, lat] of pts) {
		const s = snap(lon, lat); nearSum += Math.min(s.dist, 5)
		if (s.dist <= ON_KM && s.mile != null) { onCount++; milesOn.push(s.mile) }
	}
	const uniqMiles = [...new Set(milesOn.map(m => Math.round(m * 2) / 2))].sort((a,b)=>a-b)
	const mileMin = uniqMiles.length ? uniqMiles[0] : null
	const mileMax = uniqMiles.length ? uniqMiles[uniqMiles.length-1] : null
	const t = times.slice().sort()
	const start = t[0] || null, end = t[t.length-1] || null
	out.push({
		idx: i, date: start ? start.slice(0,10) : null, year: start ? +start.slice(0,4) : null,
		start, end, npts: pts.length,
		dist_km: +total.toFixed(2), net_km: +net.toFixed(2),
		linearity: total > 0 ? +(net/total).toFixed(3) : 0,
		onFrac: +(onCount / pts.length).toFixed(3), avgNearKm: +(nearSum/pts.length).toFixed(2),
		mileMin, mileMax, mileSpan: (mileMin!=null) ? +(mileMax-mileMin).toFixed(1) : 0,
		distinctMiles: uniqMiles.length,
		bbox: [ +Math.min(...lats).toFixed(4), +Math.min(...lons).toFixed(4), +Math.max(...lats).toFixed(4), +Math.max(...lons).toFixed(4) ],
	})
})
out.sort((a,b) => (a.start||'').localeCompare(b.start||''))
fs.writeFileSync(path.join(EXPORT_DIR, '.enriched.json'), JSON.stringify(out, null, 1))
console.error(`enriched ${out.length} tracks -> garmin-export/.enriched.json`)
