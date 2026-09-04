// Escape-safe JSON syntax highlighter (ADR-0016 XSS boundary). hljs core + the JSON
// grammar are both dynamically imported so they code-split into the lazy Debug chunk
// instead of the main bundle (ADR-0018). Rendering goes solely through hljs.highlight,
// which HTML-escapes its input — there is no highlightAuto fallback, so the string this
// returns is the only thing allowed to reach v-html.
export async function highlightJson(src: string): Promise<string> {
  const { default: hljs } = await import("highlight.js/lib/core");
  const { default: json } = await import("highlight.js/lib/languages/json");
  hljs.registerLanguage("json", json);
  return hljs.highlight(src, { language: "json" }).value;
}
