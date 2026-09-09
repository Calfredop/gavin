//! The update channel: what gavin checks, and what it refuses to do
//! without being asked.
//!
//! This is the fourth item of R6 (`SC-06`, `docs/security/README.md`).
//! Signing and notarization landed first and cover a different half of
//! the problem: a downloaded gavin is sealed, hardened and
//! Gatekeeper-checked, so the OS already refuses a modified bundle.
//! What was missing was the channel. Without one, every update is a
//! fresh manual download, so installs go stale -- and a stale install is
//! the one a known bug stays exploitable in.
//!
//! ## The key is pinned; the URL is a setting
//!
//! `plugins.updater.pubkey` in `tauri.conf.json` is the trust anchor and
//! is committed, reviewed, and baked into the binary. The private half
//! signs every update forever and lives only in a GitHub Actions
//! repository secret (`docs/RELEASING.md`).
//!
//! The endpoint, by contrast, is a setting -- default in the config,
//! overridable per install from Settings. That asymmetry is deliberate
//! and it is the whole security argument: a hostile endpoint can serve
//! anything it likes and gavin will refuse all of it, because
//! `minisign` verification happens against the pinned key before a
//! single byte is installed. Making the URL configurable therefore costs
//! nothing. Making the KEY configurable would cost everything, so there
//! is no command here that writes one.
//!
//! ## Nothing reaches the plugin from the page
//!
//! `updater:default` grants `check`, `download`, `install` and
//! `download_and_install` to the webview. It is deliberately NOT in
//! `capabilities/default.json`. Tauri defines `__TAURI_INTERNALS__` on
//! every page whether or not `withGlobalTauri` is set, so any script
//! running in gavin's origin can invoke a permitted command by name
//! (AS-01/R5) -- and `plugin:updater|download_and_install` reachable
//! that way is a code-execution primitive one `invoke` from a rendered
//! markdown file. What the page can reach instead is this module:
//! `check_for_update`, which only reads, and `install_update`, which
//! spends a `confirm_gate` token bound to the exact version the prompt
//! named.
//!
//! Driving the updater from the host has a second consequence worth
//! recording: `app.security.csp` restricts `connect-src` to `'self'`,
//! so a frontend that did its own fetching could not reach any endpoint
//! at all. The host has no CSP.
//!
//! ## Nothing installs unattended
//!
//! `check_for_update` is a read. It is called once at launch and
//! whenever the human presses the button, and an available update is
//! reported, never acted on. `install_update` quits the app and
//! relaunches it, which is why it is gated: see `sessionsToEnd` and
//! `installPrompt` in `app/src/lib/updates.ts` for what the human is
//! told first.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::UpdaterExt;

/// Whether `plugins.updater` was present in the config this binary was
/// built from, and therefore whether `tauri_plugin_updater` was
/// registered at all.
///
/// It has to be tracked separately because the plugin's own state type
/// is private to the plugin: `updater_builder()` reaches for it with
/// `state::<UpdaterState>()`, which PANICS rather than returning an
/// error when the plugin was never registered. Every command here
/// checks this flag before touching the plugin, so a build without the
/// config block answers "no update channel in this build" instead of
/// taking the window down.
pub struct UpdaterEnabled(pub bool);

/// The file the endpoint override lives in, beside `config.json` in the
/// app config directory.
///
/// Its own file rather than a field on `AppConfig`: adding one there
/// means a 15th positional argument to `persist_workspaces` and a new
/// way for any of its call sites to silently drop a setting it does not
/// know about, which is a trap this repo has already been bitten by
/// twice. A single-value setting nothing else reads gets the same shape
/// as the `require_local_token` marker -- one small file, read on
/// demand.
fn endpoint_override_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("update-endpoint"))
}

fn read_endpoint_override(app: &AppHandle) -> Option<String> {
    let path = endpoint_override_path(app).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The `endpoints` array `tauri.conf.json` shipped with, as strings.
///
/// Read back out of the parsed config rather than duplicated as a
/// constant here: the plugin uses that array when nothing overrides it,
/// so anything else this function could return would be a second,
/// disagreeing answer to the same question.
fn configured_endpoints(app: &AppHandle) -> Vec<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("endpoints"))
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Whether this build actually pinned a key. An empty `pubkey`
/// deserializes fine and then fails every signature, which would read to
/// a human as "the server is broken" rather than "this build cannot
/// verify anything" -- so the surface says which.
fn pubkey_pinned(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

/// Everything the Settings surface needs to describe the channel without
/// touching the network.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    /// `bundle.version`, which is what a release tag has to agree with
    /// (`preflight` in `.github/workflows/release.yml`).
    pub current_version: String,
    /// The endpoint this install would actually poll, or empty when
    /// there is none -- in which case nothing polls anything.
    pub endpoint: String,
    /// What the build shipped with, so the surface can offer "back to
    /// the default" without inventing a URL.
    pub default_endpoint: String,
    /// Whether `endpoint` came from this install's override rather than
    /// from the build.
    pub overridden: bool,
    /// False when the build has no `plugins.updater` block at all.
    pub enabled: bool,
    /// False when the block is there but its `pubkey` is empty, which is
    /// a build that can check for updates and install none.
    pub pinned: bool,
}

