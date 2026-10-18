import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backoffSeconds,
  classifyErrorReply,
  classifyFailure,
  formatSeconds,
  parseRetryAfter,
  type FailureClass,
} from "../src/adapters/failures.js";
import type { AdapterFailures, CliResult } from "../src/adapters/types.js";

// The failure classes: which class a failed CLI run falls in, from the
// runner's flags, its exit status and its output, and when it may be retried.

function run(fields: Partial<CliResult>): CliResult {
  return { returncode: 1, stdout: "", stderr: "", timedOut: false, duration: 1, ...fields };
}

const classify = (stderr: string, patterns?: AdapterFailures, now?: number): FailureClass =>
  classifyFailure(run({ stderr }), { patterns, now });

// --- flags and exit status --------------------------------------------------------

test("the runner's flags and exit 127 decide before any output is read", () => {
  const limited = "API Error: 429 Too Many Requests";
  assert.deepEqual(classifyFailure(run({ stderr: limited, stalled: true, returncode: -1 })), { reason: "stalled" });
  assert.deepEqual(
    classifyFailure(run({ stderr: limited, timedOut: true, returncode: -1 })),
    { reason: "timeout" },
    "a CLI killed at the timeout timed out, whatever it was retrying when it was killed",
  );
  assert.deepEqual(classifyFailure(run({ stderr: "failed to launch 'codex': spawn codex ENOENT", returncode: 127 })), {
    reason: "not_found",
  });
  assert.deepEqual(classifyFailure(run({ stderr: "sh: 1: kimi: not found", returncode: 127 })), { reason: "not_found" });
  assert.deepEqual(classify("Error: spawn /usr/lib/node_modules/opencode/bin/opencode ENOENT"), { reason: "not_found" });
  assert.deepEqual(classify("segmentation fault"), { reason: "exit" });
  assert.deepEqual(classifyFailure(run({ returncode: 2 })), { reason: "exit" }, "no output at all");
});

// --- what each CLI prints ------------------------------------------------------
//
// Verbatim samples from each CLI's source or issue tracker ("…" marks an id or
// a tail cut short there). Where a sample names when to come back, the clock
// is fixed so the retry-after can be checked too.

const T = Date.UTC(2026, 9, 17, 12, 0, 0);
const local = (h: number, m = 0) => new Date(2026, 9, 17, h, m).getTime();

