import newsletters from '@/data/PCT - Madison - 2023 - Newsletter Points.json'

const newslettersSorted = newsletters.features.sort((a, b) => {
	const aDate = new Date(a.properties.Date)
	const bDate = new Date(b.properties.Date)
	return aDate - bDate
})

export default newslettersSorted
