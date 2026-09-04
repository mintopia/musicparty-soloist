<script setup lang="ts">
defineProps<{ label: string; placeholder?: string }>();
const model = defineModel<string>({ required: true });
</script>

<template>
  <div class="tf">
    <label class="flabel">{{ label }}</label>
    <input class="field" :placeholder="placeholder" v-model="model" />
  </div>
</template>

<style scoped>
.flabel {
  font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
  color: var(--dim); margin-bottom: 6px; display: block;
}
.field { width: 100%; }
</style>
