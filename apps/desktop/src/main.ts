import { detectMode } from "./detect-mode"

const mode = detectMode(process.argv)
if (mode === "cli") {
  // TODO[cli-plan]: parse argv + run command, then exit
  console.log("cli mode")
} else {
  // TODO[desktop-shell]: start proxy + open window
  console.log("gui mode")
}
