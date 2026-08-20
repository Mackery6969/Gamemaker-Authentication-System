# site (Cloudflare Worker)

Per-tester watermarked builds that verify a player is a member of your tester
Discord server (and is the tester the build was made for, or a dev) before
the game runs. Builds that fail verification delete their own install folder.

```
Game ──POST /api/session──▶ Worker ──▶ returns state + Discord login URL
Game ──opens browser──────▶ Discord login
Discord ──redirect────────▶ Worker /callback ──asks bot: in tester guild?──▶ verdict
Game ──poll /api/result───▶ Worker ──▶ allow → play  |  deny → self-delete
```

A tester runs `/generate` in your Discord server → the Worker verifies them
and triggers a GitHub Actions build on a self-hosted runner (compiling the
build_id in) → the build is uploaded to R2 → the tester gets a DM with a
sign-in-required download link. See `DEPLOY.md` for full setup.

`../discordbot/` holds the Discord-side scripts (slash command registration,
mention fallback, admin CLI for stamping single builds). `../gamemaker/`
holds the client-side integration script. `../dllgenerator/` holds the native
build-ID watermark DLL and the self-updater.

Client-side anti-leak in a game build is bypassable by a determined attacker.
The real wins here are (1) blocking casual redistribution to non-testers and
(2) **attributing** any leak to a specific tester via the build watermark +
verification log.

## Deploy

See `DEPLOY.md`.

## Secrets

Set with `wrangler secret put <NAME>`, never in `wrangler.toml`:
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`,
`ADMIN_API_KEY`, `SIGNING_SECRET`, `GITHUB_TOKEN`.
