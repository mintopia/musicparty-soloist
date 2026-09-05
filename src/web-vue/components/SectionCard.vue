<script setup lang="ts">
import { useConfig } from "../composables/useConfig";
defineProps<{ title?: string; subtitle?: string }>();
const { trySave } = useConfig();
</script>

<template>
  <form class="card sect" @submit.prevent="trySave">
    <header v-if="title || $slots.action" class="sect-head">
      <div class="sect-heading">
        <div v-if="title" class="sect-title">{{ title }}</div>
        <div v-if="subtitle" class="sect-sub">{{ subtitle }}</div>
      </div>
      <div v-if="$slots.action" class="sect-action"><slot name="action" /></div>
    </header>
    <slot />
    <!-- Hidden default button: without a submit button the browser skips implicit
         submission on forms with more than one field, so Enter would do nothing. -->
    <button type="submit" class="sr-submit" tabindex="-1" aria-hidden="true"></button>
  </form>
</template>

<style scoped>
.sect { padding: 22px; margin-bottom: 18px; }
.sect-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.sect-heading { min-width: 0; }
.sect-title { font-family: var(--disp); font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
.sect-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
.sect-action { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; }
.sr-submit { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
</style>
