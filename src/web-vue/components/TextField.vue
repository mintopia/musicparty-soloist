<script setup lang="ts">
import { useId } from "vue";
defineProps<{ label: string; placeholder?: string }>();
const model = defineModel<string>({ required: true });
const id = useId();
</script>

<template>
  <div class="tf">
    <label class="flabel" :for="id">{{ label }}</label>
    <input :id="id" class="field" :placeholder="placeholder" v-model="model" />
  </div>
</template>

<style scoped>
.field { width: 100%; }
</style>
