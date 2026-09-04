<script setup lang="ts">
import SiteFooter from "../components/SiteFooter.vue";
// Standalone auth entry (ADR-0014): a native form POST to /login — the server owns the
// 302 redirect and sets ?error=1 on a bad credential, which we surface as the banner.
const showError = new URLSearchParams(location.search).has("error");
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
      <form class="card glass" method="POST" action="/login">
        <div v-if="showError" class="err">Incorrect username or password.</div>
        <div class="fgroup">
          <label class="lbl" for="username">Username</label>
          <input class="field" id="username" name="username" autocomplete="username" autofocus required />
        </div>
        <div class="fgroup last">
          <label class="lbl" for="password">Password</label>
          <input class="field" id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="btn pri wide" type="submit">Sign in</button>
      </form>
    </div>
    <SiteFooter />
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 40px 20px;
}
.col { width: 400px; margin: auto; }
.head { text-align: center; margin-bottom: 24px; }
.mark {
  width: 48px; height: 48px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(140deg, var(--ind-h), var(--ind)); box-shadow: 0 8px 22px rgba(13, 148, 136, .28);
}
.title { font-family: var(--disp); font-size: 22px; font-weight: 700; letter-spacing: -.01em; margin-top: 15px; }
.card { padding: 26px; }
.err { margin-bottom: 16px; padding: 10px 14px; border-radius: 11px; background: var(--bad-s); color: var(--bad); font-size: 13px; font-weight: 600; }
.fgroup { margin-bottom: 16px; }
.fgroup.last { margin-bottom: 22px; }
.field { width: 100%; display: block; }
.lbl { display: block; margin-bottom: 6px; }
.btn.wide { width: 100%; justify-content: center; }
</style>