const WORDING: Array<{ cli: string; text: string; reason: string; retryAfter?: number; now?: number; source: string }> = [
  // Claude Code (`claude -p`)
  { cli: "claude", text: "API Error: Rate limit reached", reason: "rate_limit", source: "anthropics/claude-code#79500" },
  {
    cli: "claude",
    text: "API Error: Request rejected (429) · this may be a temporary capacity issue.",
    reason: "rate_limit",
    source: "code.claude.com/docs/en/errors",
  },
  {
    cli: "claude",
    text: "API Error: Server is temporarily limiting requests (not your usage limit)",
    reason: "rate_limit",
    source: "code.claude.com/docs/en/errors",
  },
  {
    cli: "claude",
    text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded."}}',
    reason: "rate_limit",
    source: "anthropics/claude-code#39745",
  },
  {
    cli: "claude",
    text: "API Error (429 {…}) · Retrying in 1 seconds… (attempt 1/10)",
    reason: "rate_limit",
    source: "LLM-Red-Team/kimi-cc#16 (its own retries say nothing about when the limit lifts)",
  },
  {
    cli: "claude",
    text: "Claude AI usage limit reached|1751911200",
    reason: "quota",
    retryAfter: 3600,
    now: 1751911200_000 - 3600_000,
    source: "anthropics/claude-code#3138",
  },
  { cli: "claude", text: "5-hour limit reached ∙ resets 12pm", reason: "quota", retryAfter: 3600, now: local(11), source: "anthropics/claude-code#6457" },
  {
    cli: "claude",
    text: "You've hit your limit · resets 4pm (Asia/Kuala_Lumpur)",
    reason: "quota",
    retryAfter: 3600,
    now: Date.UTC(2026, 9, 17, 7, 0), // 3pm in Kuala Lumpur (UTC+8)
    source: "anthropics/claude-code#19673",
  },
  {
    cli: "claude",
    text: "You've hit your session limit · resets 10:40pm (Asia/Tokyo)",
    reason: "quota",
    retryAfter: 3600,
    now: Date.UTC(2026, 9, 17, 12, 40), // 9:40pm in Tokyo (UTC+9)
    source: "anthropics/claude-code#98132",
  },
  { cli: "claude", text: "Credit balance is too low", reason: "quota", source: "anthropics/claude-code#39453" },
  { cli: "claude", text: "Not logged in · Please run /login", reason: "auth", source: "anthropics/claude-code#39453" },
  { cli: "claude", text: "Invalid API key · Please run /login", reason: "auth", source: "anthropics/claude-code#5167" },
  {
    cli: "claude",
    text:
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. ' +
      'Please obtain a new token or refresh your existing token."}} · Please run /login',
    reason: "auth",
    source: "anthropics/claude-code#18225",
  },
  { cli: "claude", text: "Failed to authenticate", reason: "auth", source: "anthropics/claude-code CHANGELOG" },
  {
    cli: "claude",
    text: "Claude requested permissions to use mcp__github__create_issue, but you haven't granted it yet.",
    reason: "permission",
    source: "paperclipai/paperclip#14940",
  },
  {
    cli: "claude",
    text: '{"type":"result","subtype":"success","permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_…"}]}',
    reason: "permission",
    source: "anthropics/claude-code#90578",
  },
  // Codex (`codex exec`): errors on stderr as `ERROR: <msg>`, exit 1
  {
    cli: "codex",
    text: "ERROR: exceeded retry limit, last status: 429 Too Many Requests, request id: …",
    reason: "rate_limit",
    source: "openai/codex#26655",
  },
  {
    cli: "codex",
    text: "ERROR: Selected model is at capacity. Please try a different model.",
    reason: "rate_limit",
    source: "openai/codex codex-rs/protocol/src/error.rs",
  },
  {
    cli: "codex",
    text:
      "Rate limit reached for gpt-5.1 in organization org-AAA on tokens per min (TPM): Limit 30000, Used 22999, " +
      "Requested 12528. Please try again in 11.054s.",
    reason: "rate_limit",
    retryAfter: 11.054,
    source: "openai/codex codex-rs/codex-api/src/sse/responses.rs",
  },
  {
    cli: "codex",
    text:
      "■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 6 hours 37 minutes.",
    reason: "quota",
    retryAfter: 4 * 86400 + 6 * 3600 + 37 * 60,
    source: "openai/codex#4095",
  },
  {
    cli: "codex",
    text:
      "■ You've hit your usage limit. To get more access now, send a request to your admin or try again at Apr 17th, 2026 3:29 PM.",
    reason: "quota",
    retryAfter: 3600,
    now: new Date(2026, 3, 17, 14, 29).getTime(),
    source: "openai/codex#16920",
  },
  {
    cli: "codex",
    text: "ERROR: Your workspace is out of credits. Add credits to continue.",
    reason: "quota",
    source: "openai/codex codex-rs/protocol/src/error.rs",
  },
  {
    cli: "codex",
    text: "ERROR: Quota exceeded. Check your plan and billing details.",
    reason: "quota",
    source: "openai/codex codex-rs/protocol/src/error.rs",
  },
  // Codex `exec --json`: the same wording, as the message of a turn.failed or error event.
  {
    cli: "codex",
    text: "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    reason: "quota",
    source: "openai/codex codex-rs/protocol/src/error.rs (UsageLimitReachedError)",
  },
  {
    cli: "codex",
    text: "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
    reason: "quota",
    source: "openai/codex codex-rs/protocol/src/error.rs (UsageLimitReachedError)",
  },
  {
    cli: "codex",
    text: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
    reason: "quota",
    source: "openai/codex codex-rs/protocol/src/error.rs (UsageNotIncluded)",
  },
  {
    cli: "codex",
    text: "You’ve hit your usage limit for GPT-5.1-Codex-Max. Switch to another model now, or try again at 3:29 PM.",
    reason: "quota",
    retryAfter: 3600,
    now: new Date(2026, 9, 17, 14, 29).getTime(),
    source: "openai/codex codex-rs/protocol/src/error.rs (UsageLimitReachedError)",
  },
  {
    cli: "codex",
    text: "rate limit exceeded: Rate limit reached for gpt-5.1 in organization org-AAA on tokens per min (TPM). Please try again in 2.5s.",
    reason: "rate_limit",
    retryAfter: 2.5,
    source: "openai/codex codex-rs/protocol/src/error.rs (RateLimitExceeded)",
  },
  {
    cli: "codex",
    text: "We’re currently experiencing high demand, which may cause temporary errors.",
    reason: "rate_limit",
    source: "openai/codex codex-rs/protocol/src/error.rs (InternalServerError)",
  },
  { cli: "codex", text: "Flex capacity unavailable.", reason: "rate_limit", source: "openai/codex codex-rs/protocol/src/error.rs (FlexUnavailable)" },
  {
    cli: "codex",
    text: "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
    reason: "auth",
    source: "openai/codex codex-rs/login/src/auth/manager.rs",
  },
  { cli: "codex", text: "API key login is required", reason: "auth", source: "openai/codex codex-rs/login/src/auth/manager.rs" },
  {
    cli: "codex",
    text: "ERROR: unexpected status 401 Unauthorized: Incorrect API key provided: sk-…, url: …",
    reason: "auth",
    source: "openai/codex#48237",
  },
  {
    cli: "codex",
    text: "ERROR: 401 Unauthorized: Missing bearer or basic authentication in header",
    reason: "auth",
    source: "openai/codex#30514",
  },
  {
    cli: "codex",
    text:
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    reason: "auth",
    source: "openai/codex#17340",
  },
  { cli: "codex", text: '"error":{"message":"user cancelled MCP tool call"}', reason: "permission", source: "openai/codex#16685" },
  {
    cli: "codex",
    text: "MCP tool call cancelled: interactive approval is unavailable in exec mode",
    reason: "permission",
    source: "openai/codex codex-rs/core/src/mcp_tool_call.rs",
  },
  { cli: "codex", text: "exec command rejected by user", reason: "permission", source: "openai/codex (exec)" },
  // Gemini CLI: stderr, exit 1 (auth: 41)
  {
    cli: "gemini",
    text: "[API Error: Resource has been exhausted (e.g. check quota).]",
    reason: "rate_limit",
    source: "google-gemini/gemini-cli#19976",
  },
  {
    cli: "gemini",
    text: '"message": "The model is overloaded. Please try again later.", "status": "UNAVAILABLE"',
    reason: "rate_limit",
    source: "google-gemini/gemini-cli#7227",
  },
  {
    cli: "gemini",
    text:
      "You exceeded your current quota, please check your plan and billing details. " +
      '"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" Please retry in 15.002899939s.',
    reason: "rate_limit", // the free tier's per-minute limit, worded as a quota
    retryAfter: 15.002899939,
    source: "google-gemini/gemini-cli#8883",
  },
  {
    cli: "gemini",
    text:
      "Quota exceeded for quota metric 'Gemini 2.5 Pro Requests' and limit 'Gemini 2.5 Pro Requests per day per user per tier'",
    reason: "quota",
    source: "google-gemini/gemini-cli#10513",
  },
  {
    cli: "gemini",
    text: "✕ [API Error: You have exhausted your daily quota on this model.]",
    reason: "quota",
    source: "google-gemini/gemini-cli#15576",
  },
  { cli: "gemini", text: "TerminalQuotaError", reason: "quota", source: "google-gemini/gemini-cli#26840" },
  {
    cli: "gemini",
    text: "RetryableQuotaError: Suggested retry after 60s.",
    reason: "rate_limit",
    retryAfter: 60,
    source: "google-gemini/gemini-cli packages/core/src/utils/googleQuotaErrors.ts",
  },
  {
    cli: "gemini",
    text: "You have exhausted your capacity on this model. Your quota will reset after 5s.",
    reason: "rate_limit", // refills within a minute
    retryAfter: 5,
    source: "google-gemini/gemini-cli#22107",
  },
  {
    cli: "gemini",
    text: "You have exhausted your capacity on this model. Your quota will reset after 19h14m47s.",
    reason: "quota",
    retryAfter: 19 * 3600 + 14 * 60 + 47,
    source: "google-gemini/gemini-cli#22107",
  },
  {
    cli: "gemini",
    text:
      "Please set an Auth method in your /home/me/.gemini/settings.json or specify one of the following environment " +
      "variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
    reason: "auth",
    source: "google-gemini/gemini-cli packages/cli/src/validateNonInterActiveAuth.ts",
  },
  {
    cli: "gemini",
    text: "API key not valid. Please pass a valid API key.",
    reason: "auth",
    source: "google-gemini/gemini-cli#20284",
  },
  { cli: "gemini", text: "The caller does not have permission", reason: "auth", source: "google-gemini/gemini-cli#25512" },
  {
    cli: "gemini",
    text: 'Tool execution for "run_shell_command" requires user confirmation, which is not supported in non-interactive mode.',
    reason: "permission",
    source: "google-gemini/gemini-cli packages/core/src/scheduler/policy.ts",
  },
  {
    cli: "gemini",
    text: "Tool execution denied by policy.",
    reason: "permission",
    source: "google-gemini/gemini-cli packages/core/src/scheduler/policy.ts",
  },
  // Qwen Code: stderr `[API Error: …]`, exit 1
  { cli: "qwen", text: "429 Free allocated quota exceeded.", reason: "quota", source: "QwenLM/qwen-code#1742" },
  {
    cli: "qwen",
    text: "Qwen OAuth free tier has been discontinued as of 2026-04-15.",
    reason: "quota",
    source: "QwenLM/qwen-code packages/core/src/utils/retry.ts",
  },
  {
    cli: "qwen",
    text:
      "Quota exhausted: monthly tokens used up. Please retry after the reset time, or switch to another API key / auth method.",
    reason: "quota",
    source: "QwenLM/qwen-code packages/core/src/utils/quotaErrorDetection.ts",
  },
  {
    cli: "qwen",
    text: "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-13 23:52:51",
    reason: "quota",
    retryAfter: 3600,
    now: new Date(2026, 9, 13, 22, 52, 51).getTime(),
    source: "QwenLM/qwen-code#13895",
  },
  {
    cli: "qwen",
    text: "✕ [API Error: Refresh token expired or invalid. Please use '/auth' to re-authenticate.]",
    reason: "auth",
    source: "QwenLM/qwen-code#378",
  },
  { cli: "qwen", text: "API Error: 401 invalid access token or token expired", reason: "auth", source: "QwenLM/qwen-code#3858" },
  {
    cli: "qwen",
    text: "No auth type is selected. Please configure an auth type …",
    reason: "auth",
    source: "QwenLM/qwen-code packages/cli/src/validateNonInterActiveAuth.ts",
  },
  {
    cli: "qwen",
    text:
      'Qwen Code requires permission to use "run_shell_command", but that permission was declined ' +
      "(non-interactive mode cannot prompt for confirmation).",
    reason: "permission",
    source: "QwenLM/qwen-code packages/core/src/core/coreToolScheduler.ts",
  },
  // Kimi CLI (`kimi --print`): errors on stdout, exit 75 (429, 5xx) or 1
  {
    cli: "kimi",
    text:
      "Error code: 429 - {'error': {'message': \"We're receiving too many requests at the moment. Please wait a moment " +
      "and try again.\", 'type': 'rate_limit_reached_error'}}",
    reason: "rate_limit",
    source: "MoonshotAI/kimi-cli#907",
  },
  {
    cli: "kimi",
    text: "…request reached organization max RPM: 20, please try again after 1 seconds",
    reason: "rate_limit",
    retryAfter: 1,
    source: "MoonshotAI/kimi-cli#1599",
  },
  {
    cli: "kimi",
    text: "'The engine is currently overloaded, please try again later', 'type': 'engine_overloaded_error'",
    reason: "rate_limit",
    source: "MoonshotAI/kimi-cli#2571",
  },
  {
    cli: "kimi",
    text:
      'Your account org-… <ak-…> is suspended due to insufficient balance, please recharge your account or check your ' +
      'plan and billing details","type":"exceeded_current_quota_error"',
    reason: "quota",
    source: "MoonshotAI/kimi-code#1860",
  },
  {
    cli: "kimi",
    text: 'Error code: 403 - …exceeded current quota, please check your plan and billing details","type":"exceeded_current_quota_error"',
    reason: "quota",
    source: "MoonshotAI/Kimi-K2#5",
  },
  {
    cli: "kimi",
    text: "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
    reason: "quota",
    source: "letta-ai/letta-code#4162",
  },
  {
    cli: "kimi",
    text:
      "Error code: 401 - {'error': {'message': 'The API Key appears to be invalid or may have expired. Please verify your " +
      "credentials and try again.', 'type': 'invalid_authentication_error'}}",
    reason: "auth",
    source: "MoonshotAI/kimi-cli#1971",
  },
  { cli: "kimi", text: "LLM not set", reason: "auth", source: "MoonshotAI/kimi-cli" },
  // OpenCode (`opencode run --format json`): JSONL error events on stdout, exit 1
  {
    cli: "opencode",
    text: "AI_RetryError: Failed after 4 attempts. Last error: Too Many Requests",
    reason: "rate_limit",
    source: "anomalyco/opencode#2398",
  },
  { cli: "opencode", text: "Upstream request failed: Account budget exceeded", reason: "quota", source: "anomalyco/opencode#51779" },
  {
    cli: "opencode",
    text: '"type": "FreeUsageLimitError", "message": "Rate limit exceeded. Please try again later."',
    reason: "quota",
    source: "anomalyco/opencode#33495",
  },
  { cli: "opencode", text: "Free usage exceeded, subscribe to Go", reason: "quota", source: "anomalyco/opencode#45989" },
  {
    cli: "opencode",
    text: 'HTTP 401: …"CreditsError","message":"Insufficient balance. …"',
    reason: "quota", // sent as a 401
    source: "anomalyco/opencode#48604",
  },
  {
    cli: "opencode",
    text: "OpenAI API key is missing. Pass it using the 'apiKey' parameter or the OPENAI_API_KEY environment variable.",
    reason: "auth",
    source: "anomalyco/opencode#20725",
  },
  { cli: "opencode", text: "ProviderAuthError: ProviderAuthError", reason: "auth", source: "anomalyco/opencode#31414" },
  {
    cli: "opencode",
    text: '{"type":"error","error":{"name":"APIError","data":{"message":"…","statusCode":401,"isRetryable":false}}}',
    reason: "auth",
    source: "anomalyco/opencode#48297, #55653",
  },
  {
    cli: "opencode",
    text: "Error: The user rejected permission to use this specific tool call.",
    reason: "permission",
    source: "anomalyco/opencode#36413",
  },
  // Kilo Code (`kilo run`): OpenCode's shapes, plus its gateway's errors
  {
    cli: "kilo",
    text: "usage_limit_exceeded: Add credits to continue, or switch to a free model",
    reason: "quota",
    source: "Kilo-Org/cloud llm-proxy-helpers.ts; Kilo-Org/kilocode#12538",
  },
  {
    cli: "kilo",
    text: "Your authentication token is invalid. Please sign in again.",
    reason: "auth",
    source: "Kilo-Org/cloud llm-proxy-helpers.ts",
  },
  {
    cli: "kilo",
    text:
      "[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider.",
    reason: "rate_limit",
    source: "Kilo-Org/cloud llm-proxy-helpers.ts",
  },
  {
    cli: "kilo",
    text: "Your top-up is processing. Please retry in a few seconds.\nRetry-After: 5",
    reason: "rate_limit",
    retryAfter: 5,
    source: "Kilo-Org/cloud llm-proxy-helpers.ts",
  },
  {
    cli: "kilo",
    text: "run ended with an auto-rejected permission; pass --auto for autonomous use",
    reason: "permission",
    source: "Kilo-Org/kilocode packages/opencode/src/cli/cmd/run.ts",
  },
  // Cursor Agent CLI: stderr, exit 1
  { cli: "cursor", text: "ConnectError: [resource_exhausted] Error", reason: "rate_limit", source: "forum.cursor.com/t/144782" },
  { cli: "cursor", text: "Error: You’ve hit your usage limit", reason: "quota", source: "forum.cursor.com/t/128577" },
  {
    cli: "cursor",
    text: "Your usage limits will reset when your monthly cycle ends on 8/14/2025.",
    reason: "quota",
    source: "forum.cursor.com/t/128577",
  },
  {
    cli: "cursor",
    text: "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.",
    reason: "auth",
    source: "Cursor agent bundle (dist-package/7000.index.js)",
  },
  { cli: "cursor", text: "Blocked by permissions configuration", reason: "permission", source: "Cursor agent bundle" },
  { cli: "cursor", text: "⚠ Workspace Trust Required", reason: "permission", source: "Cursor agent bundle" },
  // Antigravity CLI (agy): the stream-json result's `error` (exit 3 since
  // 1.2.10), and an `AGY_ERROR: {...}` line on stderr since 1.2.6
  {
    cli: "agy",
    text:
      "API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription " +
      "to increase your limits. Resets in 2h39m52s.",
    reason: "quota",
    retryAfter: 2 * 3600 + 39 * 60 + 52,
    source: "google-antigravity/antigravity-cli#1018",
  },
  {
    cli: "agy",
    text:
      'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. ... Resets in 1h1m35s.",' +
      '"status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true}',
    reason: "quota",
    retryAfter: 3600 + 60 + 35,
    source: "google-antigravity/antigravity-cli#1018 (1.2.14)",
  },
  { cli: "agy", text: "Your AI credits balance is too low to continue.", reason: "quota", source: "agy changelog 1.2.15" },
  {
    // Composed: #1018's prefix on the 429 RESOURCE_EXHAUSTED message of #1019.
    cli: "agy",
    text: "API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).",
    reason: "rate_limit",
    source: "google-antigravity/antigravity-cli#1018, #1019",
  },
  { cli: "agy", text: "error: authentication required", reason: "auth", source: "antigravity.google/docs/cli/headless" },
  { cli: "agy", text: "Authentication expired. Please log back in.", reason: "auth", source: "agy changelog 1.3.3" },
  { cli: "agy", text: "Waiting for authentication (timeout 60s)...\nError: authentication timed out", reason: "auth", source: "google-antigravity/antigravity-cli#944" },
  { cli: "agy", text: "Error: failed to retrieve token: secret keyring is locked", reason: "auth", source: "antigravity.google/docs/cli/troubleshooting" },
  // A model the CLI does not know, has retired, or does not offer the account (model_unavailable)
  {
    cli: "claude",
    text:
      "There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it. " +
      "Run --model to pick a different model.",
    reason: "model_unavailable",
    source: "anthropics/claude-code#97393",
  },
  {
    cli: "claude",
    text: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: totally-fake-model"},"request_id":"req_…"}',
    reason: "model_unavailable",
    source: "anthropics/claude-code#99578",
  },
  {
    cli: "codex",
    text: "ERROR: unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.",
    reason: "model_unavailable",
    source: "openai/codex#44560",
  },
  { cli: "codex", text: "ERROR: unexpected status 404 Not Found: Model not found gpt-5.5", reason: "model_unavailable", source: "openai/codex#43755" },
  {
    cli: "codex",
    text: "Codex error: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    reason: "model_unavailable",
    source: "openai/codex#54665, #53020",
  },
  {
    cli: "gemini",
    text: "[API Error: models/gemini-3.1-pro is not found for API version v1beta, or is not supported for generateContent.]",
    reason: "model_unavailable",
    source: "google-gemini/gemini-cli#24131",
  },
  { cli: "gemini", text: "ModelNotFoundError: Not found (404)", reason: "model_unavailable", source: "google-gemini/gemini-cli#24828" },
  {
    cli: "gemini",
    text:
      "This client is no longer supported for Gemini Code Assist for individuals.\n" +
      "To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google",
    reason: "model_unavailable",
    source: "littlebearapps/untether#720 (gemini 0.40.1)",
  },
  {
    cli: "agy",
    text: 'invalid model selection (--model "gemini-3.1-flash-image" --effort "")',
    reason: "model_unavailable",
    source: "google-antigravity/antigravity-cli#734",
  },
  {
    cli: "agy",
    text: "model gemini-3.1-flash-image is not recognized as a known model or custom model in settings",
    reason: "model_unavailable",
    source: "google-antigravity/antigravity-cli#734",
  },
  {
    // Composed: DashScope's OpenAI-compatible error (code model_not_found) as Qwen Code prints an API error.
    cli: "qwen",
    text: "[API Error: 404 The model `qwen9-max` does not exist or you do not have access to it.]",
    reason: "model_unavailable",
    source: "composed from DashScope's OpenAI-compatible error codes; QwenLM/qwen-code#10932 (404 model_not_found)",
  },
  {
    cli: "opencode",
    text: "ProviderModelNotFoundError: Model not found: deepseek/deepseek-v4-flash. Did you mean: deepseek-flash, deepseek-v4-pro?",
    reason: "model_unavailable",
    source: "anomalyco/opencode#51159",
  },
  {
    cli: "kilo",
    text: "Model not found: kilo/kilo-auto/free. Did you mean: kilo-auto/balanced, kilo-auto/efficient, kilo-auto/frontier?",
    reason: "model_unavailable",
    source: "Kilo-Org/kilocode#13311",
  },
  {
    cli: "cursor",
    text: "Cannot use this model: haiku-4.5. Available models: auto, composer-1.5, composer-1",
    reason: "model_unavailable",
    source: "forum.cursor.com/t/164331",
  },
];

