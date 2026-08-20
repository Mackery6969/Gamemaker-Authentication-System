# Security Policy

This is a self-hosted template, not a hosted service: everyone who uses it
runs their own copy on their own Cloudflare account, GitHub org, and Discord
server, with their own secrets. There's no shared deployment where "the
whole userbase" is affected by an incident — a vulnerability here means a
bug in the template's own logic (an auth bypass, an injection point, secrets
that could leak through logs, etc.) that would affect anyone who deploys it,
not a live system that's already exposed.

## Supported versions

This repo doesn't do versioned releases — it's a rolling template. Security
fixes land on `main`; there isn't an older line still getting backports.

## What's in scope

Security issues in this repo's own code, roughly in order of how bad a bug
there would actually be:

- **`site/`** (the Cloudflare Worker) — auth bypass, session/state/device-
  token handling bugs, the `x-admin-key` checks, the Discord interaction
  signature verification, anything that lets an unauthenticated request do
  something it shouldn't (see `PUBLIC_UPDATES` in `wrangler.toml` — that one
  is *supposed* to be unauthenticated when opted into, so the bar there is
  "can it be tricked into serving something outside `base/<branch>/...`",
  not "it has no auth at all").
- **`dllgenerator/`** — the updater/launcher DLLs and the self-updater
  executable, especially anything around update-package verification
  (`sha256`, the patch manifest) that could let a tampered/wrong update
  through, or the XOR watermarking that could leak more than intended.
- **`gamemaker/`, `discordbot/`, `game-ci/`** — same standard, for whatever
  trust boundary each one crosses (game ↔ Worker, bot ↔ Worker, CI ↔
  Worker/R2).

## What's out of scope

- "Client-side anti-leak is bypassable by a determined attacker" is a known,
  documented limitation (see the root `README.md`), not a vulnerability
  report — the honest goal here is attribution after a leak, not prevention.
- Bugs in *your* deployment or configuration (leaked secrets, an
  over-permissioned Cloudflare/Discord/GitHub token, `PUBLIC_UPDATES` turned
  on when you didn't mean to, etc.) aren't issues in this repo — though a
  normal public issue is welcome if you think the docs should warn about a
  footgun more clearly.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting instead of a public
issue: open this repo's **Security** tab → **Report a vulnerability**. That
reaches the maintainer privately so a fix can go out before any details are
public.

If that option isn't available for some reason, open a regular issue that
says you have something to report privately and omits exploit details — a
way to reach you privately will follow from there.

There's no bug bounty — this is a small, mostly-solo-maintained template —
but real reports are genuinely appreciated, and you'll be credited in the
fix commit/changelog unless you'd rather stay anonymous.
