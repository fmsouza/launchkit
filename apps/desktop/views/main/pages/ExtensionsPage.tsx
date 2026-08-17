import type { ExtensionView } from "@spectrum/ipc"
import type { PluginId } from "@spectrum/types"
import {
  Button,
  EmptyState,
  ExtensionList,
  FormField,
  Modal,
  Row,
  Select,
  SettingsLayout,
  Spinner,
  TextInput,
} from "@spectrum/ui"
import type { ExtensionRowData } from "@spectrum/ui"
import { type ReactElement, useState } from "react"
import { useExtensions } from "../hooks/useExtensions"
import { useNotifications } from "../hooks/useNotifications"

/** Project the IPC-crossing `ExtensionView` to the row shape `ExtensionList` renders. */
const toRow = (view: ExtensionView): ExtensionRowData => ({
  id: view.id,
  name: view.name,
  version: view.version,
  enabled: view.enabled,
  source: view.source,
  unavailable: view.unavailable,
  ignoredContributions: view.ignoredContributions,
  providers: view.providers,
})

const MODE_OPTIONS = [
  { value: "copy", label: "Copy (snapshot)" },
  { value: "link", label: "Link (live reload from source)" },
] as const

export const ExtensionsPage = (): ReactElement => {
  const { extensions, loading, error, install, setEnabled, update, remove } =
    useExtensions()
  const { notify } = useNotifications()

  const [installOpen, setInstallOpen] = useState<boolean>(false)
  const [source, setSource] = useState<string>("")
  const [ref, setRef] = useState<string>("")
  const [mode, setMode] = useState<string>("copy")

  const closeInstallModal = (): void => {
    setInstallOpen(false)
    setSource("")
    setRef("")
    setMode("copy")
  }

  const submitInstall = async (): Promise<void> => {
    const trimmedSource = source.trim()
    if (trimmedSource === "") return
    const trimmedRef = ref.trim()
    const r = await install({
      source: trimmedSource,
      ...(trimmedRef !== "" ? { ref: trimmedRef } : {}),
      mode: mode === "link" ? "link" : "copy",
    })
    if (r.ok) {
      closeInstallModal()
    } else notify({ tone: "error", message: "Couldn't install the extension" })
  }

  return (
    <SettingsLayout title="Extensions">
      {loading ? <Spinner label="Loading extensions" /> : null}
      {error !== undefined ? (
        <EmptyState title="Could not load extensions" hint={error.detail} />
      ) : null}

      {extensions !== undefined ? (
        <>
          <Button onClick={() => setInstallOpen(true)}>
            Install extension
          </Button>
          <ExtensionList
            extensions={extensions.map(toRow)}
            onSetEnabled={(id, enabled) => {
              void setEnabled(id as PluginId, enabled).then((r) => {
                if (!r.ok)
                  notify({
                    tone: "error",
                    message: `Couldn't ${enabled ? "enable" : "disable"} the extension`,
                  })
              })
            }}
            onUpdate={(id) => {
              void update(id as PluginId).then((r) => {
                if (!r.ok)
                  notify({
                    tone: "error",
                    message: "Couldn't update the extension",
                  })
              })
            }}
            onRemove={(id) => {
              void remove(id as PluginId).then((r) => {
                if (!r.ok) {
                  notify({
                    tone: "error",
                    message: "Couldn't remove the extension",
                  })
                  return
                }
                // A DATA refusal, not a transport error: name the referencing
                // providers rather than showing a generic failure (spec §3).
                if (r.value !== undefined) {
                  notify({
                    tone: "error",
                    message: `Still in use by ${r.value.providerIds.join(", ")}`,
                  })
                }
              })
            }}
          />
        </>
      ) : null}

      <Modal
        title="Install extension"
        open={installOpen}
        onClose={closeInstallModal}
      >
        <form
          aria-label="Install extension"
          onSubmit={(e) => {
            e.preventDefault()
            void submitInstall()
          }}
        >
          <FormField id="extension-source" label="Source (path or git URL)">
            <TextInput
              id="extension-source"
              value={source}
              onChange={setSource}
              placeholder="/path/to/extension or https://…git"
            />
          </FormField>
          <FormField id="extension-ref" label="Git ref (optional)">
            <TextInput id="extension-ref" value={ref} onChange={setRef} />
          </FormField>
          <FormField id="extension-mode" label="Install mode">
            <Select
              id="extension-mode"
              value={mode}
              options={[...MODE_OPTIONS]}
              onChange={setMode}
            />
          </FormField>
          <Row gap={2} className="lk-form-actions">
            <Button onClick={() => void submitInstall()}>Install</Button>
            <Button variant="secondary" onClick={closeInstallModal}>
              Cancel
            </Button>
          </Row>
        </form>
      </Modal>
    </SettingsLayout>
  )
}