test("each CLI's own wording lands in its class, with when to come back", () => {
  for (const { cli, text, reason, retryAfter, now, source } of WORDING) {
    const got = classifyFailure(run({ stderr: text }), { now: now ?? T });
    const label = `${cli}: ${text} (${source})`;
    assert.equal(got.reason, reason, label);
    if (retryAfter === undefined) continue;
    assert.ok(got.retryAfter !== undefined && Math.abs(got.retryAfter - retryAfter) < 1e-6, `${label} → ${got.retryAfter}`);
  }
  // Every CLI and every class is covered.
  assert.deepEqual(
    [...new Set(WORDING.map((w) => w.cli))].sort(),
    ["agy", "claude", "codex", "cursor", "gemini", "kilo", "kimi", "opencode", "qwen"],
  );
  assert.deepEqual([...new Set(WORDING.map((w) => w.reason))].sort(), ["auth", "model_unavailable", "permission", "quota", "rate_limit"]);
});

test("Kimi prints its errors on stdout; colors and curly apostrophes do not hide a class", () => {
  const kimi = run({ returncode: 75, stdout: "Error code: 429 - {'error': {'type': 'rate_limit_reached_error'}}" });
  assert.equal(classifyFailure(kimi).reason, "rate_limit");
  assert.equal(classify("\x1b[31m✕ [API Error: You have exhausted your daily quota on this model.]\x1b[0m").reason, "quota");
  assert.equal(
    classify("Claude requested permissions to use Bash, but you haven’t granted it yet.").reason,
    "permission",
    "U+2019 reads as a plain apostrophe",
  );
});

