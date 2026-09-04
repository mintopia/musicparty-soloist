<script setup lang="ts">
import AuthShell from "../components/AuthShell.vue";
// Standalone auth entry (ADR-0014): a native form POST to /login — the server owns the
// 302 redirect and sets ?error=1 on a bad credential, which we surface as the banner.
const showError = new URLSearchParams(location.search).has("error");
</script>

<template>
  <AuthShell title="Sign in to Soloist Proxy">
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
  </AuthShell>
</template>
