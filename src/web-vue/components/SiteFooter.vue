<template>
  <footer class="foot">
    <span>Made with <svg class="heart" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="love"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> by
      <a href="https://github.com/mintopia" target="_blank" rel="noopener">Mintopia</a></span>
  </footer>
</template>

<style scoped>
.foot {
  text-align: center; padding: 20px 16px; font-size: 12px; color: var(--faint);
}
.heart { color: var(--faint); vertical-align: -2px; transition: fill .15s, color .15s; }
.foot:hover .heart { fill: #ec4899; color: #ec4899; }
.foot a { color: inherit; text-decoration: none; }
.foot a:hover { text-decoration: underline; }
</style>
