<script setup lang="ts">
import { ref } from "vue";
import AuthShell from "../components/AuthShell.vue";

// Standalone first-run entry (ADR-0014): native form POST to /setup — the server owns
// the 302 and re-serves /setup?error=1 on a mismatch. Mirror that password-match guard
// client-side so the obvious case fails fast without a round-trip.
const showError = new URLSearchParams(location.search).has("error");
const clientError = ref(false);
const password = ref("");
const confirm = ref("");

function onSubmit(e: Event) {
  if (!password.value || password.value !== confirm.value) {
    e.preventDefault();
    clientError.value = true;
  }
}
</script>

<template>
  <AuthShell title="Set up Soloist Proxy">
    <form class="card glass" method="POST" action="/setup" @submit="onSubmit">
      <div v-if="showError || clientError" class="err">Passwords must match and cannot be empty.</div>
      <div class="fgroup">
        <label class="lbl" for="username">Username</label>
        <input class="field" id="username" name="username" value="admin" autocomplete="username" autofocus required />
      </div>
      <div class="fgroup">
        <label class="lbl" for="password">Password</label>
        <input class="field" id="password" name="password" type="password" autocomplete="new-password" placeholder="Choose a strong password" required v-model="password" />
      </div>
      <div class="fgroup last">
        <label class="lbl" for="confirm">Confirm password</label>
        <input class="field" id="confirm" name="confirm" type="password" autocomplete="new-password" placeholder="Repeat it" required v-model="confirm" />
      </div>
      <button class="btn pri wide" type="submit">Create account &amp; continue</button>
      <div class="note">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ind)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
        <div>Saved into <b>config.yaml</b>. Everything else — Spotify key, outputs, webhooks — is configured after you sign in.</div>
      </div>
    </form>
  </AuthShell>
</template>

<style scoped>
.note { display: flex; gap: 9px; margin-top: 18px; padding: 12px 14px; background: var(--ind-s); border-radius: 11px; }
.note svg { flex: 0 0 auto; margin-top: 1px; }
.note div { font-size: 12.5px; color: var(--ind-h); line-height: 1.5; }
</style>
