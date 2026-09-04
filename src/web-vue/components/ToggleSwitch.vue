<script setup lang="ts">
defineProps<{ on: boolean; label?: string }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button" class="sw" :class="on ? 'on' : 'off'"
    role="switch" :aria-checked="on" :aria-label="label"
    @click="$emit('toggle')"
  ><i></i></button>
</template>
