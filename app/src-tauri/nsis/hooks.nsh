; Gavin's NSIS installer hooks.
;
; Merged into the installer Tauri generates through
; `bundle.windows.nsis.installerHooks` (tauri.windows.conf.json). The
; template `!include`s this file near its top -- after MUI2, LogicLib and
; its own `utils.nsh`, but BEFORE its `!define`s and before
; `MUI_LANGUAGE` inserts MUI's callback functions -- which is what lets
; this file define top-level callbacks of its own and still lean on the
; template's macros inside the four hook macros. The generated
; `target/release/nsis/x64/installer.nsi` shows the result, and is the
; installer's own account of what it will do.
;
; It exists because Tauri's template gets two things wrong for THIS app,
; both found by reading that generated script rather than running it
; (.gavin-root/plans/fix-windows-installer-collides-with-the-daemon.md):
;
; 1. The per-user default install directory, `$LOCALAPPDATA\Gavin`, IS
;    the daemon's state directory. `protocol::resolve_app_support_dir`
;    answers `%LOCALAPPDATA%\gavin` on Windows, and Windows paths are
;    case-insensitive, so the binaries land beside kanban.sqlite,
;    orchestration.sqlite, registry.sqlite and daemon.token. The
;    uninstaller then leaves the folder behind (its `RMDir` is not `/r`,
;    and says nothing), its "Delete the application data" checkbox
;    misses the databases, and the whole arrangement is one `/r` away
;    from deleting the human's boards. Moving the state directory
;    instead would touch `protocol`, three databases and every existing
;    install; moving the installer is this file.
;
; 2. The template stops `Gavin.exe` before copying files and never
;    `gavin-daemon.exe`, which the app spawns detached precisely so it
;    outlives every window. Windows will not overwrite a running
;    executable, so an upgrade over a live daemon keeps the OLD daemon
;    binary and the new app then talks to it -- the version skew
;    `gavin-mcp` fails closed on, reached by installing.
;
; The state directory below is spelled out by hand, as is the product
; name (the template's `${PRODUCTNAME}` is not defined yet where this
; file is included; the first hook checks the two agree). If
; `resolve_app_support_dir` ever moves, this must move with it: the two
; directories must never converge again.

!define GAVIN_STATE_DIR "$LOCALAPPDATA\gavin"
!define GAVIN_DEFAULT_INSTDIR "$LOCALAPPDATA\Programs\Gavin"
!define GAVIN_DAEMON_EXE "gavin-daemon.exe"

; --- the install directory ---------------------------------------------

; `$LOCALAPPDATA\Programs\<App>` is where per-user installs go on
; Windows (VS Code, Discord, ...): the per-user counterpart of Program
; Files, and the folder `scripts/start-stable-win.ps1` already looks in
; first.
;
; Set from MUI's .onGUIInit rather than from .onInit: the template owns
; .onInit, and there it first picks its default and then restores a
; previous install's location from the registry. This runs after both,
; and before the directory page shows the result -- in passive mode
; (`/P`, how the updater runs this installer) as well. Silent mode
; (`/S`) has no GUI and is caught in the pre-install hook instead.
;
; A previous install that lived in the state directory is redirected
; too, deliberately: every install made before this file existed did.
; The pre-install hook then retires what that install left behind.
!define MUI_CUSTOMFUNCTION_GUIINIT GavinGuiInit
Function GavinGuiInit
  ${If} $INSTDIR == "${GAVIN_STATE_DIR}"
    StrCpy $INSTDIR "${GAVIN_DEFAULT_INSTDIR}"
  ${EndIf}
FunctionEnd

; The directory page's validity check. NSIS calls it every time the
; text changes, and an Abort greys the Install button. LogicLib's `==`
; is StrCmp, which compares case-insensitively -- the comparison
; Windows itself makes.
Function .onVerifyInstDir
  ${If} $INSTDIR == "${GAVIN_STATE_DIR}"
  ${OrIf} $INSTDIR == "${GAVIN_STATE_DIR}\"
    Abort
  ${EndIf}
FunctionEnd

; A greyed button needs a sentence, and the directory page has nowhere
; else to put one. MUI reads this define when the template inserts the
; page; the first two sentences are NSIS's own default text.
!define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will install $(^Name) in the following folder. To install in a different folder, click Browse and select another folder.$\r$\n$\r$\nGavin's data folder, ${GAVIN_STATE_DIR}, cannot be chosen: it holds your boards and sessions, and an uninstall would take them with it. $_CLICK"

; --- stopping the daemon -----------------------------------------------

