export {
  createBunCaptureStdout,
  createDirExtensionFileSource,
  createFsReadManifest,
} from "./adapters"
export {
  SUPPORTED_API_MAJOR,
  isSupportedApiVersion,
  parseApiVersion,
} from "./api-version"
export { descriptorFromContribution } from "./descriptor"
export {
  RUNTIME_TOKENS,
  allowedTokensFor,
  renderPluginArgs,
  renderPluginEnv,
  validateContributionTemplates,
} from "./env-template"
export type { PluginError } from "./errors"
export { createInMemoryExtensionFileSource } from "./file-source"
export type { ExtensionEntry, ExtensionFileSource } from "./file-source"
export { createExtensionInstaller } from "./installer"
export type {
  ExtensionInstaller,
  InstallInput,
  InstalledExtension,
} from "./installer"
export {
  ExtensionManifestSchema,
  KNOWN_CONTRIBUTION_KEYS,
  parseManifest,
} from "./manifest"
export { redactUrlCredentials } from "./redact"
export type { ExtensionManifest, ParsedManifest } from "./manifest"
export {
  createFakeGitClient,
  createFsDirCopier,
  createInMemoryDirCopier,
  createProcessGitClient,
} from "./git"
export type { CaptureStdout, DirCopier, GitCall, GitClient } from "./git"
export { idFromSource, planInstall } from "./plan-install"
export type {
  InstallMode,
  InstallPlan,
  PlanInstallInput,
  PlannedSource,
} from "./plan-install"
export {
  PluginLaunchSchema,
  ProviderContributionSchema,
} from "./provider-contribution"
export type {
  PluginLaunch,
  ProviderContribution,
} from "./provider-contribution"
export { createExtensionRegistry } from "./registry"
export type { ExtensionRegistry, LoadedExtension } from "./registry"
