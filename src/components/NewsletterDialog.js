import { memo } from 'react'

import newsletters2023 from '@/data/PCT - Madison - 2023 - Newsletter Points.json'
import newsletters2026 from '@/data/PCT - Madison - 2026 - Newsletter Points.json'

// Reverse-chronological: newest year on top, and newest-first within each year
// (the files are stored oldest-first by mile, so reverse each).
const newsletters = [...[...newsletters2026.features].reverse(), ...[...newsletters2023.features].reverse()]

const NewsletterDialog = ({ open, onClose }) => {
	if (!open) return null
	return (
		<div className="menu-ui" role="dialog" aria-label="Newsletters">
			<header className="menu-ui-header">
				<h2>Newsletters</h2>
				<button className="menu-ui-close" onClick={onClose} aria-label="Close newsletters">
					&times;
				</button>
			</header>
			<div className="menu-ui-list">
				{newsletters.map((letter, i) => (
					<a className="menu-ui-item" href={letter.properties.Link} target="_blank" rel="noreferrer" key={`${letter.properties.Date}-${letter.properties.Mile}-${i}`}>
						<span className="menu-ui-date">{(letter.properties.Date ?? '').slice(0, -3)}</span>
						<span className="menu-ui-title">{letter.properties.Title ?? `Mile ${letter.properties.Mile}`}</span>
						<svg xmlns="http://www.w3.org/2000/svg" height="1em" viewBox="0 0 512 512">
							<path d="M320 0c-17.7 0-32 14.3-32 32s14.3 32 32 32h82.7L201.4 265.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L448 109.3V192c0 17.7 14.3 32 32 32s32-14.3 32-32V32c0-17.7-14.3-32-32-32H320zM80 32C35.8 32 0 67.8 0 112V432c0 44.2 35.8 80 80 80H400c44.2 0 80-35.8 80-80V320c0-17.7-14.3-32-32-32s-32 14.3-32 32V432c0 8.8-7.2 16-16 16H80c-8.8 0-16-7.2-16-16V112c0-8.8 7.2-16 16-16H192c17.7 0 32-14.3 32-32s-14.3-32-32-32H80z" />
						</svg>
					</a>
				))}
			</div>
		</div>
	)
}

export default memo(NewsletterDialog)
