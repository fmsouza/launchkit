import { Button, FormField, SettingsLayout, TextInput } from "@spectrum/ui"
import { type ReactElement, useState } from "react"
import { useTimeoutSettings } from "../hooks/useTimeoutSettings"
import { useUpdate } from "../hooks/useUpdate"

/** Validation bounds (mirrors packages/ipc/src/methods.ts + packages/config/src/schema.ts). */
const FIRST_TOKEN_MIN = 5000
const FIRST_TOKEN_MAX = 600000
const INTER_TOKEN_MIN = 1000
const INTER_TOKEN_MAX = 600000

/**
 * Returns `undefined` when `raw` is a valid integer within [min, max];
 * otherwise returns a human-readable error string.
 */
const validateMs = (
  raw: string,
  min: number,
  max: number,
): string | undefined => {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    return `Must be an integer between ${min} and ${max} ms`
  }
  return undefined
}

/**
 * The General settings section: the in-app updater controls (current version,
 * channel toggle, manual check) plus the LLM response timeout fields.
 * Data enters via the `useUpdate` and `useTimeoutSettings` hooks — the
 * layout stays presentational.
 */
export const GeneralPage = (): ReactElement => {
  const update = useUpdate()
  const s = update.state

  const { settings, save } = useTimeoutSettings()

  // Local field state: initialised from `settings` once loaded; driven by the
  // user thereafter. `undefined` means "not yet loaded".
  const [firstTokenRaw, setFirstTokenRaw] = useState<string | undefined>(
    undefined,
  )
  const [interTokenRaw, setInterTokenRaw] = useState<string | undefined>(
    undefined,
  )

  // Populate inputs once load completes (only if the user hasn't edited yet).
  if (settings !== undefined && firstTokenRaw === undefined) {
    setFirstTokenRaw(String(settings.firstTokenTimeoutMs))
  }
  if (settings !== undefined && interTokenRaw === undefined) {
    setInterTokenRaw(String(settings.interTokenTimeoutMs))
  }

  const firstTokenError =
    firstTokenRaw !== undefined
      ? validateMs(firstTokenRaw, FIRST_TOKEN_MIN, FIRST_TOKEN_MAX)
      : undefined

  const interTokenError =
    interTokenRaw !== undefined
      ? validateMs(interTokenRaw, INTER_TOKEN_MIN, INTER_TOKEN_MAX)
      : undefined

  const handleFirstTokenBlur = (): void => {
    if (firstTokenRaw === undefined || firstTokenError !== undefined) return
    const next = Number(firstTokenRaw)
    if (settings !== undefined && next === settings.firstTokenTimeoutMs) return
    const interToken =
      interTokenRaw !== undefined && interTokenError === undefined
        ? Number(interTokenRaw)
        : (settings?.interTokenTimeoutMs ?? 60000)
    void save({ firstTokenTimeoutMs: next, interTokenTimeoutMs: interToken })
  }

  const handleInterTokenBlur = (): void => {
    if (interTokenRaw === undefined || interTokenError !== undefined) return
    const next = Number(interTokenRaw)
    if (settings !== undefined && next === settings.interTokenTimeoutMs) return
    const firstToken =
      firstTokenRaw !== undefined && firstTokenError === undefined
        ? Number(firstTokenRaw)
        : (settings?.firstTokenTimeoutMs ?? 120000)
    void save({ firstTokenTimeoutMs: firstToken, interTokenTimeoutMs: next })
  }

  const statusText =
    s === undefined
      ? "…"
      : s.phase === "available"
        ? `Update ${s.latestVersion} available.`
        : s.phase === "downloading"
          ? `Downloading… ${Math.round(s.progress * 100)}%`
          : s.phase === "downloaded"
            ? `Update ${s.latestVersion} ready — restart to apply.`
            : s.phase === "error"
              ? "Couldn't check for updates."
              : "Up to date."

  return (
    <SettingsLayout title="General">
      <section aria-label="Updates" className="settings-updates">
        <h2>Updates</h2>

        <div className="settings-updates__row">
          <span className="settings-updates__row-label">Current version</span>
          <span className="settings-updates__row-value">
            {s === undefined ? "…" : `${s.currentVersion} · ${s.channel}`}
          </span>
        </div>

        <div
          className="settings-updates__channel"
          role="radiogroup"
          aria-label="Update channel"
        >
          <span className="settings-updates__channel-label">
            Update channel
          </span>
          <div className="settings-updates__choices">
            <label className="settings-updates__choice">
              <input
                type="radio"
                name="update-channel"
                aria-label="Stable"
                checked={s?.channel === "stable"}
                onChange={() => update.setChannel("stable")}
              />
              <span>Stable</span>
            </label>
            <label className="settings-updates__choice">
              <input
                type="radio"
                name="update-channel"
                aria-label="Canary"
                checked={s?.channel === "canary"}
                onChange={() => update.setChannel("canary")}
              />
              <span>Canary</span>
            </label>
          </div>
          <p className="settings-updates__hint">
            Switching channel restarts Spectrum to apply the change.
          </p>
        </div>

        <div className="settings-updates__actions">
          <Button variant="secondary" onClick={update.check}>
            Check for updates
          </Button>
          {s?.phase === "available" ? (
            <Button variant="primary" onClick={update.download}>
              Download update
            </Button>
          ) : s?.phase === "downloading" ? (
            <Button variant="primary" onClick={() => {}} disabled>
              Downloading…
            </Button>
          ) : s?.phase === "downloaded" ? (
            <Button variant="primary" onClick={update.apply}>
              Restart to apply
            </Button>
          ) : null}
          <span className="settings-updates__status" aria-live="polite">
            {statusText}
          </span>
        </div>
      </section>

      <section aria-label="LLM response timeouts" className="settings-timeouts">
        <h2>LLM response timeouts</h2>

        <FormField
          id="first-token-timeout"
          label="First-token timeout (ms)"
          {...(firstTokenError !== undefined ? { error: firstTokenError } : {})}
        >
          <TextInput
            id="first-token-timeout"
            type="number"
            value={firstTokenRaw ?? ""}
            onChange={setFirstTokenRaw}
            onBlur={handleFirstTokenBlur}
            placeholder="120000"
          />
        </FormField>
        <p className="settings-timeouts__hint">
          Default: 120000 ms. Range: {FIRST_TOKEN_MIN}–{FIRST_TOKEN_MAX} ms. How
          long to wait for the first response token before timing out.
        </p>

        <FormField
          id="inter-token-timeout"
          label="Inter-token timeout (ms)"
          {...(interTokenError !== undefined ? { error: interTokenError } : {})}
        >
          <TextInput
            id="inter-token-timeout"
            type="number"
            value={interTokenRaw ?? ""}
            onChange={setInterTokenRaw}
            onBlur={handleInterTokenBlur}
            placeholder="60000"
          />
        </FormField>
        <p className="settings-timeouts__hint">
          Default: 60000 ms. Range: {INTER_TOKEN_MIN}–{INTER_TOKEN_MAX} ms. How
          long to wait between tokens before timing out.
        </p>
      </section>
    </SettingsLayout>
  )
}
