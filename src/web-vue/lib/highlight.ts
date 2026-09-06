// Escape-safe JSON syntax highlighter (XSS boundary). hljs core + the JSON grammar are
// dynamically imported so they code-split into the lazy Debug chunk, not the main bundle.
// Rendering goes solely through hljs.highlight, which HTML-escapes its input — no
// highlightAuto fallback — so the string this returns is the only thing allowed past
// this point to v-html.
export async function highlightJson(src: string): Promise<string> {
  const { default: hljs } = await import("highlight.js/lib/core");
  const { default: json } = await import("highlight.js/lib/languages/json");
  hljs.registerLanguage("json", json);
  return hljs.highlight(src, { language: "json" }).value;
}
