import type { ReactElement, ReactNode } from "react"

export type SettingsLayoutProps = {
  readonly title: string
  readonly children: ReactNode
}

export const SettingsLayout = ({ title, children }: SettingsLayoutProps): ReactElement => (
  <section>
    <header>
      <h1>{title}</h1>
    </header>
    <div>{children}</div>
  </section>
)
