<script setup lang="ts">
import { useConfig } from "../../composables/useConfig";
import SectionCard from "../../components/SectionCard.vue";
import ToggleSwitch from "../../components/ToggleSwitch.vue";

const { config, loaded } = useConfig();
const c = config as any;

// Placeholder tokens shown in the Snapcast config hint. Kept as string constants because a
// literal "{{…}}" in the template would be parsed as a Vue interpolation.
const streamPh = "{{stream}}";
const snapwebPh = "{{snapweb}}";
</script>

<template>
  <div v-if="!loaded" class="lbl">Loading…</div>
  <SectionCard v-else title="Snapcast" subtitle="Multi-room audio server (Docker). Changes apply after a Snapcast restart.">
    <div class="setrow first">
      <div class="setrow-txt">
        <div class="setrow-title">Enable Snapweb</div>
        <div class="setrow-sub">Serve the Snapcast web UI and link it from the menu.</div>
      </div>
      <ToggleSwitch :on="c.snapweb" label="Enable Snapweb" @toggle="c.snapweb = !c.snapweb" />
    </div>
    <div class="tf snap-conf">
      <label class="flabel">Snapcast server config</label>
      <textarea class="field mono" rows="12" spellcheck="false" v-model="c.snapcastServerConfig"></textarea>
      <div class="dev-hint">
        <code>{{ streamPh }}</code> expands to the capture source line,
        <code>{{ snapwebPh }}</code> to the Snapweb enable flag (true/false).
      </div>
    </div>
  </SectionCard>
</template>

<style scoped>
.setrow { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--line); }
.setrow.first { margin-top: 0; padding-top: 0; border-top: none; }
.setrow-txt { min-width: 0; }
.setrow-title { font-size: 14px; font-weight: 600; }
.setrow-sub { font-size: 12.5px; color: var(--dim); margin-top: 2px; }
.snap-conf { margin-top: 20px; }
.snap-conf .field { width: 100%; box-sizing: border-box; }
.tf .field { width: 100%; }
textarea.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.5; resize: vertical; }
.snap-conf code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--sub); padding: 1px 4px; border-radius: 4px; }
.dev-hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }
</style>
