# game-ci

The GitHub Actions side that actually builds your game and feeds the queue
in `../site`. Unlike the other folders, **this one doesn't live in your copy
of this repo** — copy `game-ci/.github/` into the root of your *game's own*
repo (merging with whatever `.github/` it already has), so the paths land at
`.github/workflows/`, `.github/actions/build/`, `.github/gamemaker/`.

If your game's repo doesn't already have its own `.github/dependabot.yml`,
consider adding a `github-actions` entry for it too (see this repo's own
`.github/dependabot.yml` for the pattern) — otherwise these workflows'
pinned action versions won't get automatic update PRs.

## What it assumes

- A **self-hosted Windows runner** (`runs-on: [self-hosted, windows]`) with:
  GameMaker/Igor installable by `Mackery6969/igor-setup`, VS 2019 Build
  Tools at the default path (`.github/gamemaker/vsdevcmd-gm.bat` points at
  it), a persistent cache drive (`E:\gm-cache` by default, override via a
  `GM_CACHE_ROOT` env var on the runner itself), and — if
  `configure-steamworks` isn't set to `false` on the build action — a
  Steamworks SDK at `C:\steamworksSdk`.
- Cloudflare R2 (S3-compatible) for storing base-build packages and binary
  diff patches, accessed via `awscli` (auto-installed into a venv on first
  run).
- Your repo's `scripts/scr_auth/scr_auth.gml` and `extensions/ext_antileak_launcher/`
  paths match `../gamemaker`'s layout (rename the paths in `base-build.yml`'s
  "Enable auth system" step if you imported them somewhere else).

## Set these before running anything

**Repository variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Example | Used by |
| --- | --- | --- |
| `WORKER_BASE_URL` | `https://auth.yourdomain.com` | all workflows that talk to `../site` |
| `R2_BUCKET_NAME` | `your-game-builds` | everything touching base-build storage |
| `AUTH_SYSTEM_REPO` | `your-org/gamemaker-auth-system` | `base-build.yml`, `tester-build.yml` — wherever you keep your copy of *this whole toolkit repo*, for cross-repo DLL/updater artifact fetch and (optionally) as a submodule source |
| `GM_RUNTIME_VERSION` | `2024.1300.0.625` | GameMaker builds |
| `BUILD_MP_COUNT` | `8` | parallel compile job count (optional) |

**Secrets**:

| Secret | What it is |
| --- | --- |
| `GAMEMAKER_ACCESS_KEY` | GameMaker license/access key for Igor |
| `AUTH_SYSTEM_GITHUB_KEY` | GitHub PAT with read access to `AUTH_SYSTEM_REPO`, for fetching the pre-built launcher DLL / updater.exe artifacts (and cloning it as a submodule, if you use one) |
| `ANTILEAK_ADMIN_KEY` | **Must equal** `../site`'s `ADMIN_API_KEY` secret — different name, same value, this authenticates these workflows' callbacks to the Worker's `/api/agent/*` and `/api/admin/*` endpoints |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` | R2 API credentials (Cloudflare dashboard → R2 → Manage API Tokens) |

## Why cross-repo DLL/updater fetch

`base-build.yml` and `tester-build.yml` fetch `antileak_launcher.dll` /
`antileak_id.dll` / `updater.exe` from `AUTH_SYSTEM_REPO`'s own
`build-launcher.yml`/`build-updater.yml` runs (see `../dllgenerator`) rather
than compiling them inline here. That keeps your game repo's CI from needing
a second MSVC toolchain step on every build, and means updating the DLL
source doesn't require touching your game repo at all. If you'd rather build
them inline, replace those two steps with a direct call to
`../dllgenerator/dll/build.ps1` / `build_launcher.ps1` on a build-updater.yml
schedule of your own.

## Workflow reference

| Workflow | Trigger | Does |
| --- | --- | --- |
| `base-build.yml` | `workflow_dispatch` (from `../site`'s queue) | Full YYC build with auth enabled, uploads to R2, generates a binary diff against the previous base for that branch. |
| `compile.yml` | `workflow_dispatch` | Fast VM compile-check, no packaging - just "does this branch build." |
| `tester-build.yml` | `repository_dispatch: tester-build` (from `/generate`) | Mints one tester's build by injecting their watermark DLL into the cached base build - no full recompile. |
| `clear-gm-cache.yml` | `workflow_dispatch` | Clears the runner's GameMaker asset cache, optionally wipes a branch's (or all branches') R2 base build too. |
| `queue-push-signal.yml` | `push` | Tells the Worker's queue about relevant commits (auto-triggers a `base-build` if needed). |
| `cleanup-deleted-branch.yml` | `delete` (branch) | On a branch deletion after merge, carries its base-build cache forward to the merge target (avoids a wasted rebuild) and removes the deleted branch's R2 data. |
| `carry-base-build-on-merge.yml` | `pull_request: closed` / dispatch | Same cache-carry logic as above, for merges that don't go through branch deletion. |
| `sync-pr-with-main.yml` | `push` to main / PR labeled `sync` | Keeps PRs labeled `sync` up to date with `main`, dispatching a cache-carry when the sync is large enough that a full rebuild would otherwise be wasteful. |

`base-build`/`compile`/`clear-gm-cache` all accept `queue_id`/`target_ref`/
`target_sha` inputs and report back to the Worker's queue - that's the
contract `../site/src/index.ts`'s `queueWorkflowInputs()` dispatches against.
Don't rename those inputs without updating the Worker to match.
