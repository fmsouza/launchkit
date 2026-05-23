import { useState } from "react"
import type { ModelAlias, ProviderId } from "@launchkit/types"
import {
  AliasTable,
  Button,
  EmptyState,
  FormField,
  Select,
  SettingsLayout,
  Spinner,
  TextInput,
} from "@launchkit/ui"
import { useIpcClient } from "../IpcClientContext"
import { useAliases } from "../hooks/useAliases"
import { useProviders } from "../hooks/useProviders"

type AliasDraft = {
  readonly alias: string
  readonly providerId: string
  readonly providerModel: string
  /** When editing, the original alias name being updated; absent for a new alias. */
  readonly editingOf: string | undefined
}

const EMPTY_DRAFT: AliasDraft = { alias: "", providerId: "", providerModel: "", editingOf: undefined }

export const RoutingPage = (): JSX.Element => {
  const client = useIpcClient()
  const aliases = useAliases()
  const providers = useProviders()

  const [draft, setDraft] = useState<AliasDraft | undefined>(undefined)

  const providerNames: Record<string, string> = {}
  for (const p of providers.data ?? []) providerNames[p.id] = p.name

  const providerOptions = (providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))

  const startEdit = (aliasName: string): void => {
    const found = (aliases.data ?? []).find((a) => a.alias === aliasName)
    if (found === undefined) return
    setDraft({
      alias: found.alias,
      providerId: found.providerId,
      providerModel: found.providerModel,
      editingOf: found.alias,
    })
  }

  const submitDraft = async (): Promise<void> => {
    if (draft === undefined) return
    if (draft.alias.trim() === "" || draft.providerId.trim() === "" || draft.providerModel.trim() === "") return

    const mapping = {
      alias: draft.alias,
      providerId: draft.providerId as ProviderId,
      providerModel: draft.providerModel,
    } as unknown as ModelAlias

    const r =
      draft.editingOf === undefined
        ? await client.addAlias(mapping)
        : await client.updateAlias({
            alias: draft.editingOf as ModelAlias["alias"],
            input: { providerId: mapping.providerId, providerModel: mapping.providerModel },
          })
    if (r.ok) {
      setDraft(undefined)
      aliases.refetch()
    }
  }

  const deleteAlias = async (aliasName: string): Promise<void> => {
    const r = await client.deleteAlias({ alias: aliasName as ModelAlias["alias"] })
    if (r.ok) aliases.refetch()
  }

  const update = <K extends keyof AliasDraft>(key: K, value: AliasDraft[K]): void =>
    setDraft((prev) => ({ ...(prev ?? EMPTY_DRAFT), [key]: value }))

  return (
    <SettingsLayout title="Routing">
      {aliases.loading || providers.loading ? <Spinner label="Loading routing" /> : null}
      {aliases.error !== undefined ? (
        <EmptyState title="Could not load aliases" hint={`IPC error: ${aliases.error.kind}`} />
      ) : null}

      {aliases.data !== undefined ? (
        <>
          <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>Add alias</Button>
          <AliasTable
            aliases={aliases.data}
            providerNames={providerNames}
            onEdit={startEdit}
            onDelete={(a) => void deleteAlias(a)}
          />
        </>
      ) : null}

      {draft !== undefined ? (
        <form
          aria-label={draft.editingOf === undefined ? "Add alias" : `Edit alias ${draft.editingOf}`}
          onSubmit={(e) => {
            e.preventDefault()
            void submitDraft()
          }}
        >
          <FormField id="alias-name" label="Alias name">
            <TextInput
              id="alias-name"
              value={draft.alias}
              onChange={(v) => update("alias", v)}
              disabled={draft.editingOf !== undefined}
            />
          </FormField>
          <FormField id="alias-provider" label="Provider">
            <Select
              id="alias-provider"
              value={draft.providerId}
              options={providerOptions}
              onChange={(v) => update("providerId", v)}
            />
          </FormField>
          <FormField id="alias-model" label="Model">
            <TextInput id="alias-model" value={draft.providerModel} onChange={(v) => update("providerModel", v)} />
          </FormField>
          <Button onClick={() => void submitDraft()}>Save alias</Button>
          <Button variant="secondary" onClick={() => setDraft(undefined)}>Cancel</Button>
        </form>
      ) : null}
    </SettingsLayout>
  )
}
