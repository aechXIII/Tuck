; Per-user Tuck installer
; Build: iscc scripts/installer.iss
;
; Produces a windowed Tuck.exe for GUI / Send To and a console
; TuckCli.exe for CLI operations (including uninstall cleanup)

#define MyAppName "Tuck"
#define MyAppVersion "0.4.0"
#define MyAppPublisher "aechXIII"
#define MyAppURL "https://github.com/aechXIII/Tuck"
#define MyAppExeName "Tuck.exe"
#define MyAppCliName "TuckCli.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
OutputDir=Output
OutputBaseFilename=Tuck-Setup-{#MyAppVersion}-x64
SetupIconFile=..\assets\Tuck.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}
ChangesEnvironment=yes
CloseApplications=yes
CloseApplicationsFilter=Tuck.exe,TuckCli.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; GroupDescription: "Additional icons:"
Name: "sendto"; Description: "Install Send To shortcut"; GroupDescription: "Shell integration:"

[Files]
Source: "..\dist\Tuck\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "tuck.cmd"; DestDir: "{app}"; DestName: "tuck.cmd"; Flags: ignoreversion
Source: "MicrosoftEdgeWebView2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{tmp}\MicrosoftEdgeWebView2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2 Runtime..."; Flags: waituntilterminated skipifdoesntexist
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
const
  UserEnvironmentKey = 'Environment';
  TuckRegistryKey = 'Software\Tuck';
  PathAddedValue = 'AddedToPath';

function PathContains(PathValue, Entry: String): Boolean;
begin
  Result := Pos(';' + Lowercase(Entry) + ';', ';' + Lowercase(PathValue) + ';') > 0;
end;

function RemoveFromPath(PathValue, Entry: String): String;
var
  Position: Integer;
begin
  Result := PathValue;
  Position := Pos(';' + Lowercase(Entry) + ';', ';' + Lowercase(Result) + ';');
  if Position = 0 then
    Exit;
  if Position = 1 then begin
    Delete(Result, 1, Length(Entry));
    if (Length(Result) > 0) and (Result[1] = ';') then
      Delete(Result, 1, 1);
  end else
    Delete(Result, Position, Length(Entry) + 1);
end;

procedure AddTuckToPath;
var
  CurrentPath: String;
  TuckPath: String;
begin
  TuckPath := ExpandConstant('{app}');
  if not RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    CurrentPath := '';
  if PathContains(CurrentPath, TuckPath) then
    Exit;
  if CurrentPath = '' then
    CurrentPath := TuckPath
  else
    CurrentPath := CurrentPath + ';' + TuckPath;
  if RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    RegWriteDWordValue(HKCU, TuckRegistryKey, PathAddedValue, 1)
  else
    MsgBox('Tuck could not add its install folder to your PATH. You can still run TuckCli.exe from its install folder.', mbError, MB_OK);
end;

procedure RemoveTuckFromPath;
var
  Added: Cardinal;
  CurrentPath: String;
  TuckPath: String;
begin
  if not RegQueryDWordValue(HKCU, TuckRegistryKey, PathAddedValue, Added) or (Added <> 1) then
    Exit;
  TuckPath := ExpandConstant('{app}');
  if RegQueryStringValue(HKCU, UserEnvironmentKey, 'Path', CurrentPath) then
    RegWriteExpandStringValue(HKCU, UserEnvironmentKey, 'Path', RemoveFromPath(CurrentPath, TuckPath));
  RegDeleteValue(HKCU, TuckRegistryKey, PathAddedValue);
end;

procedure InstallSendToShortcuts;
var
  ResultCode: Integer;
begin
  if not WizardIsTaskSelected('sendto') then
    Exit;
  if not Exec(ExpandConstant('{app}\{#MyAppCliName}'), 'sendto install', '', SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then begin
    MsgBox('Tuck could not start Send To shortcut installation.', mbError, MB_OK);
    Exit;
  end;
  if ResultCode <> 0 then
    MsgBox('Tuck could not install its Send To shortcuts because a same-named shortcut is already present and is not owned by Tuck. The existing shortcut was left unchanged.', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    AddTuckToPath;
    InstallSendToShortcuts;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    RemoveTuckFromPath;
end;

[InstallDelete]
; Clean up old cache on upgrade
Type: filesandordirs; Name: "{localappdata}\Tuck\Tuck\Cache"

[UninstallRun]
; Remove Tuck-managed Send To shortcuts on uninstall
; Uses TuckCli.exe with ownership validation
; Shortcuts not owned by Tuck are never touched
Filename: "{app}\{#MyAppCliName}"; Parameters: "sendto uninstall-all"; \
    Flags: runhidden skipifdoesntexist; \
    StatusMsg: "Removing Tuck Send To shortcuts..."; \
    RunOnceId: TuckRemoveSendTo
