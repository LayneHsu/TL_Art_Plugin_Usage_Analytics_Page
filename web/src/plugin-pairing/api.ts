interface PluginApiEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

function pluginAuthBaseUrl(): string {
  const baseUrl = import.meta.env.VITE_PLUGIN_AUTH_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("插件认证服务未配置");
  }
  return baseUrl;
}

async function postPluginAuth<T>(
  endpoint: string,
  body: Record<string, string>,
): Promise<T> {
  const baseUrl = pluginAuthBaseUrl();
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  const envelope = (await response.json()) as PluginApiEnvelope<T>;
  if (!response.ok || !envelope.ok || !envelope.result) {
    throw new Error(envelope.error?.message ?? "插件认证请求未完成");
  }
  return envelope.result;
}

export function beginPluginPairing(body: Record<string, string>) {
  return postPluginAuth<{ authorizationUrl: string }>(
    "pluginBeginPairing",
    body,
  );
}

export function completePluginPairing(body: Record<string, string>) {
  return postPluginAuth<{ status: string }>("pluginCompletePairing", body);
}

export function cancelPluginPairing(body: Record<string, string>) {
  return postPluginAuth<{ status: string }>(
    "pluginCancelBrowserPairing",
    body,
  );
}

export function cancelPluginPairingKeepalive(
  body: Record<string, string>,
): void {
  try {
    void fetch(`${pluginAuthBaseUrl()}/pluginCancelBrowserPairing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 服务端仍会按短期过期时间清理无法送达的取消请求.
  }
}
