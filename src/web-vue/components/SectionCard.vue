<script setup lang="ts">
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <div class="card sect">
    <header v-if="title" class="sect-head">
      <div class="sect-title">{{ title }}</div>
      <div v-if="subtitle" class="sect-sub">{{ subtitle }}</div>
    </header>
    <slot />
  </div>
</template>

<style scoped>
.sect { padding: 22px; margin-bottom: 18px; }
.sect-head { margin-bottom: 16px; }
.sect-title { font-family: var(--disp); font-size: 16px; font-weight: 700; }
.sect-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
</style>
