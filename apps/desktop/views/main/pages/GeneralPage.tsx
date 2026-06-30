import { FormField, Select, SettingsLayout } from "@spectrum/ui"
import type { SelectOption } from "@spectrum/ui"
import { type ReactElement, useEffect, useState } from "react"
import { useIpcClient } from "../IpcClientContext"
import { useSessionNamingSettings } from "../hooks/useSessionNamingSettings"

type ModelOption = {
  readonly id: string
  readonly providerModel: string
  readonly providerId: string
}

/**
 * The General settings page: only the AI session-name model picker. The updater
 * and timeout controls moved to the Updates page. Data enters via hooks — the
 * layout stays presentational.
 */
export const GeneralPage = (): ReactElement => {
  const client = useIpcClient()
  const naming = useSessionNamingSettings()

  const [models, setModels] = useState<readonly ModelOption[]>([])
  const [providerName, setProviderName] = useState<ReadonlyMap<string, string>>(
    new Map(),
  )

  useEffect(() => {
    void Promise.all([
      client.getModels(undefined),
      client.getProviders(undefined),
    ]).then(([m, p]) => {
      if (m.ok) {
        setModels(
          m.value.map((r) => ({
            id: r.id,
            providerModel: r.providerModel,
            providerId: String(r.providerId),
          })),
        )
      }
      if (p.ok) {
        const map = new Map<string, string>()
        for (const prov of p.value) map.set(String(prov.id), prov.name)
        setProviderName(map)
      }
    })
  }, [client])

  const options: readonly SelectOption[] = [
    { value: "", label: "Off — use first prompt" },
    ...models.map((m) => ({
      value: m.id,
      label: `${m.providerModel} · ${providerName.get(m.providerId) ?? "Unknown"}`,
    })),
  ]

  return (
    <SettingsLayout title="General">
      <section aria-label="Session name" className="settings-session-name">
        <h2>Session name</h2>
        <FormField id="session-name-model" label="Auto-name model">
          <Select
            id="session-name-model"
            value={naming.modelId ?? ""}
            onChange={(v) => void naming.save(v === "" ? null : v)}
            options={options}
          />
        </FormField>
        <p className="settings-session-name__hint">
          When set, the model generates a short topic name from your first
          message. Falls back to the first prompt if generation fails. Off by
          default.
        </p>
      </section>
    </SettingsLayout>
  )
}
