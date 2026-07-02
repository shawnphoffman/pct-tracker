import { garminKmlToGeoJSON } from '@/lib/garmin'
import { computePctProgress } from '@/lib/pct-progress'
import historyCoverage from '@/data/pct-history-coverage.json'
import gapsData from '@/data/pct-gaps.json'

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

// PCT progress: snap the track onto this mile-marker tileset via Tilequery.
const MILE_MARKER_TILESET = process.env.PCT_MILE_MARKER_TILESET || 'shawnhoffman.32639qah'
const SNAP_RADIUS_M = numEnv('PCT_SNAP_RADIUS_M', 500) // max off-trail distance to count a fix
const BRIDGE_MAX_MILES = numEnv('PCT_BRIDGE_MAX_MILES', 30) // consecutive fixes farther apart = a jump, not walked
const TOTAL_MILES = numEnv('PCT_TOTAL_MILES', 2662)

// Pre-snapped covered intervals for the static (pre-2026) years, unioned with
// the live track for lifetime progress. Drop the JSON's `_comment` key.
const HISTORY = Object.fromEntries(Object.entries(historyCoverage).filter(([k]) => /^\d{4}$/.test(k)))
// Hitched/jumped sections; only those marked "complete" count as covered.
const GAPS = gapsData.gaps || []

const empty = { type: 'FeatureCollection', features: [] }

// Empty track but still surface lifetime progress from the prior years (this
// does no network when there's no live track). Used when the feed is
// unavailable so the progress panel keeps working.
const emptyWithHistory = async () => {
	const progress = await computePctProgress([], { total: TOTAL_MILES, history: HISTORY, gaps: GAPS }).catch(() => null)
	return progress ? { ...empty, progress } : empty
}

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
		return json(await emptyWithHistory(), { note: 'no-credentials' })
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
			return json(await emptyWithHistory(), { note: `upstream-${res.status}` })
		}

		const kml = await res.text()
		const geojson = garminKmlToGeoJSON(kml, {
			properties: { year: Number(params.year) },
			notAfter: DELAY_HOURS > 0 ? cutoff : null,
		})

		// Lifetime PCT progress: union the live 2026 track (snapped here) with the
		// pre-snapped prior years, deduped. Computed even when the live track is
		// empty (prior years still count). Failures must never break the response.
		const track = geojson.features.find(f => f.properties?.role === 'track')
		let progress = null
		try {
			progress = await computePctProgress(track?.geometry.coordinates ?? [], {
				token: process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
				tileset: MILE_MARKER_TILESET,
				radius: SNAP_RADIUS_M,
				bridgeMaxMiles: BRIDGE_MAX_MILES,
				total: TOTAL_MILES,
				history: HISTORY,
				gaps: GAPS,
			})
		} catch (err) {
			console.error('PCT progress computation failed', err)
		}

		const body = progress ? { ...geojson, progress } : geojson
		return json(body, { note: `ok-${geojson.features.length}${progress ? `-p${progress.coveredPercent}` : ''}` })
	} catch (err) {
		console.error('Garmin feed fetch failed', err)
		return json(await emptyWithHistory(), { note: 'fetch-failed' })
	}
}
