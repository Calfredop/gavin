/* The app's Content-Security-Policy lives in
   `src-tauri/tauri.conf.json` (`app.security.csp`), and Tauri only ever
   applies it to EMBEDDED assets: `AppManager::get_asset` attaches the
   header while answering a `tauri://localhost` request, which is the
   bundle's document and nothing else. Under `tauri dev` the window loads
   `devUrl` -- http://localhost:1420, served by this vite server -- so
   the configured policy is not present at all, and neither is
   `app.security.devCsp`, which travels down the same asset path.

   That would leave the policy unobservable in the app the human
   actually runs: a directive that breaks the editor, a terminal or the
   markdown preview would surface for the first time in a release
   bundle. So dev serves the SAME policy REPORT-ONLY. Nothing is
   blocked; WebKit logs every violation to the console, which is exactly
   the signal a smoke pass needs, and a mistake here can never take the
   dev loop down.

   The policy is read from tauri.conf.json rather than restated, because
   two copies drift and the copy that drifts is the one nobody runs. Two
   directives are relaxed for dev, and only these two:

   - script-src gains 'unsafe-inline'. The dev document carries
     SvelteKit's inline bootstrap and app.html's theme pre-boot script
     verbatim; in a bundle `tauri-codegen` hashes both into the policy
     (`inject_script_hashes`), which it cannot do for HTML it never
     sees. Without the relaxation every page load reports two
     violations, and a report nobody can read is a report nobody reads.
     script-src is therefore the one directive a bundle alone exercises.

   - connect-src gains this server's own http/ws origins, for module
     requests and the HMR socket. */

// Imported rather than read at request time: vite bundles this config
// and its relative imports, so the policy is inlined here and there is
// no `node:fs` in a file `svelte-check` also type-checks (@types/node is
// not installed -- this is a browser bundle). Vite restarts the dev
// server when a config dependency changes, so an edit to the policy
// still lands without a manual restart.
import tauriConfig from "./src-tauri/tauri.conf.json";

/**
 * Splits a policy into `[name, sources]` pairs, preserving order.
 * @param {string} policy
 * @returns {Array<[string, string[]]>}
 */
function parsePolicy(policy) {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...sources] = directive.split(/\s+/);
      return /** @type {[string, string[]]} */ ([name, sources]);
    });
}

/**
 * The configured policy with the two dev relaxations applied. Returns
 * null when tauri.conf.json has no csp -- there is then nothing to
 * mirror, and inventing one here would report against a policy the
 * bundle does not enforce.
 * @param {string} configJson
 * @param {string[]} devOrigins
 * @returns {string | null}
 */
export function devReportOnlyPolicy(configJson, devOrigins) {
  const configured = JSON.parse(configJson)?.app?.security?.csp;
  if (typeof configured !== "string" || !configured.trim()) return null;

  return parsePolicy(configured)
    .map(([name, sources]) => {
      if (name === "script-src") return `${name} ${[...sources, "'unsafe-inline'"].join(" ")}`;
      if (name === "connect-src") return `${name} ${[...sources, ...devOrigins].join(" ")}`;
      return [name, ...sources].join(" ");
    })
    .join("; ");
}

/**
 * @returns {import('vite').Plugin}
 */
export function devCspMirror() {
  return {
    name: "gavin-dev-csp-mirror",
    apply: "serve",
    configureServer(server) {
      // `hmr` is `boolean | HmrOptions`, and only the object form has a
      // port of its own -- when it does not, HMR rides the server's.
      const hmr = /** @type {{ port?: number } | boolean | undefined} */ (
        server.config.server.hmr
      );
      const ports = new Set(
        [server.config.server.port, typeof hmr === "object" ? hmr?.port : undefined].filter(
          (p) => typeof p === "number"
        )
      );
      const origins = [...ports].flatMap((port) => [
        `http://localhost:${port}`,
        `ws://localhost:${port}`,
      ]);

      let policy = null;
      try {
        policy = devReportOnlyPolicy(JSON.stringify(tauriConfig), origins);
      } catch (e) {
        // A malformed tauri.conf.json is the Tauri build's problem to
        // report, not a reason to fail `vite dev` -- the frontend is
        // also served to `npm run dev` on its own.
        server.config.logger.warn(`[dev-csp] no policy mirrored: ${e}`);
      }
      if (!policy) return;

      server.middlewares.use((req, res, next) => {
        // Documents only. A CSP header on a module or a stylesheet is
        // ignored by the browser and only costs bytes.
        const accept = /** @type {any} */ (req).headers?.accept;
        if (typeof accept === "string" && accept.includes("text/html")) {
          res.setHeader("Content-Security-Policy-Report-Only", policy);
        }
        next();
      });
    },
  };
}
