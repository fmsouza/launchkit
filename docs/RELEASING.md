# Releasing & macOS signing

macOS channel builds (`build:stable` / `build:canary`) are code-signed with a
Developer ID Application certificate and notarized + stapled by Apple. Signing
is enforced in CI — if the secrets below are missing or signing/notarization
fails, the `release.yml` / `canary.yml` macOS jobs hard-fail (they never ship an
unsigned app). Local dev builds (`bun run start`/`dev`/`build`) skip signing and
need no credentials.

> **Test before you wire up CI.** Use `scripts/check-macos-signing.sh` to verify
> your certificate + API key actually work, locally, before adding any GitHub
> Secrets. See [Validate locally first](#validate-locally-first) below.

## Release cadence

| Channel | Trigger | Tag |
|---------|---------|-----|
| **stable** | pushing a `v*` tag (`bun run release:patch\|minor\|major` bumps + tags; push it to fire `release.yml`) | `vX.Y.Z` |
| **canary** | nightly schedule at **03:17 UTC**, plus manual dispatch | `vX.Y.Z-canary.N` |

Canary is a *nightly* channel: one build per night covering everything merged
since the previous canary — not one build per merge. A night with nothing new
publishes nothing: the `version` job compares `main`'s HEAD against the commit
behind the newest canary tag and skips the rest of the pipeline when they match,
so every `canary.N` carries real changes.

Need a canary before the next scheduled run:

```sh
gh workflow run canary.yml
```

(or **Actions → Canary Release → Run workflow**). A manual run always builds,
bypassing the no-new-commits guard.

Every push to `main` and every pull request still runs the full verify gate
(`ci.yml`: typecheck, lint, test, audit) — only the *build* is nightly.

> GitHub disables scheduled workflows in a repository with no activity for 60
> days. Any push re-enables them; check **Actions → Canary Release** if nightly
> canaries stop appearing.

## Prerequisites

- An **Apple Developer Program** membership (the team that owns the Developer ID).
- Xcode Command Line Tools (`xcode-select --install`) — provides `codesign`,
  `security`, and `xcrun notarytool`.

## Required GitHub Actions secrets

Set these in the repository settings (**Settings → Secrets and variables →
Actions → New repository secret**). The macOS jobs read them directly from the
`secrets` context (the signing steps are inline in `release.yml` / `canary.yml`).

| Secret | What it is |
|--------|------------|
| `MACOS_CERTIFICATE_P12_BASE64` | base64 of your exported Developer ID Application cert **+ private key** (`.p12`) |
| `MACOS_CERTIFICATE_PASSWORD` | the export password you set on that `.p12` |
| `MACOS_SIGN_IDENTITY` | the identity string, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `MACOS_KEYCHAIN_PASSWORD` | any throwaway value; used only for the ephemeral CI keychain |
| `APPLE_API_KEY_P8_BASE64` | base64 of your App Store Connect API key (`AuthKey_XXXX.p8`) |
| `APPLE_API_KEY_ID` | the API key ID (the `XXXX` in the filename) |
| `APPLE_API_ISSUER_ID` | the API key issuer UUID |

### How to obtain each value

**1. Developer ID Application certificate → `MACOS_CERTIFICATE_P12_BASE64` + `MACOS_CERTIFICATE_PASSWORD`**

If you don't already have the certificate in your login keychain:

1. Go to <https://developer.apple.com/account/resources/certificates/list>.
2. **+** (Create) → under *Software* choose **Developer ID Application** → Continue.
3. Create a Certificate Signing Request (CSR): open **Keychain Access** →
   menu **Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority**; enter your email, leave "Saved to disk" selected,
   save the `.certSigningRequest` file. Upload it on the developer site.
4. Download the resulting `.cer` and double-click it to add it to your login
   keychain.

Then export it **with its private key**:

5. In **Keychain Access**, select the **login** keychain → **My Certificates**.
6. Find **Developer ID Application: Your Name (TEAMID)**, expand it, and confirm
   it has a disclosed private key underneath.
7. Right-click the certificate → **Export "Developer ID Application: …"** → file
   format **Personal Information Exchange (.p12)** → save as `cert.p12`.
8. Set an export password when prompted — this is `MACOS_CERTIFICATE_PASSWORD`.
9. Base64-encode for the secret:
   ```sh
   base64 -i cert.p12 | pbcopy   # now paste into MACOS_CERTIFICATE_P12_BASE64
   ```

**2. `MACOS_SIGN_IDENTITY`**

The exact, quoted identity name. Print it with:
```sh
security find-identity -v -p codesigning
# → 1) ABCD… "Developer ID Application: Your Name (TEAMID)"
```
Use the value inside the quotes, e.g. `Developer ID Application: Your Name (TEAMID)`.

**3. `MACOS_KEYCHAIN_PASSWORD`**

Just a random throwaway used to create the temporary keychain in CI:
```sh
openssl rand -hex 16 | pbcopy
```

**4. App Store Connect API key → `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`**

1. Go to <https://appstoreconnect.apple.com/access/integrations/api> (App Store
   Connect → **Users and Access → Integrations → App Store Connect API**).
