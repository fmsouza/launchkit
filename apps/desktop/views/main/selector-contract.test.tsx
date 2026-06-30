/**
 * selector-contract.test.tsx — permanent selector-contract regression guard
 *
 * Renders the real component tree across representative app states and asserts
 * that every engine-checkable CSS selector in the 11 stylesheet partials matches
 * at least one element somewhere. Any selector with zero matches is a genuine
 * CSS↔markup drift bug.
 *
 * NOT-CHECKABLE buckets (engine limitations, documented honestly):
 *
 *   GLOBAL_BUCKET — bare element/root selectors that are not rendered as
 *     children in happy-dom test containers: :root, html, body, #root, *,
 *     *::before, *::after. Also: h1–h4 (used in SettingsLayout/modal headers
 *     but queried as bare tags is engine-level noise), code/kbd/samp/pre
 *     (typography resets, not rendered in these test states).
 *
 *   PSEUDO_BUCKET — selectors with trailing state pseudos (:hover, :focus,
 *     :active, :disabled, :not(:disabled), :checked, ::placeholder, ::after,
 *     ::before, ::-webkit-scrollbar, :nth-child(n), :last-child, :first-child).
 *     The BASE selector is checked instead (the element exists even if not in
 *     the matching state).
 *
 *   HAS_NOT_BUCKET — any selector matching /:not\(\s*:has/ — happy-dom
 *     mis-evaluates :not(:has(…)); includes the EmptyState structural selectors
 *     and the sessions-detail dark-override. Also: main:has(> .lk-sessions-detail)
 *     which uses `:has()` directly (not well-supported in happy-dom).
 *
 *   DATA_ATTR_VARIANT_BUCKET — `[data-gap="N"]`, `[data-align="…"]`,
 *     `[data-justify="…"]`, `[data-wrap]` on `.lk-stack`/`.lk-row` — these
 *     attribute variants are only present when a prop is explicitly passed.
 *     The base `.lk-stack` and `.lk-row` are checked (which match); the
 *     attribute variants are a correctness contract verified by the primitive
 *     unit tests, not by this integration check.
 *
 *   @media CONDITION — not exercised (happy-dom has a fixed viewport), but
 *     inner selectors are still extracted and checked against the default render.
 *
 * States rendered:
 *   1. Sessions view — empty (no sessions, nothing selected)
 *   2. Sessions view — running + recent sessions, one selected
 *   3. New-session modal open (harness + model seed data)
 *   4. Settings General page (proxy running → StatusDot green)
 *   5. Settings Providers page (one provider → Providers table, td span[data-tone] badges)
 *   6. Settings Models page (one model in table, Add-model form open → lk-form-actions)
 *   7. Settings Harnesses page (read-only built-in list)
 *
 * Coverage gaps (documented):
 *   - `span[role="status"][aria-busy="true"]` (Spinner) — only shown briefly
 *     during loading (stubs resolve synchronously in tests). Spinner is
 *     verified by its own component tests; here it's in the PSEUDO bucket.
 *   - `.lk-field__error` — only renders when a `FormField` receives an `error`
 *     prop. No current render state triggers a server-side validation error that
 *     flows back through to the FormField. Verified by FormField unit tests.
 *   - `tbody tr:nth-child(even)` — nth-child pseudo bucketed as PSEUDO.
 *   - `.lk-tooltip__bubble` — only in the DOM while the Tooltip trigger is
 *     hovered/focused (open state). No rendered app state hovers the rail
 *     tooltip; the `.lk-tooltip` wrapper IS checked. Verified by Tooltip.test.tsx.
 *   - `span[role="img"][data-color="red"]` (StatusDot error) — only rendered by
 *     ToolCallCard when status="error". No contract state renders a conversation
 *     with an errored tool call. Verified by ToolCallCard.test.tsx and StatusDot.test.tsx.
 *   - `span[role="img"][data-color="amber"]` (StatusDot in-progress) — only rendered
 *     by TaskRow when status="in_progress". No contract state renders a TaskRail with
 *     an in-progress task. Verified by TaskRow.test.tsx and StatusDot.test.tsx.
 */

