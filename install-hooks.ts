import { ensureHooksRegistered } from "./src/hooks/claude-settings.ts";
import { resolve } from "node:path";

const home = process.env.HOME!;
const hookCmd = resolve(home, "work/js/pray-bot/hooks/pray-bot-hook.sh");

for (const dir of [".claude", ".claude-silba"]) {
  const path = resolve(home, dir, "settings.json");
  console.log(`\n=== ${path} ===`);
  const r = ensureHooksRegistered({ settingsPath: path, hookCommand: hookCmd });
  console.log("added:", r.added);
  console.log("alreadyRegistered:", r.alreadyRegistered);
}
