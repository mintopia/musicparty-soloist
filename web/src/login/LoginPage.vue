<script setup lang="ts">
// Native form POST to /login; the server sets the session cookie and 302s to /.
// Bad creds bounce back to /login?error=1 (web.ts handleLogin), shown here.
const hasError = new URLSearchParams(location.search).has("error");
</script>

<template>
  <div class="wrap">
    <div class="col">
      <div class="head">
        <div class="mark">
          <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>
        </div>
        <div class="title">Sign in to Soloist Proxy</div>
      </div>
      <form class="card" method="POST" action="/login">
        <div v-if="hasError" class="err">Incorrect username or password.</div>
        <div class="row">
          <label class="lbl" for="username">Username</label>
          <input class="field" id="username" name="username" autocomplete="username" autofocus required>
        </div>
        <div class="row last">
          <label class="lbl" for="password">Password</label>
          <input class="field" id="password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn pri" type="submit">Sign in</button>
      </form>
      <div class="foot">Session kept in a signed, HttpOnly cookie</div>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px;
  background-image:
    radial-gradient(620px 380px at 50% -8%, #dcf3ef, transparent 70%),
    radial-gradient(460px 320px at 90% 94%, rgba(6, 182, 212, .09), transparent 65%);
}
.col { width: 400px; }
.head { text-align: center; margin-bottom: 24px; }
.mark {
  width: 48px; height: 48px; border-radius: 14px;
  background: linear-gradient(140deg, #14b8a6, #0d9488);
  display: inline-flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 22px rgba(13, 148, 136, .28);
}
.title { font-family: var(--disp); font-size: 22px; font-weight: 700; letter-spacing: -.01em; margin-top: 15px; }
.card {
  background: rgba(255, 255, 255, .72);
  backdrop-filter: blur(20px) saturate(1.4); -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, .75); border-radius: 18px;
  box-shadow: 0 16px 48px rgba(30, 30, 40, .12), inset 0 1px 0 rgba(255, 255, 255, .9);
  padding: 26px;
}
.row { margin-bottom: 16px; }
.row.last { margin-bottom: 22px; }
.foot { text-align: center; margin-top: 22px; font-size: 12px; color: var(--faint); }
</style>