test("a model that is not there: read from the final lines only, after a spent quota, before a 403", () => {
  // A transcript before the end that mentions a missing model (a test of the agent's own code) is no evidence.
  const transcript = `exec npm test\nError: model not found in registry\n${"log line\n".repeat(600)}`;
  assert.equal(classify(`${transcript}fatal: the end`).reason, "exit");
  assert.equal(classify(`${transcript}ERROR: Model not found gpt-5.5`).reason, "model_unavailable");
  // A spent quota on one model ("switch to another model") is a quota; a model at capacity is a rate limit.
  assert.equal(classify("You've hit your usage limit for GPT-5.1-Codex-Max. Switch to another model now.").reason, "quota");
  assert.equal(classify("ERROR: Selected model is at capacity. Please try a different model.").reason, "rate_limit");
  // "you may not have access to it" sent as a 403 is still the model's.
  assert.equal(classify("Error 403: The model `o9` does not exist or you do not have access to it.").reason, "model_unavailable");
  // Claude Code's text mode may print it as its reply and exit 0.
  assert.deepEqual(
    classifyErrorReply("There's an issue with the selected model (claude-x). It may not exist or you may not have access to it."),
    { reason: "model_unavailable" },
  );
  // An adapter may add its own wording for the class.
  assert.equal(classify("E_NO_SUCH_MODEL", { model_unavailable: ["^E_NO_SUCH_MODEL"] }).reason, "model_unavailable");
});

