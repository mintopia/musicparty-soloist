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
.field { width: 100%; }
</style>
