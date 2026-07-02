import { garminKmlToGeoJSON } from '@/lib/garmin'

// Server-side proxy for Madison's Garmin inReach MapShare feed. The MapShare
// password stays in env and never reaches the browser. The upstream KML is
// fetched, cleaned into GeoJSON, cached, and served to the map.

// Per-year feed config. Add a new entry each season.
const YEARS = {
	2026: {
		user: process.env.GARMIN_MAPSHARE_USER || 'madison',
		// Only pull fixes from the season start forward (keeps the feed small/fast).
		start: process.env.GARMIN_2026_START || '2026-06-30T00:00:00Z',
	},
}

const isProd = process.env.NODE_ENV === 'production'
const numEnv = (name, fallback) => {
	const n = parseFloat(process.env[name])
	return Number.isFinite(n) ? n : fallback
}

// SAFETY DELAY: the public/deployed map must NOT reveal Madison's near-real-time
// location. We only surface fixes at least this old. Fresh locally for testing.
const DELAY_HOURS = numEnv('GARMIN_DELAY_HOURS', isProd ? 72 : 0)

// How long a cached response is served before refetching Garmin. Slow in prod
// (data only ages into view), fast locally.
const REVALIDATE_SECONDS = numEnv('GARMIN_REVALIDATE_SECONDS', isProd ? 12 * 3600 : 300)

const empty = { type: 'FeatureCollection', features: [] }

const json = (body, { status = 200, note } = {}) =>
	Response.json(body, {
		status,
		headers: {
			'Cache-Control': `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=3600`,
			...(note ? { 'X-Track-Status': note } : {}),
		},
	})

export async function GET(request, { params }) {
	const config = YEARS[params.year]
	if (!config) return json(empty, { status: 404, note: 'unknown-year' })

	const password = process.env.GARMIN_MAPSHARE_PASSWORD
	if (!password) {
		// Not configured yet: serve an empty track so the map still renders.
		return json(empty, { note: 'no-credentials' })
	}

	const cutoff = Date.now() - DELAY_HOURS * 3600 * 1000

	// Bound the feed window: d1 = season start, d2 = cutoff so Garmin doesn't
	// even send fixes newer than the delay allows. Converter re-filters as a
	// safety net (belt and suspenders on the location delay).
	const query = new URLSearchParams()
	if (config.start) query.set('d1', config.start)
	if (DELAY_HOURS > 0) query.set('d2', new Date(cutoff).toISOString())
	const qs = query.toString()
	const url = `https://share.garmin.com/Feed/Share/${config.user}${qs ? `?${qs}` : ''}`

	try {
		const res = await fetch(url, {
			headers: {
				// Garmin MapShare uses HTTP Basic auth with a blank username.
				Authorization: 'Basic ' + Buffer.from(`:${password}`).toString('base64'),
			},
			next: { revalidate: REVALIDATE_SECONDS },
		})

		if (!res.ok) {
			console.error(`Garmin feed ${config.user} returned ${res.status}`)
			return json(empty, { note: `upstream-${res.status}` })
		}

		const kml = await res.text()
		const geojson = garminKmlToGeoJSON(kml, {
			properties: { year: Number(params.year) },
			notAfter: DELAY_HOURS > 0 ? cutoff : null,
		})
		return json(geojson, { note: `ok-${geojson.features.length}` })
	} catch (err) {
		console.error('Garmin feed fetch failed', err)
		return json(empty, { note: 'fetch-failed' })
	}
}
