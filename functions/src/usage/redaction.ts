import { createHash } from "node:crypto";

const windowsPath = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g;
const unixPath = /(?:^|[\s"'(=])\/(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~-]+/g;
const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const bearer = /(?:Bearer|Authorization|Cookie)\s*(?::|=)?\s*(?:Bearer\s+)?[^\s,;]+/gi;
const credentialAssignment = /(["']?[A-Za-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*)(["']?[^\s,"'}]+["']?)/gi;
const jwtCredential = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const pythonStackFrame = /\bFile\s+["'][^"'\r\n]+["']\s*,\s*line\s+\d+(?:\s*,\s*in\s+[A-Za-z_][A-Za-z0-9_.<>]*)?/gi;
const volatileAddress = /0x[0-9a-f]{6,}/gi;
const unrealAssetName = /\b(?:A|BP|DT|FX|L|M|MI|NS|P|PS|S|SK|SM|T|W)_[A-Za-z0-9][A-Za-z0-9_.-]*/g;

export interface RedactedError<Category extends string = string> {
  error_category: Category;
  summary: string;
  call_site: string;
  fingerprint: string;
}

export function redactSummary(value: string): string {
  let result = value.replace(/[\r\n]+/g, " ").trim();
  result = result.replace(credentialAssignment, "$1<secret>");
  result = result.replace(bearer, "<credential>");
  result = result.replace(jwtCredential, "<credential>");
  result = result.replace(pythonStackFrame, "<stack>");
  result = result.replace(email, "<email>");
  result = result.replace(windowsPath, "<path>");
  result = result.replace(unixPath, "$1<path>");
  result = result.replace(volatileAddress, "<address>");
  result = result.replace(unrealAssetName, "<asset>");
  return result.slice(0, 512);
}

export function errorFingerprint(category: string, summary: string, callSite: string): string {
  const normalized = redactSummary(summary)
    .toLowerCase()
    .replace(/\d+/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256")
    .update(`tl-art-error-v2\u0000${category}\u0000${normalized}\u0000${callSite}`, "utf8")
    .digest("hex");
}

export function redactError<Category extends string>(error: {
  error_category: Category;
  summary: string;
  call_site: string;
}): RedactedError<Category> {
  const summary = redactSummary(error.summary);
  return {
    error_category: error.error_category,
    summary,
    call_site: error.call_site,
    fingerprint: errorFingerprint(error.error_category, summary, error.call_site),
  };
}

export function boundedDiagnostic(value: string): string {
  return redactSummary(value).replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 160);
}