// --- a clean exit whose reply is only an error ------------------------------------

test("a short reply that is only a CLI error is classified; a real answer is not", () => {
  const future = Math.floor(T / 1000) + 3 * 3600;
  assert.deepEqual(classifyErrorReply("API Error: Rate limit reached\n", { now: T }), { reason: "rate_limit" });
  assert.deepEqual(classifyErrorReply(`Claude AI usage limit reached|${future}`, { now: T }), {
    reason: "quota",
    retryAfter: 3 * 3600,
  });
  assert.equal(classifyErrorReply("Not logged in · Please run /login")?.reason, "auth");
  assert.equal(classifyErrorReply("You’ve hit your limit · resets 4pm (Asia/Kuala_Lumpur)")?.reason, "quota");
  for (const reply of [
    "",
    "The answer is 42.",
    "API Error: 500 Internal Server Error", // an error, but not one this changes anything for
    "To handle `API Error: Rate limit reached`, back off and retry.", // a reply about the error
    `API Error: Rate limit reached\n${"and here is the rest of a long answer. ".repeat(40)}`, // too long to be only that
  ]) {
    assert.equal(classifyErrorReply(reply), null, reply.slice(0, 60));
  }
});

// --- precedence and where the output is read ------------------------------------

test("a spent quota that arrives as a 429 is a quota, not a rate limit", () => {
  const openai =
    "Error code: 429 - {'error': {'message': 'You exceeded your current quota, please check your plan and billing " +
    "details.', 'type': 'insufficient_quota', 'param': None, 'code': 'insufficient_quota'}}";
  assert.equal(classify(openai).reason, "quota");
});

