import { useState } from "react"
import type { ProviderView } from "@launchkit/ipc"
import type { SdkProvider } from "@launchkit/types"
import {
  Button,
  EmptyState,
  FormField,
  ProviderList,
  Select,
  SettingsLayout,
  Spinner,
  TextInput,
} from "@launchkit/ui"
import type { ProviderDisplay } from "@launchkit/ui"
import { useIpcClient } from "../IpcClientContext"
import { useProviders } from "../hooks/useProviders"

const SDK_PROVIDER_OPTIONS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
  { value: "groq", label: "Groq" },
  { value: "ollama", label: "Ollama" },
] as const

const toDisplay = (view: ProviderView): ProviderDisplay => ({
  id: view.id,
  name: view.name,
  sdkProvider: view.sdkProvider,
})

export const ProvidersPage = (): JSX.Element => {
  const client = useIpcClient()
  const { data, loading, error, refetch } = useProviders()

  const [addOpen, setAddOpen] = useState<boolean>(false)
  const [newName, setNewName] = useState<string>("")
  const [newSdk, setNewSdk] = useState<SdkProvider>("openai")

  const [secretFor, setSecretFor] = useState<ProviderView | undefined>(undefined)
  const [secretField, setSecretField] = useState<string>("")
  const [secretValue, setSecretValue] = useState<string>("")

  const submitAdd = async (): Promise<void> => {
    if (newName.trim() === "") return
    const r = await client.addProvider({
      name: newName,
      sdkProvider: newSdk,
      config: {},
      secretFieldNames: ["apiKey"],
      models: [],
    })
    if (r.ok) {
      setAddOpen(false)
      setNewName("")
      refetch()
    }
  }

  const submitSecret = async (): Promise<void> => {
    if (secretFor === undefined || secretField.trim() === "" || secretValue.trim() === "") return
    const r = await client.setProviderSecret({
      providerId: secretFor.id,
      field: secretField,
      value: secretValue,
    })
    if (r.ok) {
      // Write-only: clear the value immediately; never echo it back.
      setSecretValue("")
      setSecretField("")
      setSecretFor(undefined)
      refetch()
    }
  }

  return (
    <SettingsLayout title="Providers">
      {loading ? <Spinner label="Loading providers" /> : null}
      {error !== undefined ? (
        <EmptyState title="Could not load providers" hint={`IPC error: ${error.kind}`} />
      ) : null}

      {data !== undefined ? (
        <>
          <ProviderList
            providers={data.map(toDisplay)}
            onAdd={() => setAddOpen(true)}
            onSelect={() => {}}
          />

          {/* Per-provider secret status (presence flags ONLY -- never a value). */}
          <ul aria-label="Provider secrets">
            {data.map((provider) => (
              <li key={provider.id}>
                <span>{provider.name}</span>
                {Object.entries(provider.secretFields).map(([field, status]) => (
                  <span key={field}>{`${field}: ${status.isSet ? "set" : "unset"}`}</span>
                ))}
                <Button variant="secondary" onClick={() => setSecretFor(provider)}>
                  {`Set secret for ${provider.name}`}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {addOpen ? (
        <form
          aria-label="Add provider"
          onSubmit={(e) => {
            e.preventDefault()
            void submitAdd()
          }}
        >
          <FormField id="new-provider-name" label="Provider name">
            <TextInput id="new-provider-name" value={newName} onChange={setNewName} />
          </FormField>
          <FormField id="new-provider-sdk" label="SDK provider">
            <Select
              id="new-provider-sdk"
              value={newSdk}
              options={SDK_PROVIDER_OPTIONS}
              onChange={(v) => setNewSdk(v as SdkProvider)}
            />
          </FormField>
          <Button onClick={() => void submitAdd()}>Create provider</Button>
          <Button variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
        </form>
      ) : null}

      {secretFor !== undefined ? (
        <form
          aria-label={`Set secret for ${secretFor.name}`}
          onSubmit={(e) => {
            e.preventDefault()
            void submitSecret()
          }}
        >
          <FormField id="secret-field" label="Secret field">
            <TextInput id="secret-field" value={secretField} onChange={setSecretField} />
          </FormField>
          {/* type="password" + write-only: the value is sent, then cleared, never shown. */}
          <FormField id="secret-value" label="Secret value">
            <TextInput id="secret-value" type="password" value={secretValue} onChange={setSecretValue} />
          </FormField>
          <Button onClick={() => void submitSecret()}>Save secret</Button>
          <Button variant="secondary" onClick={() => setSecretFor(undefined)}>Cancel</Button>
        </form>
      ) : null}
    </SettingsLayout>
  )
}
