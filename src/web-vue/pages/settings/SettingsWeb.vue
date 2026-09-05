<script setup lang="ts">
import { useConfig } from "../../composables/useConfig";
import SectionCard from "../../components/SectionCard.vue";
import TextField from "../../components/TextField.vue";
import SecretRow from "../../components/SecretRow.vue";

const { config, secretSet, loaded } = useConfig();
const c = config as any;
</script>

<template>
  <div v-if="!loaded" class="lbl">Loading…</div>
  <SectionCard v-else title="Web Access" subtitle="Credentials for signing in to this console.">
    <div class="grid2">
      <TextField label="Username" v-model="c.web.username" />
      <SecretRow
        label="Password" section="web" field-key="password"
        :is-set="secretSet['web.password']" v-model="c.web.password"
      />
    </div>
  </SectionCard>
</template>

<style scoped>
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px; align-items: start; }
@media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
</style>
