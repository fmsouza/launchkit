import type { HarnessDefinition } from "@launchkit/types"

/** A single tray entry. A discriminated union so the seam binds the right action per `kind`. */
export type TrayItem =
  | {
      readonly kind: "status"
      readonly label: string
      readonly dot: TrayStatusDot
      readonly enabled: false
    }
  | {
      readonly kind: "submenu"
      readonly label: string
      readonly items: readonly TrayItem[]
    }
  | {
      readonly kind: "launch"
      readonly label: string
      readonly harnessId: string
    }
  | { readonly kind: "disabled"; readonly label: string }
  | { readonly kind: "separator" }
  | { readonly kind: "open"; readonly label: string }
  | { readonly kind: "quit"; readonly label: string }

/** The status-dot descriptor: `on`/green when the proxy is up, `off`/grey when it is down. */
export type TrayStatusDot = {
  readonly state: "on" | "off"
  readonly color: "green" | "grey"
}

/** A serializable tray-menu descriptor — no Electrobun types, no functions. The seam renders it. */
export type TrayMenu = { readonly items: readonly TrayItem[] }

/** The inputs the pure builder needs: the harness list and whether the proxy is currently up. */
export interface BuildTrayMenuInput {
  readonly harnesses: readonly HarnessDefinition[]
  readonly proxyRunning: boolean
}

/**
 * PURE: build the tray-menu descriptor. A status item (green dot when `proxyRunning`, grey otherwise),
 * a "Launch" submenu with one item per harness (or a disabled placeholder when empty), then a
 * separator, "Open LaunchKit", and "Quit". Returns a plain serializable value — `mountTray`
 * (tray-polish-02) turns it into a native tray and binds clicks by `kind`. Cheap (`performance.md`):
 * one map over the harness list, no IO.
 */
export const buildTrayMenu = (input: BuildTrayMenuInput): TrayMenu => {
  const status: TrayItem = input.proxyRunning
    ? {
        kind: "status",
        label: "Proxy: on",
        dot: { state: "on", color: "green" },
        enabled: false,
      }
    : {
        kind: "status",
        label: "Proxy: off",
        dot: { state: "off", color: "grey" },
        enabled: false,
      }

  const launchItems: readonly TrayItem[] =
    input.harnesses.length === 0
      ? [{ kind: "disabled", label: "No harnesses configured" }]
      : input.harnesses.map(
          (h): TrayItem => ({
            kind: "launch",
            label: h.name,
            harnessId: String(h.id),
          }),
        )

  return {
    items: [
      status,
      { kind: "submenu", label: "Launch", items: launchItems },
      { kind: "separator" },
      { kind: "open", label: "Open LaunchKit" },
      { kind: "quit", label: "Quit" },
    ],
  }
}
