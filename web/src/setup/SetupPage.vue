<script setup lang="ts">
import { ref } from "vue";

// First-run only: native form POST to /setup writes web creds to the Config File,
// then the server 302s to /login (web.ts handleSetup, ADR-0010). Server rejects
// empty/mismatched creds with /setup?error=1; we also guard client-side so the
// mismatch is caught before the round-trip.
const hasError = ref(new URLSearchParams(location.search).has("error"));
const password = ref("");
const confirm = ref("");

function onSubmit(e: Event) {
  if (!password.value || password.value !== confirm.value) {
    e.preventDefault();
    hasError.value = true;
  }
}
</script>

<template>
  <div class="wrap">
    <div class="col">
      <div class="head">
        <div class="mark">
          <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
        </div>
        <div class="title">Welcome to Soloist Proxy</div>
        <div class="sub">Create the admin account for this console.<br>It's the only step before you sign in.</div>
      </div>

      <form class="card" method="POST" action="/setup" @submit="onSubmit">
        <div v-if="hasError" class="err">Passwords must match and cannot be empty.</div>
        <div class="row">
          <label class="lbl" for="username">Username</label>
          <input class="field" id="username" name="username" value="admin" autocomplete="username" autofocus required>
        </div>
        <div class="row">
          <label class="lbl" for="password">Password</label>
          <input class="field" id="password" name="password" type="password" v-model="password" autocomplete="new-password" placeholder="Choose a strong password" required>
        </div>
        <div class="row wide">
          <label class="lbl" for="confirm">Confirm password</label>
          <input class="field" id="confirm" name="confirm" type="password" v-model="confirm" autocomplete="new-password" placeholder="Repeat it" required>
        </div>
        <button class="btn pri" type="submit">Create account &amp; continue</button>
        <div class="note">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ind)" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          <div>Saved into <b>config.yaml</b>. Everything else — Spotify key, outputs, webhooks — is configured after you sign in.</div>
        </div>
      </form>

      <div class="steps">
        <span class="stepset"><span class="step on">1</span>Admin</span>
        <span class="bar"></span>
        <span class="stepset"><span class="step">2</span>Sign in</span>
        <span class="bar"></span>
        <span class="stepset"><span class="step">3</span>Configure</span>
      </div>
      <div class="foot">First-run setup</div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px;
  background-image:
    radial-gradient(680px 420px at 50% -6%, #dcf3ef, transparent 70%),
    radial-gradient(520px 360px at 88% 92%, rgba(6, 182, 212, .10), transparent 65%);
}
.col { width: 440px; }
.head { text-align: center; margin-bottom: 26px; }
.mark {
  width: 52px; height: 52px; border-radius: 15px;
  background: linear-gradient(140deg, #14b8a6, #0d9488);
  display: inline-flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 24px rgba(13, 148, 136, .30);
}
.title { font-family: var(--disp); font-size: 24px; font-weight: 700; letter-spacing: -.015em; margin-top: 16px; }
.sub { font-size: 14px; color: var(--dim); margin-top: 6px; line-height: 1.5; }
.card {
  background: rgba(255, 255, 255, .72);
  backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, .75); border-radius: 18px;
  box-shadow: 0 16px 48px rgba(30, 30, 40, .12), inset 0 1px 0 rgba(255, 255, 255, .9);
  padding: 26px;
}
.row { margin-bottom: 16px; }
.row.wide { margin-bottom: 20px; }
.note {
  display: flex; gap: 9px; margin-top: 18px; padding: 12px 14px;
  background: var(--ind-s); border-radius: 11px;
}
.note svg { flex: 0 0 auto; margin-top: 1px; }
.note div { font-size: 12.5px; color: #0b5c54; line-height: 1.5; }
.steps {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  margin-top: 22px; color: var(--faint); font-size: 12px;
}
.stepset { display: flex; align-items: center; gap: 7px; }
.step {
  width: 26px; height: 26px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 12px; font-weight: 700;
  background: #ecece8; color: var(--faint);
}
.step.on { background: var(--ind); color: #fff; }
.bar { width: 22px; height: 1px; background: var(--line2); }
.foot { text-align: center; margin-top: 22px; font-size: 11px; color: var(--faint); }
</style>
