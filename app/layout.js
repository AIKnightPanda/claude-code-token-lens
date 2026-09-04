export const metadata = {
  title: 'ccusage Dashboard',
  description: 'AI coding agent token usage & costs',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
