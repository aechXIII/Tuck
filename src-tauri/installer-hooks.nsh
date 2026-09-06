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

!macro NSIS_HOOK_PREINSTALL
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

!macro NSIS_HOOK_POSTINSTALL
  ; use the reviewed bootstrapper shipped in the package, never a build-time download
  ${IfNot} ${FileExists} "$INSTDIR\MicrosoftEdgeWebView2Setup.exe"
    MessageBox MB_OK|MB_ICONSTOP "The WebView2 installer is missing. Re-download Tuck and run the installer again."
    Abort
  ${EndIf}
  DetailPrint "Checking the Microsoft Edge WebView2 Runtime..."
  nsExec::ExecToLog '"$INSTDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install'
  Pop $R0
  ${If} $R0 != 0
  ${AndIf} $R0 != 1641
  ${AndIf} $R0 != 3010
    MessageBox MB_OK|MB_ICONSTOP "Microsoft Edge WebView2 could not be installed (exit code $R0). Check your internet connection, then run this installer again."
    Abort
  ${EndIf}

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
