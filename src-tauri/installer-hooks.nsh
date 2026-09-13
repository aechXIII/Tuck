; Tuck NSIS installer hooks (Tauri v2).
;
; installer responsibilities:
;   * remove a Tuck 0.4.x per-user install before upgrading;
;   * keep Tuck's install folder on the per-user PATH (marker under HKCU\Software\Tuck);
;   * install / remove the Explorer "Send To" shortcuts through TuckCli.exe, which
;     validates Tuck ownership before touching any shortcut.
;
; The PATH edit is delegated to scripts/tuck-path.ps1 (staged next to the app) so
; this file stays free of nested shell quoting.

!macro TuckCheckBackendFile
  Push $0
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\tuck-sidecar.exe"
      ${ExitDo}
    ${EndIf}
    ; opening for write detects a running image without changing its contents
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\tuck-sidecar.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0'
    ${If} $0 != -1
      System::Call 'kernel32::CloseHandle(p r0)'
      ${ExitDo}
    ${EndIf}
    IfSilent 0 +3
      SetErrorLevel 2
      Abort
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Tuck's background process is still running, or its file cannot be replaced. Close Tuck, then choose Retry. If it remains blocked, restart Windows before running setup again." IDRETRY +3
    SetErrorLevel 2
    Abort
  ${Loop}
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; check before removing an older installation or replacing any files
  !insertmacro TuckCheckBackendFile
  ; remove a previous Inno Setup (0.4.x) per-user install if one is present
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}_is1" "QuietUninstallString"
  ${If} $R0 != ""
    DetailPrint "Removing the previous Tuck version..."
    nsExec::ExecToLog '$R0 /NORESTART /SUPPRESSMSGBOXES'
    Pop $R1
    ${If} $R1 <> 0
      MessageBox MB_OK|MB_ICONSTOP "Tuck could not remove the previous version automatically. Uninstall the older Tuck from Windows Settings, then run this installer again."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro TuckDetectWebView2 machineRoot machineKey userRoot userKey
  ; Microsoft documents the 32-bit machine view and the current user's pv value
  SetRegView 32
  ReadRegStr $R1 ${machineRoot} "${machineKey}" "pv"
  ${If} $R1 == ""
  ${OrIf} $R1 == "0.0.0.0"
    ReadRegStr $R1 ${userRoot} "${userKey}" "pv"
  ${EndIf}
  SetRegView lastused
  ${If} $R1 == "0.0.0.0"
    StrCpy $R1 ""
  ${EndIf}
!macroend

!macro TuckEnsureWebView2 machineRoot machineKey userRoot userKey bootstrapper
  !insertmacro TuckDetectWebView2 ${machineRoot} "${machineKey}" ${userRoot} "${userKey}"
  ${If} $R1 == ""
    ; use the hash-verified bootstrapper bundled with Tuck only when needed
    ${IfNot} ${FileExists} "${bootstrapper}"
      MessageBox MB_OK|MB_ICONSTOP "The WebView2 installer is missing. Re-download Tuck and run the installer again." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    DetailPrint "Installing the Microsoft Edge WebView2 Runtime..."
    nsExec::ExecToLog '"${bootstrapper}" /silent /install'
    Pop $R0
    !insertmacro TuckDetectWebView2 ${machineRoot} "${machineKey}" ${userRoot} "${userKey}"
    ; availability is authoritative even if another installer finished concurrently
    ${If} $R1 == ""
      MessageBox MB_OK|MB_ICONSTOP "Microsoft Edge WebView2 is still unavailable (installer exit code $R0). Install the WebView2 Runtime from Microsoft, then run Tuck setup again." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    ${If} $R0 == 1641
    ${OrIf} $R0 == 3010
      SetRebootFlag true
    ${EndIf}
  ${EndIf}
  DetailPrint "Microsoft Edge WebView2 Runtime $R1 is available."
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro TuckEnsureWebView2 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "$INSTDIR\MicrosoftEdgeWebView2Setup.exe"

  ; keep the install folder on the per-user PATH and record that Tuck added it
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\tuck-path.ps1" -Action add -Dir "$INSTDIR"'
  Pop $R0
  ${If} $R0 = 0
    WriteRegDWORD HKCU "Software\Tuck" "AddedToPath" 1
  ${ElseIf} $R0 = 10
    ; the folder was already present, so Tuck must not claim ownership
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "Tuck was installed, but its command-line tools could not be added to PATH (exit code $R0). The desktop app will still work."
  ${EndIf}

  ; TuckCli checks Tuck ownership before it touches any Send To shortcut
  nsExec::ExecToLog '"$INSTDIR\TuckCli.exe" sendto install'
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Tuck was installed, but its File Explorer Send To shortcuts could not be created (exit code $R0). You can retry from Settings."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; only Tuck-owned Send To shortcuts are removed; foreign ones are left alone
  nsExec::ExecToLog '"$INSTDIR\TuckCli.exe" sendto uninstall-all'
  Pop $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Tuck could not remove every Send To shortcut (exit code $R0). You may remove remaining Tuck shortcuts from the Windows SendTo folder."
  ${EndIf}

  ; undo the PATH entry only if Tuck was the one that added it
  ReadRegDWORD $R1 HKCU "Software\Tuck" "AddedToPath"
  ${If} $R1 = 1
    nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\tuck-path.ps1" -Action remove -Dir "$INSTDIR"'
    Pop $R0
    ${If} $R0 = 0
    ${OrIf} $R0 = 10
      DeleteRegValue HKCU "Software\Tuck" "AddedToPath"
      DeleteRegKey /ifempty HKCU "Software\Tuck"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Tuck could not remove its command-line folder from PATH (exit code $R0). You can remove $INSTDIR manually from your user PATH."
    ${EndIf}
  ${EndIf}
!macroend
