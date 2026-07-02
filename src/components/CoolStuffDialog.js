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
		<div className="menu-ui" role="dialog" aria-label="Cool spots">
			<header className="menu-ui-header">
				<h2>Cool Stuff</h2>
				<button className="menu-ui-close" onClick={onClick} aria-label="Close">
					&times;
				</button>
			</header>
			<div className="menu-ui-list">
				{coolStuff.map(cool => (
					<button className="menu-ui-item" key={cool.label} onClick={() => goTo(cool)}>
						<span className="menu-ui-title">{cool.label}</span>
					</button>
				))}
			</div>
		</div>
	)
}

export default memo(CoolStuffDialog)
