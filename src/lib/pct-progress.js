// Compute how much of the PCT Madison has covered across ALL her hikes,
// deduped, by expressing every year's track as covered mile-intervals and
// taking their union.
//
// Why intervals: projecting each track point onto the nearest official mile
// marker (via the mile-marker tileset shawnhoffman.32639qah) turns a hike into
// ranges of trail miles. Off-trail wander (parking lots, town stops, GPS
// jitter) snaps back to the trail and adds nothing. A mile hiked in several
// years lands in the same interval, so the union counts it once.
//
// The live 2026 track is snapped at request time via Mapbox Tilequery; the
// static prior years (2018/2019/2023) are pre-snapped and baked into
// src/data/pct-history-coverage.json (see scripts note in that data's origin).
//
// 2026 is flip-flop aware: fixes are time-ordered, so we bridge the miles
// between two consecutive fixes only when they're within bridgeMaxMiles (a
// walkable gap); a larger gap reads as a shuttle/flip and isn't counted.

import { haversineKm, dayKey } from './garmin'

// PCT region spans (cumulative miles), derived from the mile-marker tileset and
// split at the half-mile gaps between regions so the lengths total 2662.
export const PCT_REGIONS = [
	{ name: 'SoCal', from: 0, to: 651.75 },
	{ name: 'Central California', from: 651.75, to: 1157.25 },
	{ name: 'NorCal', from: 1157.25, to: 1718.75 },
	{ name: 'Oregon', from: 1718.75, to: 2148.25 },
	{ name: 'Washington', from: 2148.25, to: 2662 },
]

const round1 = n => Math.round(n * 10) / 10

// Run `fn` over items with bounded concurrency, preserving index order.
const mapPool = async (items, limit, fn) => {
	const out = new Array(items.length)
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			const i = next++
			out[i] = await fn(items[i], i)
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return out
}

// Nearest mile marker to a coord via Tilequery, or null if none within radius.
const snapMile = async ([lon, lat], { token, tileset, radius }) => {
	const url = `https://api.mapbox.com/v4/${tileset}/tilequery/${lon},${lat}.json?radius=${radius}&limit=1&dedupe=true&access_token=${token}`
	try {
		const res = await fetch(url, { cache: 'no-store' })
		if (!res.ok) return null
		const data = await res.json()
		const mile = data.features?.[0]?.properties?.Mile
		return Number.isFinite(mile) ? mile : null
	} catch {
		return null
	}
}

// Merge any list of [from, to] intervals into sorted, non-overlapping spans.
// tolerance joins spans separated by a gap that small (a snapping seam).
export const mergeIntervals = (intervals, tolerance = 0) => {
	const sorted = intervals.filter(iv => iv && iv[1] >= iv[0]).sort((p, q) => p[0] - q[0])
	const merged = []
	for (const iv of sorted) {
		const last = merged[merged.length - 1]
		if (last && iv[0] <= last[1] + tolerance) last[1] = Math.max(last[1], iv[1])
		else merged.push([iv[0], iv[1]])
	}
	return merged
}

// Remove `holes` from sorted, non-overlapping `intervals`, returning the
// difference (also sorted, non-overlapping). Used to carve the not-yet-complete
// gaps back out of coverage so nothing can count a hitched section as walked.
export const subtractIntervals = (intervals, holes) => {
	let out = intervals
	for (const [hs, he] of mergeIntervals(holes)) {
		const next = []
		for (const [s, e] of out) {
			if (he <= s || hs >= e) next.push([s, e]) // no overlap: keep as-is
			else {
				if (hs > s) next.push([s, hs]) // remainder left of the hole
				if (he < e) next.push([he, e]) // remainder right of the hole
			}
		}
		out = next
	}
	return out
}

// Ordered snapped miles -> walked intervals, bridging only walkable gaps.
const bridgeIntervals = (miles, bridgeMax) => {
	const seq = miles.filter(m => m != null)
	const intervals = []
	for (let i = 1; i < seq.length; i++) {
		const a = seq[i - 1]
		const b = seq[i]
		if (Math.abs(b - a) <= bridgeMax) intervals.push([Math.min(a, b), Math.max(a, b)])
	}
	return mergeIntervals(intervals)
}

// Decimate timed fixes to ~minSpacingKm apart to bound Tilequery volume while
// keeping switchback resolution: keep the first timed fix, then any fix at least
// that far from the last kept. Untimed fixes can't be day-bucketed, so drop them.
const thinTimed = (fixes, minSpacingKm) => {
	const out = []
	for (const f of fixes) {
		if (!Number.isFinite(f?.time)) continue
		const prev = out[out.length - 1]
		if (!prev || haversineKm(prev.coord, f.coord) >= minSpacingKm) out.push(f)
	}
	return out
}

/**
 * Per-Pacific-day TRAIL miles from timed fixes: snap each fix to its official PCT
 * milepost, then per day take the covered trail EXTENT - the union of walkable-gap
 * intervals, the same interval method the lifetime progress uses. Off-trail fixes
 * have no milepost and a jump wider than bridgeMax reads as a mis-snap/shuttle, so
 * both drop out - which means a town/off-trail day reads ~0. That's the
 * trail-progress metric, meant to sit beside the raw GPS-walked summary
 * (summarizeDailyMiles) for comparison, not to replace it.
 *
 * NB: this is coverage, not summed |Δmile|. Summing raw deltas double-counts
 * snapping noise where the trail switchbacks or runs parallel to itself (a fix
 * mis-snaps to a nearby-but-mile-distant marker and back), inflating a day
 * several-fold. Union is immune: oscillation inside the band adds nothing. The
 * tradeoff is that a genuine on-trail out-and-back counts once, not twice - the
 * GPS column still reflects the true there-and-back distance.
 *
 * Returns [] when there's no token or too few fixes. PRIVACY: reveals WHEN Madison
 * moved - callers must gate this on the secret-keyed live path only (see
 * src/app/api/track/[year]/route.js).
 * @returns {Promise<Array<{ date: string, miles: number }>>} ascending by date
 */
