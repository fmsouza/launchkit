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

/** Normalizes `needs` (a bare string or a list in GitHub Actions) to a list. */
const needsOf = (job: WorkflowJob): readonly string[] =>
  job.needs === undefined
    ? []
    : typeof job.needs === "string"
      ? [job.needs]
      : job.needs

describe("canary workflow idle-night guard", () => {
  it("decides whether to build before spending runner minutes on the gate", () => {
    expect(needsOf(workflow.jobs.version as WorkflowJob)).toEqual([])
    expect(needsOf(workflow.jobs.gate as WorkflowJob)).toContain("version")
  })

  it("publishes a should-build verdict when the version job runs", () => {
    expect(workflow.jobs.version?.outputs?.["should-build"]).toBe(
      "${{ steps.version.outputs.should-build }}",
    )
  })

  it("skips the pipeline when the verdict says nothing new was merged", () => {
    expect(workflow.jobs.gate?.if).toBe(
      "needs.version.outputs.should-build == 'true'",
    )
  })

  it("propagates the skip to the build and publish jobs when the gate is skipped", () => {
    // GitHub skips the dependents of a skipped job, so keeping every heavy job
    // downstream of `gate` is what makes an idle night cost one short job.
    expect(needsOf(workflow.jobs["build-cli"] as WorkflowJob)).toContain("gate")
    expect(needsOf(workflow.jobs["build-desktop"] as WorkflowJob)).toContain(
      "gate",
    )
    const release = needsOf(workflow.jobs.release as WorkflowJob)
    expect(release).toContain("build-cli")
    expect(release).toContain("build-desktop")
  })
})
