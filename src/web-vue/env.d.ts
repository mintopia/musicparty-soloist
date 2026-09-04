/// <reference types="vite/client" />

// vue-tsc would supply real SFC types, but it can't yet drive TypeScript 7 (it requires
// the `typescript/lib/tsc` export TS7 dropped). Until it can, typecheck:web runs plain tsc
// and this shim types *.vue imports so the .ts entrypoints still resolve.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
