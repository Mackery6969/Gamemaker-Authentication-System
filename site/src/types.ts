import type { BuildQueue } from "./queue";
import type { VerifyFile } from "./builds";

export interface Env {
  SESSIONS: KVNamespace;
  BUILDS: KVNamespace;
  BUILDS_R2: R2Bucket;
  BUILD_QUEUE: DurableObjectNamespace<BuildQueue>;
  TESTER_GUILD_ID: string;
  ALERT_CHANNEL_ID: string;
  BUILD_LOG_CHANNEL_ID: string;
  DEV_IDS: string;
  DEV_ROLE_IDS: string;
  GUILD_ONLY: string;
  GENERATE_ENABLED: string;
  GENERATE_ALLOWLIST: string;
  MENTION_ENABLED: string;
  OAUTH_REDIRECT_URI: string;
  PUBLIC_BASE_URL: string;
  SESSION_TTL: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  ADMIN_API_KEY: string;
  SIGNING_SECRET: string;
  DISCORD_PUBLIC_KEY: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  AVAILABLE_BRANCHES: string;
  INCLUDE_PR_BRANCHES: string;
  TESTABLE_BRANCH: string;
}

// A verification/download/update session, keyed by a random `state` string
// in SESSIONS. `kind` distinguishes the three flows that all reuse the same
// Discord-OAuth-redirect dance (see auth.ts's callback()); undefined kind
// means "the original tester-build verification flow".
export interface Session {
  build_id: string; created: number; status: "pending" | "done" | "expired" | "error";
  verdict?: "allow" | "deny" | "error"; user_id?: string; username?: string;
  in_guild?: boolean; sig?: string; device_token?: string;
  kind?: "verify" | "download" | "update"; token?: string; authorized?: boolean;
  update_branch?: string; update_current_sha?: string;
  update_key?: string; update_mode?: "patch" | "full"; update_target_sha?: string;
  update_package_sha256?: string; update_verify?: VerifyFile[];
}
