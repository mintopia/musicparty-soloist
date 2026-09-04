<script setup lang="ts">
import { ref } from "vue";

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
  <div class="wrap">
    <div class="col">
      <div class="head">
        <div class="mark">
          <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
        </div>
        <div class="title">Set up Soloist Proxy</div>
      </div>
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
    </div>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
.col { width: 400px; }
.head { text-align: center; margin-bottom: 24px; }
.mark {
  width: 48px; height: 48px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(140deg, var(--ind-h), var(--ind)); box-shadow: 0 8px 22px rgba(13, 148, 136, .28);
}
.title { font-family: var(--disp); font-size: 22px; font-weight: 700; letter-spacing: -.01em; margin-top: 15px; }
.card { padding: 26px; }
.err { margin-bottom: 16px; padding: 10px 14px; border-radius: 11px; background: var(--bad-s); color: var(--bad); font-size: 13px; font-weight: 600; }
.fgroup { margin-bottom: 16px; }
.fgroup.last { margin-bottom: 20px; }
.field { width: 100%; display: block; }
.lbl { display: block; margin-bottom: 6px; }
.btn.wide { width: 100%; justify-content: center; }
.note { display: flex; gap: 9px; margin-top: 18px; padding: 12px 14px; background: var(--ind-s); border-radius: 11px; }
.note svg { flex: 0 0 auto; margin-top: 1px; }
.note div { font-size: 12.5px; color: var(--ind-h); line-height: 1.5; }
</style>
