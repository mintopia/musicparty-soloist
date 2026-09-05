<script setup lang="ts">
import { PhEye, PhEyeSlash } from "@phosphor-icons/vue";
// `off` shows the struck-through eye ("currently visible — click to hide"); default shows
// the open eye.
defineProps<{ off?: boolean }>();
</script>

<template>
  <PhEyeSlash v-if="off" :size="16" weight="fill" aria-hidden="true" />
  <PhEye v-else :size="16" weight="fill" aria-hidden="true" />
</template>
