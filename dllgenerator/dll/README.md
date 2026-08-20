# dll

## antileak_id.dll (per-tester watermark)

```powershell
./build.ps1 -BuildId "some_tester"
```

Generates a fresh random XOR key, encodes `-BuildId` with it, patches both
into a temp copy of `antileak_id.c`, and compiles that. `antileak_id.c` as
checked into this repo is just a placeholder that build.ps1 always
overwrites — don't compile it directly.

Output: `antileak_id.dll` next to the script (or `-OutDir`). Copy it into
your GameMaker project's `extensions/` folder for whichever extension wraps
`antileak_get_build_id()` (see `../../gamemaker/README.md`).

In your normal per-tester build pipeline, this runs as one step of whatever
builds the actual game (e.g. a CI job) — `../../site` never needs to know the
key or the DLL, it just receives whatever `antileak_get_build_id()` returns
at runtime and treats it as an opaque id.

## antileak_launcher.dll (generic helper)

```powershell
./build_launcher.ps1
```

Same for every build — build once, copy the output into your GameMaker
project's extension folder, done. Re-run only if you change `antileak_launcher.c`.
