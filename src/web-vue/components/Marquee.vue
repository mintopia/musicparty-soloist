<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";

// Ping-pong marquee for a single line of text that clips: scrolls to the overflow and
// back, pausing at each end. Ported from src/web/app.js (setScrollingText/animateMarquee).
// Idempotent per text so the 500ms position tick never restarts an in-flight scroll.
const props = defineProps<{ text: string }>();

const clip = ref<HTMLElement | null>(null);
const span = ref<HTMLElement | null>(null);
// Edge-fade masks apply only while the text overflows, so short titles stay crisp and a
// clipped long title reads as "there's more", not a hard cut.
const overflowing = ref(false);

function animate() {
  const c = clip.value, s = span.value;
  if (!c || !s) return;
  s.getAnimations().forEach((a) => a.cancel());
  s.style.transform = "translateX(0)";
  const staticOverflow = s.scrollWidth - c.clientWidth;
  overflowing.value = staticOverflow > 1;
  // Honor reduced-motion: leave the text static (edge-faded) rather than scroll it forever.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  requestAnimationFrame(() => {
    const overflow = s.scrollWidth - c.clientWidth;
    overflowing.value = overflow > 1;
    if (overflow <= 1) return;
    s.animate([
      { transform: "translateX(0)" },
      { transform: "translateX(0)", offset: 0.12 },
      { transform: `translateX(${-overflow}px)`, offset: 0.5 },
      { transform: `translateX(${-overflow}px)`, offset: 0.62 },
      { transform: "translateX(0)" },
    ], { duration: Math.max(6000, overflow * 90), iterations: Infinity, easing: "ease-in-out" });
  });
}

watch(() => props.text, () => nextTick(animate));

let resizeTimer: number | undefined;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(animate, 150);
}

onMounted(() => { animate(); window.addEventListener("resize", onResize); });
onBeforeUnmount(() => window.removeEventListener("resize", onResize));
</script>

<template>
  <span ref="clip" class="mq-clip" :class="{ over: overflowing }"><span ref="span" class="mq">{{ text }}</span></span>
</template>

<style scoped>
.mq-clip { display: block; overflow: hidden; white-space: nowrap; }
.mq { display: inline-block; will-change: transform; }
/* Fade both clipped edges only while overflowing — a soft "more text here" cue. */
.mq-clip.over {
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 18px), transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 18px), transparent 100%);
}
</style>
