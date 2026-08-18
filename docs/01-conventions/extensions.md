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
- `flow` — a plugin-driven multi-step setup exchange; see "Setup flows" below

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

## Setup flows

A `flow` action is a multi-step setup exchange — forms, messages, an OAuth handshake
through the OS browser — that your supervised process serves **as data**. Spectrum
renders every step with its own components; your code never reaches the renderer, and
no field value you send ever crosses back to it either except through the sanitized
paths described below.

**A flow needs a supervised contribution.** It runs on your `transport.launch` process
— there is nothing to talk to otherwise. A contribution with no `launch` block cannot
offer a `flow` action; asking Spectrum to start one on such a contribution fails with
`invalid-manifest` (`NO_LAUNCH_BLOCK_DETAIL`, `packages/provider-host/src/host.ts:157-158,199`),
surfaced to the user verbatim as:

> Setup cannot continue: this extension offers a setup flow but declares no server
> for Spectrum to start, so there is nothing to run it. Its manifest needs a launch
> block.

(`apps/desktop/src/gui/ipc/flow-errors.ts`, matched on the exported
`NO_LAUNCH_BLOCK_DETAIL` constant rather than on `kind` alone — `invalid-manifest`
also covers an unparseable step from a live flow, and the two need different copy.)

### The endpoints

Spectrum calls your server at two paths, always at the base url's **root** —
independent of your `wire`'s own paths (`/responses`, `/models`, …) so a plugin whose
wire prefix happened to be `/v1` cannot collide with them:

```
POST /spectrum/v1/flow/{flowId}/start
POST /spectrum/v1/flow/{flowId}/next
```