; Stops every gavin-daemon.exe whose image is exactly `daemonPath`, and
; waits for the last one to go. Asks first, the way the template's own
; `CheckIfAppIsRunning` asks about Gavin.exe: a silent or passive run
; stops it without a prompt, an interactive one gets OK / Cancel. A
; daemon that will not stop ends the install the same way the template
; ends it when Gavin.exe will not die.
;
; Aimed at ONE image path, never at the process name. `taskkill /IM
; gavin-daemon.exe` reaches every daemon on the machine -- the dev
; tree's, another install's -- which is the mistake the app's own
; restart path (`daemon::stop_running_daemon`) was rewritten to avoid.
; The polite route that path tries first, `Request::Shutdown` over the
; named pipe, needs the token and the pipe name, i.e. a client; and the
; daemon answers it by calling `exit` at once, so TerminateProcess
; (`Stop-Process -Force`, the same call the app's fallback makes) loses
; nothing SQLite had committed.
;
; PowerShell rather than the `nsis_tauri_utils` plugin, which only finds
; and kills by name. CIM rather than `Get-Process ... .Path`, which is
; null for any process the caller cannot open a module handle on;
; `Win32_Process.ExecutablePath` is not. The path travels in the
; environment rather than on the command line because a user name with
; an apostrophe (O'Brien) would end a quoted argument early, and nsExec
; inherits the installer's environment. `$$` is how an NSIS string
; spells a literal `$`.
;
; The NATIVE PowerShell, on purpose. The installer is a 32-bit program,
; so a bare `powershell.exe` resolves through WOW64 to the SysWOW64
; one, which measured 3.7 s to start and 14 s to over 30 s (the
; original timeout, hit) to enumerate processes over WMI -- a "could
; not check" abort on a machine where nothing was wrong. With file
; system redirection off, `$SYSDIR` reaches the real System32 and the
; same query answers in under 2 s. Redirection is re-enabled right
; after each call; nothing between the two lines touches the file
; system. The timeouts are still long, for a slow machine's sake: a
; wrong answer costs more than a wait.
!macro GavinStopDaemonAt daemonPath
  System::Call 'kernel32::SetEnvironmentVariable(t "GAVIN_DAEMON_EXE_PATH", t "${daemonPath}")'

  ${DisableX64FSRedirection}
  nsExec::ExecToStack /TIMEOUT=120000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$p=$$env:GAVIN_DAEMON_EXE_PATH; if (@(Get-CimInstance Win32_Process | Where-Object { $$_.Name -ieq '${GAVIN_DAEMON_EXE}' -and $$_.ExecutablePath -ieq $$p }).Count -gt 0) { exit 0 } else { exit 1 }"`
  ${EnableX64FSRedirection}
  Pop $R0 ; exit code: 0 running, 1 not, or "error" / "timeout" from nsExec
  Pop $R1 ; output, unused

  ${If} $R0 == "0"
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode != 1
      ; `IDOK +2` skips the one instruction after the MessageBox.
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Gavin's background service is still running:$\r$\n${daemonPath}$\r$\n$\r$\nIt holds every open terminal session, and they end with it. Click OK to stop it, or Cancel to abort." IDOK +2
      Abort "Cancelled: gavin-daemon.exe is still running."
    ${EndIf}

    DetailPrint "Stopping ${daemonPath}"
    ${DisableX64FSRedirection}
    nsExec::ExecToStack /TIMEOUT=180000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$p=$$env:GAVIN_DAEMON_EXE_PATH; for ($$i = 0; $$i -lt 25; $$i++) { $$d = @(Get-CimInstance Win32_Process | Where-Object { $$_.Name -ieq '${GAVIN_DAEMON_EXE}' -and $$_.ExecutablePath -ieq $$p }); if ($$d.Count -eq 0) { exit 0 }; $$d | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 200 }; exit 1"`
    ${EnableX64FSRedirection}
    Pop $R0
    Pop $R1
    ${If} $R0 != "0"
      !insertmacro GavinAbort "Could not stop gavin-daemon.exe (${daemonPath}). Stop it from Task Manager, then run this again."
    ${EndIf}
  ${ElseIf} $R0 != "1"
    !insertmacro GavinAbort "Could not check whether gavin-daemon.exe is running (PowerShell answered: $R0). Stop it from Task Manager if it is, then run this again."
  ${EndIf}
!macroend

; Ends the run the way the template's own app check does when it cannot
; kill Gavin.exe: a red line on the console for a silent run, the status
; line of the install page otherwise.
!macro GavinAbort message
  ${If} ${Silent}
    System::Call 'kernel32::AttachConsole(i -1)i.r0'
    ${If} $0 != 0
      System::Call 'kernel32::GetStdHandle(i -11)i.r0'
      System::Call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)'
      FileWrite $0 "${message}$\n"
    ${EndIf}
    Abort
  ${Else}
    Abort "${message}"
  ${EndIf}
!macroend

; --- the four hooks ------------------------------------------------------

; Runs inside `Section Install`, after `SetOutPath $INSTDIR` and before
; the template's own `CheckIfAppIsRunning` and the `File` lines.
!macro NSIS_HOOK_PREINSTALL
  ; The two names this file spells out by hand, checked against the
  ; config now that the template's defines exist.
  !if "${PRODUCTNAME}" != "Gavin"
    !error "nsis/hooks.nsh assumes productName Gavin; it is ${PRODUCTNAME}"
  !endif
  !if "${MAINBINARYNAME}" != "Gavin"
    !error "nsis/hooks.nsh assumes a main binary named Gavin; it is ${MAINBINARYNAME}"
  !endif

  ; Never into the state directory. Only reachable without a GUI (`/S`,
  ; or `/D=` naming it): the directory page refuses this folder and
  ; GavinGuiInit never offers it. `SetOutPath` again because the
  ; template's ran before this hook, with the old value.
  ${If} $INSTDIR == "${GAVIN_STATE_DIR}"
    StrCpy $INSTDIR "${GAVIN_DEFAULT_INSTDIR}"
    SetOutPath $INSTDIR
    DetailPrint "${GAVIN_STATE_DIR} is Gavin's data folder; installing to $INSTDIR instead"
  ${EndIf}

  ; The app first, then its daemon. The template's own check comes right
  ; after this hook, but that is after the daemon would already be gone,
  ; and an app that outlives its daemon shows a connection overlay with
  ; a Restart button on it -- pressed while the installer waits on a
  ; prompt, it would spawn a fresh daemon from the very binary about to
  ; be replaced. Inserted here, the template's second check finds nothing
  ; and does nothing.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro GavinStopDaemonAt "$INSTDIR\${GAVIN_DAEMON_EXE}"

  ; A previous install that lived in the state directory: every install
  ; made before this file existed. The template registered its location
  ; under MANUPRODUCTKEY, restored it as the default, and GavinGuiInit
  ; has just moved this install elsewhere -- so this install supersedes
  ; that registration (the registry lines below the hook overwrite it),
  ; and what it left in the state directory is this install's to
  ; retire: its daemon, its four binaries, by name, and nothing else in
  ; the folder, which is the human's data. Shortcuts that still point
  ; into it are retargeted with the template's own macros; the template
  ; only retargets within one folder, and in update mode (`/UPDATE`,
  ; the updater) creates none.
  ReadRegStr $R8 SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $R8 == "${GAVIN_STATE_DIR}"
    !insertmacro GavinStopDaemonAt "${GAVIN_STATE_DIR}\${GAVIN_DAEMON_EXE}"
    Delete "${GAVIN_STATE_DIR}\${MAINBINARYNAME}.exe"
    Delete "${GAVIN_STATE_DIR}\${GAVIN_DAEMON_EXE}"
    Delete "${GAVIN_STATE_DIR}\gavin-mcp.exe"
    Delete "${GAVIN_STATE_DIR}\uninstall.exe"
    DetailPrint "Retired the previous install's binaries from ${GAVIN_STATE_DIR}"

    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "${GAVIN_STATE_DIR}\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "${GAVIN_STATE_DIR}\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}
!macroend

; Runs inside `Section Uninstall`, before the template's own app check
; and its `Delete` lines. Same order as the install, for the same
; reason: a `Delete` of a running gavin-daemon.exe fails silently and
; leaves the folder behind.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  !insertmacro GavinStopDaemonAt "$INSTDIR\${GAVIN_DAEMON_EXE}"
!macroend

; Runs at the end of `Section Uninstall`, after the template has acted on
; its "Delete the application data" checkbox. That removes
; `$APPDATA\com.gavin.app` (config.json) and `$LOCALAPPDATA\com.gavin.app`
; (the WebView2 profile). The boards, the rails, the workspace list, the
; session registry and the daemon's token and log are in the state
; directory, which it does not know about; this makes the checkbox mean
; what it says. A dev-tree daemon holding its `-dev` files open keeps
; those files; `RMDir /r` takes the rest and reports nothing, as the
; template's own deletions do. Never in update mode: an update keeps the
; data by definition.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "${GAVIN_STATE_DIR}"
  ${EndIf}
!macroend
