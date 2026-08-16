import type { ProviderView } from "@spectrum/ipc"
import { SdkProviderSchema } from "@spectrum/types"
import {
  Button,
  EmptyState,
  FormField,
  Modal,
  ProviderForm,
  ProviderList,
  Row,
  SecretFieldsForm,
  Select,
  SettingsLayout,
  Spinner,
  StatusDot,
  TextInput,
} from "@spectrum/ui"
import type { ProviderRow } from "@spectrum/ui"
import { type ReactElement, useState } from "react"
import { useDraftConnectionTest } from "../hooks/useDraftConnectionTest"
import { useDraftProviderModels } from "../hooks/useDraftProviderModels"
import { useNotifications } from "../hooks/useNotifications"
import { useProviderCatalog } from "../hooks/useProviderCatalog"
import { useProviders } from "../hooks/useProviders"

/** Drop empty-string config values so optional fields read as "unset" (zod `.url().optional()` rejects ""). */
const omitEmpty = (
  config: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(config).filter(([, v]) => v !== ""))

const toRow = (view: ProviderView): ProviderRow => {
  const fields = Object.values(view.secretFields)
  const secretSet = fields.length > 0 && fields.every((s) => s.isSet)
  return {
    id: view.id,
    name: view.name,
    sdkProvider: view.sdkProvider,
    secretSet,
  }
}

