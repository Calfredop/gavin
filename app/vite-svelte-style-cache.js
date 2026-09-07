/* A component's compiled CSS is served from a cache vite-plugin-svelte
   fills during that component's TRANSFORM (src/index.js: load() returns
   `cache.getCSS(request)` or nothing at all). Ask for the style module
   before the component itself has been transformed in this server
   incarnation and that lookup misses, load() returns undefined, and
   vite's own fs fallback answers the request with the file the id points
   at -- the `.svelte` SOURCE, handed to the browser as a stylesheet.

   That happens whenever the dev server restarts in-process under a page
   that stays loaded, which vite-cache-guard.sh does deliberately: the
   window keeps its modules, so nothing re-imports the component, and the
   next style request arrives at a cold cache.

   WebKit does not discard the file it is given. The CSS parser
   error-recovers through the `<script>` and the markup, reaches the
   component's own `<style>` block, and applies the rules it finds there
   with NO scoping class on them -- so they are global. One component
   served raw restyles the whole app: MainAgentPanel's
   `.head { display: flex; align-items: center; text-transform: uppercase }`
   landed on the card detail modal's head and laid its four stacked bands
   out in a row, in capitals, with the title overlapping the file path.
   The component that lost its own CSS is not the one that looks broken,
   which is what makes this expensive to chase.

   So the cache is never allowed to be cold on the way out:

   - warm  (pre)  transforms the component first, so the plugin's own
                  load() finds the CSS it compiled.
   - guard (post) runs only if that still missed -- a component that does
                  not compile has no CSS -- and answers with an empty
                  stylesheet. One component unstyled is a bug you can
                  see; the raw file is a bug that moves. */

// `/abs/path/Comp.svelte?svelte&type=style&lang.css`, and nothing else
// that carries the same extension: `?raw` (the surface tests read source
// that way) and `type=script` must fall straight through.
const STYLE_MODULE = /\.svelte\?(?:.*&)?type=style(?:&|$)/;

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isSvelteStyleModule(id) {
  return STYLE_MODULE.test(id);
}

/** @returns {import("vite").Plugin[]} */
export function svelteStyleCache() {
  // Ids and config.root are both POSIX-separated by the time a plugin
  // sees them -- vite normalises before it hands anything over -- so this
  // file needs no path module and the app needs no node typings for it.
  let root = "";
  // Transforming the component re-enters resolution for its own
  // sub-modules. Nothing observed re-enters THIS id, but a load hook that
  // can wait on itself is a hang rather than a wrong colour, so the door
  // is only ever open once.
  const warming = new Set();

  /** @param {string} file */
  const urlOf = (file) =>
    root && file.startsWith(root + "/") ? "/" + file.slice(root.length + 1) : "/@fs" + file;

  /** @param {string} id */
  const fileOf = (id) => id.slice(0, id.indexOf("?"));

  return [
    {
      name: "svelte-style-cache-warm",
      apply: "serve",
      enforce: "pre",
      configResolved(config) {
        root = config.root;
      },
      async load(id) {
        if (!STYLE_MODULE.test(id) || warming.has(id)) return null;
        warming.add(id);
        try {
          // Fills vite-plugin-svelte's CSS cache for this component. Its
          // own load() runs next and finds it. `apply: "serve"` is what
          // makes the cast safe -- a build never reaches this hook, and
          // only the dev environment can transform on request.
          const env = /** @type {import("vite").DevEnvironment} */ (this.environment);
          await env.transformRequest(urlOf(fileOf(id)));
        } catch {
          // A component that does not compile has no CSS to hand over.
          // The guard below is what stops that being the whole app's
          // problem.
        } finally {
          warming.delete(id);
        }
        return null;
      },
    },
    {
      name: "svelte-style-cache-guard",
      apply: "serve",
      enforce: "post",
      load(id) {
        if (!STYLE_MODULE.test(id)) return null;
        // Reaching a post hook at all means every plugin before this one
        // passed, so the cache is still cold. The next hook down is
        // vite's fs fallback, and that is the one that must not run.
        const file = fileOf(id);
        this.warn(
          `no compiled CSS for ${file.slice(file.lastIndexOf("/") + 1)} — served an empty stylesheet rather than the raw component file`,
        );
        return "";
      },
    },
  ];
}
