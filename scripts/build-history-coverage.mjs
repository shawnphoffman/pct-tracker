// Regenerates src/data/pct-history-coverage.json: the pre-snapped covered
// mile-intervals for Madison's static (pre-2026) PCT hikes.
//
// The older years' geometry lives only in Mapbox tilesets, so we harvest the
// mile-marker tileset and each year's track tileset by decoding their vector
// tiles, snap every track vertex to the nearest mile marker, and merge the
// snapped miles into covered [from, to] intervals. The live 2026 track is NOT
// baked here; it's snapped at request time in src/lib/pct-progress.js.
//
// Run when a historical year's track tileset changes:
//   npm i --no-save @mapbox/vector-tile pbf
//   MAPBOX_TOKEN=pk.xxx node scripts/build-history-coverage.mjs
// (token also read from NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN in the environment.)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader as Pbf } from 'pbf'

const TOKEN = process.env.MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN
if (!TOKEN) {
	console.error('Set MAPBOX_TOKEN (or NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN).')
	process.exit(1)
}

const MARKER = { tileset: 'shawnhoffman.32639qah', layer: 'Full_PCT_Mile_Marker_shapefil-9o39kw', z: 10, bounds: [-123.258, 32.5958, -116.4127, 49.058] }
// 2023 is NOT harvested here anymore: its coverage now comes from the Garmin
// export bucket via scripts/garmin/bucket_coverage.py (pct-export-coverage.json),
// so the % matches the 2023 line we draw from the same export. Only 2018/2019
// (which have no export-bucket coverage of their own) still come from tilesets.
const YEARS = [
	{ year: 2018, tileset: 'shawnhoffman.8f35lgg6', layer: 'PCT_-_Madison_-_2018-12dy82', z: 12, bounds: [-119.34, 36.56, -118.06, 37.88] },
	{ year: 2019, tileset: 'shawnhoffman.0psf6y5h', layer: 'tracks', z: 13, bounds: [-119.75, 37.88, -119.36, 38.33] },
]
const FILL_GAP = 3 // miles: bridge sorted snapped miles within this gap (dense track sampling)
const MAX_SNAP_KM = 0.5 // >500m off any marker = not on trail, skip the vertex

const N = z => 2 ** z
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * N(z))
const lat2y = (lat, z) => {
	const r = (lat * Math.PI) / 180
	return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N(z))
}

const R_KM = 6371
const toRad = d => (d * Math.PI) / 180
const hav = (lon1, lat1, lon2, lat2) => {
	const dLat = toRad(lat2 - lat1)
	const dLon = toRad(lon2 - lon1)
	const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
	return 2 * R_KM * Math.asin(Math.sqrt(a))
}

// Fetch + decode every tile in a tileset's bounds; call fn(geoJsonGeometry, props).
const forEachFeature = async ({ tileset, layer, z, bounds }, fn) => {
	const x0 = lon2x(bounds[0], z)
	const x1 = lon2x(bounds[2], z)
	const y0 = lat2y(bounds[3], z)
	const y1 = lat2y(bounds[1], z)
	for (let x = x0; x <= x1; x++) {
		for (let y = y0; y <= y1; y++) {
			const res = await fetch(`https://api.mapbox.com/v4/${tileset}/${z}/${x}/${y}.vector.pbf?access_token=${TOKEN}`)
			if (!res.ok) continue
			const buf = Buffer.from(await res.arrayBuffer())
			if (!buf.length) continue
			const lyr = new VectorTile(new Pbf(buf)).layers[layer]
			if (!lyr) continue
			for (let i = 0; i < lyr.length; i++) {
				const f = lyr.feature(i)
				fn(f.toGeoJSON(x, y, z).geometry, f.properties)
			}
		}
	}
}

const coordsOf = geom => {
	if (geom.type === 'LineString') return geom.coordinates
	if (geom.type === 'MultiLineString') return geom.coordinates.flat()
	if (geom.type === 'Point') return [geom.coordinates]
	if (geom.type === 'MultiPoint') return geom.coordinates
	return []
}

console.log('Harvesting mile markers...')
const markers = []
await forEachFeature(MARKER, (geom, props) => {
	const [lon, lat] = geom.coordinates
	if (Number.isFinite(props.Mile)) markers.push({ lon, lat, mile: props.Mile })
})
console.log(`  ${markers.length} markers`)

// Bucket markers by 0.1-deg lat for fast nearest lookup.
const idx = new Map()
for (const m of markers) {
	const k = Math.round(m.lat * 10)
	if (!idx.has(k)) idx.set(k, [])
	idx.get(k).push(m)
}
const snap = (lon, lat) => {
	const base = Math.round(lat * 10)
	let best = null
	let bestD = Infinity
	for (let k = base - 1; k <= base + 1; k++) {
		for (const m of idx.get(k) || []) {
			const d = hav(lon, lat, m.lon, m.lat)
			if (d < bestD) {
				bestD = d
				best = m
			}
		}
	}
	return best && bestD <= MAX_SNAP_KM ? best.mile : null
}

// Sort snapped miles, merge within FILL_GAP, drop zero-length spans.
const toIntervals = miles => {
	const s = [...new Set(miles)].sort((a, b) => a - b)
	const out = []
	for (const m of s) {
		const last = out[out.length - 1]
		if (last && m - last[1] <= FILL_GAP) last[1] = m
		else out.push([m, m])
	}
	return out.filter(([a, b]) => b > a).map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10])
}

const result = {}
for (const y of YEARS) {
	console.log(`Harvesting ${y.year}...`)
	const miles = []
	await forEachFeature(y, geom => {
		for (const [lon, lat] of coordsOf(geom)) {
			const mi = snap(lon, lat)
			if (mi != null) miles.push(mi)
		}
	})
	result[y.year] = toIntervals(miles)
	const covered = result[y.year].reduce((s, [a, b]) => s + (b - a), 0)
	console.log(`  ${result[y.year].length} intervals, ${covered.toFixed(1)} mi`)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outPath = path.join(__dirname, '..', 'src', 'data', 'pct-history-coverage.json')
const body = {
	_comment: "Pre-snapped covered mile-intervals [from,to] for Madison's static (pre-2026) PCT hikes, unioned with the live 2026 track in src/lib/pct-progress.js. Regenerate with scripts/build-history-coverage.mjs when a year's track tileset changes.",
	...result,
}
fs.writeFileSync(outPath, JSON.stringify(body, null, '\t') + '\n')
console.log(`\nWrote ${outPath}`)