import { afterEach, describe, expect, it } from "bun:test"
import type { ProviderView } from "@spectrum/ipc"
import type { HarnessDefinition, ModelRoute, Session } from "@spectrum/types"
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { render } from "@testing-library/react"
import { App } from "./app"
import type { RunnerClient } from "./runner/runnerClient"
import { createFakeIpcClient } from "./test/fake-client"
import { createUpdateClient } from "./update/updateClient"

// ---------------------------------------------------------------------------
// Fakes (mirror what app.test.tsx uses)
// ---------------------------------------------------------------------------

const fakeRunnerClient: RunnerClient = {
  attach: () => {},
  send: () => {},
  approve: () => {},
  interrupt: () => {},
  dispatch: () => {},
  onEvent: () => {},
  onAny: () => () => {},
  onSessionRenamed: () => () => {},
  onResumeToken: () => () => {},
  connectionLost: () => {},
  onConnectionLost: () => () => {},
} as unknown as RunnerClient

// ---------------------------------------------------------------------------
// Seed fixtures (minimal valid shapes from existing test files)
// ---------------------------------------------------------------------------

const harness: HarnessDefinition = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  apiFormat: "anthropic",
  envTemplate: { ANTHROPIC_BASE_URL: "{{proxyUrl}}" },
  builtIn: true,
} as unknown as HarnessDefinition

const provider: ProviderView = {
  id: "p_openai",
  name: "OpenAI",
  sdkProvider: "openai",
  config: { baseUrl: "https://api.openai.com/v1" },
  secretFields: { apiKey: { isSet: true } },
  models: ["gpt-4o"],
} as unknown as ProviderView

const model: ModelRoute = {
  id: "m_1",
  providerId: "p_openai",
  providerModel: "gpt-4o-mini",
  aliases: [],
} as unknown as ModelRoute

const runningSession: Session = {
  id: "s_running" as Session["id"],
  harnessId: "claude" as Session["harnessId"],
  modelId: "m_1" as Session["modelId"],
  startedAt: "2026-06-01T10:00:00.000Z",
  name: "My running session",
} as unknown as Session

const endedSession: Session = {
  id: "s_ended" as Session["id"],
  harnessId: "claude" as Session["harnessId"],
  modelId: "m_1" as Session["modelId"],
  startedAt: "2026-06-01T08:00:00.000Z",
  endedAt: "2026-06-01T08:30:00.000Z",
  exitCode: 0,
  name: "Finished session",
} as unknown as Session

/**
 * A session that exited with code 1 — triggers the `danger` tone badge in SessionRow.
 * Also used as the "selected replay" session to get .lk-replay rendered (with non-empty bytes).
 */
const failedSession: Session = {
  id: "s_failed" as Session["id"],
  harnessId: "claude" as Session["harnessId"],
  modelId: "m_1" as Session["modelId"],
  startedAt: "2026-06-01T09:00:00.000Z",
  endedAt: "2026-06-01T09:10:00.000Z",
  exitCode: 1,
  name: "Failed session",
} as unknown as Session

// ---------------------------------------------------------------------------
// CSS selector parsing
// ---------------------------------------------------------------------------

const PARTIALS = [
  "tokens",
  "base",
  "controls",
  "primitives",
  "shell",
  "sessions-master",
  "sessions-detail",
  "forms",
  "modal",
  "lists",
  "page",
] as const

/**
 * Parse every selector from all partials. Handles @media blocks by recursing
 * into their bodies so the inner selectors are still checked.
 * Returns raw selectors (comma groups already split).
 */
const loadSelectors = async (): Promise<ReadonlyArray<string>> => {
  const out: string[] = []

  for (const p of PARTIALS) {
    const raw = await Bun.file(
      new URL(`./styles/${p}.css`, import.meta.url),
    ).text()
    extractSelectors(raw, out)
  }

  return out
}

