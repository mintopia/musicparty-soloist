<script setup lang="ts">
import { ref } from "vue";
import { useConfig } from "../composables/useConfig";
import EyeIcon from "./EyeIcon.vue";

const props = defineProps<{
  label: string;
  section?: string;
  fieldKey?: string;
  isSet: boolean;
  optional?: boolean;
  revealable?: boolean;
  hint?: string;
}>();

// Masked secret: `true` = stored, `false` = unset, a string = a new plaintext the
// operator is entering. dirty tracking is automatic (the working copy is reactive),
// so no markDirty call is needed on edit.
// Order matters: String must precede Boolean in the inferred runtime prop type,
// or Vue's boolean-attribute coercion casts the "" edit sentinel back to `true`
// and the edit input never renders.
const model = defineModel<string | boolean>({ required: true });
const { revealSecret } = useConfig();

const revealed = ref(false);
const revealedValue = ref("");
const show = ref(false); // whether the new-value input is unmasked

function edit() {
  model.value = "";
  revealed.value = false;
  show.value = false;
}
function cancel() {
  model.value = props.isSet;
  revealed.value = false;
  show.value = false;
}
async function view() {
  if (!props.section || !props.fieldKey) return;
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
        <input class="bare" :class="{ mono: show }" :type="show ? 'text' : 'password'" placeholder="New value" v-model="model" />
        <button type="button" class="iconbtn" :title="show ? 'Hide' : 'Show'" @click="show = !show"><EyeIcon :off="show" /></button>
        <button type="button" class="linkbtn" @click="cancel">Cancel</button>
      </template>
      <template v-else-if="revealed">
        <input class="bare mono" readonly :value="revealedValue" />
        <button type="button" class="iconbtn" title="Hide" @click="revealed = false"><EyeIcon off /></button>
        <button type="button" class="linkbtn" @click="edit">Replace</button>
      </template>
      <template v-else>
        <span class="pill" :class="isSet ? 'set' : optional ? 'neutral' : 'unset'">{{ isSet ? "Set" : "Not set" }}</span>
        <button v-if="revealable && isSet" type="button" class="iconbtn" title="View" @click="view"><EyeIcon /></button>
        <button type="button" class="linkbtn" @click="edit">{{ isSet ? "Replace" : "Set" }}</button>
      </template>
    </div>
    <div v-if="hint" class="hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.box { justify-content: space-between; }
.box .pill { margin-right: auto; }
.pill.set { background: var(--ind-s); color: var(--link); }
.pill.unset { background: var(--warn-s); color: var(--warn); }
.pill.neutral { background: var(--line); color: var(--dim); }
.bare {
  flex: 1; min-width: 0; border: none; background: transparent; padding: 0;
  box-shadow: none; font: inherit; color: inherit;
}
.bare:focus { outline: none; box-shadow: none; }
.bare.mono { font-family: ui-monospace, monospace; font-size: 13px; }
.linkbtn {
  font-size: 12px; white-space: nowrap; margin-left: 12px; border: none; background: none;
  padding: 0; cursor: pointer; color: var(--link); font-family: inherit;
}
.linkbtn:hover { color: var(--ind-h); }
.iconbtn {
  display: inline-flex; align-items: center; margin-left: 12px; border: none; background: none;
  padding: 0; cursor: pointer; color: var(--dim);
}
.iconbtn:hover { color: var(--txt); }
.hint { font-size: 11.5px; color: var(--faint); margin-top: 4px; }
</style>
