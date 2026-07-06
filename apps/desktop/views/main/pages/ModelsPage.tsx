import {
  type DiscoveredAttachments,
  heuristicAttachments,
} from "@spectrum/providers"
import type { ModelId, ProviderId } from "@spectrum/types"
import {
  Button,
  EmptyState,
  FormField,
  Modal,
  ModelPicker,
  ModelTable,
  Row,
  Select,
  SettingsLayout,
  Spinner,
  TextInput,
} from "@spectrum/ui"
import { type ReactElement, useMemo, useState } from "react"
import { useModels } from "../hooks/useModels"
import { useNotifications } from "../hooks/useNotifications"
import { useProviderModels } from "../hooks/useProviderModels"
import { useProviders } from "../hooks/useProviders"

type ModelDraft = {
  readonly providerId: string
  readonly providerModel: string
  readonly aliases: string
  /** Local-form state for the capability toggles. */
  readonly image: boolean
  readonly pdf: boolean
  /** True once the user has manually flipped either toggle. */
  readonly capsTouched: boolean
  /** When editing, the ModelId being updated; undefined for a new model. */
  readonly editingOf: string | undefined
}

const EMPTY_DRAFT: ModelDraft = {
  providerId: "",
  providerModel: "",
  aliases: "",
  image: false,
  pdf: false,
  capsTouched: false,
  editingOf: undefined,
}

/** Renders the Model form field: loading / discovered-select / free-text fallback. */
const ModelField = ({
  providerId,
  value,
  onChange,
}: {
  readonly providerId: string
  readonly value: string
  readonly onChange: (v: string) => void
}): ReactElement => {
  const { data: models, loading, error } = useProviderModels(providerId)
  const discovered = models ?? []
  const showMessage =
    providerId !== "" && !(error === undefined && discovered.length > 0)
  return (
    <ModelPicker
      id="model-model"
      loading={loading && providerId !== ""}
      models={discovered.map((d) => d.id)}
      value={value}
      onChange={onChange}
      {...(showMessage
        ? {
            errorMessage:
              "Couldn't list models for this provider — enter one manually.",
          }
        : {})}
    />
  )
}

