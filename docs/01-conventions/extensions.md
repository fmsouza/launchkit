# Writing a Spectrum extension

> The author contract for a Spectrum provider-plugin extension: the manifest shape,
> the launch contract, the two wires, and how to install one for development.

## What an extension is

An extension is a directory containing a `spectrum-extension.json` manifest, plus
whatever its manifest's `contributes.providers[].transport.launch.command` runs. Today
the only thing an extension can contribute is an LLM **provider** — a description of a
model backend plus (optionally) how to launch its server as a local child process.

Spectrum reads `spectrum-extension.json` from the extension's directory
(`packages/extensions/src/adapters.ts:9`); that is the one file every install mode
(git clone, `--copy`, `link`, or a hand-placed directory) must provide.

## The manifest reference

Schemas: `ExtensionManifestSchema` (`packages/extensions/src/manifest.ts`),
`ProviderContributionSchema` and `PluginLaunchSchema`
(`packages/extensions/src/provider-contribution.ts`).

```jsonc
{
  "apiVersion": "spectrum.dev/v1",
  "id": "acme",                    // PluginId: /^[a-z0-9][a-z0-9-]*$/
  "name": "Acme",
  "version": "1.0.0",
  "description": "optional",
  "contributes": {
    "providers": [
      {
        "id": "acme",              // becomes provider key `plugin:acme`
        "descriptor": {
          "label": "Acme",
          "configFields": [],      // ConfigFieldSpec[] — see caveat below
          "secretFields": [
            { "name": "apiKey", "label": "API key", "required": true }
          ],
          "supportsCustomHeaders": false,
          "streaming": "incremental",     // "incremental" | "buffered"
          "reasoning": { "shape": "none", "supportedTiers": [] },
          "discovery": { "strategy": "openai-models" },
          "actions": []                    // optional — see "Actions" below
        },
        "transport": {
          "kind": "http",                  // the only implemented transport
          "wire": "openai",                // "openai" | "anthropic"
          "launch": {
            "command": "/usr/local/bin/acme-server",
            "args": ["--port", "{{port}}"],
            "envTemplate": {
              "ACME_KEY": "{{apiKey}}",
              "SPECTRUM_TOKEN": "{{hostToken}}"
            },
            "healthPath": "/models",       // default; must start with "/"
            "readyTimeoutMs": 10000        // default; clamped 1000-120000
          }
        }
      }
    ]
  }
}
```

Field notes:

- `descriptor.reasoning` validates against `ReasoningSupportSchema` — the same shape a
  builtin provider uses (`shape` ∈ `none | anthropic-thinking | openai-effort |
  google-thinking | codex-effort`, plus `supportedTiers`).
- `descriptor.discovery` validates against `DiscoverySchema` — see "The two wires"
  below for what each strategy actually fetches.
- `descriptor.actions`, if present, replaces the default action set entirely (it is
  not merged with it) — see "Actions".
- `transport.launch` is optional. A contribution with no `launch` block is
  **user-run** — see "Supervised vs. user-run".

This is a hand-transcribed version of the worked example in
`packages/runtime-core/src/extension-provider.integration.test.ts` (`manifestFor`,
around line 65) — that test spawns exactly this shape as a real child process end to
end (spawn → readiness → a streamed completion → model discovery), so it is the
closest thing to a guaranteed-current example in the repo.

## `apiVersion` and forward compatibility

The manifest **root** is `.strict()` — an unknown top-level key (a typo) is a loud
parse error. `contributes` is the one `.passthrough()`: an unknown key under
`contributes` is reported (as `ignoredContributions` on the parse result) but not
rejected, so a manifest written for a future Spectrum still installs here and simply
contributes less (`packages/extensions/src/manifest.ts:17-45`).

`apiVersion` must be `spectrum.dev/v<major>`; this Spectrum supports major `1`
(`SUPPORTED_API_MAJOR`, `packages/extensions/src/api-version.ts`). The api-version
check runs **before** shape validation (`parseManifest`,
`packages/extensions/src/manifest.ts:66-83`), so a manifest whose major is newer than
this Spectrum understands reports "needs a newer Spectrum" rather than a confusing
schema error.

