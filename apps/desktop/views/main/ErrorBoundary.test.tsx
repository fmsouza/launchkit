import { describe, expect, it } from "bun:test"
import type { Logger } from "@spectrum/logger"
import { createNoopLogger } from "@spectrum/logger"
import { render } from "@testing-library/react"
import { ErrorBoundary } from "./ErrorBoundary"
import { LoggerContext } from "./LoggerContext"

const Boom = (): never => {
  throw new Error("kaboom")
}

describe("ErrorBoundary", () => {
  it("logs page errors via the injected logger and renders the fallback", () => {
    const calls: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const logger: Logger = {
      ...createNoopLogger(),
      error: (msg, fields) => {
        const entry: { msg: string; fields?: Record<string, unknown> } = { msg }
        if (fields !== undefined) entry.fields = fields
        calls.push(entry)
      },
    }
    const { getByRole } = render(
      <LoggerContext.Provider value={logger}>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </LoggerContext.Provider>,
    )
    expect(getByRole("alert").textContent).toContain("kaboom")
    expect(calls[0]?.msg).toBe("page error")
  })
})
