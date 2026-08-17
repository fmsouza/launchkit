import { describe, expect, it } from "bun:test"
import { render, screen } from "@testing-library/react"
import { ExtensionList } from "./ExtensionList"
import type { ExtensionRowData } from "./ExtensionList"

const noops = {
  onSetEnabled: (): void => {},
  onUpdate: (): void => {},
  onRemove: (): void => {},
}

// Annotated with `ExtensionRowData` (rather than `as const`-ing every literal) so
// `source.kind` narrows against the real discriminated union — a typo here should fail
// to compile, not silently fall through to a badge.
const ext: ExtensionRowData = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  enabled: true,
  source: {
    kind: "git",
    url: "https://e.com/a.git",
    ref: "HEAD",
    commit: "c1",
  },
  unavailable: false,
  ignoredContributions: [] as string[],
  providers: [
    {
      key: "plugin:acme",
      label: "Acme",
      status: "running" as const,
      launchCommand: "/usr/local/bin/acme-server",
      launchArgs: ["--port", "{{port}}"],
      secretFieldNames: ["apiKey"],
    },
  ],
}

const linkedExt: ExtensionRowData = {
  ...ext,
  source: { kind: "path", path: "/src/acme", linked: true },
}

describe("ExtensionList", () => {
  it("renders the extension name and its contributed provider status", () => {
    render(<ExtensionList extensions={[ext]} {...noops} />)
    expect(screen.getByText("Acme")).toBeInTheDocument()
    expect(screen.getByText(/running/i)).toBeInTheDocument()
  })

  it("discloses the command that will be spawned", () => {
    render(<ExtensionList extensions={[ext]} {...noops} />)
    expect(screen.getByText(/acme-server/)).toBeInTheDocument()
  })

  it("renders launchArgs as the raw unrendered template, never interpolated", () => {
    const { container } = render(
      <ExtensionList extensions={[ext]} {...noops} />,
    )
    // The manifest-declared placeholder must survive verbatim (spec §3: a rendered
    // arg list can carry a resolved secret) ...
    expect(screen.getByText(/\{\{port\}\}/)).toBeInTheDocument()
    // ... and a plausible resolved value must never appear anywhere in the row.
    expect(container.textContent).not.toMatch(/--port 8080/)
    expect(container.textContent?.includes("8080")).toBe(false)
  })

  it("discloses the secret fields the extension receives", () => {
    render(<ExtensionList extensions={[ext]} {...noops} />)
    expect(screen.getByText(/apiKey/)).toBeInTheDocument()
  })

  it("marks a linked extension as linked so its dev status is obvious", () => {
    render(<ExtensionList extensions={[linkedExt]} {...noops} />)
    expect(screen.getByText(/linked/i)).toBeInTheDocument()
  })

  it("shows an unavailable marker when a linked source has disappeared", () => {
    render(
      <ExtensionList
        extensions={[{ ...linkedExt, unavailable: true, providers: [] }]}
        {...noops}
      />,
    )
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument()
  })

  it("names the ignored contribution keys when the extension declares unknown ones", () => {
    render(
      <ExtensionList
        extensions={[{ ...ext, ignoredContributions: ["themes"] }]}
        {...noops}
      />,
    )
    expect(screen.getByText(/themes/)).toBeInTheDocument()
  })

  it("hides the update control for a linked install", () => {
    render(<ExtensionList extensions={[linkedExt]} {...noops} />)
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull()
  })

  it("offers the update control for a git install", () => {
    render(<ExtensionList extensions={[ext]} {...noops} />)
    expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument()
  })

  it("calls back with the flipped enabled state when the toggle is used", () => {
    const seen: { id: string; enabled: boolean }[] = []
    render(
      <ExtensionList
        extensions={[ext]}
        {...noops}
        onSetEnabled={(id, enabled) => seen.push({ id, enabled })}
      />,
    )
    screen.getByRole("button", { name: /disable/i }).click()
    expect(seen).toEqual([{ id: "acme", enabled: false }])
  })

  it("renders an empty state when no extensions are installed", () => {
    render(<ExtensionList extensions={[]} {...noops} />)
    expect(screen.getByText(/no extensions/i)).toBeInTheDocument()
  })
})
