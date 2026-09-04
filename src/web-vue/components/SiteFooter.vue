<template>
  <footer class="foot">
    <span>Made with <svg class="heart" width="13" height="13" viewBox="0 0 24 24" aria-label="love"><path d="M12 21s-7.5-4.9-10-9.1C.4 8.6 2 5 5.4 5c2 0 3.4 1.1 4.6 2.6C11.2 6.1 12.6 5 14.6 5 18 5 19.6 8.6 22 11.9 19.5 16.1 12 21 12 21z"/></svg> by
      <a href="https://github.com/mintopia" target="_blank" rel="noopener">Mintopia</a></span>
  </footer>
</template>

<style scoped>
.foot {
  text-align: center; padding: 20px 16px; font-size: 12px; color: var(--faint);
}
.heart { fill: var(--faint); vertical-align: -2px; transition: fill .15s; }
.foot:hover .heart { fill: #ec4899; }
.foot a { color: inherit; text-decoration: none; }
.foot a:hover { text-decoration: underline; }
</style>
