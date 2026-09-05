# highlight.js renders JSON on the Debug Page, lazy-loaded on that route

The Debug Page shows JSON in three places — the Soloist frame stream, Webhook request and
response headers, and Webhook response bodies — and it should be pretty-printed and
syntax-highlighted to be readable at a glance.

The app is deliberately lean: its only runtime dependencies are `ws` and `yaml`, and it
ships no UI framework dependency beyond Vue itself. Adding a highlighter is therefore a
real dependency decision, which per our ADR convention gets recorded.

We adopt **highlight.js** (its core build plus the JSON language only), imported
dynamically so it loads only when the Debug Page route is entered. The main bundle — every
other page — is unaffected; the highlighter's weight lands solely on the operator who opens
the Debug Page.

## Considered Options

- **Hand-rolled JSON highlighter** (~30–40 lines: `JSON.stringify(…, 2)` + regex-wrapped
  spans for keys/strings/numbers/booleans/null): zero dependency, ~1 KB, and it covers the
  only formats shown here. Rejected in favor of a maintained library for correct handling
  of edge cases (escapes, large/awkward payloads) and less bespoke code to own.
- **Prism**: comparable to highlight.js; no decisive advantage for JSON-only use.
- **highlight.js, core + JSON, lazy-loaded on the Debug route** (chosen): a maintained
  highlighter with the cost isolated to the one page that needs it, so the lean main
  bundle is preserved.

## Consequences

A new runtime dependency enters the tree, and the Debug route gains a dynamic-import
chunk (~15–30 KB gzipped for core + JSON). Because the import is route-lazy, first paint of
every non-Debug page is unchanged. The dependency footprint is bounded to the JSON grammar
— no full-language registration — and highlighting is presentational only: raw frame and
webhook data is rendered as received, never altered by the highlighter.
