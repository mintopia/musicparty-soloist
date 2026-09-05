<script setup lang="ts">
import { PhMusicNotesSimple } from "@phosphor-icons/vue";
import SiteFooter from "./SiteFooter.vue";

// Shared chrome for the standalone auth entries (Login, Setup): centered card column,
// brand mark, title, and footer. The page slots its own <form class="card glass">; the
// form's fields are styled here via :slotted so both pages stay in sync (ADR-0014).
defineProps<{ title: string }>();
</script>

<template>
  <div class="wrap">
    <div class="col">
      <div class="head">
        <div class="mark">
          <PhMusicNotesSimple :size="26" weight="bold" color="#fff" />
        </div>
        <div class="title">{{ title }}</div>
      </div>
      <slot />
    </div>
    <SiteFooter />
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 20px; }
.col { width: 400px; margin: auto; }
.head { text-align: center; margin-bottom: 24px; }
.mark {
  width: 48px; height: 48px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(140deg, var(--ind-h), var(--ind)); box-shadow: 0 8px 22px rgba(13, 148, 136, .28);
}
.title { font-family: var(--disp); font-size: 22px; font-weight: 700; letter-spacing: -.01em; margin-top: 15px; }
/* The slotted <form> and its fields (parent-owned DOM, reached via :slotted). */
:slotted(.card) { padding: 26px; }
:slotted(.err) { margin-bottom: 16px; padding: 10px 14px; border-radius: 11px; background: var(--bad-s); color: var(--bad); font-size: 13px; font-weight: 600; }
:slotted(.fgroup) { margin-bottom: 16px; }
:slotted(.fgroup.last) { margin-bottom: 20px; }
:slotted(.field) { width: 100%; display: block; }
:slotted(.lbl) { display: block; margin-bottom: 6px; }
:slotted(.btn.wide) { width: 100%; justify-content: center; }
</style>