test("the end of stderr outweighs a transcript printed before it", () => {
  // Codex prints its whole session (commands, their output) on stderr.
  const transcript = `exec curl -s localhost:3000/admin\nHTTP/1.1 401 Unauthorized\n${"log line\n".repeat(600)}`;
  assert.equal(classify(`${transcript}ERROR: exceeded retry limit, last status: 429 Too Many Requests`).reason, "rate_limit");
  // ... but the transcript still counts when the end says nothing.
  assert.equal(classify(`${transcript}fatal: the end`).reason, "auth");
  // A rate limit, which starts a whole new agent run, needs the final lines.
  const tested = `exec curl -si localhost:3000/burst\nHTTP/1.1 429 Too Many Requests\n${"log line\n".repeat(600)}`;
  assert.equal(classify(`${tested}ERROR: stream disconnected before completion`).reason, "exit");
  assert.equal(classify(`${tested}ERROR: exceeded retry limit, last status: 429 Too Many Requests`).reason, "rate_limit");
});

test("stdout is read when stderr says nothing, JSONL events included", () => {
  assert.equal(
    classifyFailure(run({ stdout: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }))
      .reason,
    "rate_limit",
  );
  const event = JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Rate limit exceeded", statusCode: 429 } } });
  assert.equal(classifyFailure(run({ stdout: `{"type":"step_start"}\n${event}\n`, stderr: "" })).reason, "rate_limit");
});

