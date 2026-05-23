import type { ReactElement, ReactNode } from "react"

export type NavItem = {
  readonly route: string
  readonly label: string
}

export type AppShellProps = {
  readonly navItems: readonly NavItem[]
  readonly activeRoute: string
  readonly onNavigate: (route: string) => void
  readonly children: ReactNode
}

export const AppShell = ({ navItems, activeRoute, onNavigate, children }: AppShellProps): ReactElement => (
  <div>
    <nav aria-label="Primary">
      <ul>
        {navItems.map((item) => (
          <li key={item.route}>
            <a
              href={`#${item.route}`}
              aria-current={item.route === activeRoute ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault()
                onNavigate(item.route)
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
    <main>{children}</main>
  </div>
)
