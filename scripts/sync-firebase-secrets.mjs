import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateFirebaseRuntimeConfig } from "./validate-firebase-runtime-config.mjs";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../config/firebase-runtime-parameters.json", import.meta.url)), "utf8"));

export function syncFirebaseSecrets({ environment = process.env, execute = spawnSync, log = console.log } = {}) {
  const { projectId } = validateFirebaseRuntimeConfig(environment);
  for (const item of manifest.secret_parameters) {
    const value = environment[item.name];
    const result = execute(
      "npm",
      ["run", "firebase", "--", "functions:secrets:set", item.name, "--project", projectId, "--data-file", "-", "--non-interactive"],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), input: value, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Failed to synchronize Firebase secret ${item.name}`);
  }
  log(`Synchronized ${manifest.secret_parameters.length} Firebase function secrets.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    syncFirebaseSecrets();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
