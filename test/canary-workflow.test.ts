import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * Contract test for the canary release pipeline. Canary is a NIGHTLY channel:
 * one build per night covering everything merged since the previous canary,
 * never one build per merge. `ci.yml` keeps verifying every push and PR, so
 * these assertions are only about the *build + publish* cadence — and they are
 * the regression guard: an edit that restores `on: push` fails here.
 */

type WorkflowJob = {
  readonly needs?: string | readonly string[]
  readonly if?: string
  readonly outputs?: Readonly<Record<string, string>>
}

type Workflow = {
  readonly on: {
    readonly push?: unknown
    readonly schedule?: readonly { readonly cron: string }[]
    readonly workflow_dispatch?: unknown
  }
  readonly concurrency: {
    readonly group: string
    readonly "cancel-in-progress": boolean
  }
  readonly jobs: Readonly<Record<string, WorkflowJob>>
}

const CANARY_WORKFLOW = new URL(
  "../.github/workflows/canary.yml",
  import.meta.url,
)

const workflow = Bun.YAML.parse(
  readFileSync(CANARY_WORKFLOW, "utf8"),
) as Workflow

describe("canary workflow triggers", () => {
  it("builds on a nightly schedule when the cron fires", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "17 3 * * *" }])
  })

  it("does not build on every merge when a commit lands on main", () => {
    expect(workflow.on.push).toBeUndefined()
  })

  it("allows an on-demand canary when a maintainer runs the workflow by hand", () => {
    expect(Object.keys(workflow.on)).toContain("workflow_dispatch")
  })

  it("queues rather than cancels when a second canary run starts", () => {
    expect(workflow.concurrency.group).toBe("canary-release")
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
  })
})
