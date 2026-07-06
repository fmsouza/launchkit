import { describe, expect, it } from "bun:test"
import { fireEvent, render, screen } from "@testing-library/react"
import { UpdateBanner } from "./UpdateBanner"

const base = {
  phase: "available" as const,
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  latestHash: null,
  available: true,
  progress: 0,
  error: null,
  channel: "stable" as const,
  showBanner: true,
}

describe("UpdateBanner", () => {
  it("renders nothing when showBanner is false", () => {
    const { container } = render(
      <UpdateBanner
        state={{ ...base, showBanner: false }}
        onDownload={() => {}}
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("shows Download in the available phase and fires onDownload", () => {
    const calls: string[] = []
    render(
      <UpdateBanner
        state={base}
        onDownload={() => calls.push("download")}
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/1\.1\.0 is available/i)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /download/i }))
    expect(calls).toEqual(["download"])
  })

  it("shows the full canary version string when an update is available", () => {
    render(
      <UpdateBanner
        state={{ ...base, latestVersion: "1.6.0-canary.43", channel: "canary" }}
        onDownload={() => {}}
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(
      screen.getByText(/Spectrum 1\.6\.0-canary\.43 is available/i),
    ).toBeTruthy()
  })

  it("shows a progress indicator while downloading", () => {
    render(
      <UpdateBanner
        state={{ ...base, phase: "downloading", progress: 0.42 }}
        onDownload={() => {}}
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/downloading/i)).toBeTruthy()
  })

  it("shows Restart now when downloaded and fires onRestart", () => {
    const calls: string[] = []
    render(
      <UpdateBanner
        state={{ ...base, phase: "downloaded", progress: 1 }}
        onDownload={() => {}}
        onRestart={() => calls.push("restart")}
        onDismiss={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }))
    expect(calls).toEqual(["restart"])
  })

  it("renders nothing when state is undefined", () => {
    const { container } = render(
      <UpdateBanner
        state={undefined}
        onDownload={() => {}}
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("fires onDismiss when the dismiss button is clicked", () => {
    const calls: string[] = []
    render(
      <UpdateBanner
        state={base}
        onDownload={() => {}}
        onRestart={() => {}}
        onDismiss={() => calls.push("dismiss")}
      />,
    )
    fireEvent.click(
      screen.getByRole("button", { name: /dismiss update notification/i }),
    )
    expect(calls).toEqual(["dismiss"])
  })

  it("shows the download percentage while downloading", () => {
    render(
      <UpdateBanner
        state={{ ...base, phase: "downloading", progress: 0.42 }}
        onDownload={() => {}}
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText(/42%/)).toBeTruthy()
  })
})
