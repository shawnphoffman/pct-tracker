'use client'

// Local-only newsletter authoring UI. Reads/writes the source-of-truth GeoJSON
// for the year below (src/data/PCT - Madison - <YEAR> - Newsletter Points.json)
// via /api/admin/newsletters/<year>, which only responds under `next dev`. Click
// the map to drop a point, drag a dot to move it, edit fields in the panel, then
// Save to write the file. Commit + deploy to publish. See CLAUDE.md.

import { useRef, useEffect, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN

const IS_DEV = process.env.NODE_ENV === 'development'

// The year this editor writes. The API allowlists which years are editable; bump
// this (and add the file + API entry) when a new hiking year starts. 2023 is left
// read-only on purpose.
const YEAR = '2026'
const API = `/api/admin/newsletters/${YEAR}`

const defaults = { lng: -121.577, lat: 41.369, zoom: 4.25 }

// GeoJSON <-> flat form rows.
function featureToRow(f, id) {
	const p = f.properties || {}
	const c = f.geometry?.coordinates || [0, 0]
	return {
		_id: id,
		Mile: p.Mile ?? '',
		Link: p.Link ?? '',
		Date: p.Date ?? '',
		Title: p.Title ?? '',
		lng: c[0],
		lat: c[1],
	}
}

function rowToFeature(row) {
	const properties = {
		Mile: row.Mile === '' ? 0 : Number(row.Mile),
		Link: row.Link,
		Date: row.Date,
	}
	if (row.Title && row.Title.trim()) properties.Title = row.Title.trim()
	return {
		type: 'Feature',
		properties,
		geometry: { type: 'Point', coordinates: [Number(row.lng), Number(row.lat)] },
	}
}

export default function NewsletterAdmin() {
	const mapContainer = useRef(null)
	const map = useRef(null)
	const markers = useRef(new Map()) // _id -> mapboxgl.Marker
	const idRef = useRef(0)
	const nextId = () => `f${idRef.current++}`

	const [mapReady, setMapReady] = useState(false)
	const [features, setFeatures] = useState([])
	const [selectedId, setSelectedId] = useState(null)
	const [dirty, setDirty] = useState(false)
	const [status, setStatus] = useState(IS_DEV ? 'Loading…' : '')

	const load = useCallback(() => {
		if (!IS_DEV) return
		setStatus('Loading…')
		fetch(API)
			.then(r => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
			.then(fc => {
				setFeatures((fc.features || []).map(f => featureToRow(f, nextId())))
				setSelectedId(null)
				setDirty(false)
				setStatus(`Loaded ${fc.features?.length ?? 0} newsletters.`)
			})
			.catch(() => setStatus('Could not load newsletters.'))
	}, [])

	// Init map once.
	useEffect(() => {
		if (map.current) return
		map.current = new mapboxgl.Map({
			container: mapContainer.current,
			style: process.env.NEXT_PUBLIC_MAPBOX_STYLE,
			center: [defaults.lng, defaults.lat],
			zoom: defaults.zoom,
			projection: 'mercator',
		})
		map.current.addControl(new mapboxgl.NavigationControl())
		map.current.on('load', () => {
			// Click empty map to add a point.
			map.current.on('click', e => {
				const id = nextId()
				const { lng, lat } = e.lngLat
				setFeatures(prev => [...prev, { _id: id, Mile: '', Link: '', Date: '', Title: '', lng, lat }])
				setSelectedId(id)
				setDirty(true)
			})
			setMapReady(true)
		})
	}, [])

	// Fetch data once the component mounts.
	useEffect(() => {
		load()
	}, [load])

	// Reconcile markers with the features array.
	useEffect(() => {
		if (!mapReady || !map.current) return
		const m = map.current
		const seen = new Set()
		for (const row of features) {
			seen.add(row._id)
			let marker = markers.current.get(row._id)
			if (!marker) {
				const el = document.createElement('div')
				el.style.cssText = 'border-radius:50%;border:2px solid #1a1a1a;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.5)'
				el.addEventListener('click', ev => {
					ev.stopPropagation()
					setSelectedId(row._id)
				})
				marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: 'center' }).setLngLat([row.lng, row.lat]).addTo(m)
				marker.on('dragstart', () => setSelectedId(row._id))
				marker.on('dragend', () => {
					const { lng, lat } = marker.getLngLat()
					setFeatures(prev => prev.map(r => (r._id === row._id ? { ...r, lng, lat } : r)))
					setDirty(true)
				})
				markers.current.set(row._id, marker)
			} else {
				const cur = marker.getLngLat()
				if (cur.lng !== Number(row.lng) || cur.lat !== Number(row.lat)) marker.setLngLat([Number(row.lng), Number(row.lat)])
			}
			const el = marker.getElement()
			const sel = row._id === selectedId
			el.style.background = sel ? '#dc2626' : '#eab308'
			el.style.width = sel ? '18px' : '13px'
			el.style.height = sel ? '18px' : '13px'
			el.style.zIndex = sel ? '2' : '1'
		}
		for (const [id, marker] of markers.current) {
			if (!seen.has(id)) {
				marker.remove()
				markers.current.delete(id)
			}
		}
	}, [features, selectedId, mapReady])

	// Warn before leaving with unsaved edits.
	useEffect(() => {
		const handler = e => {
			if (dirty) {
				e.preventDefault()
				e.returnValue = ''
			}
		}
		window.addEventListener('beforeunload', handler)
		return () => window.removeEventListener('beforeunload', handler)
	}, [dirty])

	const selected = features.find(r => r._id === selectedId) || null

	const updateField = (field, value) => {
		setFeatures(prev => prev.map(r => (r._id === selectedId ? { ...r, [field]: value } : r)))
		setDirty(true)
	}

	const selectFromList = row => {
		setSelectedId(row._id)
		map.current?.easeTo({ center: [Number(row.lng), Number(row.lat)], duration: 600 })
	}

	const addAtCenter = () => {
		const c = map.current.getCenter()
		const id = nextId()
		setFeatures(prev => [...prev, { _id: id, Mile: '', Link: '', Date: '', Title: '', lng: c.lng, lat: c.lat }])
		setSelectedId(id)
		setDirty(true)
	}

	const deleteSelected = () => {
		if (!selected) return
		setFeatures(prev => prev.filter(r => r._id !== selected._id))
		setSelectedId(null)
		setDirty(true)
	}

	const save = () => {
		setStatus('Saving…')
		const fc = { type: 'FeatureCollection', features: features.map(rowToFeature) }
		fetch(API, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(fc),
		})
			.then(async r => {
				const data = await r.json().catch(() => ({}))
				if (!r.ok) throw new Error(data.error || 'save failed')
				setDirty(false)
				setStatus(`Saved ${data.count} newsletters to disk. Commit + deploy to publish.`)
			})
			.catch(err => setStatus(`Save failed: ${err.message}`))
	}

	return (
		<div style={S.wrap}>
			<div ref={mapContainer} style={S.map} />
			<aside style={S.panel}>
				<h1 style={S.h1}>Newsletters · {YEAR}</h1>
				{!IS_DEV && <p style={S.warn}>This editor only works locally. Run <code>npm run dev</code> and open this page on localhost.</p>}

				<div style={S.toolbar}>
					<button style={S.btn} onClick={addAtCenter} disabled={!IS_DEV}>+ Add point</button>
					<button style={{ ...S.btn, ...S.primary, opacity: dirty ? 1 : 0.5 }} onClick={save} disabled={!IS_DEV || !dirty}>Save</button>
					<button style={S.btn} onClick={load} disabled={!IS_DEV}>Revert</button>
				</div>
				<p style={S.status}>{dirty ? '● Unsaved changes. ' : ''}{status}</p>
				<p style={S.hint}>Click the map to add a point, or drag a dot to move it.</p>

				{selected && (
					<div style={S.form}>
						<h2 style={S.h2}>Edit point</h2>
						<label style={S.label}>Mile
							<input style={S.input} type="number" value={selected.Mile} onChange={e => updateField('Mile', e.target.value)} />
						</label>
						<label style={S.label}>Date
							<input style={S.input} type="text" placeholder="M/D/YY" value={selected.Date} onChange={e => updateField('Date', e.target.value)} />
						</label>
						<label style={S.label}>Title <span style={S.opt}>(optional)</span>
							<input style={S.input} type="text" value={selected.Title} onChange={e => updateField('Title', e.target.value)} />
						</label>
						<label style={S.label}>Link
							<input style={S.input} type="url" placeholder="https://madisonsites.substack.com/p/…" value={selected.Link} onChange={e => updateField('Link', e.target.value)} />
						</label>
						<div style={S.coords}>
							<label style={S.label}>Lng
								<input style={S.input} type="number" step="any" value={selected.lng} onChange={e => updateField('lng', e.target.value)} />
							</label>
							<label style={S.label}>Lat
								<input style={S.input} type="number" step="any" value={selected.lat} onChange={e => updateField('lat', e.target.value)} />
							</label>
						</div>
						<button style={{ ...S.btn, ...S.danger }} onClick={deleteSelected}>Delete this point</button>
					</div>
				)}

				<h2 style={S.h2}>All points ({features.length})</h2>
				<ul style={S.list}>
					{features.map(row => (
						<li key={row._id}>
							<button
								style={{ ...S.listItem, ...(row._id === selectedId ? S.listItemActive : {}) }}
								onClick={() => selectFromList(row)}
							>
								<span style={S.listMile}>Mile {row.Mile === '' ? '—' : row.Mile}</span>
								<span style={S.listDate}>{row.Date || 'no date'}</span>
							</button>
						</li>
					))}
				</ul>
			</aside>
		</div>
	)
}

