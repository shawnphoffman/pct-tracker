// // Show popup on mouseover
// map.current.on('mouseover', Object.values(Layers), function (e) {
// const layerId = e.features[0].layer.id
// const yearName = layerIdToYear(layerId)
// if (!yearName) return
// popup.current
// .setLngLat(e.lngLat)
// .setHTML(`<h1 style="color: var(--color-${yearName.toString().slice(-2)})">${yearName}</h1>`)
// .addTo(map.current)
// map.current.setPaintProperty(layerId, 'line-width', 5)
// })

// // Add a mouseleave event to the layer and fix the line width
// Object.values(Layers).forEach(layer => {
// map.current.on('mouseleave', layer, function (e) {
// const yearName = layerIdToYear(layer)
// if (!yearName) return
// setTimeout(() => {
// map.current.setPaintProperty(layer, 'line-width', 3)
// // popup.current.remove()
// }, 1000)
// })
// })

// map.current.on('mouseover', Object.values(Layers), function (e) {
// const c = e.features[0].layer.paint['line-color']
// const str = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`
// console.log('LINE HOVER', { c, str })
// })

// map.current.on('move', () => {
// setLng(map.current.getCenter().lng.toFixed(4));
// setLat(map.current.getCenter().lat.toFixed(4));
// setZoom(map.current.getZoom().toFixed(2));
// });