2. Under **Team Keys**, click **+** (Generate API Key). Name it (e.g.
   `spectrum-notarization`) and give it the **Developer** access role
   (sufficient for notarization). Generate.
3. **Download** the key file `AuthKey_XXXXXXXXXX.p8` — Apple lets you download it
   **once**. Keep it safe.
4. From the keys list, copy:
   - **Key ID** (the `XXXXXXXXXX`) → `APPLE_API_KEY_ID`
   - **Issuer ID** (the UUID at the top of the page) → `APPLE_API_ISSUER_ID`
5. Base64-encode the key for the secret:
   ```sh
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
   ```

## Validate locally first

Before touching GitHub, prove the credentials work on your Mac with
`scripts/check-macos-signing.sh`. It imports the cert into a throwaway keychain,
test-signs a binary, and authenticates the API key against Apple's notary
service — all isolated (it never modifies your login/default keychain) and
cleaned up on exit.

Create a gitignored env file (`.env.*` is already ignored) — locally you can
point at the raw files instead of base64-encoding:

```sh
cat > .env.signing <<'EOF'
MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
MACOS_CERTIFICATE_PASSWORD="the-p12-export-password"
MACOS_CERTIFICATE_P12_PATH="/absolute/path/to/cert.p12"
APPLE_API_KEY_ID="XXXXXXXXXX"
APPLE_API_ISSUER_ID="00000000-0000-0000-0000-000000000000"
APPLE_API_KEY_P8_PATH="/absolute/path/to/AuthKey_XXXXXXXXXX.p8"
EOF

scripts/check-macos-signing.sh .env.signing
```

Expected on success:
```
✓ Certificate imported (the .p12 password is correct).
✓ Found identity matching MACOS_SIGN_IDENTITY.
✓ Signed + verified with a Developer ID Application identity.
✓ App Store Connect API key authenticated (notarytool reached Apple).
✅ All signing + notarization credentials look good — safe to set these as GitHub Secrets.
```

The script also accepts the base64 forms (`MACOS_CERTIFICATE_P12_BASE64`,
`APPLE_API_KEY_P8_BASE64`) if you want to validate the exact strings you'll paste
into GitHub. Run with `MACOS_KEYCHAIN_PASSWORD` unset — it auto-generates one.

Once every check is green, copy the seven values into GitHub Secrets (remember
the base64 forms for the cert and key) and the next channel build will sign +
notarize automatically.

## How CI uses them

1. The inline **Set up macOS signing** step (macOS legs only) imports the cert
   into a temporary keychain and writes the `.p8` to `$RUNNER_TEMP`, exporting
   `ELECTROBUN_DEVELOPER_ID` and the `ELECTROBUN_APPLEAPI*` env vars Electrobun
   reads.
2. `electrobun build --env=<channel>` signs the app bundle + self-extracting
   bundle + `.dmg`, then notarizes and staples each.
3. A verify gate mounts the `.dmg` and asserts `codesign --verify`,
   `spctl` "Notarized Developer ID", and `stapler validate` all pass — the job
   hard-fails otherwise.
4. The keychain and key file are deleted in a final `if: always()` cleanup step.

## Released artifacts

Each versioned release ships, per platform: one OS installer (macOS `.dmg`,
Linux `*-Setup.tar.gz`, Windows `*-Setup.zip`) + one CLI archive, plus a single
`checksums-sha256.txt`. The auto-update feed (`*-update.json`, `*.patch`,
`*.tar.zst`) is published separately to the rolling `updates` tag.
