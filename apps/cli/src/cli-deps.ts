import type { CliDeps, StartProxyDeps } from "@spectrum/cli"
import type { AppContext } from "@spectrum/runtime-core"

/** Assemble the CliDeps the CLI runner needs from a wired AppContext. */
export const cliDepsFrom = (ctx: AppContext): CliDeps => ({
  config: ctx.config,
  secrets: ctx.secrets,
  sessions: ctx.sessions,
  projects: ctx.projects,
  runtime: ctx.runtime,
  registry: ctx.registry,
  extensions: ctx.extensions,
  extensionRegistry: ctx.extensionRegistry,
  launch: ctx.launch,
  proxy: {
    isRunning: ctx.proxy.isRunning,
    start: (opts: StartProxyDeps) =>
      ctx.proxy.start({
        host: opts.host,
        port: opts.port,
        proxyKey: opts.proxyKey,
        config: opts.config,
      }),
  },
  genProxyKey: ctx.genProxyKey,
  logger: ctx.log.child("cli"),
  out: {
    write: (line: string): void => {
      process.stdout.write(`${line}\n`)
    },
  },
})
