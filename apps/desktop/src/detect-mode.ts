export type AppMode = "cli" | "gui"

const CLI_VERBS = ["launch", "list", "add", "remove"] as const

export const detectMode = (argv: readonly string[]): AppMode => {
  const first = argv[2]
  return first !== undefined && (CLI_VERBS as readonly string[]).includes(first)
    ? "cli"
    : "gui"
}
