<script setup lang="ts">
import { useConfig } from "../composables/useConfig";

// Trivial placeholder: proves useConfig exposes the reactive working copy, dirty
// tracking, and the secretSet map. Real editors land in later view tickets.
const { config, summary, secretSet, dirty, status, loaded } = useConfig();
const sections = () => Object.keys(config);
</script>

<template>
  <section class="card view">
    <h1>Settings</h1>
    <p class="lbl">Config working copy (placeholder — editors land in later tickets)</p>
    <p v-if="!loaded">Loading…</p>
    <template v-else>
      <p>Sections: {{ sections().join(", ") || "none" }}</p>
      <p>Dirty: {{ dirty }} · Status: {{ status }} · Pending restart: {{ summary.pendingRestart ?? false }}</p>
      <p>Secrets set: {{ Object.entries(secretSet).filter(([, v]) => v).map(([k]) => k).join(", ") || "none" }}</p>
    </template>
  </section>
</template>

<style scoped>
p { font-size: 14px; }
</style>
