<script setup lang="ts">
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <div class="card sect">
    <header v-if="title || $slots.action" class="sect-head">
      <div class="sect-heading">
        <div v-if="title" class="sect-title">{{ title }}</div>
        <div v-if="subtitle" class="sect-sub">{{ subtitle }}</div>
      </div>
      <div v-if="$slots.action" class="sect-action"><slot name="action" /></div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.sect { padding: 22px; margin-bottom: 18px; }
.sect-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 16px; }
.sect-heading { min-width: 0; }
.sect-title { font-family: var(--disp); font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
.sect-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
.sect-action { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; }
</style>
