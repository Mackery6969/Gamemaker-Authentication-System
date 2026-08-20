"""Register ONE tester's build with the antileak backend, then print the line to
paste into the game's ANTILEAK_BUILD_ID macro before you export for that tester.

Example:
    python stamp_build.py --tester-id 123456789012345678 --label "some tester" \
        --base-url https://auth.yourdomain.com --admin-key <ADMIN_API_KEY>

The build_id is now COMPILED INTO the game (#macro ANTILEAK_BUILD_ID), so there is
no stamp file to write - you recompile per tester. This tool only creates the
backend's build_id -> tester_id mapping and hands you the id to compile in.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tester-id", required=True, help="tester's Discord user ID")
    p.add_argument("--label", default="", help="human label, e.g. tester name")
    p.add_argument("--base-url", required=True, help="backend URL, e.g. https://auth.yourdomain.com")
    p.add_argument("--admin-key", required=True, help="ADMIN_API_KEY from the backend")
    p.add_argument("--build-id", default=None, help="reuse a specific build id (default: random)")
    args = p.parse_args()

    build_id = args.build_id or uuid.uuid4().hex
    base_url = args.base_url.rstrip("/")

    body = json.dumps(
        {"build_id": build_id, "tester_id": args.tester_id, "label": args.label}
    ).encode()
    req = urllib.request.Request(
        base_url + "/api/admin/register-build",
        data=body,
        headers={"Content-Type": "application/json", "X-Admin-Key": args.admin_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            print("registered:", r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"register failed: {e.code} {e.read().decode()}")

    print()
    print(f"  build_id : {build_id}")
    print(f"  tester   : {args.tester_id}  {args.label}")
    print()
    print("Now set this in scripts/scr_auth, then export for this tester:")
    print(f'  #macro ANTILEAK_BUILD_ID    "{build_id}"')


if __name__ == "__main__":
    main()