export async function summarizeDailySnappedMiles(
	fixes,
	{ token, tileset, radius, bridgeMax = 30, timeZone = 'America/Los_Angeles', minSpacingKm = 0.15, seamMiles = 1 } = {}
) {
	if (!token || !Array.isArray(fixes)) return []
	const timed = thinTimed(fixes, minSpacingKm)
	if (timed.length < 2) return []
	const miles = await mapPool(timed, 8, f => snapMile(f.coord, { token, tileset, radius }))
	// Bucket each fix's milepost into its Pacific day, in time order.
	const byDay = new Map()
	for (let i = 0; i < timed.length; i++) {
		if (miles[i] == null) continue
		const day = dayKey(timed[i].time, timeZone)
		if (!byDay.has(day)) byDay.set(day, [])
		byDay.get(day).push(miles[i])
	}
	return [...byDay.entries()]
		.sort(([d1], [d2]) => (d1 < d2 ? -1 : d1 > d2 ? 1 : 0))
		.map(([date, ms]) => ({ date, miles: round1(totalLength(mergeIntervals(bridgeIntervals(ms, bridgeMax), seamMiles))) }))
}

const totalLength = intervals => intervals.reduce((sum, [a, b]) => sum + (b - a), 0)

const overlapLen = ([s, e], from, to) => {
	const a = Math.max(s, from)
	const b = Math.min(e, to)
	return b > a ? b - a : 0
}

const regionBreakdown = intervals =>
	PCT_REGIONS.map(r => {
		const length = r.to - r.from
		const covered = intervals.reduce((sum, iv) => sum + overlapLen(iv, r.from, r.to), 0)
		return {
			name: r.name,
			from: r.from,
			to: r.to,
			length: round1(length),
			covered: round1(covered),
			percent: round1((covered / length) * 100),
		}
	})

/**
 * @param {Array<[number, number]>} liveCoords ordered [lon, lat] 2026 vertices (oldest -> latest), or [] if none.
 * @param {{
 *   token: string, tileset: string, radius: number, bridgeMaxMiles: number, total: number,
 *   history?: Record<string, Array<[number, number]>>,
 *   gaps?: Array<{ from: number, to: number, status: string }>, seamMiles?: number,
 * }} opts history maps prior year -> pre-snapped covered intervals; gaps are the
 *   manually-adjudicated hitched/jumped sections (only status "complete" counts).
 * @returns {Promise<object|null>} combined progress, or null if there's nothing to report.
 */
export async function computePctProgress(liveCoords, { token, tileset, radius, bridgeMaxMiles, total, history = {}, gaps = [], seamMiles = 1 }) {
	// Snap the live 2026 track (if any) to its walked intervals.
	let liveIntervals = []
	let currentMile = null
	let furthestMile = null
	if (token && Array.isArray(liveCoords) && liveCoords.length) {
		const miles = await mapPool(liveCoords, 8, c => snapMile(c, { token, tileset, radius }))
		const snapped = miles.filter(m => m != null)
		if (snapped.length) {
			liveIntervals = bridgeIntervals(miles, bridgeMaxMiles)
			currentMile = round1([...miles].reverse().find(m => m != null))
			furthestMile = round1(Math.max(...snapped))
		}
	}

	// Per-year covered miles (each year on its own; overlaps allowed here).
	const byYear = {}
	for (const [year, intervals] of Object.entries(history)) {
		byYear[year] = round1(totalLength(mergeIntervals(intervals)))
	}
	if (liveIntervals.length) byYear['2026'] = round1(totalLength(liveIntervals))

	// Gaps she hitched/jumped only count once manually marked "complete".
	const completeIntervals = gaps.filter(g => g.status === 'complete').map(g => [g.from, g.to])
	const pending = gaps.filter(g => g.status !== 'complete')

	// Union everything -> deduped lifetime coverage.
	const unioned = mergeIntervals([...Object.values(history).flat(), ...liveIntervals, ...completeIntervals], seamMiles)
	if (!unioned.length) return null

	// Carve the not-yet-complete gaps back OUT: pct-gaps.json is the authoritative
	// "not walked" record, so a bridged live fix or snapping noise can't count a
	// hitched section as covered. Keeps the panel consistent with the incomplete layer.
	const all = subtractIntervals(unioned, pending.map(g => [g.from, g.to]))

	// Pending = not-yet-complete gap miles that nothing else covers (the to-do list).
	const pendingMiles = pending.reduce((sum, g) => {
		const covered = all.reduce((o, iv) => o + overlapLen(iv, g.from, g.to), 0)
		return sum + Math.max(0, g.to - g.from - covered)
	}, 0)

	const coveredMiles = totalLength(all)
	return {
		total,
		coveredMiles: round1(coveredMiles),
		coveredPercent: round1((coveredMiles / total) * 100),
		currentMile,
		furthestMile,
		byYear,
		regions: regionBreakdown(all),
		pendingMiles: round1(pendingMiles),
		pendingGaps: pending.length,
		bridgeMaxMiles,
	}
}