test("the brief's own words: 429, rate limit, too many requests, overloaded, 529/503", () => {
  for (const text of [
    "HTTP 429",
    "Error: rate limit",
    "rate limit hit, backing off",
    "Too Many Requests",
    "API Error: Overloaded",
    "529 Overloaded",
    "503 Service Unavailable: the model is overloaded",
  ]) {
    assert.equal(classify(text).reason, "rate_limit", text);
  }
});

test("an agent's own work in the output is not mistaken for a failure class", () => {
  for (const text of [
    "I'll add rate limiting middleware: 100 requests per minute per client.",
    "The usage limit for free accounts is 10 per day.",
    "error: call of overloaded 'parse(int)' is ambiguous",
    "bash: ./deploy.sh: Permission denied",
    "src/billing/invoice.ts | 12 ++++++------",
    "Retrying in 5 seconds… (attempt 2/10)",
    "TypeError: Cannot read properties of undefined (reading 'quota')",
    "line 429: unexpected token",
  ]) {
    assert.equal(classify(text).reason, "exit", text);
  }
});

test("lines that only echo the prompt are no evidence", () => {
  const prompt = "You are one agent in an automated workflow.\n\nRetry 429 Too Many Requests responses in the API client.";
  // Codex prints the prompt on stderr before its session.
  const stderr = `[2026-10-17T12:00:00] User instructions:\n${prompt}\n\n[2026-10-17T12:00:09] ERROR: stream disconnected`;
  assert.equal(classifyFailure(run({ stderr })).reason, "rate_limit", "unguarded, the task reads as a rate limit");
  assert.equal(classifyFailure(run({ stderr }), { prompt }).reason, "exit");
  const limited = `${stderr}\nERROR: exceeded retry limit, last status: 429 Too Many Requests`;
  assert.equal(classifyFailure(run({ stderr: limited }), { prompt }).reason, "rate_limit", "the CLI's own error still counts");
});

test("an adapter's own patterns are matched first, and may re-class a message", () => {
  const perMinute = "Quota exceeded for quota metric 'Requests' and limit 'Requests per day per user'";
  assert.equal(classify(perMinute).reason, "quota");
  assert.equal(classify(perMinute, { rate_limit: ["quota metric 'Requests'"] }).reason, "rate_limit");
  assert.equal(classify("E_BUSY: come back later", { rate_limit: ["^E_BUSY"] }).reason, "rate_limit");
  assert.equal(classify("session gone, sorry", { auth: ["session gone"] }).reason, "auth");
  assert.equal(classify("out of juice", { quota: ["out of juice"] }).reason, "quota");
  // A pattern built by hand that does not compile is skipped, not thrown.
  assert.equal(classify("boom", { auth: ["(unclosed"] }).reason, "exit");
});

test("a rate limit or a quota carries when to come back, read from the output", () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0);
  assert.deepEqual(classify("429 Too Many Requests. Retry-After: 30", undefined, now), {
    reason: "rate_limit",
    retryAfter: 30,
  });
  assert.deepEqual(classify("You've hit your usage limit. Try again in 3h 22m.", undefined, now), {
    reason: "quota",
    retryAfter: 12_120,
  });
  assert.deepEqual(classify("Invalid API key · Please run /login. Retry after 30s", undefined, now), { reason: "auth" });
});

// --- retry-after --------------------------------------------------------------------