export const ModelsPage = (): ReactElement => {
  const models = useModels()
  const providers = useProviders()
  const { notify } = useNotifications()

  const [draft, setDraft] = useState<ModelDraft | undefined>(undefined)
  // Reuse the same hook at the page level so we can read the discovered
  // models for capability prefill WITHOUT triggering an extra render cycle
  // (sharing the same call keeps both subscribers in sync).
  const providerIdForDiscovery = draft?.providerId ?? ""
  const { data: discoveredRaw } = useProviderModels(providerIdForDiscovery)
  const discoveredById = useMemo<
    ReadonlyMap<string, DiscoveredAttachments | undefined>
  >(() => {
    const m = new Map<string, DiscoveredAttachments | undefined>()
    for (const d of discoveredRaw ?? []) {
      // `DiscoveredModel.attachments` is the same shape as
      // `DiscoveredAttachments`; readonly is erased at the call site.
      m.set(d.id, d.attachments as DiscoveredAttachments | undefined)
    }
    return m
  }, [discoveredRaw])

  const providerNames: Record<string, string> = {}
  for (const p of providers.data ?? []) providerNames[p.id] = p.name

  const providerOptions = (providers.data ?? []).map((p) => ({
    value: p.id,
    label: p.name,
  }))

  const startEdit = (id: string): void => {
    const found = (models.data ?? []).find((m) => m.id === id)
    if (found === undefined) return
    setDraft({
      providerId: found.providerId,
      providerModel: found.providerModel,
      aliases: (found.aliases ?? []).join(", "),
      image: found.attachments?.image === true,
      pdf: found.attachments?.pdf === true,
      capsTouched: found.attachmentsSource === "user",
      editingOf: found.id,
    })
  }

  const submitDraft = async (): Promise<void> => {
    if (draft === undefined) return
    if (draft.providerId.trim() === "" || draft.providerModel.trim() === "")
      return

    const aliases = draft.aliases
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")

    const attachments = { image: draft.image, pdf: draft.pdf }
    const attachmentsSource = draft.capsTouched ? "user" : "auto"

    const r =
      draft.editingOf === undefined
        ? await models.add({
            providerId: draft.providerId as ProviderId,
            providerModel: draft.providerModel,
            aliases,
            attachments,
            attachmentsSource,
          })
        : await models.update(draft.editingOf as ModelId, {
            providerId: draft.providerId as ProviderId,
            providerModel: draft.providerModel,
            aliases,
            attachments,
            attachmentsSource,
          })
    if (r.ok) setDraft(undefined)
    else
      notify({
        tone: "error",
        message:
          draft.editingOf === undefined
            ? "Couldn't add the model"
            : "Couldn't update the model",
      })
  }

  const deleteModel = async (id: string): Promise<void> => {
    const r = await models.remove(id as ModelId)
    if (r.ok) notify({ tone: "success", message: "Model deleted" })
    else
      notify({
        tone: "error",
        message: "Couldn't delete the model",
        action: { label: "Retry", onClick: () => void deleteModel(id) },
      })
  }

  const update = <K extends keyof ModelDraft>(
    key: K,
    value: ModelDraft[K],
  ): void => setDraft((prev) => ({ ...(prev ?? EMPTY_DRAFT), [key]: value }))

  /** When the provider changes, clear providerModel — the previous model may not be valid. */
  const updateProvider = (newProviderId: string): void =>
    setDraft((prev) => ({
      ...(prev ?? EMPTY_DRAFT),
      providerId: newProviderId,
      providerModel: "",
      image: false,
      pdf: false,
      capsTouched: false,
    }))

  const updateProviderModel = (newModelId: string): void => {
    setDraft((prev) => {
      if (prev === undefined) return prev
      if (prev.capsTouched) {
        return { ...prev, providerModel: newModelId }
      }
      // Prefill capabilities from discovery, else heuristic.
      const discovered = discoveredById.get(newModelId)
      const caps = discovered ?? heuristicAttachments(newModelId)
      return {
        ...prev,
        providerModel: newModelId,
        image: caps.image === true,
        pdf: caps.pdf === true,
      }
    })
  }

  const draftIncomplete =
    draft === undefined ||
    draft.providerId.trim() === "" ||
    draft.providerModel.trim() === ""

  return (
    <SettingsLayout title="Models">
      {models.loading || providers.loading ? (
        <Spinner label="Loading models" />
      ) : null}
      {models.error !== undefined ? (
        <EmptyState
          title="Could not load models"
          hint={`IPC error: ${models.error.kind}`}
        />
      ) : null}

      {models.data !== undefined ? (
        <>
          <Button
            onClick={() =>
              setDraft({
                ...EMPTY_DRAFT,
                providerId: providers.data?.[0]?.id ?? "",
              })
            }
          >
            Add model
          </Button>
          <ModelTable
            models={models.data}
            providerNames={providerNames}
            onEdit={startEdit}
            onDelete={(id) => void deleteModel(id)}
          />
        </>
      ) : null}

      <Modal
        title={draft?.editingOf === undefined ? "Add model" : "Edit model"}
        open={draft !== undefined}
        onClose={() => setDraft(undefined)}
      >
        {draft !== undefined ? (
          <form
            aria-label={
              draft.editingOf === undefined ? "Add model" : "Edit model"
            }
            onSubmit={(e) => {
              e.preventDefault()
              void submitDraft()
            }}
          >
            <FormField id="model-provider" label="Provider">
              <Select
                id="model-provider"
                value={draft.providerId}
                options={[
                  { value: "", label: "Select a provider…" },
                  ...providerOptions,
                ]}
                onChange={updateProvider}
              />
            </FormField>
            <ModelField
              providerId={draft.providerId}
              value={draft.providerModel}
              onChange={updateProviderModel}
            />
            <FormField id="model-aliases" label="Aliases">
              <TextInput
                id="model-aliases"
                value={draft.aliases}
                placeholder="Optional, comma-separated (e.g. haiku, small)"
                onChange={(v) => update("aliases", v)}
              />
            </FormField>
            <label className="lk-form-check">
              <input
                type="checkbox"
                aria-label="Accepts images"
                checked={draft.image}
                onChange={(e) =>
                  setDraft((d) =>
                    d === undefined
                      ? d
                      : {
                          ...d,
                          image: e.target.checked,
                          capsTouched: true,
                        },
                  )
                }
              />
              Accepts images
            </label>
            <label className="lk-form-check">
              <input
                type="checkbox"
                aria-label="Accepts PDFs"
                checked={draft.pdf}
                onChange={(e) =>
                  setDraft((d) =>
                    d === undefined
                      ? d
                      : {
                          ...d,
                          pdf: e.target.checked,
                          capsTouched: true,
                        },
                  )
                }
              />
              Accepts PDFs
            </label>
            <Row gap={2} className="lk-form-actions">
              <Button
                onClick={() => void submitDraft()}
                disabled={draftIncomplete}
              >
                Save model
              </Button>
              <Button variant="secondary" onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
            </Row>
          </form>
        ) : null}
      </Modal>
    </SettingsLayout>
  )
}