A manifest whose own `contributes.providers` declares one contribution `id` twice is
**rejected at parse time**, before it ever reaches the installer or the registry
(`ContributesSchema`'s `superRefine`, `manifest.ts:20-45`) — a self-colliding manifest
that reached disk would otherwise brick every other installed extension's `list()`
call, not just its own.

## The two wires

`transport.wire` is `"openai"` or `"anthropic"`. **This is the paragraph that saves an
author a day:**

> `wire: "openai"` is built with `createOpenAI(...)(modelId)`
> (`packages/proxy/src/providers/load-sdk.ts:11`), which in the pinned
> `@ai-sdk/openai@3.0.67` resolves to the **Responses** API — `POST /responses`, **not**
> `POST /chat/completions`
> (`node_modules/.bun/node_modules/@ai-sdk/openai/dist/index.js:5039`; verified against
> the installed package, not the changelog). A server that implements chat completions
> will 404 on every request. This is the same request the builtin "Custom
> (OpenAI-compatible)" provider makes — it is app-wide behaviour, not something plugins
> opted into.

`descriptor.discovery.strategy` decides the model-listing request
(`packages/proxy/src/model-lister.ts:230-280`):

| Strategy | Request |
|---|---|
| `openai-models` | `GET <base>/models`, `Authorization: Bearer <apiKey>` if a key is set |
| `ollama-tags` | `GET <base>/tags`, `Authorization: Bearer <apiKey>` only if `sendAuthHeader: true` |
| `none` | discovery unsupported; the GUI falls back to free-text model entry |

Note the exact ollama path: the lister always appends the literal segment `/tags` to
`<base>` — never `/api/tags`. The builtin Ollama provider's discovery URL happens to
end in `/api/tags` only because its `defaultBaseUrl` is `https://ollama.com/api`, and
that whole default is **ignored for a plugin-keyed provider anyway** (a plugin's
`discovery.defaultBaseUrl` is never read — see "Paths are root-relative" below). If
your extension declares `ollama-tags`, its server must answer `GET /tags` at the base
url Spectrum resolves for it (the supervised loopback root, or the user's configured
`serverUrl`), not `/api/tags`.

`packages/runtime-core/src/fixtures/echo-openai-server.ts` is the minimal conforming
server for `wire: "openai"`: it serves `POST /responses` (a Server-Sent-Events stream)
and `GET /models`, both at the root of its base url.

## Paths are root-relative

Spectrum hands the SDK factory a bare `http://127.0.0.1:<port>` for a supervised
extension — no `/v1`, no version segment. `@ai-sdk/openai` and the model lister append
their own paths (`/responses`, `/models`) to that root. **Do not assume a `/v1`
prefix** — unlike the builtin cloud descriptors, whose `defaultBaseUrl` values
already carry their own version path (e.g. `https://openrouter.ai/api/v1`).

`healthPath` (default `/models`) is likewise root-relative and must start with `/`
(`PluginLaunchSchema`, `packages/extensions/src/provider-contribution.ts:19`).

## The launch contract

Spectrum allocates a loopback port (binds `127.0.0.1:0`, reads it, releases it) and
passes it to your process as `{{port}}`. **The extension must bind `127.0.0.1` only.**
Spectrum cannot enforce this — it only ever *dials* `127.0.0.1:<port>`; if your server
binds `0.0.0.0` it is reachable from the network too, on a port picked for you.

## The host token

Your launched server must echo `{{hostToken}}` back in an `x-spectrum-host-token`
response header on its `healthPath`, or Spectrum's readiness check never passes and
the extension never becomes ready (`waitForReady`,
`packages/provider-host/src/readiness.ts`; header name is
`HOST_TOKEN_HEADER = "x-spectrum-host-token"`).

Why: between Spectrum releasing the probe port (closing the socket it used to
discover a free port) and your process actually binding it, any other local process
can grab that port first. The host token is how Spectrum tells the difference between
"my child bound the port" and "something else got there first" — `waitForReady` keeps
polling on a token mismatch rather than failing immediately, because your real server
may simply not have started listening yet.

## The token set

Every launch template (`args`, `envTemplate` values) may reference these tokens
regardless of what the contribution declares (`RUNTIME_TOKENS`,
`packages/extensions/src/env-template.ts`):

- `{{port}}` — the allocated port, as a string
- `{{host}}` — always `127.0.0.1`
- `{{baseUrl}}` — `http://127.0.0.1:<port>`
- `{{hostToken}}` — the per-run token described above

On top of those, `allowedTokensFor(contribution)` also permits the contribution's own
declared **secret** field names and **config** field names as tokens
(`env-template.ts:26-34`). Any other `{{token}}` in `args` or `envTemplate` is
**rejected at validation, before anything spawns**
(`validateContributionTemplates`, checked by the installer at install/update time and
by the provider host on every launch).

**Verified runtime caveat, not documented anywhere else:** only **secret** field
values actually reach the rendered template at spawn time. The values object the host
builds is `{ ...secrets, port, host, baseUrl, hostToken }`
(`packages/provider-host/src/host.ts:250-257`) — a declared **config** field name is
accepted by validation as a legal token, but nothing ever supplies its value, so
`{{someConfigField}}` always renders to the empty string in practice. If your launch
needs a non-secret setting, there is currently no supported way to pass it through the
launch template — treat `configFields` as SDK-request-time configuration only (see
`buildSdkOptions`), not as launch-template input.

Secrets are substituted **first**, specifically so a contribution cannot shadow a
runtime token by declaring a secret field named `hostToken` (`host.ts:250-252`).

## Secrets

An extension receives exactly the secrets it declares in `descriptor.secretFields`,
as environment values on its own process (via `envTemplate`), and nothing else. There
is no ambient credential inheritance from Spectrum's own environment beyond what your
`envTemplate` explicitly maps.

## Actions

`descriptor.actions` is a list of `ProviderAction`s
(`packages/providers/src/types.ts:38-52`):

- `edit-config` — opens the config form over `configFields`
- `set-secrets` — opens the secret form over `secretFields`
- `flow` — a plugin-driven step flow (see Plan 4's flow-protocol document; not covered
  here)

Each action has a `context` of `"create" | "provider" | "both"` (default
`"provider"`) that decides where it is offered — `ProviderActionBar` filters actions
by `a.context === context || a.context === "both"`
(`packages/ui/src/molecules/ProviderActionBar.tsx:19`).

A contribution that declares **no** `actions` key at all gets `defaultActions` — the
same set a builtin provider gets: always `edit-config`, plus `set-secrets` if
`secretFields` is non-empty (`packages/providers/src/catalog.ts:28-42`, applied by
`ProviderContributionSchema`'s `.transform`,
`packages/extensions/src/provider-contribution.ts:52-61`). If you declare
`actions: []` explicitly, you get no actions at all — an empty array is not "use the
default."

`spectrum-cli plugin list`/`plugin install` prints a line for every contribution that
declares a `flow` action, because the CLI cannot run one — only the GUI can
(`packages/cli/src/plugin-command.ts:66-80`).

## The trust posture

Installing an extension **is** the trust decision — there is no separate confirmation
gate. `spectrum-cli plugin install` and `plugin update` enable the extension as part
of installing, and instead of a prompt they **disclose**: the resolved commit (git)
or the linked/copied path, the exact (unrendered) spawn command and args, and the
declared secret field *names* (`discloseInstall`,
`packages/cli/src/plugin-command.ts:90-120`). The GUI discloses the same facts for the
same reason. What is deliberately never shown, on either surface: a rendered argument
(which can carry a resolved secret), an env map, the host token, or the instance key.

## Lifecycle

- **Lazy spawn.** A supervised contribution's server is not started until something
  asks for it (`ensureRunning`); a fresh port and a fresh host token are minted on
  every start, including every restart.
- **Readiness.** Bounded by `launch.readyTimeoutMs` (default 10 000 ms, clamped
  1000-120 000 ms).
- **Restart on crash.** Capped at 3 **consecutive** failures
  (`DEFAULT_MAX_RESTARTS = 3`, `packages/provider-host/src/host.ts:85`); the counter
  resets after 60 s of stable uptime (`STABLE_UPTIME_MS`, `host.ts:95`) — so a plugin
  that crashes once a month is never permanently marked `failed`, but one that dies
  immediately after every restart is, after the third try.
- **Killed** on disable, uninstall, or app quit.
- **Known limits, stated honestly:** the kill is a `SIGTERM` to the child process
  only, never its process group (`packages/proc/src/process-spawner.ts:13-17`) — a
  child that spawns its own grandchildren, or that ignores `SIGTERM`, is not force
  -killed and can outlive Spectrum.

## Supervised vs. user-run

A contribution with a `transport.launch` block is **supervised**: Spectrum spawns and
owns its process, on a loopback port only Spectrum knows. A contribution with no
`launch` block is **user-run**: its base URL comes from the `serverUrl` config field
the user fills in themselves (the same field the builtin "Custom (OpenAI-compatible)"
provider uses) — Spectrum spawns nothing.

Consequence worth stating plainly: **model discovery requires a loopback base URL for
every plugin-keyed provider, supervised or not** — the model lister refuses a
non-loopback base url for any `plugin:` key
(`packages/proxy/src/model-lister.ts:247-252`; enforced regardless of `enabled`,
supervision, or discovery strategy). A user-run extension pointed at a LAN or remote
host can serve chat requests but can never list its models through Spectrum's model
picker.

## Developing an extension

```sh
# link (default) — Spectrum reads your working directory live, nothing is copied
spectrum-cli plugin install /abs/path/to/my-extension

# edit spectrum-extension.json or your server, then just reload the extension list
# (the GUI does this automatically on every mutation; the CLI re-reads on the next command)

# snapshot instead of linking
spectrum-cli plugin install /abs/path/to/my-extension --copy
```

`plugin update` only applies to a `git` install — it fetches and checks out the
tracked ref, then re-validates. It is refused, with a distinct message per case, for
every other install kind, because there is nothing for Spectrum to fetch
(`ExtensionInstaller.update`, `packages/extensions/src/installer.ts:343-374`):

- a **linked** path install — nothing to fetch, you already control the source
- a **copied** path install — "reinstall with `--copy` instead," since updating in
  place would silently diverge from whatever you'd copy next
- a **local** hand-placed install (a directory Spectrum never wrote itself, with no
  install record of a source at all) — nothing Spectrum ever fetched

Uninstalling a `linked` or `local` extension **never deletes the source directory** —
only files Spectrum itself wrote (a git clone or a `--copy` snapshot) are removed
(`ExtensionInstaller.remove`, `installer.ts:424-460`).

### Installing from a private git repository

**A credentialed `https://` source URL is refused at install time**, before any
network request: `https://user:token@host/repo.git` and `https://token@host/repo.git`
both fail with an error pointing at SSH or a git credential helper
(`plan-install.ts:215-220`). Reason: the install record (including the source URL
verbatim) is persisted to `config.json`, and this repo's rule is that secrets live in
the OS keychain — config stores only a reference, never a credential.

Use instead:

- `ssh://git@host/org/repo.git` (key-based auth — `git@` here is a username, not a
  secret)
- the scp-style equivalent, `git@host:org/repo.git`
- git's own credential helper with a bare `https://host/org/repo.git` URL

An `ssh://` URL is refused too, but only if its userinfo carries a **password**
(`ssh://user:pass@host/...`) — a bare `ssh://user@host/...` is fine
(`plan-install.ts:222-227`).

### Known limitation

**One unparseable or unsupported manifest in the plugin directory fails the load for
every installed extension, not just its own** — `ExtensionRegistry.list()` returns a
single `Err` for the whole installed set on the first `invalid-manifest` or
`unsupported-api-version` it hits (`packages/extensions/src/registry.ts`). Both
`invalid-manifest` and `unsupported-api-version` carry an optional extension `id`
(attached by `list()`, since `parseManifest` itself never sees a directory), so the
CLI and GUI can at least name which extension is broken — but until that one manifest
is fixed or removed, every other installed extension goes dark too, including ones
that were working fine. If you are hand-editing a manifest on a linked install, you
will hit this the moment you introduce a typo. There is a separate task queued to
change this; it has not shipped yet.

## A minimal complete example

The smallest end-to-end example in the repo is the fixture + manifest pair used by
`packages/runtime-core/src/extension-provider.integration.test.ts`:

- **Server:** `packages/runtime-core/src/fixtures/echo-openai-server.ts` — a ~100-line
  `Bun.serve` that reads `--port` from argv, echoes `SPECTRUM_TOKEN` as the host-token
  header, and serves `GET /models` + `POST /responses` (one streamed "hello").
- **Manifest:** the `manifestFor()` builder in the same test file (around line 65) —
  `wire: "openai"`, `discovery: { strategy: "openai-models" }`, a `launch` block
  spawning the fixture with `bun <fixture> --port {{port}}`, and one declared secret
  field used only to prove readiness in the test.

To turn that into a real extension directory: create a directory, write a
`spectrum-extension.json` with the shape from "The manifest reference" above (dropping
the test-only `readyMarker` secret), point `launch.command` at your server, and
`spectrum-cli plugin install --copy` or `link` it, per "Developing an extension".
