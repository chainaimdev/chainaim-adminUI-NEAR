/** True when `moduleUrl` is the program node was started with (not an import, e.g. from a test). */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isEntry(moduleUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false; // argv[1] is not a file path (e.g. node -e): not the program
  }
}