(`FLOW_PATH_PREFIX`, `packages/extensions/src/flow.ts:5`; the client builds the url as
`${baseUrl.replace(/\/$/, "")}${FLOW_PATH_PREFIX}/${flowId}/${op}` — a trailing slash on
your base url is stripped first, `packages/provider-host/src/flow-client.ts:131`.)
Every request carries
`x-spectrum-host-token`, the same header your process echoes back on `healthPath` — a
launched plugin must check it on every flow request and refuse with `401` on a
missing or mismatched value. It is the only thing standing between your credential
exchange and any other local process that might have raced you for the port. The
worked example below rejects exactly this. The happy-path cases above that block do
drive the fixture through the real `FlowClient`; the refusals themselves are probed with raw
`fetch`, which is the point — they prove the FIXTURE rejects a bad token or a forged session
id, not merely that the client never sends one
(`packages/runtime-core/src/extension-flow.integration.test.ts`, describe block "the oauth
fixture's own refusals").

`start` receives `{ context: "create" | "provider", config: Record<string, string> }`.
`next` receives `{ sessionId: string, result: FlowResult }` — `sessionId` is the id
**you** minted in your `start` response, echoed back; it is never Spectrum's own
session handle (see "Two session-id spaces" below). Both must be answered with a
`FlowResponse`: `{ sessionId: string, step: FlowStep, toast?: FlowToast }`
(`packages/extensions/src/flow.ts:177-184`).

### Step and result kinds

Every object in the protocol is `.strict()` — a property your response includes that
the schema doesn't declare is a hard parse failure, not a warning. `FlowStepSchema`
(`packages/extensions/src/flow.ts:98-153`) is a discriminated union on `kind`:

| `kind` | Fields | Notes |
|---|---|---|
| `form` | `title`, `description?`, `fields: FlowField[]`, `submitLabel?` | Each field has `name`, `label`, `kind: "text" \| "url" \| "password" \| "select"`, `required`, `placeholder?`, `options?` (required and non-empty when `kind: "select"`, rejected at parse time otherwise) |
| `message` | `title`, `body`, `tone: "info" \| "success" \| "warning"`, `continueLabel?` | Never `"error"` — that's the `error` step kind below |
| `open-external` | `title`, `description?`, `url`, `buttonLabel?` | `url` must be `http:`/`https:` (see "The browser opens on delivery" below) |
| `await` | `title`, `description?`, `pollMs` | **`pollMs` defaults to `1000` even though the spec text declares it required** — omitting it is accepted, not an error (`packages/extensions/src/flow.ts:133-136`) |
| `done` | `message?`, `config?: Record<string,string>`, `secrets?: Record<string,string>` | Terminal — see "`done` handling" below |
| `error` | `message` | Terminal; ends the flow |

`FlowResultSchema` (what your `next` handler receives as `result`) is one of
`{ kind: "form", values: Record<string,string> }`, `{ kind: "ack" }`,
`{ kind: "poll" }`, or `{ kind: "cancel" }` — also each `.strict()`.

**Spectrum does not currently send `{ kind: "cancel" }`.** The schema carries it because
the protocol declares it, but a cancelled flow is ended by KILLING your process, not by
calling `next` first — the same is true of the 10-minute deadline, a disabled extension, and
every error path. Write your cleanup so it does not depend on a cancel callback ever firing:
anything your process must release, it has to release on exit.

**An unknown `kind` anywhere in your response is a contract violation Spectrum treats
as "you're ahead of me," not "you sent garbage."** The client's `FlowResponseSchema`
parse fails with `invalid-manifest`, and the runner turns that into an `error` step
reading "this step needs a newer Spectrum" — ending the flow cleanly rather than
leaving the UI stuck rendering nothing
(`packages/provider-host/src/flow-client.ts:135-138`,
`apps/desktop/src/gui/ipc/flow-errors.ts`).

### The caps — Spectrum's, never yours

Every cap below is enforced by Spectrum's runner. It never trusts a number your
process sends (`FLOW_LIMITS`, `packages/extensions/src/flow.ts:11-17`):

- **50 steps** per flow. Step 51 ends the flow with `read-failed: "flow exceeded 50
  steps"` regardless of what your process still wants to say.
- **10 minutes total**, wall clock, armed the instant the flow starts. A flow that
  hangs — or whose UI is simply never closed — is killed on this deadline even if no
  call is outstanding; the next call (or the one already suspended) gets a
  user-facing "this setup was stopped because it ran longer than 10 minutes" message
  instead of a bare `not-found`.
- **`await.pollMs` is clamped to `[500, 10000]`** (`clampPollMs`) before the step ever
  reaches the UI. Ask for `10` and the UI polls at `500` regardless — you cannot pin
  the renderer to a faster rate than Spectrum allows.
- **256 KB per response body.** The HTTP adapter aborts a response mid-stream once it
  crosses this, rather than buffering whatever a hung or hostile process sends first.
- **200 characters per title or button label, 2000 per body, message or toast**
  (`FLOW_TEXT_LIMITS`, `packages/extensions/src/flow.ts:33-36`). Spectrum renders these strings
  verbatim, so without a bound the only limit on a "title" would be the 256 KB body cap — and
  a step that shipped one would push the setup modal's own cancel button off the screen. Over
  the bound is a parse failure like any other, not a truncation.

### `done` handling

A `done` step's `config` is merged onto the provider record (stored config <
whatever `config` your `start` call was given < your `done.config` — your values
win) and each entry in `secrets` is written to the OS keychain, with only the
resulting **ref** stored in Spectrum's config file. `done.secrets` never crosses IPC
to the renderer — the GUI's flow handler drains it main-side with
`flowRunner.takeCompletion` (exactly once; a replayed call gets `undefined`) and
rebuilds the step it sends the renderer from `message` alone
(`apps/desktop/src/gui/ipc/handlers.ts`, `persistFlowCompletion`/`deliverFlowStep`).
Only secret fields your contribution actually **declares** in `secretFields` are
written; an undeclared field in `done.secrets` is silently dropped.

- In `context: "create"`, completing the flow **creates and saves** a new provider
  record — there is no draft state. A flow's child cannot be probed, tested, or have
  its models listed before the record exists, because model discovery and the
  provider factory both require an instance key derived from a saved record's config
  and secret refs. If you need to validate a credential before committing to it, do
  that validation inside your own flow (a `message` step reporting failure, or an
  `error` step) before returning `done` — Spectrum gives you no "try it and roll
  back" path.
