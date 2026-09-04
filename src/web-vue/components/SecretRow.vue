<script setup lang="ts">
// Masked secret editor. The working-config value is a boolean (true=set, false=unset)
// while masked; clicking Replace swaps it to a string entry field. Never shows the
// stored value. `isSet` is the load-time state, used to restore on Cancel.
const value = defineModel<string | boolean>({ required: true });
defineProps<{ label: string; isSet: boolean }>();
</script>

<template>
  <div>
    <label class="flabel">{{ label }}</label>
    <div class="field box">
      <template v-if="typeof value === 'string'">
        <input class="bare" type="password" placeholder="New value" v-model="value" />
        <a href="#" class="lnk" @click.prevent="value = isSet">Cancel</a>
      </template>
      <template v-else>
        <span class="pill" :class="value ? 'set' : 'unset'">{{ value ? "Set" : "Not set" }}</span>
        <a href="#" class="lnk" @click.prevent="value = ''">Replace</a>
      </template>
    </div>
  </div>
</template>

<style scoped>
.box { display: flex; align-items: center; justify-content: space-between; }
.bare { border: none; background: transparent; padding: 0; box-shadow: none; font-size: 14px; color: var(--txt); flex: 1; font-family: var(--sans); }
.bare:focus { outline: none; }
.pill.set { background: var(--ind-s); color: var(--ind); }
.pill.unset { background: var(--warn-s); color: var(--warn); }
.lnk { font-size: 12px; white-space: nowrap; margin-left: 12px; }
</style>
