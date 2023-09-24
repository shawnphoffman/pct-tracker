'use client'
import { useRef, useEffect, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

import EyeToggle from '@/components/EyeToggle'
import ColorCircle from '@/components/ColorCircle'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN

const defaults = {
	lng: -121.577,
	lat: 41.369,
	zoom: 4.1,
	bounds: {
		north: 49.94686973387624,
		south: 30.997918064591815,
		east: -92.56810177337066,
		west: -146.44220630628152,
	},
}

class CustomControl {
	constructor({ container }) {
		this._container = container
	}
	onAdd(map) {
		const container = this._container
		// console.log('onAdd', { map, container })
		this._map = map
		this._container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group'
		return this._container
	}
	onRemove() {
		this._container.parentNode.removeChild(this._container)
		this._map = undefined
	}
}

const Layers = {
	Madi2023: 'PCT - 2023',
	Madi2019: 'PCT - 2019',
	Madi2018: 'PCT - 2018',
}

/*

=== HIGH PRIORITY ===

=== LOW PRIORITY ===
- Source with newsletter locations
- Interesting places with zoom (sonora with pitch, cool photos, etc)
*/

const layerIdToYear = id => {
	switch (id) {
		case Layers.Madi2023:
			return 2023
		case Layers.Madi2019:
			return 2019
		case Layers.Madi2018:
			return 2018
		default:
			return null
	}
}

const Home = () => {
	const mapContainer = useRef(null)
	const map = useRef(null)
	const popup = useRef(null)
	// TODO - You don't need this state
	const [lng] = useState(defaults.lng)
	const [lat] = useState(defaults.lat)
	const [zoom] = useState(defaults.zoom)
	//
	const [show23, setShow23] = useState(true)
	const [show19, setShow19] = useState(true)
	const [show18, setShow18] = useState(true)

	const toggleLayer = useCallback(
		(layerName, stateCallback) => {
			if (!map.current) {
				return
			}
			const visibility = map.current.getLayoutProperty(layerName, 'visibility')
			// Toggle layer visibility by changing the layout object's visibility property.
			map.current.setLayoutProperty(layerName, 'visibility', visibility === 'none' ? 'visible' : 'none')
			stateCallback && stateCallback(visibility === 'none')
		},
		[map]
	)

	const reset = useCallback(() => {
		popup.current?.remove()
		map.current.easeTo(
			{
				center: [defaults.lng, defaults.lat],
				zoom: defaults.zoom,
				pitch: 0,
				bearing: 0,
			},
			{
				duration: 2000,
			}
		)
	}, [])

	useEffect(() => {
		if (map.current) return // initialize map only once

		// Zoom and pitch controls
		const controlNav = new mapboxgl.NavigationControl({
			visualizePitch: true,
		})

		// Scale control
		const controlScale = new mapboxgl.ScaleControl({
			maxWidth: 80,
			unit: 'imperial',
		})

		// Fullscreen control
		const controlFullscreen = new mapboxgl.FullscreenControl()

		// Attribution control
		const controlAttribution = new mapboxgl.AttributionControl({
			customAttribution: 'Map by Shawn',
		})

		// Year controls
		const control23 = new CustomControl({
			container: document.getElementById('toggle-23'),
		})
		const control19 = new CustomControl({
			container: document.getElementById('toggle-19'),
		})
		const control18 = new CustomControl({
			container: document.getElementById('toggle-18'),
		})
		const buttonReset = new CustomControl({
			container: document.getElementById('button-reset'),
		})

		// Initialize map
		map.current = new mapboxgl.Map({
			container: mapContainer.current,
			style: process.env.NEXT_PUBLIC_MAPBOX_STYLE,
			center: [lng, lat],
			zoom: zoom,
			attributionControl: false,
			minZoom: defaults.zoom - 0.5,
			// maxBounds: [defaults.bounds.west, defaults.bounds.south, defaults.bounds.east, defaults.bounds.north],
			// touchZoomRotate: true,
		})
			.addControl(controlNav)
			.addControl(controlScale)
			.addControl(controlFullscreen)
			.addControl(controlAttribution)
			.addControl(control23, 'top-left')
			.addControl(control19, 'top-left')
			.addControl(control18, 'top-left')
			.addControl(buttonReset, 'top-right')

		// Wait for the map to laod
		map.current.on('load', () => {
			console.log('Map loaded', { map, zoom, lng, lat })

			// Create a basic popup
			const pp = new mapboxgl.Popup({
				closeButton: false,
				closeOnClick: false,
				anchor: 'left',
				className: 'popup',
				offset: 10,
			})
			popup.current = pp

			// Show popup on mouseover
			map.current.on('mouseover', Object.values(Layers), function (e) {
				const layerId = e.features[0].layer.id
				const yearName = layerIdToYear(layerId)
				if (!yearName) return
				popup.current
					.setLngLat(e.lngLat)
					.setHTML(`<h1 style="color: var(--color-${yearName.toString().slice(-2)})">${yearName}</h1>`)
					.addTo(map.current)
				map.current.setPaintProperty(layerId, 'line-width', 5)
			})

			// Add a mouseleave event to the layer and fix the line width
			Object.values(Layers).forEach(layer => {
				map.current.on('mouseleave', layer, function (e) {
					const yearName = layerIdToYear(layer)
					if (!yearName) return
					setTimeout(() => {
						map.current.setPaintProperty(layer, 'line-width', 3)
						// popup.current.remove()
					}, 1000)
				})
			})

			// NOTE Show layers one by one
			map.current.getStyle().layers.forEach((layer, i) => {
				if (layer.id.includes('PCT -')) {
					console.log('layer', { layer, i: i - 69 })
					// setTimeout(() => {
					map.current.setLayoutProperty(layer.id, 'visibility', 'visible')
					// }, (i - 69) * 1 * 500)

					const color = layer.paint['line-color']
					const yearKey = layer.id.slice(-2)
					document.documentElement.style.setProperty(`--color-${yearKey}`, color)
				}
			})

			// DEBUG STUFF
			map.current.on('click', function (e) {
				console.log('click', { e })
			})
			map.current.on('mouseover', Object.values(Layers), function (e) {
				const c = e.features[0].layer.paint['line-color']
				const str = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`
				console.log('LINE CLICK', { c, str })
			})

			// map.current.on('move', () => {
			// 	setLng(map.current.getCenter().lng.toFixed(4));
			// 	setLat(map.current.getCenter().lat.toFixed(4));
			// 	setZoom(map.current.getZoom().toFixed(2));
			// 	});
		})
	}, [lat, lng, zoom])

	useEffect(() => {
		popup.current?.remove()
	}, [show18, show19, show23])

	return (
		<div>
			<div className="controls">
				<div id="toggle-23">
					<button className={`mapboxgl-ctrl-year year-visible-${show23} year-23`} onClick={() => toggleLayer(Layers.Madi2023, setShow23)}>
						<EyeToggle visible={show23} />
						<>2023</>
						<ColorCircle />
					</button>
				</div>
				<div id="toggle-19">
					<button className={`mapboxgl-ctrl-year year-visible-${show19} year-19`} onClick={() => toggleLayer(Layers.Madi2019, setShow19)}>
						<EyeToggle visible={show19} />
						<>2019</>
						<ColorCircle />
					</button>
				</div>
				<div id="toggle-18">
					<button className={`mapboxgl-ctrl-year year-visible-${show18} year-18`} onClick={() => toggleLayer(Layers.Madi2018, setShow18)}>
						<EyeToggle visible={show18} />
						<>2018</>

						<ColorCircle />
					</button>
				</div>
				<div id="button-reset">
					<button className="" onClick={() => reset()}>
						<span className="mapboxgl-ctrl-icon madi-icon">
							<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 512 512">
								<path d="M48.5 224H40c-13.3 0-24-10.7-24-24V72c0-9.7 5.8-18.5 14.8-22.2s19.3-1.7 26.2 5.2L98.6 96.6c87.6-86.5 228.7-86.2 315.8 1c87.5 87.5 87.5 229.3 0 316.8s-229.3 87.5-316.8 0c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0c62.5 62.5 163.8 62.5 226.3 0s62.5-163.8 0-226.3c-62.2-62.2-162.7-62.5-225.3-1L185 183c6.9 6.9 8.9 17.2 5.2 26.2s-12.5 14.8-22.2 14.8H48.5z" />
							</svg>
						</span>
					</button>
				</div>
			</div>
			<div ref={mapContainer} className="map-container" />
		</div>
	)
}

export default Home
