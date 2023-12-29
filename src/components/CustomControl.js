class CustomControl {
	constructor({ container }) {
		this._container = container
	}
	onAdd(map) {
		this._map = map
		this._container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group'
		return this._container
	}
	onRemove() {
		this._container.parentNode.removeChild(this._container)
		this._map = undefined
	}
}

export default CustomControl
