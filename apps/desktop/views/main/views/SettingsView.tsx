import { SettingsNav } from "@spectrum/ui"
import type { ReactElement, ReactNode } from "react"
import { ErrorBoundary } from "../ErrorBoundary"
import { useIpcClient } from "../IpcClientContext"
import { useNotifications } from "../hooks/useNotifications"
import { useUpdate } from "../hooks/useUpdate"
import {
  DataPage,
  ExtensionsPage,
  GeneralPage,
  HarnessesPage,
  ModelsPage,
  ProvidersPage,
  UpdatesPage,
} from "../pages"

const SECTIONS = [
  { key: "general", label: "General" },
  { key: "updates", label: "Updates" },
  { key: "providers", label: "Providers" },
  { key: "models", label: "Models" },
  { key: "harnesses", label: "Harnesses" },
  { key: "extensions", label: "Extensions" },
  { key: "data", label: "Data" },
] as const

/**
 * Connects `DataPage` to the IPC client so the factory-reset action calls the
 * `resetApp` method. A real component (not the `detailFor` factory) so it can
 * call the `useIpcClient` hook.
 */
const DataPageConnected = (): ReactElement => {
  const client = useIpcClient()
  const { notify } = useNotifications()
  return (
    <DataPage
      onReset={() => {
        // On success the app relaunches, so only the failure path needs a toast.
        void client.resetApp(undefined).then((r) => {
          if (!r.ok)
            notify({
              tone: "error",
              message: "Reset failed. Please try again.",
            })
        })
      }}
    />
  )
}

/**
 * Renders the Settings nav with a version footer derived from the update
 * store. A real component (not the `SettingsView` factory) so it can call
 * `useUpdate()`. The footer uses `state.currentVersion` (which carries the
 * `-canary.N` suffix once Task 6 bakes it) and `state.channel` (the channel
 * authority). The footer is hidden until the update state has loaded.
 */
const SettingsNavConnected = ({
  sections,
  active,
  onSelect,
}: {
  readonly sections: readonly { readonly key: string; readonly label: string }[]
  readonly active: string
  readonly onSelect: (key: string) => void
}): ReactElement => {
  const { state } = useUpdate()
  const footer =
    state === undefined
      ? undefined
      : `${state.currentVersion} · ${state.channel}`
  return (
    <SettingsNav
      sections={sections}
      active={active}
      onSelect={onSelect}
      footer={footer}
    />
  )
}

const detailFor = (section: string): ReactNode => {
  switch (section) {
    case "providers":
      return <ProvidersPage />
    case "models":
      return <ModelsPage />
    case "harnesses":
      return <HarnessesPage />
    case "extensions":
      return <ExtensionsPage />
    case "data":
      return <DataPageConnected />
    case "updates":
      return <UpdatesPage />
    default:
      return <GeneralPage />
  }
}

/**
 * Settings master/detail factory: `SettingsNav` (sections + version footer)
 * as master, the matching page as detail (wrapped in an `ErrorBoundary` keyed
 * by section so a crashing page resets when you navigate away). Pages own their
 * own hooks.
 */
export const SettingsView = ({
  section,
  onSection,
}: {
  readonly section: string
  readonly onSection: (key: string) => void
}): { readonly master: ReactNode; readonly detail: ReactNode } => ({
  master: (
    <SettingsNavConnected
      sections={SECTIONS}
      active={section}
      onSelect={onSection}
    />
  ),
  detail: <ErrorBoundary key={section}>{detailFor(section)}</ErrorBoundary>,
})