export const ProvidersPage = (): ReactElement => {
  const { data, loading, error, add, update, setSecret } = useProviders()
  const catalog = useProviderCatalog()
  const { notify } = useNotifications()

  const catalogOptions =
    catalog.data?.map((c) => ({ value: c.key, label: c.label })) ?? []

  const defaultSdk = catalogOptions[0]?.value ?? "openai"

  const [addOpen, setAddOpen] = useState<boolean>(false)
  const [newName, setNewName] = useState<string>("")
  const [newSdk, setNewSdk] = useState<string>(defaultSdk)
  const [newConfig, setNewConfig] = useState<Record<string, string>>({})
  const [newSecrets, setNewSecrets] = useState<Record<string, string>>({})
  const discovery = useDraftProviderModels()
  const conn = useDraftConnectionTest()

  const resetDraftProbes = (): void => {
    discovery.reset()
    conn.reset()
  }

  const closeAddModal = (): void => {
    setAddOpen(false)
    setNewName("")
    setNewConfig({})
    setNewSecrets({})
    resetDraftProbes()
  }

  const selectedEntry = catalog.data?.find((c) => c.key === newSdk)

  const submitAdd = async (): Promise<void> => {
    const trimmed = newName.trim()
    const secretFieldNames = selectedEntry?.secretFields.map((s) => s.name) ?? [
      "apiKey",
    ]
    // The catalog entry's key may be a plugin key; add-provider is builtin-only for now.
    const validated = SdkProviderSchema.safeParse(selectedEntry?.key ?? newSdk)
    if (!validated.success) {
      notify({
        tone: "error",
        message: `Provider key not supported: ${newSdk}`,
      })
      return
    }
    const r = await add({
      ...(trimmed !== "" ? { name: trimmed } : {}),
      sdkProvider: validated.data,
      config: omitEmpty(newConfig),
      secretFieldNames,
      ...(Object.keys(newSecrets).length > 0 ? { secrets: newSecrets } : {}),
      models: [],
    })
    if (r.ok) {
      closeAddModal()
    } else notify({ tone: "error", message: "Couldn't add the provider" })
  }

  const [secretFor, setSecretFor] = useState<ProviderView | undefined>(
    undefined,
  )
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})

  const secretCatalogEntry =
    secretFor !== undefined
      ? catalog.data?.find((c) => c.key === secretFor.sdkProvider)
      : undefined

  const [editFor, setEditFor] = useState<ProviderView | undefined>(undefined)
  const [editConfig, setEditConfig] = useState<Record<string, string>>({})

  const closeSecretModal = (): void => {
    setSecretFor(undefined)
    setSecretValues({})
  }

  const secretSubmittable = Object.values(secretValues).some(
    (v) => v.trim() !== "",
  )

  const submitSecret = async (): Promise<void> => {
    if (secretFor === undefined) return
    const entries = Object.entries(secretValues).filter(
      ([, v]) => v.trim() !== "",
    )
    if (entries.length === 0) return
    for (const [field, value] of entries) {
      const r = await setSecret({ providerId: secretFor.id, field, value })
      if (!r.ok) {
        notify({ tone: "error", message: "Couldn't save the secret" })
        return
      }
    }
    // Write-only: clear immediately, never echo back.
    closeSecretModal()
  }

  const submitEdit = async (): Promise<void> => {
    if (editFor === undefined) return
    const validated = SdkProviderSchema.safeParse(editFor.sdkProvider)
    if (!validated.success) {
      notify({
        tone: "error",
        message: `Provider key not supported: ${editFor.sdkProvider}`,
      })
      return
    }
    const r = await update(editFor.id, {
      name: editFor.name,
      sdkProvider: validated.data,
      config: editConfig,
      secretFieldNames: Object.keys(editFor.secretFields),
      models: editFor.models,
    })
    if (r.ok) {
      setEditFor(undefined)
    } else notify({ tone: "error", message: "Couldn't save the provider" })
  }

  const editCatalogEntry =
    editFor !== undefined
      ? catalog.data?.find((c) => c.key === editFor.sdkProvider)
      : undefined

  return (
    <SettingsLayout title="Providers">
      {loading ? <Spinner label="Loading providers" /> : null}
      {error !== undefined ? (
        <EmptyState
          title="Could not load providers"
          hint={`IPC error: ${error.kind}`}
        />
      ) : null}

      {data !== undefined ? (
        <>
          <Button onClick={() => setAddOpen(true)}>Add provider</Button>
          <ProviderList
            providers={data.map(toRow)}
            onSetSecret={(id) => {
              const p = data.find((x) => x.id === id)
              if (p !== undefined) {
                setSecretFor(p)
                setSecretValues({})
              }
            }}
            onEdit={(id) => {
              const p = data.find((x) => x.id === id)
              if (p !== undefined) {
                setEditFor(p)
                setEditConfig({ ...p.config })
              }
            }}
          />
        </>
      ) : null}

      <Modal title="Add provider" open={addOpen} onClose={closeAddModal}>
        <form
          aria-label="Add provider"
          onSubmit={(e) => {
            e.preventDefault()
            void submitAdd()
          }}
        >
          <FormField id="new-provider-name" label="Provider name">
            <TextInput
              id="new-provider-name"
              value={newName}
              onChange={setNewName}
              placeholder="Defaults to the SDK provider name"
            />
          </FormField>
          <FormField id="new-provider-sdk" label="SDK provider">
            <Select
              id="new-provider-sdk"
              value={newSdk}
              options={catalogOptions}
              onChange={(v) => {
                setNewSdk(v)
                setNewConfig({})
                setNewSecrets({})
                resetDraftProbes()
              }}
            />
          </FormField>
          {selectedEntry !== undefined &&
          selectedEntry.configFields.length > 0 ? (
            <ProviderForm
              fields={selectedEntry.configFields}
              values={newConfig}
              onChange={(name, value) => {
                setNewConfig((c) => ({ ...c, [name]: value }))
                resetDraftProbes()
              }}
            />
          ) : null}
          {selectedEntry !== undefined &&
          selectedEntry.secretFields.length > 0 ? (
            <SecretFieldsForm
              fields={selectedEntry.secretFields}
              values={newSecrets}
              onChange={(name, value) => {
                setNewSecrets((s) => ({ ...s, [name]: value }))
                resetDraftProbes()
              }}
            />
          ) : null}
          <Row gap={2}>
            <Button
              variant="secondary"
              disabled={discovery.loading || conn.testing}
              onClick={() => {
                void (async () => {
                  // Draft discovery/connection-test probes are builtin-only for now.
                  const validated = SdkProviderSchema.safeParse(
                    selectedEntry?.key ?? newSdk,
                  )
                  if (!validated.success) return
                  const sdkProvider = validated.data
                  const config = omitEmpty(newConfig)
                  // The probe needs a target model: use the first discoverable one
                  // (the handler falls back to the provider name when none exists).
                  const models = await discovery.discover({
                    sdkProvider,
                    config,
                    secrets: newSecrets,
                  })
                  await conn.test({
                    sdkProvider,
                    config,
                    secrets: newSecrets,
                    providerModel: models[0]?.id ?? "",
                  })
                })()
              }}
            >
              Test connection
            </Button>
            {discovery.loading || conn.testing ? (
              <Spinner label="Testing connection…" />
            ) : null}
            {conn.result !== undefined ? (
              <StatusDot
                status={conn.result.ok ? "on" : "error"}
                label={
                  conn.result.ok
                    ? `Connected (${conn.result.latencyMs}ms)`
                    : "Connection failed"
                }
              />
            ) : null}
            {conn.error !== undefined ? (
              <>
                <StatusDot status="error" label="Connection test failed" />
                {conn.error.detail !== "" ? (
                  <span>{conn.error.detail}</span>
                ) : null}
              </>
            ) : null}
            {discovery.error !== undefined && discovery.error.detail !== "" ? (
              <span>{discovery.error.detail}</span>
            ) : null}
          </Row>
          <Row gap={2} className="lk-form-actions">
            <Button onClick={() => void submitAdd()}>Create provider</Button>
            <Button variant="secondary" onClick={closeAddModal}>
              Cancel
            </Button>
          </Row>
        </form>
      </Modal>

      <Modal
        title={
          secretFor === undefined
            ? "Set secret"
            : `Set secret for ${secretFor.name}`
        }
        open={secretFor !== undefined}
        onClose={closeSecretModal}
      >
        {secretFor !== undefined ? (
          <form
            aria-label={`Set secret for ${secretFor.name}`}
            onSubmit={(e) => {
              e.preventDefault()
              void submitSecret()
            }}
          >
            {secretCatalogEntry !== undefined &&
            secretCatalogEntry.secretFields.length > 0 ? (
              <SecretFieldsForm
                fields={secretCatalogEntry.secretFields}
                values={secretValues}
                onChange={(name, value) =>
                  setSecretValues((s) => ({ ...s, [name]: value }))
                }
              />
            ) : null}
            <Row gap={2} className="lk-form-actions">
              <Button
                onClick={() => void submitSecret()}
                disabled={!secretSubmittable}
              >
                Save secret
              </Button>
              <Button variant="secondary" onClick={closeSecretModal}>
                Cancel
              </Button>
            </Row>
          </form>
        ) : null}
      </Modal>
      <Modal
        title={
          editFor === undefined
            ? "Edit provider"
            : `Edit provider ${editFor.name}`
        }
        open={editFor !== undefined}
        onClose={() => setEditFor(undefined)}
      >
        {editFor !== undefined ? (
          <form
            aria-label={`Edit provider ${editFor.name}`}
            onSubmit={(e) => {
              e.preventDefault()
              void submitEdit()
            }}
          >
            {editCatalogEntry !== undefined &&
            editCatalogEntry.configFields.length > 0 ? (
              <ProviderForm
                fields={editCatalogEntry.configFields}
                values={editConfig}
                onChange={(name, value) =>
                  setEditConfig((c) => ({ ...c, [name]: value }))
                }
              />
            ) : null}
            <Row gap={2} className="lk-form-actions">
              <Button onClick={() => void submitEdit()}>Save changes</Button>
              <Button variant="secondary" onClick={() => setEditFor(undefined)}>
                Cancel
              </Button>
            </Row>
          </form>
        ) : null}
      </Modal>
    </SettingsLayout>
  )
}
