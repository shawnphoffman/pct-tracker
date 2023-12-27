import './globals.css'

export const metadata = {
	title: 'PCT Tracker',
	description: '',
}

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	)
}