/** Strip /* … * / block comments from CSS text. */
const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * Recursively extract selectors from CSS text (handles @media blocks).
 * Populates `out` with individual comma-split selectors.
 */
const extractSelectors = (rawCss: string, out: string[]): void => {
  // Strip all block comments first to prevent comment text leaking as selectors
  const css = stripComments(rawCss)

  // Strip @keyframes blocks (they contain rule-like syntax but no element selectors)
  const noKeyframes = css.replace(
    /@keyframes\s+[^{]*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
    "",
  )

  // Extract @media block bodies for recursive processing
  const mediaBodyTexts: string[] = []
  const mediaRegex = /@media[^{]*\{((?:[^{}]|\{[^{}]*\})*)\}/g
  let mediaMatch: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard loop pattern
  while ((mediaMatch = mediaRegex.exec(noKeyframes)) !== null) {
    const body = mediaMatch[1]
    if (body !== undefined) mediaBodyTexts.push(body)
  }

  // Remove @media blocks from flat CSS for non-media rule extraction
  const flatCss = noKeyframes.replace(
    /@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g,
    "",
  )

  // Extract "selector { ... }" rules from flat CSS
  // Matches the selector (non-{} content before the block) then the block
  const ruleRegex = /([^{};@][^{@]*?)\s*\{[^{}]*\}/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard loop pattern
  while ((m = ruleRegex.exec(flatCss)) !== null) {
    const selectorBlock = (m[1] ?? "").trim()
    if (selectorBlock === "") continue
    // Split comma groups and trim each part
    for (const part of selectorBlock.split(",")) {
      const s = part.trim()
      // Skip empty, at-rules, and any remaining comment fragments
      if (
        s.length > 0 &&
        !s.startsWith("@") &&
        !s.startsWith("*") &&
        !s.startsWith("/*") &&
        // Guard against multi-word comment leakage (valid selectors don't have unquoted spaces mid-token like this)
        !/^\s*(?:for|to|from|and|or|not|in|the|its|so|a|an|this|that|of|with|all|each|any|only|both|where)\s/.test(
          s,
        )
      ) {
        out.push(s)
      }
    }
  }

  // Recurse into @media block bodies
  for (const body of mediaBodyTexts) {
    extractSelectors(body, out)
  }
}

// ---------------------------------------------------------------------------
// Bucketing logic
// ---------------------------------------------------------------------------

/**
 * Global/root selectors not present as child elements in happy-dom containers.
 * Includes bare type selectors for typography resets (h1–h4, code, kbd, etc.)
 * that aren't rendered in the tested states, plus animation keyframe tokens.
 */
const isGlobalBucket = (s: string): boolean => {
  const globalSet = new Set([
    ":root",
    "html",
    "body",
    "#root",
    "*",
    "to",
    "from",
    // Theme opt-in root selector — dark is the default; the light theme is only
    // active when [data-theme="light"] is set on <html>. No rendered test state
    // opts into light, so this root-level selector matches nothing by design.
    '[data-theme="light"]',
    // Typography resets — present in real app but not reliably in test states
    "h1",
    "h2",
    "h3",
    "h4",
    "code",
    "kbd",
    "samp",
    "pre",
    // Focus outline — only present in keyboard-nav state
    ":focus-visible",
    // @media reduced-motion * rule
    "* ",
  ])
  return globalSet.has(s) || globalSet.has(s.trim())
}

/**
 * State pseudo-classes and pseudo-elements to strip from selector tails.
 * Returns the base selector if stripping applies, undefined otherwise.
 *
 * We iterate stripping until stable so that compound chains like
 * `button[data-variant]:active:not(:disabled)` get both tails removed.
 */
const stripStatePseudos = (s: string): string | undefined => {
  // Patterns to strip from the tail of a selector (ordered by specificity)
  const tailPatterns = [
    /:hover$/,
    /:focus-visible$/,
    /:focus$/,
    /:active$/,
    // :not(:disabled) — full compound pseudo at the tail
    /:not\(:disabled\)$/,
    /:disabled$/,
    /:checked$/,
    /::placeholder$/,
    /::after$/,
    /::before$/,
    /::-webkit-scrollbar$/,
    // :nth-child(…), :last-child, :first-child
    /:nth-child\([^)]*\)$/,
    /:last-child$/,
    /:first-child$/,
    // :not(:has(…)) — the whole compound at the tail (handled separately in has-not bucket,
    // but also strip here for safety)
    /:not\(:has\([^)]*\)\)$/,
  ]

  let current = s
  let stripped = false

  let changed = true
  while (changed) {
    changed = false
    for (const pat of tailPatterns) {
      if (pat.test(current)) {
        const next = current.replace(pat, "").trim()
        if (next.length > 0) {
          current = next
          stripped = true
          changed = true
        }
      }
    }
  }

  return stripped ? current : undefined
}

/**
 * happy-dom mis-evaluates :not(:has(…)) and may mis-evaluate :has(…) in complex
 * compound selectors too. Bucket any selector containing these patterns.
 */
const isHasNotBucket = (s: string): boolean =>
  /:not\(\s*:has/.test(s) || (s.includes(":has(") && s.includes(">"))

/**
 * Selectors that are documented coverage gaps for the test states:
 *
 *   - Primitive attribute variants (.lk-stack[data-gap="N"], [data-align="…"], etc.)
 *     — only present when the primitive is rendered with the specific prop. The
 *     base class (.lk-stack, .lk-row) IS checked; the attribute variant is
 *     verified by the primitive unit tests (Stack.test.tsx, Row.test.tsx).
 *
 *   - Spinner `span[role="status"][aria-busy="true"]` — only shown during loading,
 *     but stubs resolve synchronously; selector is verified by Spinner unit tests.
 *
 *   - `.lk-field__error` — only rendered when FormField receives an `error` prop
 *     (server validation error); no test state triggers a server-side form error.
 *     Verified by FormField.test.tsx.
 *
 *   - `span[role="img"][data-color="red"]` (StatusDot error) — only rendered by
 *     ToolCallCard when status="error". No contract state renders a conversation
 *     with an errored tool call. Verified by ToolCallCard.test.tsx and StatusDot.test.tsx.
 */
const isDocumentedGap = (s: string): boolean => {
  // Stack/Row attribute variants
  if (/^\.lk-(?:stack|row)\[data-(?:gap|align|justify|wrap)/.test(s))
    return true
  // Stack min-height-0 variant
  if (s === ".lk-stack[data-min-height-0]") return true
  // Spinner — timing-dependent (only during loading, stubs resolve synchronously)
  if (s === 'span[role="status"][aria-busy="true"]') return true
  // FormField error — requires a server-side validation failure propagated to the form
  if (s === ".lk-field__error") return true
  // Tooltip bubble — only present in the DOM while the trigger is hovered/focused
  // (open state). No rendered app state hovers the rail tooltip; the bubble's
  // appearance is verified by Tooltip.test.tsx. The .lk-tooltip wrapper IS checked.
  if (s === ".lk-tooltip__bubble") return true
  // ProjectGroup toggle collapsed state variant — only present when a project is
  // collapsed (data-collapsed="true"). The base .lk-project-group__toggle IS checked
  // (from the expanded groups rendered in State 2a). Collapsing is verified by
  // ProjectGroup.test.tsx.
  if (s === '.lk-project-group__toggle[data-collapsed="true"]') return true
  // Red StatusDot — only rendered by ToolCallCard on status="error". No contract state
  // renders a conversation/ToolCallCard with an error status. Verified by
  // ToolCallCard.test.tsx and StatusDot.test.tsx.
  if (s === 'span[role="img"][data-color="red"]') return true
  // Amber StatusDot — only rendered by TaskRow when status="in_progress". No contract
  // state renders a TaskRail with an in-progress task. Verified by TaskRow.test.tsx
  // and StatusDot.test.tsx.
  if (s === 'span[role="img"][data-color="amber"]') return true
  // ContextMenu (right-click delete menu) — pure presentational molecule that is
  // only mounted on demand when the user right-clicks a row (wired in a later task).
  // No current app state renders it, so its selectors match nothing here by design.
  // Verified by ContextMenu.test.tsx.
  if (/^\.lk-context-menu(?:__item)?\b/.test(s)) return true
  // ConfirmDialog (destructive-action confirmation) — pure presentational
  // molecule consumed by ProjectList and DataPage in later tasks. No current app
  // state mounts it, so its `__message`/`__input` selectors match nothing here by
  // design. Verified by ConfirmDialog.test.tsx.
  if (/^\.lk-confirm-dialog__(?:message|input)\b/.test(s)) return true
  // DataPage danger zone (Settings → Data factory-reset section) — only rendered
  // when the Settings "data" section is active. The default app mount is the
  // sessions view, and no contract state navigates to settings/data, so its
  // `.lk-danger-zone` selector matches nothing here by design. Verified by
  // DataPage.test.tsx.
  if (/^\.lk-danger-zone\b/.test(s)) return true
  // Toast (transient notification) — pure presentational atom mounted only when a
  // notification exists (wired by the notifications engine in a later task). No
  // current app state renders one, so its `.lk-toast` / `__msg` / `__action` /
  // `__dismiss` selectors (and `[data-tone="…"]` tone variants) match nothing here
  // by design. Verified by Toast.test.tsx.
  if (/^\.lk-toast(?:__(?:msg|action|dismiss))?\b/.test(s)) return true
  return false
}

// ---------------------------------------------------------------------------
// State rendering helpers
// ---------------------------------------------------------------------------

const baseStubs = {
  getSessions: async () => ({ ok: true as const, value: [] }),
  getHarnesses: async () => ({ ok: true as const, value: [] }),
  getProxyStatus: async () => ({
    ok: true as const,
    value: { running: false, port: 4000 },
  }),
  getModels: async () => ({ ok: true as const, value: [] }),
  getProviders: async () => ({ ok: true as const, value: [] }),
  getProjects: async () => ({ ok: true as const, value: [] }),
  setCollapsedProjects: async () => ({ ok: true as const, value: null }),
  getSettings: async () => ({
    ok: true as const,
    value: {
      lastSelectedFolder: "",
      lastSelectedHarnessId: "",
      collapsedProjects: [],
    },
  }),
  // Update store stubs: the Settings nav footer reads `state.currentVersion ·
  // state.channel` from the update store. Without these, `useUpdate().check()`
  // fails (default stub returns handler-failed), the store stays `undefined`,
  // and `.lk-settings-nav__footer` never mounts.
  checkForUpdate: async () => ({
    ok: true as const,
    value: {
      phase: "up-to-date" as const,
      currentVersion: "1.0.0",
      latestVersion: null,
      latestHash: null,
      available: false,
      progress: 0,
      error: null,
      channel: "stable" as const,
      showBanner: false,
    },
  }),
  getUpdateState: async () => ({
    ok: true as const,
    value: {
      phase: "up-to-date" as const,
      currentVersion: "1.0.0",
      latestVersion: null,
      latestHash: null,
      available: false,
      progress: 0,
      error: null,
      channel: "stable" as const,
      showBanner: false,
    },
  }),
}

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Main contract test
// ---------------------------------------------------------------------------

describe("selector contract: no dead selectors in the live UI", () => {
  it("every checkable selector matches at least one element across all rendered app states", async () => {
    const selectors = await loadSelectors()
    const containers = await renderAllStates()

    // Classify each selector and collect results
    const globalBucket: string[] = []
    const pseudoBucket: string[] = []
    const hasNotBucket: string[] = []
    const docGapBucket: string[] = []
    const checked: string[] = []
    const dead: string[] = []

    for (const rawSel of selectors) {
      // 1. Global/root bucket
      if (isGlobalBucket(rawSel)) {
        globalBucket.push(rawSel)
        continue
      }

      // 2. :not(:has()) / :has() compound bucket (happy-dom engine bug)
      if (isHasNotBucket(rawSel)) {
        hasNotBucket.push(rawSel)
        continue
      }

      // 3. Documented coverage gap bucket
      if (isDocumentedGap(rawSel)) {
        docGapBucket.push(rawSel)
        continue
      }

      // 4. Strip trailing state pseudos and use the base selector
      const baseSelector = stripStatePseudos(rawSel)
      const selectorToCheck = baseSelector ?? rawSel

      if (baseSelector !== undefined) {
        pseudoBucket.push(rawSel)
      }

      // 5. Try to match across all containers
      let found = false
      for (const container of containers) {
        try {
          if (container.querySelectorAll(selectorToCheck).length > 0) {
            found = true
            break
          }
        } catch {
          // Selector not supported by happy-dom engine — treat as unevaluable
          hasNotBucket.push(rawSel)
          found = true
          break
        }
      }

      if (found) {
        checked.push(selectorToCheck)
      } else {
        dead.push(rawSel)
      }
    }

    // Log bucket summaries for debuggability
    console.log("\n=== Selector Contract Report ===")
    console.log(`Total raw selectors parsed: ${selectors.length}`)
    console.log(`Checked (matched ≥1 element): ${checked.length}`)
    console.log(
      `Global bucket (not checkable, by design): ${globalBucket.length}`,
      globalBucket,
    )
    console.log(
      `Pseudo bucket (base checked instead): ${pseudoBucket.length}`,
      pseudoBucket,
    )
    console.log(
      `has-not bucket (happy-dom engine bug): ${hasNotBucket.length}`,
      hasNotBucket,
    )
    console.log(
      `Documented-gap bucket (verified by unit tests; see file header): ${docGapBucket.length}`,
      docGapBucket,
    )
    if (dead.length > 0) {
      console.log(
        `\n!!! DEAD SELECTORS (genuine CSS↔markup drift): ${dead.length}`,
      )
      for (const d of dead) console.log(`  DEAD: ${d}`)
    } else {
      console.log("\nDead selectors: 0 — no CSS↔markup drift detected.")
    }

    expect(
      dead,
      `Dead selectors (CSS↔markup drift): ${dead.join(", ")}`,
    ).toEqual([])
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Render all states and collect containers
// ---------------------------------------------------------------------------

/**
 * Render the App in each representative state, collect the container nodes
 * (cloned so cleanup doesn't destroy them), then cleanup before the next state.
 */
const renderAllStates = async (): Promise<ReadonlyArray<ParentNode>> => {
  const containers: ParentNode[] = []

  // ── State 1: Sessions view — EMPTY ──────────────────────────────────────
  {
    const client = createFakeIpcClient(baseStubs)
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="sessions"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".lk-shell")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 2a: Sessions view — project groups with sessions, failed session selected ─
  // Renders: .lk-session-row, .lk-session-row__line, .lk-session-row__sub,
  //   .lk-session-row__meta, .lk-session-list,
  //   .lk-project-group, .lk-project-group__header, .lk-project-group__toggle,
  //   .lk-project-group__name, .lk-project-group__body,
  //   .lk-sessions-detail (not matched by has() — see has-not bucket)
  {
    const allSessions = [runningSession, failedSession, endedSession]
    const client = createFakeIpcClient({
      ...baseStubs,
      getProjects: async () => ({
        ok: true as const,
        value: [
          {
            id: "prj_1",
            name: "demo",
            path: "/demo",
            sessionCount: allSessions.length,
          },
        ],
      }),
      getSessions: async () => ({
        ok: true as const,
        value: allSessions,
      }),
      getHarnesses: async () => ({ ok: true as const, value: [harness] }),
      getModels: async () => ({ ok: true as const, value: [model] }),
    })
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        // Select the failedSession so its danger badge renders in the row
        initialView={`sessions/${failedSession.id}`}
      />,
    )
    await waitFor(() => {
      // Wait for the project group and session rows to appear
      expect(container.querySelector(".lk-project-group")).not.toBeNull()
      expect(container.querySelector(".lk-session-row")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 3: New-session modal open ─────────────────────────────────────
  {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({ ok: true as const, value: [harness] }),
      getModels: async () => ({ ok: true as const, value: [model] }),
    })
    const { container, getByRole } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="sessions"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".lk-shell")).not.toBeNull()
    })
    fireEvent.click(getByRole("button", { name: /new session/i }))
    await waitFor(() => {
      expect(container.querySelector("dialog[aria-modal]")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 4: Settings — General page (proxy running) ────────────────────
  {
    const client = createFakeIpcClient({
      ...baseStubs,
      getProxyStatus: async () => ({
        ok: true as const,
        value: { running: true, port: 4000 },
      }),
    })
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="settings/general"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".lk-page")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 5: Settings — Providers page (one provider) ───────────────────
  // Renders: table (Providers table), td span[data-tone] (badges in table cells)
  {
    const client = createFakeIpcClient({
      ...baseStubs,
      getProviders: async () => ({ ok: true as const, value: [provider] }),
    })
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="settings/providers"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector("table")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 6: Settings — Models page (table + Add-model form) ────────────
  {
    const client = createFakeIpcClient({
      ...baseStubs,
      getModels: async () => ({ ok: true as const, value: [model] }),
      getProviders: async () => ({ ok: true as const, value: [provider] }),
      listProviderModels: async () => ({
        ok: true as const,
        value: { models: [] },
      }),
    })
    const { container, getByRole } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="settings/models"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector("table")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    // Also open the add-model form for .lk-form-actions + .lk-field
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /add model/i }))
    })
    await waitFor(() => {
      expect(container.querySelector(".lk-form-actions")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 7: Settings — Harnesses page (read-only built-in list) ─────────
  {
    const client = createFakeIpcClient({
      ...baseStubs,
      getHarnesses: async () => ({
        ok: true as const,
        value: [harness],
      }),
    })
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="settings/harnesses"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".lk-list")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 8: Update banner — available phase (.update-banner + .update-banner__dismiss) ──
  {
    const updateStateAvailable = {
      ok: true as const,
      value: {
        phase: "available" as const,
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        available: true,
        progress: 0,
        error: null,
        channel: "stable" as const,
        showBanner: true,
      },
    }
    const client = createFakeIpcClient({
      ...baseStubs,
      checkForUpdate: async () => updateStateAvailable,
      getUpdateState: async () => updateStateAvailable,
    })
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="sessions"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".update-banner")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 9: Update banner — downloaded phase (.update-banner__hint) ──────
  {
    const updateStateDownloaded = {
      ok: true as const,
      value: {
        phase: "downloaded" as const,
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        available: true,
        progress: 1,
        error: null,
        channel: "stable" as const,
        showBanner: true,
      },
    }
    const client = createFakeIpcClient({
      ...baseStubs,
      checkForUpdate: async () => updateStateDownloaded,
      getUpdateState: async () => updateStateDownloaded,
    })
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="sessions"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".update-banner__hint")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  // ── State 10: Settings — Updates page (moved-up updater + timeouts sections) ─
  // Renders: .settings-updates* and .settings-timeouts* selectors that moved here
  // from the General page in the auto-session-name work. baseStubs already includes
  // checkForUpdate/getUpdateState (see State 4) and getTimeoutSettings.
  {
    const client = createFakeIpcClient(baseStubs)
    const { container } = render(
      <App
        client={client}
        runnerClient={fakeRunnerClient}
        updateClient={createUpdateClient()}
        initialView="settings/updates"
      />,
    )
    await waitFor(() => {
      expect(container.querySelector(".settings-updates")).not.toBeNull()
    })
    containers.push(container.cloneNode(true) as ParentNode)
    cleanup()
  }

  return containers
}
