import { timingSafeEqual } from 'node:crypto'

import { garminKmlToGeoJSON, parseGarminFixes } from '@/lib/garmin'
import { computePctProgress, summarizeDailySnappedMiles } from '@/lib/pct-progress'
import historyCoverage from '@/data/pct-history-coverage.json'
import exportCoverage from '@/data/pct-export-coverage.json'
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

// LIVE PREVIEW: `?live=<secret>` bypasses the safety delay so trusted viewers
// can see the real-time track on the deployed site. The secret lives only in
// env (set GARMIN_LIVE_SECRET in Vercel); unset disables the bypass entirely.
// A wrong or missing key silently gets the normal delayed feed, so the
// endpoint never confirms whether a guess was close. A valid key additionally
// unlocks per-fix timestamps (hoverable points) and a daily-mileage summary
// (includeTimes below) - trusted viewers only; the public/delayed feed stays
// geometry-only. Rotate by changing the env var; the secret rides in a URL, so
// treat it as semi-durable (browser history, access logs).
const isLiveKey = key => {
	const secret = process.env.GARMIN_LIVE_SECRET
	if (!secret || !key) return false
	const a = Buffer.from(String(key))
	const b = Buffer.from(secret)
	return a.length === b.length && timingSafeEqual(a, b)
}

// How long a cached response is served before refetching Garmin. Slow in prod
// (data only ages into view), fast locally.
const REVALIDATE_SECONDS = numEnv('GARMIN_REVALIDATE_SECONDS', isProd ? 12 * 3600 : 300)

// PCT progress: snap the track onto this mile-marker tileset via Tilequery.
const MILE_MARKER_TILESET = process.env.PCT_MILE_MARKER_TILESET || 'shawnhoffman.32639qah'
const SNAP_RADIUS_M = numEnv('PCT_SNAP_RADIUS_M', 500) // max off-trail distance to count a fix
const BRIDGE_MAX_MILES = numEnv('PCT_BRIDGE_MAX_MILES', 5) // consecutive fixes farther apart = a jump, not walked
// Consecutive fixes farther apart than this break the drawn line (a hitch/flip,
// e.g. off-trail at Ebbetts and back on at Carson, isn't a walked straight line).
const MAX_GAP_KM = numEnv('PCT_MAX_GAP_KM', 5)
const TOTAL_MILES = numEnv('PCT_TOTAL_MILES', 2662)

// Pre-snapped covered intervals for the static (pre-2026) years, unioned with
// the live track for lifetime progress. Drop the JSON's `_comment` key.
// Union the tileset-derived years (2018/2019/2023) with the export buckets
// (2026/trail-crew/misc) so coverage counts all of Madison's PCT miles. 2026 is
// also added live via the feed (liveCoords); the union with its snapshot is
// idempotent. Drop the `_comment` keys; computePctProgress unions the rest.
const HISTORY = Object.fromEntries(
	[...Object.entries(historyCoverage), ...Object.entries(exportCoverage)].filter(([k]) => !k.startsWith('_'))
)
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

const json = (body, { status = 200, note, live = false } = {}) =>
	Response.json(body, {
		status,
		headers: {
			// Live (secret-keyed) responses are never shared-cached: the point is
			// fresh data, and no copy keyed by the secret URL should sit in a CDN.
			'Cache-Control': live ? 'private, no-store' : `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=3600`,
			...(note ? { 'X-Track-Status': note } : {}),
		},
	})

