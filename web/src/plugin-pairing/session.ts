export interface PluginPairingSession {
  pairingId: string;
  pairingSecret: string;
  state: string;
  nonce: string;
  pkceVerifier: string;
  callbackUri: string;
}

const pluginPairingKeys = {
  pairingId: "plugin_pairing_id",
  pairingSecret: "plugin_pairing_secret",
  state: "plugin_pairing_oauth_state",
  nonce: "plugin_pairing_oidc_nonce",
  pkceVerifier: "plugin_pairing_pkce_verifier",
  callbackUri: "plugin_pairing_callback_uri",
} as const;

export function savePluginPairingSession(session: PluginPairingSession): void {
  for (const [name, key] of Object.entries(pluginPairingKeys)) {
    sessionStorage.setItem(key, session[name as keyof PluginPairingSession]);
  }
}

export function loadPluginPairingSession(): PluginPairingSession | null {
  const values = Object.fromEntries(
    Object.entries(pluginPairingKeys).map(([name, key]) => [
      name,
      sessionStorage.getItem(key),
    ]),
  ) as Record<keyof PluginPairingSession, string | null>;
  if (Object.values(values).some((value) => !value)) {
    return null;
  }
  return values as PluginPairingSession;
}

export function clearPluginPairingSession(): void {
  for (const key of Object.values(pluginPairingKeys)) {
    sessionStorage.removeItem(key);
  }
}
