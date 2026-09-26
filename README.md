# GameMaker Authentication System

A per-tester build watermarking + Discord-gated auth system for distributing
private GameMaker builds to a closed group of testers — built for, and
intended to be reused across, Pizza Tower (PT-Optimized-based) mods. Blocks
casual redistribution to non-testers and, more importantly, **attributes**
any leaked build back to whichever tester it was issued to.

```text
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
| --- | --- |
| `site/` | Cloudflare Worker — the backend. OAuth flow, build queue, tester/dev Discord slash commands, download hosting, leak-attribution logging. |
| `discordbot/` | Small Python scripts that live alongside the Worker: slash-command registration, an optional "@bot generate" gateway fallback, an admin CLI for one-off build stamping. |
| `dllgenerator/` | Native Windows tooling: the per-build watermark DLL, a launcher helper DLL, and the self-updater executable — plus the CI (`.github/workflows/`) that builds them. |
| `gamemaker/` | The GML side — a script + a controller object to drop into your GameMaker project. |
| `game-ci/` | GitHub Actions workflows that actually build your game and feed `site/`'s queue. Copy its `.github/` into your *game's own* repo, not this one — see `game-ci/README.md`. |

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
5. **`game-ci/`** — copy its `.github/` into your game repo and set up the
   self-hosted runner it expects (`game-ci/README.md` has the full
   variable/secret list).

You don't need `dllgenerator/`/`gamemaker/`/`game-ci/`'s watermarking and
build automation at all to use just the tester-build pipeline manually —
`site/` and `discordbot/` alone can gate Discord-verified downloads of builds
you upload by hand. The other three pieces are what add build watermarking,
Discord-gated boot verification, self-updating, and full CI automation.

## Editor setup

`.vscode/extensions.json` has recommended extensions for the mix of
languages here (TypeScript, Python, PowerShell, GitHub Actions YAML, GML).

## Security

Found a vulnerability in this template's own code (not "client-side
anti-leak is bypassable," which is a known limitation, not a bug)? See
[Here](SECURITY.md) for what's in scope and how to report it privately.

## Support

This is free and self-hostable, and stays that way — the whole point is that
you can run it yourself on Cloudflare's free tier. If it saved you a weekend
of wiring up Discord OAuth and build plumbing, you can chip in:

- [GitHub Sponsors](https://github.com/sponsors/Mackery6969) — recurring or one-off
- [Ko-fi](https://ko-fi.com/Mackery6969) — one-off, no account needed

Donations support development in general; they don't buy priority support or
a place in the issue queue. Bug reports and PRs are worth just as much.

## License

Apache 2.0 — see [LICENSE](LICENSE).