export async function GET(request, { params }) {
	const config = YEARS[params.year]
	if (!config) return json(empty, { status: 404, note: 'unknown-year' })

	// Secret-keyed live preview: a valid key drops the safety delay to zero.
	const live = isLiveKey(new URL(request.url).searchParams.get('live'))
	const delayHours = live ? 0 : DELAY_HOURS

	const password = process.env.GARMIN_MAPSHARE_PASSWORD
	if (!password) {
		// Not configured yet: serve an empty track so the map still renders.
		return json(await emptyWithHistory(), { note: 'no-credentials', live })
	}

	const cutoff = Date.now() - delayHours * 3600 * 1000

	// Bound the feed window: d1 = season start, d2 = cutoff so Garmin doesn't
	// even send fixes newer than the delay allows. Converter re-filters as a
	// safety net (belt and suspenders on the location delay).
	const query = new URLSearchParams()
	if (config.start) query.set('d1', config.start)
	if (delayHours > 0) query.set('d2', new Date(cutoff).toISOString())
	const qs = query.toString()
	const url = `https://share.garmin.com/Feed/Share/${config.user}${qs ? `?${qs}` : ''}`

	try {
		const res = await fetch(url, {
			headers: {
				// Garmin MapShare uses HTTP Basic auth with a blank username.
				Authorization: 'Basic ' + Buffer.from(`:${password}`).toString('base64'),
			},
			// Live previews always refetch Garmin; the public feed can lean on the
			// data cache since its data only ages into view.
			...(live ? { cache: 'no-store' } : { next: { revalidate: REVALIDATE_SECONDS } }),
		})

		if (!res.ok) {
			console.error(`Garmin feed ${config.user} returned ${res.status}`)
			return json(await emptyWithHistory(), { note: `upstream-${res.status}`, live })
		}

		const kml = await res.text()
		const geojson = garminKmlToGeoJSON(kml, {
			properties: { year: Number(params.year) },
			notAfter: delayHours > 0 ? cutoff : null,
			maxGapKm: MAX_GAP_KM,
			// LIVE ONLY: emit per-fix timestamps (hoverable points) + a daily-mileage
			// summary. Gated on the accepted secret so the public/delayed feed stays
			// geometry-only, and live responses are private/no-store (see json()).
			includeTimes: live,
		})

		// Lifetime PCT progress: union the live 2026 track (snapped here) with the
		// pre-snapped prior years, deduped. Computed even when the live track is
		// empty (prior years still count). Failures must never break the response.
		const track = geojson.features.find(f => f.properties?.role === 'track')
		// Flatten MultiLineString (jump-split) to the ordered vertex list snapping
		// wants; bridgeMaxMiles still keeps the jump from counting as walked.
		const trackCoords =
			track?.geometry.type === 'MultiLineString' ? track.geometry.coordinates.flat() : track?.geometry.coordinates ?? []
		let progress = null
		try {
			progress = await computePctProgress(trackCoords, {
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

		// LIVE ONLY: alongside the raw GPS-walked `daily` summary, add a trail
		// metric (`milesSnapped`) per day by snapping each timed fix to its PCT
		// milepost. Two views of the same days: GPS = all ground covered (incl.
		// town), snapped = trail miles made good. Gated on the accepted secret
		// (same as `daily`); failures must never break the response.
		if (live && Array.isArray(geojson.daily) && geojson.daily.length) {
			try {
				const { fixes } = parseGarminFixes(kml, { notAfter: null })
				const snapped = await summarizeDailySnappedMiles(fixes, {
					token: process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
					tileset: MILE_MARKER_TILESET,
					radius: SNAP_RADIUS_M,
					bridgeMax: BRIDGE_MAX_MILES,
				})
				const byDate = new Map(snapped.map(d => [d.date, d.miles]))
				geojson.daily = geojson.daily.map(d => ({ ...d, milesSnapped: byDate.get(d.date) ?? 0 }))
			} catch (err) {
				console.error('snapped daily mileage failed', err)
			}
		}

		// `live: true` tells the map the key was accepted (it renders a badge);
		// a rejected key just yields the delayed body with no marker.
		const body = { ...geojson, ...(progress ? { progress } : {}), ...(live ? { live: true } : {}) }
		return json(body, { note: `ok-${geojson.features.length}${progress ? `-p${progress.coveredPercent}` : ''}`, live })
	} catch (err) {
		console.error('Garmin feed fetch failed', err)
		return json(await emptyWithHistory(), { note: 'fetch-failed', live })
	}
}