const S = {
	wrap: { position: 'fixed', inset: 0, display: 'flex', fontFamily: 'system-ui, sans-serif' },
	map: { flex: 1, height: '100%' },
	panel: { width: 360, height: '100%', overflowY: 'auto', padding: '16px 18px', background: '#fff', color: '#1a1a1a', boxShadow: '-2px 0 8px rgba(0,0,0,.15)', boxSizing: 'border-box' },
	h1: { margin: '0 0 12px', fontSize: 20 },
	h2: { margin: '20px 0 8px', fontSize: 14, textTransform: 'uppercase', letterSpacing: '.05em', color: '#666' },
	warn: { background: '#fef3c7', border: '1px solid #f59e0b', padding: '8px 10px', borderRadius: 6, fontSize: 13 },
	toolbar: { display: 'flex', gap: 8, marginBottom: 8 },
	btn: { padding: '6px 10px', fontSize: 13, borderRadius: 6, border: '1px solid #ccc', background: '#f5f5f5', cursor: 'pointer' },
	primary: { background: '#dc2626', color: '#fff', borderColor: '#dc2626' },
	danger: { background: '#fff', color: '#dc2626', borderColor: '#dc2626', marginTop: 8, width: '100%' },
	status: { fontSize: 12, color: '#444', minHeight: 16, margin: '4px 0' },
	hint: { fontSize: 12, color: '#888', margin: '0 0 8px' },
	form: { borderTop: '1px solid #eee', paddingTop: 12 },
	label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#555', marginBottom: 8 },
	opt: { color: '#aaa', fontWeight: 400 },
	input: { padding: '6px 8px', fontSize: 14, border: '1px solid #ccc', borderRadius: 6, color: '#1a1a1a' },
	coords: { display: 'flex', gap: 8 },
	list: { listStyle: 'none', margin: 0, padding: 0 },
	listItem: { display: 'flex', justifyContent: 'space-between', width: '100%', padding: '8px 10px', border: '1px solid #eee', borderRadius: 6, background: '#fafafa', cursor: 'pointer', marginBottom: 4, fontSize: 13, textAlign: 'left' },
	listItemActive: { borderColor: '#dc2626', background: '#fef2f2' },
	listMile: { fontWeight: 600 },
	listDate: { color: '#888' },
}
