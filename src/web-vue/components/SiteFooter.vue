<script setup lang="ts">
import { PhHeart } from "@phosphor-icons/vue";
</script>

<template>
  <footer class="foot">
    <a class="credit" href="https://github.com/mintopia" target="_blank" rel="noopener">Made with <span class="heart" aria-label="love"><PhHeart class="h-out" :size="13" weight="regular" /><PhHeart class="h-fill" :size="13" weight="fill" /></span> by Mintopia</a>
  </footer>
</template>

<style scoped>
.foot { text-align: center; padding: 20px 16px; font-size: 12px; }
.credit { color: var(--faint); text-decoration: none; }
.credit:hover { text-decoration: none; }
.heart { display: inline-flex; vertical-align: -2px; color: var(--faint); transition: color .15s; }
/* Outline by default; on hover of the text it fills and goes pink. */
.h-fill { display: none; }
.credit:hover .h-out { display: none; }
.credit:hover .h-fill { display: inline-flex; }
.credit:hover .heart { color: #ec4899; }
</style>
