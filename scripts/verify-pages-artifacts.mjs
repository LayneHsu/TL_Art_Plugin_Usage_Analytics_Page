import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultBasePath = "/TL_Art_Tool_Usage_Analytics/";
const pagesOrigin = "https://pages.invalid";

function normalizeBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("Pages base path must be a non-empty URL path");
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

function readRequiredFile(outputDirectory, relativePath) {
  const filePath = path.join(outputDirectory, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing Pages artifact: ${relativePath}`);
  }
  return fs.readFileSync(filePath);
}

function extractAssetUrls(html) {
  const urls = [];
  const tagPattern = /<(?:script|link)\b[^>]*>/gi;
  const attributePattern = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/i;

  for (const tagMatch of html.matchAll(tagPattern)) {
    const attributeMatch = attributePattern.exec(tagMatch[0]);
    if (!attributeMatch) {
      continue;
    }
    const value = attributeMatch[2];
    const pathWithoutQuery = value.split(/[?#]/, 1)[0].toLowerCase();
    if (pathWithoutQuery.endsWith(".js") || pathWithoutQuery.endsWith(".css")) {
      urls.push(value);
    }
  }

  return urls;
}

function resolveAssetPath(outputDirectory, assetUrl, expectedBasePath) {
  if (!assetUrl.startsWith("/")) {
    throw new Error(`Asset URL must use Pages base path ${expectedBasePath}: ${assetUrl}`);
  }

  const parsedUrl = new URL(assetUrl, pagesOrigin);
  if (parsedUrl.origin !== pagesOrigin) {
    throw new Error(`Asset URL must be local to the Pages artifact: ${assetUrl}`);
  }

  const decodedPath = decodeURIComponent(parsedUrl.pathname);
  if (!decodedPath.startsWith(expectedBasePath)) {
    throw new Error(`Asset URL must use Pages base path ${expectedBasePath}: ${assetUrl}`);
  }

  const relativePath = decodedPath.slice(expectedBasePath.length);
  const assetPath = path.resolve(outputDirectory, ...relativePath.split("/"));
  const pathFromOutput = path.relative(outputDirectory, assetPath);
  if (
    !relativePath ||
    pathFromOutput.startsWith("..") ||
    path.isAbsolute(pathFromOutput)
  ) {
    throw new Error(`Asset URL escapes the Pages artifact: ${assetUrl}`);
  }

  return { assetPath, relativePath };
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith(".js") ? [entryPath] : [];
  });
}

export function verifyPagesArtifacts(outputDirectory, options = {}) {
  const resolvedOutputDirectory = path.resolve(outputDirectory);
  if (
    !fs.existsSync(resolvedOutputDirectory) ||
    !fs.statSync(resolvedOutputDirectory).isDirectory()
  ) {
    throw new Error(`Pages output directory does not exist: ${resolvedOutputDirectory}`);
  }

  const expectedBasePath = normalizeBasePath(
    options.expectedBasePath ||
      process.env.PORTAL_PUBLIC_BASE_PATH ||
      defaultBasePath,
  );
  const maximumJavaScriptChunkBytes = options.maximumJavaScriptChunkBytes ?? 500_000;
  const indexContent = readRequiredFile(resolvedOutputDirectory, "index.html");
  const fallbackContent = readRequiredFile(resolvedOutputDirectory, "404.html");
  readRequiredFile(resolvedOutputDirectory, ".nojekyll");

  if (!indexContent.equals(fallbackContent)) {
    throw new Error("404.html must be identical to index.html");
  }

  const referencedAssets = new Set();
  for (const pageName of ["index.html", "404.html"]) {
    const html = readRequiredFile(resolvedOutputDirectory, pageName).toString("utf8");
    const assetUrls = extractAssetUrls(html);
    const hasJavaScript = assetUrls.some((value) =>
      value.split(/[?#]/, 1)[0].toLowerCase().endsWith(".js"),
    );
    const hasStylesheet = assetUrls.some((value) =>
      value.split(/[?#]/, 1)[0].toLowerCase().endsWith(".css"),
    );
    if (!hasJavaScript || !hasStylesheet) {
      throw new Error(`${pageName} must reference JavaScript and CSS assets`);
    }

    for (const assetUrl of assetUrls) {
      const { assetPath, relativePath } = resolveAssetPath(
        resolvedOutputDirectory,
        assetUrl,
        expectedBasePath,
      );
      if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
        throw new Error(`Referenced asset does not exist: ${assetUrl}`);
      }
      referencedAssets.add(relativePath);
    }
  }


  for (const javascriptPath of listJavaScriptFiles(path.join(resolvedOutputDirectory, "assets"))) {
    const size = fs.statSync(javascriptPath).size;
    if (size > maximumJavaScriptChunkBytes) {
      throw new Error(`JavaScript chunk exceeds ${maximumJavaScriptChunkBytes} bytes: ${path.relative(resolvedOutputDirectory, javascriptPath)} (${size})`);
    }
  }

  const javascriptNames = listJavaScriptFiles(path.join(resolvedOutputDirectory, "assets")).map((filePath) => path.basename(filePath));
  for (const prefix of options.requiredJavaScriptChunkPrefixes ?? []) {
    if (!javascriptNames.some((name) => name.startsWith(prefix))) {
      throw new Error(`Missing required JavaScript chunk prefix: ${prefix}`);
    }
  }

  return {
    assetCount: referencedAssets.size,
    basePath: expectedBasePath,
  };
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsScript) {
  const outputDirectory = process.argv[2] || path.join("web", "dist");
  try {
    const result = verifyPagesArtifacts(outputDirectory, {
      requiredJavaScriptChunkPrefixes: ["vue-vendor-", "firebase-auth-", "firebase-firestore-"],
    });
    console.log(
      `Pages artifacts verified: ${result.assetCount} assets under ${result.basePath}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pages artifact verification failed: ${message}`);
    process.exitCode = 1;
  }
}
