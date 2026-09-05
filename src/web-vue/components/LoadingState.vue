<template>
  <div class="loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span class="loading-txt">Loading…</span>
  </div>
</template>

<style scoped>
.loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 40px 0; color: var(--faint);
}
.spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 3px solid var(--line2); border-top-color: var(--ind);
  animation: ls-spin .7s linear infinite;
}
.loading-txt { font-size: 13px; font-weight: 500; letter-spacing: .01em; }
@keyframes ls-spin { to { transform: rotate(360deg); } }
/* Keep a slow rotation rather than freezing, so the state still reads as "working". */
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 1.6s; }
}
</style>
