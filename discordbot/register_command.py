import json
import sys
import urllib.error
import urllib.request


def load_env(path=".env"):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = line.strip()
            if not m or m.startswith("#") or "=" not in m:
                continue
            k, v = m.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def main():
    env = load_env()
    app_id = env["DISCORD_CLIENT_ID"]
    guild_id = env["TESTER_GUILD_ID"]
    token = env["DISCORD_BOT_TOKEN"]

    branch_option = {
        "name": "branch",
        "description": "Branch to build from (default: tester-builds if it exists, else main)",
        "type": 3,
        "required": False,
        "autocomplete": True,
    }

    generate_options = [branch_option]
    generatefor_options = [
        {
            "name": "user",
            "description": "User to generate the build for",
            "type": 6,
            "required": True,
        },
        branch_option,
    ]

    commands = [
        {
            "name": "generate",
            "description": "Generate your personal tester build",
            "type": 1,
            "options": generate_options,
        },
        {
            "name": "cancel",
            "description": "(dev) Cancel a build and reset a user's cooldown",
            "type": 1,
            "options": [
                {
                    "name": "user",
                    "description": "User to cancel/reset (default: yourself)",
                    "type": 6,
                    "required": False,
                }
            ],
        },
        {
            "name": "cancelrun",
            "description": "(dev) Cancel a queued or running Worker run",
            "type": 1,
            "options": [
                {
                    "name": "runid",
                    "description": "Numeric Worker run id from /queue",
                    "type": 4,
                    "required": True,
                }
            ],
        },
        {
            "name": "cancel-build",
            "description": "(dev) Cancel a queued or running build by its build id",
            "type": 1,
            "options": [
                {
                    "name": "buildid",
                    "description": "Build id shown in parentheses by /queue",
                    "type": 3,
                    "required": True,
                }
            ],
        },
        {
            "name": "generatefor",
            "description": "(dev) Generate a build for another user",
            "type": 1,
            "options": generatefor_options,
        },
        {
            "name": "list",
            "description": "(dev) List running/queued builds",
            "type": 1,
        },
        {
            "name": "queue",
            "description": "(dev) Show the priority queue",
            "type": 1,
        },
        {
            "name": "dispatch",
            "description": "(dev) Run a dispatchable GitHub workflow",
            "type": 1,
            "options": [
                {
                    "name": "workflow",
                    "description": "Workflow to run",
                    "type": 3,
                    "required": True,
                    "choices": [
                        {"name": "base-build", "value": "base-build"},
                        {"name": "compile", "value": "compile"},
                        {"name": "clear-gm-cache", "value": "clear-gm-cache"},
                        {"name": "sync-pr-with-main", "value": "sync-pr-with-main"},
                    ],
                },
                {
                    "name": "branch",
                    "description": "Branch/ref to run on (defaults to main)",
                    "type": 3,
                    "required": False,
                    "autocomplete": True,
                },
                {
                    "name": "priority",
                    "description": "Lower number runs sooner",
                    "type": 4,
                    "required": False,
                },
            ],
        },
        {
            "name": "history",
            "description": "(dev) List recent completed/failed builds",
            "type": 1,
        },
    ]

    url = f"https://discord.com/api/v10/applications/{app_id}/guilds/{guild_id}/commands"
    req = urllib.request.Request(
        url,
        data=json.dumps(commands).encode(),
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "DiscordBot (https://github.com/your-org/your-repo, 1.0)",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req) as r:
            print("registered commands:", r.status)
            print(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"failed: {e.code} {e.read().decode()}")


if __name__ == "__main__":
    main()
