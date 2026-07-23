<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  beginPluginPairing,
  cancelPluginPairing,
  cancelPluginPairingKeepalive,
  completePluginPairing,
} from "./api";
import {
  clearPluginPairingSession,
  loadPluginPairingSession,
  savePluginPairingSession,
} from "./session";

type PageState =
  | "ready"
  | "redirecting"
  | "completing"
  | "complete"
  | "cancelled"
  | "error";

const pageState = ref<PageState>("ready");
const errorMessage = ref("");
const query = new URLSearchParams(window.location.search);
const fragment = new URLSearchParams(window.location.hash.slice(1));
const initialPairingId = query.get("pairing_id") ?? "";
const hasQueryPairingSecret = query.has("pairing_secret");
const initialPairingSecret = hasQueryPairingSecret
  ? ""
  : (fragment.get("pairing_secret") ?? "");
const isCallback = window.location.pathname.endsWith("/plugin/pair/callback");
const authorizationCode = query.get("code") ?? "";
const returnedState = query.get("state") ?? "";
const oauthError = query.get("error");
let intentionalOAuthNavigation = false;

const scrubbedQuery = new URLSearchParams();
if (!isCallback && initialPairingId) {
  scrubbedQuery.set("pairing_id", initialPairingId);
}
const scrubbedSearch = scrubbedQuery.toString();
if (isCallback) {
  window.history.replaceState(window.history.state, "", window.location.pathname);
} else {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${scrubbedSearch ? `?${scrubbedSearch}` : ""}`,
  );
}

const statusLabel = computed(() => {
  const labels: Record<PageState, string> = {
    ready: "等待认领",
    redirecting: "正在打开公司账号验证",
    completing: "正在确认设备归属",
    complete: "设备认领完成",
    cancelled: "本次认领已取消",
    error: "设备认领未完成",
  };
  return labels[pageState.value];
});

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function callbackUri(): string {
  return new URL(
    `${import.meta.env.BASE_URL}plugin/pair/callback`,
    window.location.origin,
  ).toString();
}

async function claimDevice(): Promise<void> {
  if (hasQueryPairingSecret || !initialPairingId || !initialPairingSecret) {
    pageState.value = "error";
    errorMessage.value = "配对请求无效或已过期。";
    clearPluginPairingSession();
    return;
  }
  pageState.value = "redirecting";
  errorMessage.value = "";
  const state = randomBase64Url(24);
  const nonce = randomBase64Url(24);
  const pkceVerifier = randomBase64Url(48);
  const targetCallbackUri = callbackUri();
  savePluginPairingSession({
    pairingId: initialPairingId,
    pairingSecret: initialPairingSecret,
    state,
    nonce,
    pkceVerifier,
    callbackUri: targetCallbackUri,
  });
  try {
    const result = await beginPluginPairing({
      pairing_id: initialPairingId,
      pairing_secret: initialPairingSecret,
      state,
      nonce,
      pkce_challenge: await sha256Base64Url(pkceVerifier),
      callback_uri: targetCallbackUri,
    });
    intentionalOAuthNavigation = true;
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    intentionalOAuthNavigation = false;
    try {
      await cancelPluginPairing({
        pairing_id: initialPairingId,
        pairing_secret: initialPairingSecret,
      });
    } catch {
      // 请求可能已完成、取消或过期, 不覆盖原始错误.
    }
    clearPluginPairingSession();
    pageState.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "配对请求未完成。";
  }
}

async function cancelClaim(): Promise<void> {
  const session = loadPluginPairingSession();
  const pairingId = session?.pairingId ?? initialPairingId;
  const pairingSecret = session?.pairingSecret ?? initialPairingSecret;
  try {
    if (pairingId && pairingSecret) {
      await cancelPluginPairing({
        pairing_id: pairingId,
        pairing_secret: pairingSecret,
      });
    }
  } catch {
    // 服务端仍会按短期过期时间清理无法送达的取消请求.
  } finally {
    clearPluginPairingSession();
    pageState.value = "cancelled";
  }
}

async function completeClaim(): Promise<void> {
  pageState.value = "completing";
  const session = loadPluginPairingSession();
  if (
    !session ||
    oauthError ||
    !authorizationCode ||
    returnedState !== session.state
  ) {
    if (session) {
      try {
        await cancelPluginPairing({
          pairing_id: session.pairingId,
          pairing_secret: session.pairingSecret,
        });
      } catch {
        // 请求已完成或已过期时不覆盖原始 OAuth 错误状态.
      }
    }
    clearPluginPairingSession();
    pageState.value = "error";
    errorMessage.value = "公司账号验证结果无效，请从插件重新发起绑定。";
    return;
  }
  try {
    await completePluginPairing({
      pairing_id: session.pairingId,
      pairing_secret: session.pairingSecret,
      state: returnedState,
      callback_uri: session.callbackUri,
      authorization_code: authorizationCode,
      pkce_verifier: session.pkceVerifier,
    });
    clearPluginPairingSession();
    pageState.value = "complete";
  } catch (error) {
    try {
      await cancelPluginPairing({
        pairing_id: session.pairingId,
        pairing_secret: session.pairingSecret,
      });
    } catch {
      // 请求可能已完成、取消或过期, 不覆盖原始错误.
    }
    clearPluginPairingSession();
    pageState.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "设备认领未完成。";
  }
}

function cancelOnPageHide(): void {
  if (
    intentionalOAuthNavigation ||
    pageState.value === "complete" ||
    pageState.value === "cancelled"
  ) {
    return;
  }
  const session = loadPluginPairingSession();
  const pairingId = session?.pairingId ?? initialPairingId;
  const pairingSecret = session?.pairingSecret ?? initialPairingSecret;
  if (pairingId && pairingSecret) {
    cancelPluginPairingKeepalive({
      pairing_id: pairingId,
      pairing_secret: pairingSecret,
    });
  }
  clearPluginPairingSession();
}

onMounted(() => {
  window.addEventListener("pagehide", cancelOnPageHide);
  if (isCallback) {
    void completeClaim();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("pagehide", cancelOnPageHide);
});
</script>

<template>
  <main class="pairing-shell">
    <section class="pairing-panel" aria-labelledby="pairing-title">
      <div class="pairing-ticket" :data-state="pageState">
        <span class="ticket-mark" aria-hidden="true"></span>
        <span>TL ART TOOL</span>
        <strong>{{ statusLabel }}</strong>
      </div>

      <div class="pairing-content">
        <p class="pairing-kicker">公司账号 · 插件设备绑定</p>
        <h1 id="pairing-title">{{ statusLabel }}</h1>

        <template v-if="pageState === 'ready'">
          <p class="pairing-message">确认后将打开公司的 Google 账号验证页面。</p>
          <div class="pairing-actions">
            <button class="primary-action" type="button" @click="claimDevice">
              认领此设备
            </button>
            <button class="secondary-action" type="button" @click="cancelClaim">
              取消
            </button>
          </div>
        </template>

        <template v-else-if="pageState === 'redirecting' || pageState === 'completing'">
          <div class="progress-line" role="status" aria-live="polite">
            <span></span>
          </div>
        </template>

        <template v-else-if="pageState === 'complete'">
          <p class="pairing-message">可以关闭此页面并返回 UE 编辑器。</p>
        </template>

        <template v-else-if="pageState === 'cancelled'">
          <p class="pairing-message">可以关闭此页面。</p>
        </template>

        <template v-else-if="pageState === 'error'">
          <p class="pairing-error" role="alert">{{ errorMessage }}</p>
        </template>
      </div>
    </section>
  </main>
</template>
