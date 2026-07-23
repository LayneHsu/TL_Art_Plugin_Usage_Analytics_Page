import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..");
const validatorPath = path.join(
  repositoryRoot,
  "scripts",
  "verify-pages-artifacts.mjs",
);
const expectedBasePath = "/TL_Art_Tool_Usage_Analytics/";

function createHtml(basePath = expectedBasePath) {
  return `<!doctype html>
<html>
  <head>
    <script type="module" src="${basePath}assets/app.js"></script>
    <link rel="stylesheet" href="${basePath}assets/app.css">
  </head>
  <body><div id="app"></div></body>
</html>
`;
}

function createFixture(testContext, options = {}) {
  const outputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pages-artifacts-"),
  );
  testContext.after(() => {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  });

  const html = options.indexHtml || createHtml(options.basePath);
  fs.mkdirSync(path.join(outputDirectory, "assets"));
  fs.writeFileSync(path.join(outputDirectory, "index.html"), html, "utf8");
  fs.writeFileSync(
    path.join(outputDirectory, "404.html"),
    options.fallbackHtml || html,
    "utf8",
  );

  if (options.noJekyll !== false) {
    fs.writeFileSync(path.join(outputDirectory, ".nojekyll"), "", "utf8");
  }
  if (options.javascript !== false) {
    fs.writeFileSync(
      path.join(outputDirectory, "assets", "app.js"),
      options.javascriptContent || "export {};\n",
      "utf8",
    );
  }
  if (options.stylesheet !== false) {
    fs.writeFileSync(
      path.join(outputDirectory, "assets", "app.css"),
      "body {}\n",
      "utf8",
    );
  }
  for (const name of options.extraJavascriptNames || []) {
    fs.writeFileSync(path.join(outputDirectory, "assets", name), "export {};\n", "utf8");
  }

  return outputDirectory;
}

async function loadValidator() {
  assert.ok(
    fs.existsSync(validatorPath),
    `Missing Pages artifact validator: ${validatorPath}`,
  );
  return import(pathToFileURL(validatorPath).href);
}

test("accepts a complete Pages artifact", async (testContext) => {
  const outputDirectory = createFixture(testContext);
  const { verifyPagesArtifacts } = await loadValidator();

  const result = verifyPagesArtifacts(outputDirectory, { expectedBasePath });

  assert.equal(result.assetCount, 2);
});

test("rejects a fallback page that differs from index", async (testContext) => {
  const outputDirectory = createFixture(testContext, {
    fallbackHtml: "<!doctype html><title>broken</title>\n",
  });
  const { verifyPagesArtifacts } = await loadValidator();

  assert.throws(
    () => verifyPagesArtifacts(outputDirectory, { expectedBasePath }),
    /404\.html must be identical to index\.html/,
  );
});

test("rejects a Pages artifact without .nojekyll", async (testContext) => {
  const outputDirectory = createFixture(testContext, { noJekyll: false });
  const { verifyPagesArtifacts } = await loadValidator();

  assert.throws(
    () => verifyPagesArtifacts(outputDirectory, { expectedBasePath }),
    /Missing Pages artifact: \.nojekyll/,
  );
});

test("rejects JavaScript and CSS URLs outside the project base path", async (testContext) => {
  const outputDirectory = createFixture(testContext, { basePath: "/wrong/" });
  const { verifyPagesArtifacts } = await loadValidator();

  assert.throws(
    () => verifyPagesArtifacts(outputDirectory, { expectedBasePath }),
    /Asset URL must use Pages base path/,
  );
});

test("rejects a referenced asset that is missing", async (testContext) => {
  const outputDirectory = createFixture(testContext, { javascript: false });
  const { verifyPagesArtifacts } = await loadValidator();

  assert.throws(
    () => verifyPagesArtifacts(outputDirectory, { expectedBasePath }),
    /Referenced asset does not exist/,
  );
});

test("rejects any JavaScript chunk larger than 500_000 bytes", async (testContext) => {
  const outputDirectory = createFixture(testContext, {
    javascriptContent: "x".repeat(500_001),
  });
  const { verifyPagesArtifacts } = await loadValidator();

  assert.throws(
    () => verifyPagesArtifacts(outputDirectory, { expectedBasePath }),
    /JavaScript chunk exceeds 500000 bytes/,
  );
});

test("requires the configured production vendor chunk prefixes", async (testContext) => {
  const outputDirectory = createFixture(testContext, {
    extraJavascriptNames: ["vue-vendor-hash.js", "firebase-auth-hash.js"],
  });
  const { verifyPagesArtifacts } = await loadValidator();

  assert.throws(
    () => verifyPagesArtifacts(outputDirectory, {
      expectedBasePath,
      requiredJavaScriptChunkPrefixes: ["vue-vendor-", "firebase-auth-", "firebase-firestore-"],
    }),
    /Missing required JavaScript chunk prefix: firebase-firestore-/,
  );
});
