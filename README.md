# GameMaker Authentication System

A per-tester build watermarking + Discord-gated auth system for distributing
private GameMaker builds to a closed group of testers — built for, and
intended to be reused across, Pizza Tower (PT-Cleaned-based) mods. Blocks
casual redistribution to non-testers and, more importantly, **attributes**
any leaked build back to whichever tester it was issued to.

```
Game ──POST /api/session──▶ Worker ──▶ returns state + Discord login URL
Game ──opens browser──────▶ Discord login
Discord ──redirect────────▶ Worker /callback ──asks bot: in tester guild?──▶ verdict
Game ──poll /api/result───▶ Worker ──▶ allow → play  |  deny → self-delete
```

A tester runs `/generate` in your Discord server → the Worker verifies them
and triggers a GitHub Actions build on a self-hosted runner (compiling a
per-tester build id in) → the build's uploaded to R2 → the tester gets a DM
with a sign-in-required download link. The game also self-updates: on boot it
checks a version endpoint and, if stale, downloads and applies an update
without the tester doing anything manually.

Be honest with yourself about what this buys you: client-side anti-leak in a
compiled game build is bypassable by a determined attacker. The real wins are
(1) blocking casual redistribution to non-testers and (2) **attributing** any
leak that does happen to a specific tester, via the build watermark and the
Worker's verification log.

## Components

| Folder | What it is |
|---|---|
| `site/` | Cloudflare Worker — the backend. OAuth flow, build queue, tester/dev Discord slash commands, download hosting, leak-attribution logging. |
| `discordbot/` | Small Python scripts that live alongside the Worker: slash-command registration, an optional "@bot generate" gateway fallback, an admin CLI for one-off build stamping. |
| `dllgenerator/` | Native Windows tooling: the per-build watermark DLL, a launcher helper DLL, and the self-updater executable. |
| `gamemaker/` | The GML side — a script + a controller object to drop into your GameMaker project. |

Each folder has its own README with the details; this one is just the map
and the setup order.

## Setup order

1. **`site/`** — deploy the Worker first (`site/DEPLOY.md`). Everything else
   points at its URL.
2. **`discordbot/`** — register slash commands against your tester guild.
3. **`dllgenerator/`** — build the DLLs/updater (needs MSVC build tools,
   Windows-only).
4. **`gamemaker/`** — import the script + object into your GameMaker project,
   wire up the extension functions from step 3, add the required lang
   strings, and set the macros to point at your deployed Worker.

You don't need `dllgenerator/`/`gamemaker/`'s watermarking at all to use just
the tester-build pipeline (Discord → CI → R2 → DM) — that part of `site/`
works standalone. The DLL/GML pieces are what add build watermarking,
Discord-gated boot verification, and self-updating to the game itself.

## What's *not* here

CI workflows that actually build your game (`base-build`/`compile`/
`clear-gm-cache` `workflow_dispatch` jobs in your game's own repo) and a
self-hosted runner to execute them. `site/`'s queue *dispatches* those
workflows and polls GitHub for the result; it doesn't build anything itself.
See `site/DEPLOY.md`'s prerequisites for the exact `workflow_dispatch` input
contract your workflows need to accept.

## License

Apache 2.0 — see `LICENSE`.
