# dllgenerator

Native Windows tooling used by the GameMaker client (`../gamemaker/`):

- **`dll/`** — two small DLLs, built with the MSVC compiler (`cl.exe`, from a
  Visual Studio "Developer PowerShell" so it's on PATH):
  - `antileak_id.dll` — carries the per-build watermark (`antileak_get_build_id()`).
    Rebuilt fresh for every tester build, with a random key and that tester's
    id baked in.
  - `antileak_launcher.dll` — generic helper (launch a process, detect Wine).
    Identical for every build; build it once.
- **`updater/`** — `updater.exe`, a standalone self-updater the game launches
  and then exits, so it can replace the game's own files while they're not in
  use. Built with `cl.exe` too, links `miniz` (bundled) for zip extraction.

None of this needs to exist if you don't want auto-updates or build
watermarking — the site/bot/gamemaker pieces work without them (see
`../gamemaker/README.md` for what `ANTILEAK_ENABLED false` skips).

## Build requirements

- MSVC build tools (Visual Studio or the standalone Build Tools), run from a
  "Developer PowerShell for VS" so `cl.exe` is on PATH.
- Windows only - these DLLs/exe are Win32 targets.