/// An update the endpoint announced. Reporting it is the whole of
/// `check_for_update`: nothing here downloads.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub version: String,
    pub current_version: String,
    /// The release notes the manifest carried, if any.
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[tauri::command]
pub fn update_settings(app_handle: AppHandle, enabled: State<UpdaterEnabled>) -> UpdateSettings {
    let default_endpoint = configured_endpoints(&app_handle).first().cloned().unwrap_or_default();
    let overridden = read_endpoint_override(&app_handle);
    UpdateSettings {
        current_version: app_handle.package_info().version.to_string(),
        endpoint: overridden.clone().unwrap_or_else(|| default_endpoint.clone()),
        default_endpoint,
        overridden: overridden.is_some(),
        enabled: enabled.0,
        pinned: pubkey_pinned(&app_handle),
    }
}

/// Points this install at a different manifest, or (with `None` or a
/// blank string) puts it back on the one the build shipped with.
///
/// No validation beyond "it parses as a URL": the endpoint is not a
/// trust decision, the pinned key is, so refusing an unusual URL here
/// would be theatre. A URL that does not resolve surfaces as the check's
/// own error, where the human can read it.
#[tauri::command]
pub fn set_update_endpoint(app_handle: AppHandle, endpoint: Option<String>) -> Result<(), String> {
    let path = endpoint_override_path(&app_handle)?;
    let value = endpoint.map(|e| e.trim().to_string()).filter(|e| !e.is_empty());
    match value {
        Some(url) => {
            url::Url::parse(&url).map_err(|e| format!("that is not a URL: {e}"))?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, url.as_bytes()).map_err(|e| e.to_string())
        }
        None => {
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

/// Builds an updater against the effective endpoint.
///
/// Shared by the check and the install so the two cannot disagree about
/// which manifest they are talking to -- an install that resolved a
/// different endpoint than the check the human answered would defeat the
/// version binding on the confirmation token.
fn updater(app: &AppHandle, enabled: &UpdaterEnabled) -> Result<tauri_plugin_updater::Updater, String> {
    if !enabled.0 {
        return Err("this build has no update channel (no plugins.updater in tauri.conf.json)".to_string());
    }
    let mut builder = app.updater_builder();
    if let Some(url) = read_endpoint_override(app) {
        let parsed = url::Url::parse(&url).map_err(|e| format!("the update endpoint is not a URL: {e}"))?;
        builder = builder.endpoints(vec![parsed]).map_err(|e| e.to_string())?;
    }
    builder.build().map_err(|e| match e {
        tauri_plugin_updater::Error::EmptyEndpoints => {
            "no update endpoint is set — add one in Settings › Updates".to_string()
        }
        other => other.to_string(),
    })
}

/// Asks the endpoint whether there is a newer release. `Ok(None)` means
/// this install is current.
///
/// A read, and the only thing the launch check calls. Its failures are
/// ordinary -- no network, a 404 because nothing has been published yet
/// -- so the caller decides whether they are worth showing; see
/// `updates.ts`.
#[tauri::command]
pub async fn check_for_update(
    app_handle: AppHandle,
    enabled: State<'_, UpdaterEnabled>,
) -> Result<Option<AvailableUpdate>, String> {
    let updater = updater(&app_handle, &enabled)?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    Ok(found.map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|d| d.to_string()),
    }))
}

/// Downloads, verifies against the pinned key, installs, and relaunches.
///
/// Gated (`confirm_gate::GATED_ACTIONS`), with the announced VERSION as
/// the subject rather than a placeholder the way `restart_daemon` uses
/// one. There is only ever one app, so a constant subject would have
/// been the obvious choice -- but the thing being confirmed here is not
/// "update" in the abstract, it is "install 0.2.0", and a token minted
/// for a prompt that named 0.2.0 must not install whatever the endpoint
/// happens to announce a moment later. The re-check below is the other
/// half of that: the version this actually installs is compared with the
/// version the human was shown, and a disagreement is a refusal.
///
/// This does not return. `restart_after_install` is the plugin's
/// default, so a successful install replaces the bundle and relaunches;
/// the `Ok(())` path exists for the platforms and failure modes where it
/// comes back.
#[tauri::command]
pub async fn install_update(
    app_handle: AppHandle,
    version: String,
    token: String,
    enabled: State<'_, UpdaterEnabled>,
    gate: State<'_, crate::confirm_gate::ConfirmGate>,
) -> Result<(), String> {
    crate::confirm_gate::spend(&gate, &token, "install_update", &version)?;
    let updater = updater(&app_handle, &enabled)?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "there is no update to install any more".to_string())?;
    if update.version != version {
        return Err(format!(
            "the endpoint now offers {} rather than the {version} you confirmed — check again",
            update.version
        ));
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}
