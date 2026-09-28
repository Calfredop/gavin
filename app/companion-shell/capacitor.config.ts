// The Companion shell as a store app (ADR 0002, ADR 0005).
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.gavin.companion",
  appName: "Gavin",
  // The hub's static build. Only this ever loads in the shell's own
  // webview; a Workstation's bundle is embedded elsewhere and opens in a
  // webview of its own (scripts/sync.mjs, the BundleView plugin).
  webDir: "build",
  // The desktop theme's dark base, behind the webview while it loads.
  backgroundColor: "#1e1e1e",
  ios: {
    // The page places itself around the notch (viewport-fit=cover).
    contentInset: "never",
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    // Neither is used, and each would widen what the shell's own page
    // can do beyond what it ships with.
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
  },
};

export default config;
