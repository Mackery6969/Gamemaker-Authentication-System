import sys
import discord
import aiohttp

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load_env(path=".env"):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = line.strip()
            if m and not m.startswith("#") and "=" in m:
                k, v = m.split("=", 1)
                env[k.strip()] = v.strip()
    return env


_env = load_env()
TOKEN = _env["DISCORD_BOT_TOKEN"]
ADMIN_KEY = _env["ADMIN_API_KEY"]
BASE_URL = _env["WORKER_URL"].rstrip("/")

intents = discord.Intents.default()
client = discord.Client(intents=intents)


@client.event
async def on_ready():
    print(f"[mention-bot] online as {client.user} -- mention with '... generate' to build", flush=True)


@client.event
async def on_message(msg: discord.Message):
    if msg.author.bot:
        return
    print(f"[mention-bot] saw msg from {msg.author} content={msg.content!r} "
          f"mentions_me={client.user in msg.mentions}", flush=True)
    if client.user not in msg.mentions:
        return
    text = msg.content
    for token in (client.user.mention, f"<@!{client.user.id}>", f"<@{client.user.id}>"):
        text = text.replace(token, "")
    t = text.strip().lower()
    print(f"[mention-bot] stripped t={t!r} -> match={t == 'generate' or t.endswith(' generate')}", flush=True)
    if not (t == "generate" or t.endswith(" generate")):
        return

    payload = {"user_id": str(msg.author.id), "username": msg.author.name}
    print(f"[mention-bot] calling worker {BASE_URL}/api/mention-generate ...", flush=True)
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{BASE_URL}/api/mention-generate",
                              headers={"X-Admin-Key": ADMIN_KEY},
                              json=payload, timeout=aiohttp.ClientTimeout(total=15)) as r:
                data = await r.json()
    except Exception as e:
        print(f"[mention-bot] worker call FAILED: {type(e).__name__}: {e}", flush=True)
        return

    print(f"[mention-bot] worker said: {data}", flush=True)
    if data.get("ignore"):
        return
    await msg.reply(data.get("message", "..."), mention_author=True)


if __name__ == "__main__":
    client.run(TOKEN)
