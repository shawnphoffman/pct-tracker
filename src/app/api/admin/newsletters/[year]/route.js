import { promises as fs } from 'fs'
import path from 'path'

import { NextResponse } from 'next/server'

// Local-authoring endpoint for the per-year newsletter points. This writes back
// to the source-of-truth GeoJSON on disk, so it is intentionally gated to
// `next dev` and CANNOT run on Vercel (read-only serverless FS + the guard
// below). Never relax this guard: it is what keeps the editor local-only.
const isDev = process.env.NODE_ENV === 'development'

// Allowlisted year -> data file. Add a line here to enable editing a new year.
const FILES = {
	'2023': 'PCT - Madison - 2023 - Newsletter Points.json',
	'2026': 'PCT - Madison - 2026 - Newsletter Points.json',
}

function fileFor(year) {
	const name = FILES[year]
	return name ? path.join(process.cwd(), 'src', 'data', name) : null
}

export async function GET(request, { params }) {
	if (!isDev) return NextResponse.json({ error: 'Editor is available in local dev only.' }, { status: 404 })
	const file = fileFor(params.year)
	if (!file) return NextResponse.json({ error: `Unknown year: ${params.year}` }, { status: 404 })
	const raw = await fs.readFile(file, 'utf8')
	return new NextResponse(raw, { headers: { 'content-type': 'application/json' } })
}

export async function PUT(request, { params }) {
	if (!isDev) return NextResponse.json({ error: 'Editor is available in local dev only.' }, { status: 403 })
	const file = fileFor(params.year)
	if (!file) return NextResponse.json({ error: `Unknown year: ${params.year}` }, { status: 404 })

	let body
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 })
	}

	// Validate the shape before overwriting the file so a bad payload can't
	// corrupt the data the public map depends on.
	if (!body || body.type !== 'FeatureCollection' || !Array.isArray(body.features)) {
		return NextResponse.json({ error: 'Expected a GeoJSON FeatureCollection.' }, { status: 400 })
	}
	for (const [i, f] of body.features.entries()) {
		const c = f?.geometry?.coordinates
		if (f?.type !== 'Feature' || f?.geometry?.type !== 'Point' || !Array.isArray(c) || c.length !== 2 || !c.every(n => typeof n === 'number' && Number.isFinite(n))) {
			return NextResponse.json({ error: `Feature ${i} is not a valid Point.` }, { status: 400 })
		}
	}

	// Match the existing files' tab indentation + trailing newline to keep diffs clean.
	const json = JSON.stringify(body, null, '\t') + '\n'
	await fs.writeFile(file, json, 'utf8')
	return NextResponse.json({ ok: true, count: body.features.length })
}
