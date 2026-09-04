<script setup lang="ts">
import { ref } from "vue";
import { useConfig } from "../composables/useConfig";

const props = defineProps<{
  label: string;
  section: string;
  fieldKey: string;
  isSet: boolean;
  revealable?: boolean;
}>();

// Masked secret: `true` = stored, `false` = unset, a string = a new plaintext the
// operator is entering. dirty tracking is automatic (the working copy is reactive),
// so no markDirty call is needed on edit.
const model = defineModel<boolean | string>({ required: true });
const { revealSecret } = useConfig();

const revealed = ref(false);
const revealedValue = ref("");

function replace() {
  model.value = "";
  revealed.value = false;
}
function cancel() {
  model.value = props.isSet;
  revealed.value = false;
}
async function view() {
  try {
    revealedValue.value = await revealSecret(props.section, props.fieldKey);
    revealed.value = true;
  } catch { /* leave masked */ }
}
</script>

<template>
  <div class="sr">
    <label class="flabel">{{ label }}</label>
    <div class="field row box">
      <template v-if="typeof model === 'string'">
        <input class="bare" type="password" placeholder="New value" v-model="model" />
        <a href="#" @click.prevent="cancel">Cancel</a>
      </template>
      <template v-else-if="revealed">
        <input class="bare mono" readonly :value="revealedValue" />
        <a href="#" @click.prevent="revealed = false">Hide</a>
        <a href="#" @click.prevent="replace">Replace</a>
      </template>
      <template v-else>
        <span class="pill" :class="isSet ? 'set' : 'unset'">{{ isSet ? "Set" : "Not set" }}</span>
        <a v-if="revealable && isSet" href="#" @click.prevent="view">View</a>
        <a href="#" @click.prevent="replace">Replace</a>
      </template>
    </div>
  </div>
</template>

<style scoped>
.flabel {
  font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase;
  color: var(--dim); margin-bottom: 6px; display: block;
}
.box { justify-content: space-between; }
.box .pill { margin-right: auto; }
.pill.set { background: var(--ind-s); color: var(--ind); }
.pill.unset { background: var(--warn-s); color: var(--warn); }
.bare {
  flex: 1; min-width: 0; border: none; background: transparent; padding: 0;
  box-shadow: none; font: inherit; color: inherit;
}
.bare:focus { outline: none; box-shadow: none; }
.bare.mono { font-family: ui-monospace, monospace; font-size: 13px; }
.sr a { font-size: 12px; white-space: nowrap; margin-left: 12px; }
</style>
