# Windows sandbox checklist

Run this checklist in a disposable Windows VM or Windows Sandbox with a new
standard user account. Use the candidate installer and record the results
below before release. The installer has no Windows code-signing certificate,
so Windows may show an unknown-publisher warning. Do not use a developer checkout or a user profile
that has run Tuck before.

## Prepare

1. Copy the candidate installer and its published SHA-256 value into the
   sandbox. Verify the file hash with `Get-FileHash -Algorithm SHA256`.
2. Confirm that neither **Tuck** nor **TuckCli** is on `PATH`, and that no Tuck
   entry exists in the user `Path` environment value.
3. Keep one small playable video available outside the installation folder.
4. Record the Windows version, architecture, candidate version, installer file
   name, and hash in the table.

## Clean install and backend

1. In one fresh snapshot, run the installer as the standard user and complete
   WebView2 setup. In another fresh snapshot, run `<installer> /S`; confirm the
   silent install completes and Start-menu launch works in both cases.
2. Start Tuck from the Start menu. At the 960 x 640 minimum window size, add
   the sample video through the file dialog, then drag the same file from File
   Explorer into the editor. Confirm the drop overlay responds, the file is not
   duplicated, thumbnail and preview load, and seeking works.
3. With Tuck already open, launch `Tuck.exe <second-sample-video>` from a
   Command Prompt. Confirm no second editor window stays open, the first window
   receives focus, and it imports the second file exactly once.
4. Queue a short export and wait for a completed output.
5. Open Settings and use **Open configuration folder** and **Open logs folder**.
   Confirm both opened folders contain the files Tuck uses: configuration holds
   `settings.json` after a settings change, and logs contains `tuck.log` after
   the app runs. They must not be empty unrelated Tauri application folders.
6. Close Tuck during a second short export. Confirm the app closes and no new
   `tuck-sidecar.exe` or `ffmpeg.exe` process remains after a short wait.

Expected: the editor starts without a browser error, preview and export use the
bundled tools, second launches focus and forward files once, settings persist
after restart, and the backend stops when Tuck closes.

## Command line and Send To

1. Open a *new* Command Prompt and run `tuck --version`.
2. In File Explorer, select the sample video and choose **Send to > Tuck**.
   Confirm the editor opens with the file ready for review.
3. Repeat with **Send to > Tuck Compress**. Confirm a console encode starts and
   creates an output without opening a second editor.
4. In Tuck Settings, remove and then restore the generic Send To integration.
   Confirm both shortcuts are removed and restored. If a same-named shortcut
   from another application is deliberately placed in SendTo, confirm Tuck
   reports the collision and leaves that shortcut unchanged.

Expected: `tuck` resolves after a new shell starts; review targets `Tuck.exe`;
compress targets `TuckCli.exe`; and only shortcuts marked as Tuck-owned are
removed.

## PATH ownership and uninstall

Run these as separate fresh sandbox snapshots so their preconditions stay
clear. Inspect the user value with
`[Environment]::GetEnvironmentVariable('Path', 'User')` and the marker with
`Get-ItemProperty 'HKCU:\Software\Tuck' -Name AddedToPath`.

### Tuck-added entry

1. With no install directory entry on user PATH, install Tuck.
2. Confirm the install directory appears once on user PATH and `AddedToPath` is
   `1`.
3. Uninstall from Windows Settings.
4. Confirm that one directory entry is gone and the marker is gone.

### Pre-existing entry

1. Before installing, add the intended install directory to user PATH yourself.
2. Install Tuck.
3. Confirm the directory appears once and no `AddedToPath` marker was created.
4. Uninstall Tuck.
5. Confirm the pre-existing directory remains on user PATH.

Expected: uninstall changes PATH only when Tuck created the recorded entry.

## Upgrade and package checks

1. In a clean snapshot, install the previous 0.4.x Inno Setup release, create a
   custom profile, and install its Send To shortcut.
2. Run the candidate installer over it. Confirm the old installation is removed,
   the custom profile is still available, and both generic Send To actions work.
3. Run the candidate uninstaller. Confirm no Tuck-owned generic or profile Send
   To shortcut remains, and repeat the PATH ownership check that matches the
   snapshot setup.
4. In the build environment, run
   `python scripts/verify_package.py --platform windows --artifact <installer>`
   and record its result. This checks the actual installer payload and starts
   the frozen sidecar and CLI.

Expected: upgrading preserves settings and profiles, removes only
Tuck-owned integrations, and the artifact verification reports `PACKAGE OK`.

## Test record

Record the candidate version, installer filename and SHA-256, Windows version,
tester, and test date. Mark each check as passed, failed, or not run:

- Installer signature and package verification
- Interactive and silent installation
- Preview, export, and shutdown
- Command line and Send To
- PATH ownership and uninstall
- Upgrade from the previous release

Include error messages and steps to reproduce any failure.
