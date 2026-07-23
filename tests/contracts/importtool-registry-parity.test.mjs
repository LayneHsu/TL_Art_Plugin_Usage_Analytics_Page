import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const importToolRoot = process.env.IMPORTTOOL_ROOT;

test("ImportTool action registry matches the checked-in server registry", { skip: !importToolRoot }, () => {
  if (!existsSync(importToolRoot)) throw new Error(`IMPORTTOOL_ROOT does not exist: ${importToolRoot}`);
  const script = path.join(repositoryRoot, "scripts", "generate-tool-registry-from-importtool.py");
  const result = spawnSync(
    process.env.PYTHON || "python",
    [script, "--importtool-root", importToolRoot, "--check"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`${result.stdout || ""}${result.stderr || ""}`.trim());
  }
});
