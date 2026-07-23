<script setup lang="ts">
import { defineAsyncComponent } from "vue";

const ActivePage = defineAsyncComponent(() => import("./portal/PortalApp.vue"));
</script>

<template>
  <ActivePage />
</template>
