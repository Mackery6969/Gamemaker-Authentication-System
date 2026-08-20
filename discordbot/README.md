# discordbot

Discord-side scripts for your tester Discord server. Companion to `../site/`
(the Cloudflare Worker backend) — these talk to the Worker over HTTP, they
don't run any of the verification/build logic themselves.

| File | Role |
|------|------|
| `mention_bot.py` | Gateway listener for the "@bot generate" fallback. Relays to the Worker's `/api/mention-generate`; running it is what makes the bot show online. Stop it and you're back to slash-only. |
| `register_command.py` | Registers the `/generate`, `/generatefor`, `/cancel`, `/cancelrun`, `/list`, `/queue`, `/dispatch`, `/history` slash commands in your tester guild. Re-run after changing `AVAILABLE_BRANCHES` / `INCLUDE_PR_BRANCHES`. |
| `stamp_build.py` | Admin CLI: registers a `build_id -> tester_id` mapping with the Worker's admin API and prints the `ANTILEAK_BUILD_ID` macro line to compile into the game for that tester. |

Most slash commands (`/generate`, `/dispatch`, branch autocomplete, etc.) are
actually handled **directly by the Worker** via Discord's Interactions
Endpoint URL (set that to `https://auth.yourdomain.com/interactions` in the
Discord Developer Portal) — they don't need `mention_bot.py` running at all.
Only the "@bot generate" mention fallback needs the gateway bot online.

## Setup

```bash
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # then edit .env
python register_command.py  # registers/updates the slash commands
```

`/queue` shows only working/waiting queued actions, sorted with working items
first and then by priority. `/history` shows the last 10 completed, canceled,
or failed queued actions. `/cancelrun` cancels a queued or running action by
the numeric Worker run id shown in `/queue`.

`/dispatch` lets devs manually run any dispatchable workflow except
`tester-build`. `branch` is optional and defaults to your `TESTABLE_BRANCH`
(or `main`).

`register_command.py` and `mention_bot.py` read `.env`. `stamp_build.py` takes
everything via CLI flags instead — see `python stamp_build.py --help`.

`start_bot.bat` / `stop_bot.bat` / `restart_bot.bat` run `mention_bot.py` as a
background process on Windows (they look for `.venv\Scripts\pythonw.exe`,
falling back to `pythonw.exe` on PATH). Only needed if you want the mention
fallback.
