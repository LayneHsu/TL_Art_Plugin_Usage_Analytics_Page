import { PluginAuthError } from "./errors";

export function assertPluginEndpointHeaders(headers: {
  authorization?: string | string[];
}): void {
  if (headers.authorization) {
    throw new PluginAuthError(
      "AUTH_DOMAIN_MISMATCH",
      "Portal sessions are not accepted by plugin endpoints",
      401,
    );
  }
}