test("parseRetryAfter reads durations in the wordings CLIs use", () => {
  const cases: Array<[string, number]> = [
    ["retry after 30s", 30],
    ["Retry-After: 30", 30],
    ['"retry-after": "30"', 30],
    ["Please try again in 2 minutes.", 120],
    ["Please retry in 41.512937196s.", 41.512937196],
    ['"retryDelay": "41s"', 41],
    ["Try again in 3h 22m.", 12_120],
    ["try again in 4 days 2 hours 13 minutes", 4 * 86400 + 2 * 3600 + 13 * 60],
    ["please try again after 1 seconds", 1],
    ["Please try again in 6m0s.", 360],
    ["Please try again in 820ms.", 0.82],
    ["try again in 1 hour and 30 minutes", 5400],
    ["Your limit resets in 2 hours", 7200],
  ];
  for (const [text, seconds] of cases) {
    const got = parseRetryAfter(text);
    assert.ok(got !== undefined && Math.abs(got - seconds) < 1e-9, `${text} → ${got}, expected ${seconds}`);
  }
});

test("parseRetryAfter reads reset times: clock, date, IANA zone, HTTP date, ISO, epoch", () => {
  const now = Date.UTC(2026, 9, 17, 18, 0, 0); // 18:00 UTC = 14:00 in New York = 03:00 next day in Tokyo
  const epoch = Date.UTC(2026, 9, 17, 18, 10) / 1000;
  const cases: Array<[string, number]> = [
    ["5-hour limit reached ∙ resets 7pm (UTC)", 3600],
    ["Your limit will reset at 7:10 pm (UTC).", 4200],
    ["resets at 19:10 (UTC)", 4200],
    ["You've hit your limit · resets 3pm (America/New_York)", 3600],
    ["resets 4am (Asia/Tokyo)", 3600],
    ["resets at 5pm (UTC)", 23 * 3600], // passed today: tomorrow's
    ["Opus weekly limit reached ∙ resets Oct 20, 5pm (UTC)", 3 * 86400 - 3600],
    ["try again at Oct 20th, 2026 3:45 PM (UTC)", 3 * 86400 - 2 * 3600 - 15 * 60],
    ["Retry-After: Sat, 17 Oct 2026 18:01:00 GMT", 60],
    ["resets at 2026-10-17T19:10:00Z", 4200],
    [`Claude AI usage limit reached|${epoch}`, 600],
  ];
  for (const [text, seconds] of cases) {
    assert.equal(parseRetryAfter(text, now), seconds, text);
  }
});

test("parseRetryAfter reads a clock time with no zone locally, and a reset that just passed as now", () => {
  const sixPm = new Date(2026, 9, 17, 18, 0, 0).getTime(); // local time, wherever the tests run
  assert.equal(parseRetryAfter("resets at 7:10pm", sixPm), 4200);
  assert.equal(parseRetryAfter("resets 7pm (PT)", sixPm), 3600, "not an IANA zone: read locally");
  assert.equal(parseRetryAfter("resets at 6pm", sixPm + 60_000), 0, "printed a moment ago: it has just reset");
  assert.equal(parseRetryAfter("Retry-After: Sat, 17 Oct 2026 11:00:00 GMT", Date.UTC(2026, 9, 17, 12)), 0, "past is 0");
});

test("parseRetryAfter ignores what is not a retry hint, and the last hint wins", () => {
  for (const text of [
    "try again later",
    "Retrying in 5 seconds… (attempt 2/10)",
    "retrying 1/5 in 202ms…",
    "resets soon",
    "Retry-After: soon",
    "retry after 30", // no unit: not a header
    "resets at 13pm",
  ]) {
    assert.equal(parseRetryAfter(text), undefined, text);
  }
  assert.equal(parseRetryAfter("retry after 10s\n... later ...\nretry after 20s"), 20);
});

// --- backoff and formatting ---------------------------------------------------------

test("backoffSeconds doubles from 15s, honors a retry-after, and stays under maxBackoff", () => {
  const exact = (retry: number, retryAfter?: number, max = 300) => backoffSeconds(retry, retryAfter, max, () => 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => exact(n)), [15, 30, 60, 120, 240, 300]);
  assert.equal(exact(1, 45), 45, "the CLI's own retry-after replaces the exponential step");
  assert.equal(exact(3, 0.5), 0.5);
  assert.equal(exact(1, 300), 300);
  assert.equal(exact(1, 301), null, "asked for longer than maxBackoff: not worth retrying early");
  assert.equal(exact(1, undefined, 10), 10);
  const spread = backoffSeconds(2, undefined, 300, () => 0.999)!;
  assert.ok(spread > 30 && spread < 36, `up to 20% jitter: ${spread}`);
  assert.equal(backoffSeconds(1, 290, 300, () => 0.999), 300, "jitter never pushes past maxBackoff");
});

test("formatSeconds", () => {
  const cases: Array<[number, string]> = [
    [0, "0s"],
    [0.05, "0.1s"],
    [4.5, "4.5s"],
    [9.99, "10s"],
    [45, "45s"],
    [60, "1m"],
    [125, "2m 5s"],
    [3600, "1h"],
    [12_120, "3h 22m"],
    [4 * 86400 + 2 * 3600 + 13 * 60, "4d 2h"],
  ];
  for (const [seconds, text] of cases) assert.equal(formatSeconds(seconds), text, String(seconds));
});
