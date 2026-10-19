import Link from 'next/link'

const LINKS = [
  ['/rules/', 'Rules'],
  ['/matches/', 'Matches'],
  ['/deliveries/', 'Deliveries'],
  ['/relayer/', 'Relayer'],
  ['/health/', 'Health'],
] as const

export function Nav() {
  return (
    <nav aria-label="Dashboard" className="nav">
      <Link href="/">Blockwarden</Link>
      {LINKS.map(([href, label]) => (
        <Link key={href} href={href}>
          {label}
        </Link>
      ))}
    </nav>
  )
}
