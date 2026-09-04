<script setup lang="ts">
import { ref, onMounted } from "vue";
import { highlightJson } from "../lib/highlight";
import "highlight.js/styles/github.css";

// Stub Debug view — its only job for T7 is to establish the lazy async chunk that pulls
// in hljs + the theme CSS (ADR-0018). The real inspector UI lands in T10 (#33). v-html
// receives only highlightJson's HTML-escaped output (ADR-0016 XSS boundary).
const html = ref("");

onMounted(async () => {
  html.value = await highlightJson(JSON.stringify({ soloist: "debug", ready: true }, null, 2));
});
</script>

<template>
  <section class="debug">
    <h1>Debug</h1>
    <pre class="hljs"><code v-html="html"></code></pre>
  </section>
</template>

<style scoped>
.debug h1 { font-family: var(--disp); font-size: 20px; font-weight: 700; margin: 0 0 16px; }
.debug pre { border: 1px solid var(--line2); border-radius: 12px; padding: 16px; overflow: auto; font-size: 13px; }
</style>