- In `context: "provider"`, completing the flow **updates the existing record** —
  the same one whose secrets your child was started with (see "Two session-id
  spaces" below).

### The browser opens on step delivery, not on click

When your `start` or `next` response includes an `open-external` step, Spectrum opens
the OS browser to that url as soon as it delivers the step to the renderer — not when
the user clicks the step's button
(`apps/desktop/src/gui/ipc/handlers.ts`, `deliverFlowStep`). **By the time the user
sees the step at all, the browser is already open.** Design your copy accordingly:
the button means "I'm done" or "continue," never "authorize" — the authorization
already happened (or is already in progress) by the time it's visible.

The url is validated `http:`/`https:` only before the OS is ever asked to open
anything: `FlowStepSchema`'s own `.refine(isSafeExternalUrl, …)` on the `url` field
means a step carrying a `file:` or custom-scheme url normally fails to parse as
`open-external` at all (`packages/extensions/src/flow.ts:59-66,122-124`); and even if a
step somehow reached the opener with an unsafe scheme,
`createGuardedOpenExternal` checks `isSafeExternalUrl` again immediately before
calling the injected opener — that is the actual gate on the call, not anything
downstream of it (`packages/provider-host/src/open-external.ts`). Separately,
`FlowStepViewSchema` re-validates the same scheme on the sanitized step that crosses
IPC to the renderer — real, but it runs *after* delivery and only bounds what the
webview is shown, not whether the OS was asked to open the url.

### The config-field token limitation

A `done.config` write reaches the provider's config fields, but **there is currently
no supported way for a launch template to read a config field back.**
`allowedTokensFor` accepts a contribution's declared config field names as legal
`{{token}}`s in `args`/`envTemplate` — the validator does not reject
`{{accountId}}` — but only secret field values are actually substituted at spawn
time; a config-field token always renders to the empty string (see "The token set"
above, and its "Verified runtime caveat" note). Concretely: if your flow's `done`
writes `config: { region: "eu" }`, a launch template referencing
`{{region}}` will not see `"eu"` — it renders empty. **Until this is fixed, a flow can
only deliver a value your launch command actually needs through `done.secrets`** —
declared as a `secretFields` entry even if the value itself isn't sensitive. The
worked example below demonstrates the gap deliberately: its `done` step returns
`accountId` through `config`, and nothing in its launch template can read it back;
the credential its serving process actually needs (`apiKey`) travels through
`secretFields` instead, which *is* substituted at spawn time.

### Two session-id spaces

Your `start` response mints a session id in `sessionId` — that's **your** id, and
every subsequent `next` call for this exchange echoes it back to you unchanged.
Spectrum separately mints its own session id, returned to its own caller (the GUI) as
the outer `sessionId` on the `RunnerStep` the runner hands back — this is a different
value in a different namespace, and the two are never interchanged. Your process
should refuse a `next` call whose `sessionId` it did not itself mint (the worked
example below does exactly this, with a `400`).

### A complete worked example: the OAuth fixture

The fixture at `packages/runtime-core/src/fixtures/oauth-extension-server.ts`, and the
manifest the `manifest()` builder wraps around it in
`packages/runtime-core/src/extension-flow.integration.test.ts` (`manifestFor()` is the
provider integration test's builder, in a different file), is a full OAuth-shaped
flow you can run yourself. It is deliberately strict: it answers `401` to any flow
request missing the correct `x-spectrum-host-token`, and `400` to a malformed
`start`/`next` body or a `next` carrying a session id it never minted — so it proves
what it validates, not merely that a url was reachable.

**What it does**, end to end:

1. Your GUI click on the `flow` action calls `start` with
   `{ context, config: {} }`. The fixture mints its own session id, remembers a
   random `state` value, and answers with an `open-external` step pointing at its own
   `/fake-idp?state=<state>` endpoint (standing in for a real identity provider) plus
   an info toast.
2. Spectrum opens that url in the OS browser **the instant it delivers the step**
   (see "The browser opens on step delivery" above) — the user sees a browser tab
   already open, and a step whose button says "continue," not "authorize."
3. The renderer's `ack` (clicking the step's button) is answered with an `await`
   step, because the fixture has not yet seen the redirect land — the browser tab is
   still open. The fixture's own `pollMs: 10` is clamped by Spectrum to the `500`ms
   floor before the UI ever sees it.
4. Once the fake IdP endpoint receives the redirect (marking that `state` consented),
   the next `poll` is answered with a `done` step:
   `{ message: "Signed in", config: { accountId }, secrets: { apiKey } }`, plus a
   success toast.
5. Spectrum drains the completion, writes `secrets.apiKey` to the OS keychain,
   merges `config.accountId` onto the provider record, and (in `context: "create"`)
   saves a brand-new provider. The renderer receives only the sanitized `done` step
   (`message` alone).
6. A serving instance of the same contribution, launched later with the saved
   secret ref resolved into `SPECTRUM_API_KEY`, lists the real model — proving the
   credential the flow granted actually reached the process that needs it.

**I ran this walkthrough**, end to end, from a clean data dir (`SPECTRUM_DATA_DIR`
pointed at an empty directory), against exactly this fixture:

```sh
# 1. install the extension (a directory named "oauth-demo", containing a manifest
#    whose launch block spawns the fixture above)
SPECTRUM_DATA_DIR=<clean dir> spectrum-cli plugin install <path>/oauth-demo --copy
#   -> installed oauth-demo (1.0.0) from path <path>/oauth-demo
#      will spawn: bun .../oauth-extension-server.ts --port {{port}}
#      declared secrets: apiKey
#      oauth-demo: at least one setup action is only available in the GUI

# 2. confirm the CLI's flow-only notice, per "Actions" above
SPECTRUM_DATA_DIR=<clean dir> spectrum-cli plugin list
#   -> oauth-demo  OAuth demo  enabled
#      oauth-demo: at least one setup action is only available in the GUI
```

Starting and stepping the flow itself is a GUI action the CLI cannot perform (per
"Actions" above), so this repo has no headless way to click through it — the click
path is exactly what `apps/desktop/src/gui/ipc/handlers.ts`'s
`startProviderFlow`/`advanceProviderFlow` do, and I could not drive Electrobun's
webview from this environment to prove that surface specifically. What I *did* run,
against the exact data dir the install above produced, is the same
`flowRunner.start`/`advance` calls those handlers make — spawning the real fixture as
a real child process on a real loopback port: `start` returned the `open-external`
step with the fake IdP url; an `ack` before touching that url returned `await` with
`pollMs` clamped to `500` (confirming the clamp against the fixture's own `pollMs:
10`); fetching the url and then sending `poll` returned `done` with
`config: { accountId: "acct-42" }` and `secrets: { apiKey: "sk-from-oauth" }`, matching
what the manifest declared the fixture would grant. This is the same call sequence
`extension-flow.integration.test.ts` pins with `bun test`, which is the repo's
standing regression coverage for the exact click-through this walkthrough describes.

## The trust posture

Spectrum does not vet, sandbox, or adjudicate the trust of extension code. Its job is
to give you the autonomy to run an extension you chose — not to decide on your behalf
whether that extension deserves your trust. **Installing an extension is the trust
decision, and it is yours to make.**

Concretely: there is no separate confirmation gate. `spectrum-cli plugin install` and
`plugin update` enable the extension as part of installing, and instead of a prompt
they **disclose**: the resolved commit (git)
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

`plugin update` only applies to a `git` install — it fetches the tracked ref,
validates the incoming manifest while it is still only in `FETCH_HEAD`, and checks it
out only once it passes. An upstream commit whose manifest is broken is refused with
your working copy untouched and still loadable. It is refused, with a distinct message
per case, for every other install kind, because there is nothing for Spectrum to fetch
(`ExtensionInstaller.update`, `packages/extensions/src/installer.ts`):

- a **linked** path install — nothing to fetch, you already control the source
- a **copied** path install — "reinstall with `--copy` instead," since updating in
  place would silently diverge from whatever you'd copy next
- a **local** hand-placed install (a directory Spectrum never wrote itself, with no
  install record of a source at all) — nothing Spectrum ever fetched

Uninstalling a `linked` or `local` extension **never deletes the source directory** —
only files Spectrum itself wrote (a git clone or a `--copy` snapshot) are removed
(`ExtensionInstaller.remove`, `installer.ts`).

### Installing from a private git repository

**A credentialed `https://` source URL is refused at install time**, before any
network request: `https://user:token@host/repo.git` and `https://token@host/repo.git`
both fail with an error pointing at SSH or a git credential helper
(`plan-install.ts`). Reason: the install record (including the source URL
verbatim) is persisted to `config.json`, and this repo's rule is that secrets live in
the OS keychain — config stores only a reference, never a credential.

Use instead:

- `ssh://git@host/org/repo.git` (key-based auth — `git@` here is a username, not a
  secret)
- the scp-style equivalent, `git@host:org/repo.git`
- git's own credential helper with a bare `https://host/org/repo.git` URL

An `ssh://` URL is refused too, but only if its userinfo carries a **password**
(`ssh://user:pass@host/...`) — a bare `ssh://user@host/...` is fine. The scp-style
form follows the same rule: `user:pass@host:path` is refused, `git@host:path` is fine
(`plan-install.ts`).

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
