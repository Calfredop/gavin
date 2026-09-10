/// Live state that has to survive a hot reload.
///
/// Vite re-executes a module for any edit anywhere in its DEPENDENCY cone,
/// not just for edits to the module itself: a change to `backend.ts` (or
/// `layoutState.ts`, or `ui/theme.ts`) invalidates every `.svelte` file that
/// transitively imports it, and re-fetching those boundaries re-fetches what
/// they import -- this module among them. So a module holding live objects in
/// module-level `const`s loses all of them on nearly every edit, while the app
/// around it keeps running and never notices.
///
/// `import.meta.hot.data` is the one bag Vite carries across those
/// re-executions. It is keyed by the module's own path, so every instance of
/// the module sees the same bag and the second one can adopt what the first
/// built. Pass `import.meta.hot?.data` in; a caller that has no hot context --
/// a production build, or vitest -- passes `undefined` and gets a fresh value,
/// which is exactly right, because a real page load has nothing to adopt.
export function hotState<T>(key: string, fresh: () => T, data?: Record<string, unknown>): T {
  if (!data) return fresh();
  // `in`, not `??=`: a stored value that happens to be falsy is still the
  // state the previous instance left behind, and rebuilding it would be the
  // very loss this exists to prevent.
  if (!(key in data)) data[key] = fresh();
  return data[key] as T;
}
