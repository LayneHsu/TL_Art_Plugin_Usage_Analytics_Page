import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const webRoot = path.join(repositoryRoot, "web");
const vitePath = (...segments: string[]) => path.join(...segments).replaceAll("\\", "/");

export default defineConfig({
  root: webRoot,
  base: "/",
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^\.\/firebase$/, replacement: vitePath(testDirectory, "stubs", "firebase.ts") },
      { find: /^\.\/store$/, replacement: vitePath(testDirectory, "stubs", "store.ts") },
    ],
  },
  server: {
    fs: { allow: [repositoryRoot] },
  },
});
