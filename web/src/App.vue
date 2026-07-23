<script setup lang="ts">
import { defineAsyncComponent } from "vue";

const isPluginPairingRoute = window.location.pathname.includes("/plugin/pair");
const ActivePage = defineAsyncComponent(() => isPluginPairingRoute
  ? import("./plugin-pairing/PluginPairingPage.vue")
  : import("./portal/PortalApp.vue"));
</script>

<template>
  <ActivePage />
</template>
