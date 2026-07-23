import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv, type Plugin } from "vite";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(webRoot, "..");

function normalizeBasePath(value: string): string {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function createPagesArtifacts(): Plugin {
  return {
    name: "create-pages-artifacts",
    apply: "build",
    async closeBundle() {
      const outputDirectory = path.join(webRoot, "dist");
      await copyFile(
        path.join(outputDirectory, "index.html"),
        path.join(outputDirectory, "404.html"),
      );
      await writeFile(path.join(outputDirectory, ".nojekyll"), "", "utf8");
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(
    mode,
    path.join(repositoryRoot, "config", "environments"),
    "PORTAL_",
  );
  const defaultBasePath =
    mode === "production" ? "/TL_Art_Tool_Usage_Analytics/" : "/";

  return {
    base: normalizeBasePath(
      environment.PORTAL_PUBLIC_BASE_PATH || defaultBasePath,
    ),
    envDir: path.join(repositoryRoot, "config", "environments"),
    envPrefix: ["PORTAL_", "VITE_PLUGIN_"],
    plugins: [vue(), createPagesArtifacts()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replaceAll("\\", "/");
            if (normalized.includes("/node_modules/@firebase/firestore") || normalized.includes("/node_modules/firebase/firestore")) return "firebase-firestore";
            if (normalized.includes("/node_modules/@firebase/auth") || normalized.includes("/node_modules/firebase/auth")) return "firebase-auth";
            if (normalized.includes("/node_modules/@firebase/") || normalized.includes("/node_modules/firebase/")) return "firebase-core";
            if (normalized.includes("/node_modules/vue/") || normalized.includes("/node_modules/@vue/")) return "vue-vendor";
          },
        },
      },
    },
  };
});
