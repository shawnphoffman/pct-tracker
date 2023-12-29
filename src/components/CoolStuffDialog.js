import { memo, useCallback } from 'react'

import coolStuff from '@/data/cool-stuff.json'

const CoolStuffDialog = ({ open, map, onClick }) => {
	const goTo = useCallback(
		data => {
			const { center, zoom, pitch, bearing } = data
			map.current.flyTo({
				center,
				zoom,
				pitch,
				bearing,
			})
			if (onClick) onClick()
		},
		[map, onClick]
	)

	if (!open) return null
	return (
		<nav className="menu-ui">
			{coolStuff.map(cool => (
				<div key={cool.label} onClick={() => goTo(cool)}>
					{cool.label}
				</div>
			))}
		</nav>
	)
}

export default memo(CoolStuffDialog)
