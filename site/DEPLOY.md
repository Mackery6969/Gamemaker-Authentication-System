# Deploying the Worker to Cloudflare

The Worker serves the OAuth return + verdict polling at
`https://auth.yourdomain.com`. The GameMaker client (`../gamemaker/`) and
`../discordbot/stamp_build.py` just point at this URL — nothing about them
needs to change based on how you deploy the Worker.

## Prerequisites

- A Cloudflare account with `yourdomain.com` added as a zone (or use the free
  `*.workers.dev` subdomain Cloudflare gives every Worker instead of a custom
  domain — everything below still works, just skip the "attach the subdomain"
  step and use that URL everywhere).
- A Discord application (bot token, client id/secret, bot invited to your
  tester server). **Server Members Intent is NOT required** for the Worker —
  it checks membership via the REST API, which only needs the bot to be *in*
  the guild.
- A GitHub repo containing your game project, with `base-build`, `compile`,
  and `clear-gm-cache` workflows that accept `workflow_dispatch` with
  `queue_id` / `target_ref` / `target_sha` inputs (see the queue-item
  dispatch logic in `src/index.ts`'s `queueWorkflowInputs()` for the exact
  contract), and a self-hosted runner able to build your game headlessly.
  That CI setup is outside the scope of this repo — this Worker only
  *dispatches* the workflow and polls GitHub for the run's outcome.

## 1. Install + log in

```bash
cd site
npm install
npx wrangler login
```

## 2. Create the KV namespaces and R2 bucket

```bash
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create BUILDS
npx wrangler r2 bucket create your-bucket-name
```

Paste the printed `id` values into `wrangler.toml` (replacing
`PASTE_SESSIONS_KV_ID` / `PASTE_BUILDS_KV_ID`), and put your bucket name in
place of `PASTE_YOUR_R2_BUCKET_NAME`.

## 3. Fill in non-secret config

Edit `[vars]` in `wrangler.toml` — at minimum:
- `TESTER_GUILD_ID` — your Discord server's ID
- `GITHUB_REPO` — `owner/repo` of your game project
- `DISCORD_PUBLIC_KEY` — from the Discord Developer Portal, your app's
  General Information page (not a secret, but app-specific)
- `OAUTH_REDIRECT_URI` = `"https://auth.yourdomain.com/callback"`
- `PUBLIC_BASE_URL` = `"https://auth.yourdomain.com"`

`DEV_IDS` / `DEV_ROLE_IDS` (comma-separated Discord user/role IDs) control
who can use the dev-only slash commands (`/generatefor`, `/dispatch`,
`/cancel`, etc.) — leave both empty and nobody gets dev access until you set
one.

## 4. Set the secrets

```bash
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put GITHUB_TOKEN         # needs repo + workflow scopes on GITHUB_REPO
npx wrangler secret put ADMIN_API_KEY        # invent a long random string
npx wrangler secret put SIGNING_SECRET       # invent another, different string
```

## 5. Deploy + attach the domain (optional)

```bash
npx wrangler deploy
```

If you're using a custom domain: in the dashboard, **Workers & Pages →
gm-auth-worker → Settings → Domains & Routes → Add Custom Domain →
`auth.yourdomain.com`**. Cloudflare creates the DNS record and TLS cert
automatically. (Or uncomment the `routes` line in `wrangler.toml` and
re-deploy.) If you're using the default `*.workers.dev` URL instead, skip
this step and use that URL everywhere `auth.yourdomain.com` appears above.

## 6. Point Discord at it

In the Discord developer portal: **OAuth2 → Redirects** must contain exactly
the value you set as `OAUTH_REDIRECT_URI`.

## 7. Verify

```bash
curl https://auth.yourdomain.com/api/health        # {"ok":true}
```

## 8. Stamp a single build (skip the queue, for one-off testers)

```bash
python ../discordbot/stamp_build.py \
  --tester-id 123456789012345678 --label "some tester" \
  --base-url https://auth.yourdomain.com \
  --admin-key <ADMIN_API_KEY>
```

This just registers the `build_id -> tester_id` mapping and prints the
`ANTILEAK_BUILD_ID` value to compile into that one build — see
`../gamemaker/README.md` for what to do with it. It doesn't touch CI at all;
for the normal per-tester flow (Discord `/generate` → CI build → DM), you
don't need this script.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the secrets
npx wrangler dev                 # serves http://localhost:8787
```

For local OAuth, temporarily add `http://localhost:8787/callback` to the
Discord redirect list and set the two `*_URI`/`*_URL` vars to
`http://localhost:8787`.

## Leak attribution

Every verification is logged two ways:
- `npx wrangler tail` — live stream (`VERIFY {...}` lines).
- `GET /api/admin/logs?limit=200` with header `X-Admin-Key: <ADMIN_API_KEY>` —
  durable (90-day) JSON history. A build assigned to one tester that shows
  `deny` hits from other accounts has leaked.

## Cost

Free tier covers this easily: 100k Worker requests/day and 100k KV reads/day.
Each verification is a handful of requests.
