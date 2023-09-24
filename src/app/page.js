'use client'
import { useRef, useEffect, useState, useCallback } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN

const Layers = {
	Madi2023: 'PCT - 2023',
	Madi2019: 'PCT - 2019',
	Madi2018: 'PCT - 2018',
}

const Home = () => {
	const mapContainer = useRef(null)
	const map = useRef(null)
	const [lng, setLng] = useState(-121.577)
	const [lat, setLat] = useState(41.369)
	const [zoom, setZoom] = useState(4.75)

	const toggleLayer = useCallback(
		layerName => {
			if (!map.current) {
				console.log('NO MAP')
				return
			}

			const visibility = map.current.getLayoutProperty(layerName, 'visibility')

			// console.log('Toggling layer', {
			// 	layerName,
			// 	currentVisibility: visibility,
			// 	newVisibility: visibility === 'none' ? 'visible' : 'none',
			// })

			// Toggle layer visibility by changing the layout object's visibility property.
			map.current.setLayoutProperty(layerName, 'visibility', visibility === 'none' ? 'visible' : 'none')
		},
		[map]
	)

	useEffect(() => {
		if (map.current) return // initialize map only once
		map.current = new mapboxgl.Map({
			container: mapContainer.current,
			style: process.env.NEXT_PUBLIC_MAPBOX_STYLE,
			center: [lng, lat],
			zoom: zoom,
		})

		map.current.on('load', () => {
			console.log('Map loaded')
			const popup = new mapboxgl.Popup()
			map.current.on('click', 'PCT - 2023', function (e) {
				new mapboxgl.Popup().setLngLat(e.lngLat).setHTML('<h2>Madison wee wee woo woo</h2>').addTo(map.current)
			})
			map.current.on('mouseover', 'PCT - 2023', function (e) {
				popup.setLngLat(e.lngLat).setHTML('<h2>HOVER BOI!!!</h2>').addTo(map.current)
			})
			map.current.on('mouseleave', 'PCT - 2023', function (e) {
				setTimeout(() => {
					popup.remove()
				}, 500)
			})
		})

		// // NOTE DEBUG-ONLY
		// window.map = map.current
	}, [lat, lng, zoom])

	return (
		<div>
			<nav>
				<button onClick={() => toggleLayer('PCT - 2023')}>2023</button>
				<button onClick={() => toggleLayer('PCT - 2019')}>2019</button>
				<button onClick={() => toggleLayer('PCT - 2018')}>2018</button>
			</nav>
			<div ref={mapContainer} className="map-container" />
		</div>
	)
}

export default Home
