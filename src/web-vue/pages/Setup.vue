<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { PhInfo } from "@phosphor-icons/vue";
import AuthShell from "../components/AuthShell.vue";

// Must match MIN_PASSWORD_LENGTH in web.ts — the server is the authority (UX-M8).
const MIN_PASSWORD_LENGTH = 8;

// Standalone first-run entry (ADR-0014): native form POST to /setup — the server owns
// the 302 and re-serves /setup?error=1 on a mismatch. Mirror the password guards
// client-side so the obvious cases fail fast without a round-trip.
const showError = ref(false);
const clientError = ref(false);
const password = ref("");
const confirm = ref("");
const passwordEl = ref<HTMLInputElement>();
const confirmEl = ref<HTMLInputElement>();
const passwordInvalid = ref(false);
const confirmInvalid = ref(false);

// A server-side ?error=1 means the POST was rejected (mismatch or too short); the server
// doesn't say which field, so flag both and focus the password to start. Reveal the banner
// after mount, not during the first render, so its role=alert is actually announced.
onMounted(() => {
  if (new URLSearchParams(location.search).has("error")) {
    showError.value = true;
    passwordInvalid.value = true;
    confirmInvalid.value = true;
    passwordEl.value?.focus();
  }
});

// Lightweight length-and-variety strength cue; not a gate beyond the 8-char minimum.
const strength = computed(() => {
  const p = password.value;
  if (!p) return null;
  if (p.length < MIN_PASSWORD_LENGTH) return { level: "short", label: `At least ${MIN_PASSWORD_LENGTH} characters` };
  let score = 0;
  if (p.length >= 12) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^a-zA-Z0-9]/.test(p)) score++;
  if (score <= 1) return { level: "weak", label: "Weak password" };
  if (score === 2) return { level: "fair", label: "Fair password" };
  return { level: "strong", label: "Strong password" };
});

function onSubmit(e: Event) {
  passwordInvalid.value = false;
  confirmInvalid.value = false;
  if (password.value.length < MIN_PASSWORD_LENGTH) {
    e.preventDefault();
    clientError.value = true;
    passwordInvalid.value = true;
    passwordEl.value?.focus();
    return;
  }
  if (password.value !== confirm.value) {
    e.preventDefault();
    clientError.value = true;
    confirmInvalid.value = true;
    confirmEl.value?.focus();
  }
}
</script>

<template>
  <AuthShell title="Set up Soloist Proxy">
    <form class="card glass" method="POST" action="/setup" @submit="onSubmit">
      <div v-if="showError || clientError" class="err" role="alert">Passwords must match and be at least {{ MIN_PASSWORD_LENGTH }} characters.</div>
      <div class="fgroup">
        <label class="lbl" for="username">Username</label>
        <input class="field" id="username" name="username" value="admin" autocomplete="username" autofocus required />
      </div>
      <div class="fgroup">
        <label class="lbl" for="password">Password</label>
        <input ref="passwordEl" class="field" id="password" name="password" type="password" autocomplete="new-password" placeholder="Choose a strong password" required v-model="password" :aria-invalid="passwordInvalid || undefined" />
        <div v-if="strength" class="pw-hint" :class="strength.level">{{ strength.label }}</div>
      </div>
      <div class="fgroup last">
        <label class="lbl" for="confirm">Confirm password</label>
        <input ref="confirmEl" class="field" id="confirm" name="confirm" type="password" autocomplete="new-password" placeholder="Repeat it" required v-model="confirm" :aria-invalid="confirmInvalid || undefined" />
      </div>
      <button class="btn pri wide" type="submit">Create account &amp; continue</button>
      <div class="note">
        <PhInfo class="note-ic" :size="16" weight="fill" />
        <div>Saved into <b>config.yaml</b>. Everything else — Spotify key, outputs, webhooks — is configured after you sign in.</div>
      </div>
    </form>
  </AuthShell>
</template>

<style scoped>
.pw-hint { margin-top: 6px; font-size: 12px; font-weight: 600; }
.pw-hint.short { color: var(--faint); }
.pw-hint.weak { color: var(--bad); }
.pw-hint.fair { color: var(--warn); }
.pw-hint.strong { color: var(--ok); }
.note { display: flex; gap: 9px; margin-top: 18px; padding: 12px 14px; background: var(--ind-s); border-radius: 11px; }
.note svg { flex: 0 0 auto; margin-top: 1px; color: var(--ind); }
.note div { font-size: 12.5px; color: var(--ind-h); line-height: 1.5; }
</style>
