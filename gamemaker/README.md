# gamemaker

Client-side integration for a PT-Cleaned-based project. Two resources:

- **`scr_auth/`** — all the logic: talks to `../site`, tracks boot state,
  drives the updater. Import as a script.
- **`obj_authenticator/`** — a small persistent controller that drives
  `scr_auth`'s state machine and draws a plain status/progress screen while
  it runs. Import as an object.

## 1. Import both resources

Drop `scr_auth/` into your project's `scripts/` folder and
`obj_authenticator/` into `objects/` (or use GameMaker's "Add Existing" /
Local Package import so the IDE registers them and picks up the event list).

## 2. Create the `authentication` room

A small, otherwise-empty room. Place one persistent instance of
`obj_authenticator` in it. This is the room the game boots into instead of
your normal title screen; `obj_authenticator` sends the player on to
`Realtitlescreen` once `global.antileak_boot_stage` reaches `"ready"`.

Point your game's actual boot room at `authentication` instead of
`Realtitlescreen` directly.

## 3. Add the extension functions

`scr_auth.gml` calls three functions that come from `../dllgenerator`'s
compiled DLLs, not from GML itself. Create an Extension resource in the IDE
(or two — one per DLL) that binds these signatures:

| Function | From | Signature |
|---|---|---|
| `antileak_get_build_id()` | `antileak_id.dll` | `() -> string` |
| `antileak_launch_process(path, args)` | `antileak_launcher.dll` | `(string, string) -> real` (nonzero = success) |
| `antileak_is_wine()` | `antileak_launcher.dll` | `() -> real` (bool as 0/1) |

Point the extension at the DLL files built by `../dllgenerator` (copy the
compiled `.dll`s into the extension's folder, or wherever you configure the
extension to look).

## 4. Add the lang strings

`obj_authenticator/Draw_64.gml` calls `lang_get_value()` (standard
PT-Cleaned localization) for these keys — add them to your lang file(s):

`antileak_verifying`, `antileak_link_copied`, `antileak_checking_update`,
`antileak_update_prompt`, `antileak_update_confirm`, `option_yes`,
`option_no`, `antileak_updating_auth`, `antileak_update_ready` (this last one
via `lang_get_value_newline`, and takes `program_directory` as an
`embed_value_string` substitution — e.g. `"Update ready. Files are in {0}"`).

## 5. Configure the macros

At the top of `scr_auth.gml`:

```gml
#macro ANTILEAK_ENABLED	 false
#macro NUKE_ENABLED		 false
#macro ANTILEAK_BASE_URL	"https://auth.yourdomain.com"
#macro ANTILEAK_UPDATE_URL  "https://auth.yourdomain.com/api/latest"
#macro ANTILEAK_BRANCHES_URL "https://auth.yourdomain.com/api/branches"
```

- **`ANTILEAK_ENABLED false`** — the whole system no-ops (verification always
  passes instantly) *except* if a `test_id.txt` file sits next to the
  executable, in which case it fakes a verified session using that file's
  contents as the build id (or `"LOCALTEST"` if the file's empty) — lets you
  exercise the update-check/UI flow without a real DLL or real Discord login.
  Use this for every local/dev build.
- **`ANTILEAK_ENABLED true`** — the real thing: reads the build id from
  `antileak_get_build_id()` and closes the game if that fails (fail-closed).
  Set this only in builds that actually have `antileak_id.dll` compiled in
  with a real per-tester id (see `../dllgenerator/dll/README.md`).
- **`NUKE_ENABLED`** — whether a `deny` verdict deletes the install folder
  (`antileak_selfdestruct()`) or just closes the game. There's a hardcoded
  safety check refusing to delete anything if the install path looks like
  `windows`, `program files`, `system32`, or is suspiciously short — but
  you're still choosing whether this system is allowed to delete files at
  all, so understand what you're enabling before flipping it on.
  `global.antileak_build_id == "DEV"` is also always exempt.

## How a boot looks (real / `ANTILEAK_ENABLED true`)

1. `obj_authenticator` Create → `antileak_begin()` reads the build id from
   the DLL, `POST /api/session`.
2. Worker replies with a Discord login URL → game opens it in the browser
   and polls `poll_url` every `ANTILEAK_POLL_SECS`.
3. Player finishes the Discord login → next poll gets `verdict: allow` (or
   `deny`, which self-destructs if `NUKE_ENABLED`) → `device_token` gets
   saved to disk so the *next* launch can skip the browser step entirely if
   it's still fresh (24h).
4. On `allow`: fetches the selectable-branch list, then checks for an update
   against whichever branch is current (`antileak_version.json` next to the
   exe, written by your build pipeline — `{"branch": "...", "sha": "..."}`).
5. If an update's available: simple yes/no prompt → `antileak_start_update()`
   → downloads a signed job onto `../dllgenerator/updater`'s `updater.exe`,
   which the game hands off to and then exits.
6. Otherwise: `global.antileak_boot_stage = "ready"` → `obj_authenticator`
   sends the player to `Realtitlescreen`.

## Manual re-check

Call `antileak_manual_recheck()` from wherever your options/settings menu
lives to let a player force an update check without restarting (e.g. a
"Check for updates" button). It's a no-op if the player hasn't verified yet
or is already sitting in the `authentication` room.

## Settings players can change

Persisted via the save system's ini (see `antileak_load_settings()` /
`antileak_save_device_token()` etc. in `scr_auth.gml`):
`global.antileak_updates_disabled` (skip auto-update checks) and
`global.antileak_branch_override` (request a build from a specific branch
instead of whatever's baked into `antileak_version.json`). Wire these up to
options-menu UI however you like — they're just globals `scr_auth.gml`
reads.
