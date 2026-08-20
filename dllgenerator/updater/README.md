# updater

Standalone self-updater. The game can't safely overwrite its own running
`.exe`/`.dll` files, so instead it writes an `update_job.txt` job file and
launches `updater.exe`, which waits for the game process to exit, downloads
+ verifies + applies the update (full zip extract, or an `hpatchz`-style
binary diff if `mode=patch`), then relaunches the game.

```powershell
./build.ps1
```

Output: `updater.exe` next to the script (or `-OutDir`). Copy it next to your
game's main executable in every distributed build.

## Job file format

Plain `key=value` lines, written by `../gamemaker/scr_auth.gml`'s
`antileak_launch_updater()` next to `updater.exe` (or, as a fallback,
`%APPDATA%\<GAME_APPDATA_FOLDER_NAME>\update_job.txt` — see the `#define` at
the top of `updater.c`):

```
download_url=https://...
mode=full|patch
target_sha=...
package_sha256=...
install_dir=C:\path\to\game\
relaunch_exe=YourGame.exe
verify=some/file.ext|<sha256>        # zero or more, patch mode only
```

`verify` entries are checked against the current install *before* patching —
if any don't match, the patch is refused (a stale/hand-modified install can't
safely receive a binary diff) rather than corrupting the install.

Progress/errors show in a small always-on-top window; failures also get
appended to `update_error.log` in the install directory.
