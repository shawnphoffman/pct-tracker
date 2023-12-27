import Lightbox from 'yet-another-react-lightbox'
import 'yet-another-react-lightbox/styles.css'

import NextJsImage from '@/components/NextJsImage'

// import pct001 from '@/images/PCT_001.png'
// import pct002 from '@/images/PCT_002.png'
// import pct003 from '@/images/PCT_003.png'
// import pct004 from '@/images/PCT_004.HEIC'

const images = require.context('@/images/', true, /\.(jpg|jpeg|png)$/i)
const imageList = images.keys().map(image => images(image).default)

// const slides = [pct001, pct002, pct003]
// console.log({ imageList, slides })
console.log(imageList, images)

export default function PhotoLightbox({ isOpen, setIsOpen }) {
	return <Lightbox open={isOpen} close={() => setIsOpen(false)} slides={imageList} render={{ slide: NextJsImage }} />
}
