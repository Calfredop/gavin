
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const CARGO_PKG_VERSION_PRE: string;
	export const CLAUDE_CODE_MESSAGING_TOKEN: string;
	export const CMUX_BUNDLED_CLI_PATH: string;
	export const MANPATH: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const GHOSTTY_RESOURCES_DIR: string;
	export const CLAUDE_EFFORT: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const CMUX_CLAUDE_WRAPPER_SHIM_ROOT: string;
	export const CMUX_SHELL_INTEGRATION_DIR: string;
	export const TERM_PROGRAM: string;
	export const CARGO_PKG_README: string;
	export const CMUX_NO_PR_WATCH: string;
	export const GHOSTTY_SURFACE_ID: string;
	export const NODE: string;
	export const CLAUDE_CODE_BRIDGE_SESSION_ID: string;
	export const ANDROID_HOME: string;
	export const CMUX_CODEX_WRAPPER_SHIM: string;
	export const GEM_HOME: string;
	export const INIT_CWD: string;
	export const TAURI_ANDROID_PACKAGE_NAME_PREFIX: string;
	export const CARGO_PKG_HOMEPAGE: string;
	export const CMUX_BUNDLE_ID: string;
	export const SHELL: string;
	export const TERM: string;
	export const CLAUDE_PID: string;
	export const CLAUDE_CODE_CHILD_SESSION: string;
	export const CARGO_TERM_PROGRESS_WHEN: string;
	export const CMUX_PANEL_ID: string;
	export const HOMEBREW_REPOSITORY: string;
	export const TMPDIR: string;
	export const CMUX_SOCKET: string;
	export const npm_config_global_prefix: string;
	export const FPATH: string;
	export const TAURI_CLI_VERBOSITY: string;
	export const COLOR: string;
	export const CMUX_SOCKET_CAPABILITY: string;
	export const npm_config_noproxy: string;
	export const CARGO_PKG_NAME: string;
	export const ZSH: string;
	export const npm_config_local_prefix: string;
	export const GIT_EDITOR: string;
	export const AI_AGENT: string;
	export const OUT_DIR: string;
	export const USER: string;
	export const LS_COLORS: string;
	export const TAURI_ENV_TARGET_TRIPLE: string;
	export const COMMAND_MODE: string;
	export const REACT_EDITOR: string;
	export const RUSTUP_TOOLCHAIN_SOURCE: string;
	export const CARGO_MANIFEST_DIR: string;
	export const npm_config_globalconfig: string;
	export const CMUX_SUPPRESS_SUBAGENT_NOTIFICATIONS: string;
	export const SSH_AUTH_SOCK: string;
	export const __CF_USER_TEXT_ENCODING: string;
	export const CMUX_AGENT_LAUNCH_ARGV_B64: string;
	export const npm_execpath: string;
	export const GOOGLE_CLOUD_PROJECT: string;
	export const PAGER: string;
	export const CARGO_PKG_AUTHORS: string;
	export const CARGO_PKG_REPOSITORY: string;
	export const CMUX_AGENT_LAUNCH_CWD: string;
	export const LSCOLORS: string;
	export const PATH: string;
	export const CARGO_HOME: string;
	export const _: string;
	export const CMUX_PORT: string;
	export const GHOSTTY_SHELL_FEATURES: string;
	export const npm_package_json: string;
	export const CARGO_PKG_DESCRIPTION: string;
	export const __CFBundleIdentifier: string;
	export const npm_config_init_module: string;
	export const npm_config_userconfig: string;
	export const CMUX_CLAUDE_HOOK_CMUX_BIN: string;
	export const CARGO_PKG_RUST_VERSION: string;
	export const CMUX_PORT_END: string;
	export const PWD: string;
	export const npm_command: string;
	export const CMUX_NO_GIT_WATCH: string;
	export const CMUX_SHELL_INTEGRATION: string;
	export const CMUX_WORKSPACE_ID: string;
	export const EDITOR: string;
	export const npm_lifecycle_event: string;
	export const CARGO: string;
	export const CARGO_PKG_LICENSE_FILE: string;
	export const CARGO_TERM_PROGRESS_WIDTH: string;
	export const LANG: string;
	export const npm_package_name: string;
	export const XPC_FLAGS: string;
	export const npm_config_npm_version: string;
	export const CMUX_CODEX_WRAPPER_SHIM_ROOT: string;
	export const CMUX_KIRO_NOTIFICATION_LEVEL: string;
	export const CARGO_PKG_VERSION_PATCH: string;
	export const RUSTUP_TOOLCHAIN: string;
	export const CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION: string;
	export const npm_config_node_gyp: string;
	export const CARGO_PKG_LICENSE: string;
	export const XPC_SERVICE_NAME: string;
	export const npm_package_version: string;
	export const CARGO_PKG_VERSION_MAJOR: string;
	export const GEMINI_API_KEY: string;
	export const CMUX_TAB_ID: string;
	export const HOME: string;
	export const SHLVL: string;
	export const TERMINFO: string;
	export const CMUX_CLAUDE_PID: string;
	export const CLAUDE_CODE_EXECPATH: string;
	export const CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: string;
	export const HOMEBREW_PREFIX: string;
	export const CMUX_PORT_RANGE: string;
	export const RUSTUP_HOME: string;
	export const LESS: string;
	export const LOGNAME: string;
	export const RUST_RECURSION_COUNT: string;
	export const npm_config_cache: string;
	export const npm_lifecycle_script: string;
	export const XDG_DATA_DIRS: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const CARGO_PKG_VERSION: string;
	export const CARGO_PKG_VERSION_MINOR: string;
	export const TAURI_ANDROID_PACKAGE_NAME_APP_NAME: string;
	export const npm_config_user_agent: string;
	export const CLAUDE_CODE_SESSION_ID: string;
	export const CMUX_SOCKET_PATH: string;
	export const HOMEBREW_CELLAR: string;
	export const INFOPATH: string;
	export const CARGO_MANIFEST_PATH: string;
	export const GAVIN_SESSION_ID: string;
	export const GHOSTTY_BIN: string;
	export const CMUX_AGENT_LAUNCH_KIND: string;
	export const OSLogRateLimit: string;
	export const CMUX_CLAUDE_WRAPPER_SHIM: string;
	export const CMUX_AGENT_LAUNCH_EXECUTABLE: string;
	export const CLAUDECODE: string;
	export const CLAUDE_CODE_MESSAGING_SOCKET: string;
	export const CMUX_SURFACE_ID: string;
	export const COLORTERM: string;
	export const npm_config_prefix: string;
	export const npm_node_execpath: string;
	export const TEST: string;
	export const VITEST: string;
	export const NODE_ENV: string;
	export const PROD: string;
	export const DEV: string;
	export const BASE_URL: string;
	export const MODE: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		CARGO_PKG_VERSION_PRE: string;
		CLAUDE_CODE_MESSAGING_TOKEN: string;
		CMUX_BUNDLED_CLI_PATH: string;
		MANPATH: string;
		NoDefaultCurrentDirectoryInExePath: string;
		GHOSTTY_RESOURCES_DIR: string;
		CLAUDE_EFFORT: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		CMUX_CLAUDE_WRAPPER_SHIM_ROOT: string;
		CMUX_SHELL_INTEGRATION_DIR: string;
		TERM_PROGRAM: string;
		CARGO_PKG_README: string;
		CMUX_NO_PR_WATCH: string;
		GHOSTTY_SURFACE_ID: string;
		NODE: string;
		CLAUDE_CODE_BRIDGE_SESSION_ID: string;
		ANDROID_HOME: string;
		CMUX_CODEX_WRAPPER_SHIM: string;
		GEM_HOME: string;
		INIT_CWD: string;
		TAURI_ANDROID_PACKAGE_NAME_PREFIX: string;
		CARGO_PKG_HOMEPAGE: string;
		CMUX_BUNDLE_ID: string;
		SHELL: string;
		TERM: string;
		CLAUDE_PID: string;
		CLAUDE_CODE_CHILD_SESSION: string;
		CARGO_TERM_PROGRESS_WHEN: string;
		CMUX_PANEL_ID: string;
		HOMEBREW_REPOSITORY: string;
		TMPDIR: string;
		CMUX_SOCKET: string;
		npm_config_global_prefix: string;
		FPATH: string;
		TAURI_CLI_VERBOSITY: string;
		COLOR: string;
		CMUX_SOCKET_CAPABILITY: string;
		npm_config_noproxy: string;
		CARGO_PKG_NAME: string;
		ZSH: string;
		npm_config_local_prefix: string;
		GIT_EDITOR: string;
		AI_AGENT: string;
		OUT_DIR: string;
		USER: string;
		LS_COLORS: string;
		TAURI_ENV_TARGET_TRIPLE: string;
		COMMAND_MODE: string;
		REACT_EDITOR: string;
		RUSTUP_TOOLCHAIN_SOURCE: string;
		CARGO_MANIFEST_DIR: string;
		npm_config_globalconfig: string;
		CMUX_SUPPRESS_SUBAGENT_NOTIFICATIONS: string;
		SSH_AUTH_SOCK: string;
		__CF_USER_TEXT_ENCODING: string;
		CMUX_AGENT_LAUNCH_ARGV_B64: string;
		npm_execpath: string;
		GOOGLE_CLOUD_PROJECT: string;
		PAGER: string;
		CARGO_PKG_AUTHORS: string;
		CARGO_PKG_REPOSITORY: string;
		CMUX_AGENT_LAUNCH_CWD: string;
		LSCOLORS: string;
		PATH: string;
		CARGO_HOME: string;
		_: string;
		CMUX_PORT: string;
		GHOSTTY_SHELL_FEATURES: string;
		npm_package_json: string;
		CARGO_PKG_DESCRIPTION: string;
		__CFBundleIdentifier: string;
		npm_config_init_module: string;
		npm_config_userconfig: string;
		CMUX_CLAUDE_HOOK_CMUX_BIN: string;
		CARGO_PKG_RUST_VERSION: string;
		CMUX_PORT_END: string;
		PWD: string;
		npm_command: string;
		CMUX_NO_GIT_WATCH: string;
		CMUX_SHELL_INTEGRATION: string;
		CMUX_WORKSPACE_ID: string;
		EDITOR: string;
		npm_lifecycle_event: string;
		CARGO: string;
		CARGO_PKG_LICENSE_FILE: string;
		CARGO_TERM_PROGRESS_WIDTH: string;
		LANG: string;
		npm_package_name: string;
		XPC_FLAGS: string;
		npm_config_npm_version: string;
		CMUX_CODEX_WRAPPER_SHIM_ROOT: string;
		CMUX_KIRO_NOTIFICATION_LEVEL: string;
		CARGO_PKG_VERSION_PATCH: string;
		RUSTUP_TOOLCHAIN: string;
		CMUX_LOAD_GHOSTTY_ZSH_INTEGRATION: string;
		npm_config_node_gyp: string;
		CARGO_PKG_LICENSE: string;
		XPC_SERVICE_NAME: string;
		npm_package_version: string;
		CARGO_PKG_VERSION_MAJOR: string;
		GEMINI_API_KEY: string;
		CMUX_TAB_ID: string;
		HOME: string;
		SHLVL: string;
		TERMINFO: string;
		CMUX_CLAUDE_PID: string;
		CLAUDE_CODE_EXECPATH: string;
		CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: string;
		HOMEBREW_PREFIX: string;
		CMUX_PORT_RANGE: string;
		RUSTUP_HOME: string;
		LESS: string;
		LOGNAME: string;
		RUST_RECURSION_COUNT: string;
		npm_config_cache: string;
		npm_lifecycle_script: string;
		XDG_DATA_DIRS: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		CARGO_PKG_VERSION: string;
		CARGO_PKG_VERSION_MINOR: string;
		TAURI_ANDROID_PACKAGE_NAME_APP_NAME: string;
		npm_config_user_agent: string;
		CLAUDE_CODE_SESSION_ID: string;
		CMUX_SOCKET_PATH: string;
		HOMEBREW_CELLAR: string;
		INFOPATH: string;
		CARGO_MANIFEST_PATH: string;
		GAVIN_SESSION_ID: string;
		GHOSTTY_BIN: string;
		CMUX_AGENT_LAUNCH_KIND: string;
		OSLogRateLimit: string;
		CMUX_CLAUDE_WRAPPER_SHIM: string;
		CMUX_AGENT_LAUNCH_EXECUTABLE: string;
		CLAUDECODE: string;
		CLAUDE_CODE_MESSAGING_SOCKET: string;
		CMUX_SURFACE_ID: string;
		COLORTERM: string;
		npm_config_prefix: string;
		npm_node_execpath: string;
		TEST: string;
		VITEST: string;
		NODE_ENV: string;
		PROD: string;
		DEV: string;
		BASE_URL: string;
		MODE: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
