# Connectors: treg and GitHub, security first (design, revision 6)

Research and design only, no product code. Base `cloud/main` c976ea1 (read-only; every file:line below re-read in this revision). Date 2026-10-06. Rev 4 fixed the first hostile review (C1, H1-H3, leaks, M1-M6, encryption, LOW). Rev 5 fixes the sign-off round (R1-R5 and the smaller items, all in section 10). Every file:line below was re-read on c976ea1.

## Answer first

1. **Legion core holds every connector token, and Legion's own code is built so that no token is handed to an agent process.** Agents see only Legion's own in-process tools with fixed names. This is a design property of Legion's code, not a guarantee against a same-user process (including an agent's shell tool) reading what the OS lets that user read (section 4.4).
2. **The card is raised inside the gateway handler, not by the permission layer.** Rev 3's `ALWAYS_CARDED` in `needsApproval` is dead on the Claude path in uncapped full mode (verified: `engine.ts:862-864` sets `bypassPermissions`; `canUseTool` is only installed in the other branch, `engine.ts:865-871`). Every outward write and every spend handler calls `ApprovalBroker.request` itself, and those tools are exempt from `canUseTool`, so the card appears once, in every mode.
3. **Spend controls aim to prevent double-spend and price drift:** the cap is reserved atomically before the card, the gateway fetches and freezes the price, the "sent" record is written before the request, a write is never retried after send, and an unknown outcome blocks spending until the owner clears it. They reduce the risk; treg's prepaid balance and daily ceiling remain the hard limit.
4. **Every outbound request in OAuth discovery is an SSRF surface** and is guarded (https, public addresses only, no redirects, never port 3321, tokens only to issuer-checked endpoints, the sign-in host shown to the owner).
5. Tokens encrypted at rest (safeStorage envelope), GitHub = two GitHub Apps with device flow, treg = generic OAuth engine, phasing and decisions as before, plus the amended items.

## 1. Binding decisions

| Decision | Effect |
|---|---|
| GitHub App user token, device flow; "Legion (read)" first, write app only when writes are on | Section 4.3, checklist section 9 |
| GitHub agent writes: card ALWAYS, also on full access; reads never ask | Handler-raised card (4.1) |
| treg: connectors release, off by default, click-to-connect, cost per call, caps 0.50/call, 2/session, 5/day; **card on every call, every mode** | 4.5 |
| Maintainer decision 2026-10-06: spends and GitHub writes always ask, including in full | Recorded beside the 2026-10-04 rule (4.1 step 6) |
| Tokens encrypted at rest on Windows, macOS, Linux | 4.4 |
| Settings nav Agents / Doctrine and skills / Connectors / Legion; rename "Connections" to "Use from Claude" | 4.6, D8 |

## 2. Research table (sources)

| Fact | Source |
|---|---|
| MCP auth spec 2026-07-28: PKCE, `resource` in both requests, issuer-checked discovery, `iss` check (RFC 9207), registration order pre-registered > CIMD > DCR (deprecated) > prompt, step-up on 403 `insufficient_scope`, refresh tokens "MUST" be confidential in storage, tokens "MUST NOT" go to a server other than the AS-issued one | https://modelcontextprotocol.io/specification/latest/basic/authorization (+ `/client-registration`, `/authorization-server-discovery`) |
| treg AS: DCR, S256, public clients, revocation endpoint, CIMD, scopes `treg:catalog treg:call treg:read treg:directory`; access 1 h, refresh 30 days, loopback redirect port may vary; treg has refresh-token reuse handling (`_revoke_refresh_family`) | live `https://treg.to/.well-known/oauth-authorization-server`; treg `src/treg/domain/identity/mcp_oauth.py` |
| treg MCP: `call` (destructive, open-world, non-idempotent) returns `cost_usd`, `call_id`; `balance` returns `balance_micro`; `/mcp/v2/` splits `catalog_call_read`/`catalog_call_write`; `idempotency_key` param on `call`; per-day spend ceiling; an unpriced endpoint is refused | treg `src/treg/mcp.py`, `docs/context/architecture/mcp-oauth.md`, README, `USAGE.md` |
| treg licence: Apache 2.0 plus a hosted-service ban; hosted API use allowed; Legion bundles no treg code | treg `LICENSE`, README |
| GitHub AS: device grant, S256, `iss`, no `registration_endpoint`, no CIMD; remote MCP metadata names it | live `.well-known` fetches |
| GitHub App user token: device flow needs enabling, no client secret for device flow; 8 h token, 6 month refresh; permissions = intersection of app and user | https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app ; https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps |
| Token revocation for apps (`DELETE /applications/{client_id}/token`) authenticates with the app's client ID and **secret** (basic auth). Legion has no secret, so it can only delete locally | https://docs.github.com/en/rest/apps/oauth-applications (assumption, verify in C-GH-6) ; user-side revoke page https://github.com/settings/applications |
| Registration form fields | https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app |
| Endpoint permissions (actions read/write, issues write, PR write, contents read, metadata read) | https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps |
| `safeStorage` names (async API, `shouldReEncrypt`, `getSelectedStorageBackend` values, platform backing, macOS signing, `basic_text` unprotected) | https://www.electronjs.org/docs/latest/api/safe-storage |
| Claude Desktop GitHub connectors; claude.ai integration reads files only | https://claude.com/docs/third-party/claude-desktop/connectors-github.md ; https://claude.com/docs/connectors/github.md |

## 3. Legion today (file:line, `cloud/main` c976ea1)

| Area | Fact |
|---|---|
| Full mode bypasses permission checks | `engine.ts:862-864`: `agent.approval === 'full'` and no stricter ceiling gives `permissionMode='bypassPermissions'`; `canUseTool` (calling `toolDecider`) exists only in the else branch (`engine.ts:865-871`). So nothing in `needsApproval` runs for an uncapped full Claude run. |
| One-rule guards | `approvals.ts:37-48` OWNER RULE (2026-10-04): in `full` a guard never shows a card; `guardAsk` (`approvals.ts:66-83`) and `decideGuard` (`:86-88`) return no card in full; the comment says a guard that calls `broker.request` directly "is the bug this exists to prevent" (`:61-63`). The connector gateway is a deliberate, dated exception. |
| Broker | `ApprovalBroker.request(taskId, agentId, toolName, input, origin, {onTimeout, summary})` (`approvals.ts:141-156`), 10 minute timeout then denied (`:138`, `engine.ts:795-804`). `ModuleDeps` carries `approvals: ApprovalBroker` (`modules.ts:85`), so a module's handlers can raise cards themselves. |
| Card text | `summarizeToolInput` caps at 400 characters (`approvals.ts:110-120`); `request` accepts a written-out `summary` (`:144,148`), which the gateway uses with the full argument text. |
| Agent tools run in core | In-process SDK servers (`engine.ts:696,707-709`, `agent-tools.ts:211`, `blender/guard.ts:16`); `moduleJob` exposes `taint()`, `markTainted()`, `origin`, `ceiling` (`engine.ts:701-706`). |
| Child env, launch secrets | CLI gets `buildChildEnv` (`engine.ts:154,841`). Core reads per-launch secrets from a stdin pipe: `legion-core.ts:41-43` (`readLaunchSecrets`), Electron writes `child.stdin.end(secret + '\n' + native + '\n')` (`electron/main.ts:156-173`). |
| Logging | `legion-core.ts:34-38`: one `log()` writes to stderr and `core.log`; `process.on('uncaughtException', e => log(...))` (`:134`); Electron main also redirects the core's stderr into `core.log` (`electron/main.ts:153`). `core.log` sits in the data dir where an agent's shell tool can read it. |
| MCP client origin | A run started by an MCP client has origin `roomId: 'mcp'`, ceiling `ask` (`engine.ts:343-347`); a task that agent starts through the bridge gets `roomId: 'agent-bridge'` (`engine.ts:357`), so `roomId === 'mcp'` is lost one hop down. The MCP bearer token can start tasks and read results (admin gate allows the client route list). |
| Per-agent MCP list | `AgentProfile.mcpServers: string[]`, `['*']` = all (`types.ts:45-46`, `engine.ts:684-685`). |
| Tripwire | `test/bsv-scan.ts:63-80` allowlist; dynamic tool names refused (`bsv-scan.ts:1-18`); MCP transports only in `external-mcp.ts` (`providers-tripwire.test.ts:31-37`). |
| URL guard | `src/core/browser/resolve.ts:1-15`: `checkUrlResolved` runs `checkUrl` then resolves the name and checks every address (`url-guard.ts` rules: loopback, private, link-local, metadata). A resolver failure refuses. |
| Wallet port | 3321 is forbidden in repo code and tests (`test/bsv-fake-wallet.ts:18`, CLAUDE.md hard rule). `PROTECTED_LOCAL_PORT = 3321` (`url-guard.ts:14`) is refused only for local, private and metadata address classes (`classRefusal`, `url-guard.ts:134`); a public address on port 3321 passes it, and `checkUrl` accepts `http:` (`url-guard.ts:151`). So the connector engine adds its own rules (4.2 step 2). |
| Bridge and room origins | `bridgeOrigin` (`engine.ts:350-358`) builds `{roomId:'agent-bridge', ...}` from the caller's task, merging `approvalCeiling` strictest-wins and OR-ing `tainted`; it does not carry the `'mcp'` room id. Room-woken runs get `approvalCeiling: strictest(bots...)` (`comms/hub.ts:955`). `TaskOrigin` has only `roomId, fromAgentId, hop, approvalCeiling, tainted?` (`shared/comms.ts:90-98`). |
| Core stdout and stderr | Electron main starts core with `stdio: ['pipe', out, out]` (`electron/main.ts:161`): both stdout and stderr go straight into the `core.log` file descriptor. |
| Secrets pattern | `providers/secrets.ts:2-46`; MCP headers/env sit plain in config.json (`settings.ts:159-160,205`), unfit for OAuth tokens. |
| Browser launch | Electron `openExternal`, http(s) only (`electron/main.ts:73,548`). |
| Admin gate | Default-deny (`server.ts:207-217,507-509`). |
| Isolation | `inheritMcp` false, `strictMcpConfig` (`config.ts:187`, `engine.ts:834`). |

## 4. Design

### 4.1 Gateway (mandatory) and where the card is raised

In-process module server `legion_connectors`, fixed names only:

| Tool | Does | Card | Taint |
|---|---|---|---|
| `connector_list` | Connected connectors, state, per tool enabled/class. Connector and tool names must match `[a-z0-9_-]{1,64}`, else the entry is shown wrapped and the run tainted | none | no |
| `connector_tools(connector)` | Enabled tools, input schema, description (third-party text: wrapped, 500 char cap) | none | tainted |
| `connector_call_read(connector, tool, args)` | READ tools only; refuses others | none | result and error bodies wrapped, run tainted |
| `connector_call_write(connector, tool, args)` | WRITE and SPEND tools; refuses READ | **raised by the handler** | result and error bodies wrapped, run tainted |
| `github_*` reads | Native, shared client | none | tainted |
| `github_*` writes (`github_issue_write`, `github_comment`, `github_create_pr`, `github_review`, `github_ci_rerun`, `github_ci_cancel`) | Native | **raised by the handler** | tainted |

**How the card is raised (fix for C1).**
1. Each write/spend handler, after validating arguments and before any network call, calls `deps.approvals.request(taskId, agentId, toolName, input, origin, { summary, onTimeout })` **directly** (the broker is in `ModuleDeps`, `modules.ts:85`). It does **not** call `guardAsk`/`decideGuard`, which return no card in full by design.
2. The mode and the run ceiling are ignored: the handler always asks. Timeout or deny returns a plain refusal; the handler performs no action.
3. To avoid a second card, these tool names are exempt from `canUseTool`: they carry the Legion prefix, which `needsApproval` already lets through (`approvals.ts:98`), and no `ALWAYS_CARDED` set is added to `needsApproval` (it would be dead code in full and a double card elsewhere). A test asserts that in `ask` mode exactly one card is raised per call.
4. Card text: `summary` holds the **full** argument text (comment body, issue title and body, PR fields, endpoint id and parameters), plain text, scrollable in the UI, never truncated at 400 characters (M1; the UI component that shows `summary` must be checked for its own truncation and fixed in the same change). Plus: connector, tool, class, for spend the price, session and day totals and balance, and, if `moduleJob.taint()` is true, "This run has read outside content (web, GitHub text, tool results). Check it was not tricked."
5. Headless runs with nobody answering are denied after the 10 minute timeout (`approvals.ts:138`).
5a. **Falling back is never to "no card at all" (N2).** When the owner turns "writes always ask" OFF for a generic connector, or reclassifies a tool to READ, the handler falls back to `guardAsk` (`approvals.ts:66-83`), which respects the mode: a card in `ask`/`auto` and for capped runs, none only in uncapped `full`. GitHub writes and treg spend never take this fallback (step 1: they always ask). Tests: switch OFF in `ask` mode still cards; GitHub write and treg spend cannot be switched down (mutation negative).
6. **Record the exception** (the owner decided 2026-10-06 that spends and GitHub writes always ask): add a dated comment directly beside the 2026-10-04 OWNER RULE at `approvals.ts:40`, naming the gateway handlers as the only exceptions, so the next reader does not "fix" it.
7. **Test (real Claude path):** with the fake-backed harness (docs/TESTING.md) run a Claude-path task whose agent is `full` and uncapped, call `connector_call_write` and a `github_*` write, assert a card is raised and the action does not run until it is answered. Mutation negative: temporarily route the handler through `guardAsk` (or drop the request) and show the test fails. Same test on the provider path. A source test that only the gateway modules call `approvals.request` for connector tools.

**Classification (M2, fixes the 4.1/threat-table contradiction).** A table that **ships with Legion** classifies the known tools of GitHub and treg as READ, WRITE or SPEND. **Anything not in a shipped table is WRITE** (SPEND for treg). Server annotations (`readOnlyHint`, `destructiveHint`) are a UI hint only and never lower a class. For a generic third-party connector the owner may reclassify a tool to READ one by one, with a warning; shipped-table tools cannot be made looser. The gateway checks the class at call time; `connector_call_read` on a WRITE tool is refused.

**Switches and scoping.** Per-tool on/off (new connector: reads on, writes off). **Connectors are an explicit per-agent opt-in** through a new `AgentProfile.connectors: string[]` field (default empty); `mcpServers: ['*']` does **not** grant connectors (M4), and the gateway enforces it, not only the UI. Per-connector "writes always ask" (default ON) applies to generic connectors; the handler card for GitHub writes and treg spend cannot be switched off.

**Prefix and taint.** `mcp__legion_connectors__` is added to `LEGION_TOOL_PREFIXES` (`approvals.ts:12`). Consequence: `taintsRun` returns false for any Legion in-process tool (`engine.ts:118-122`), so the engine will **not** taint a run for these calls. Every gateway handler therefore calls `moduleJob.markTainted()` itself (`engine.ts:703-704`) for every read result, tool description and error body before returning. The "external text taints" test runs on the Claude path as well as the provider path, with a mutation negative (remove one `markTainted`).

**No token leaves core.** Token lookup, refresh and HTTP calls happen in the handlers; results and errors are scrubbed for token-shaped strings; the gateway also redacts the signed log URL (below). No static Authorization header in CLI MCP config, argv, env or temp files.

**Client-origin runs (leak: MCP bearer), bridge-proof (R1).** Anyone holding the MCP bearer token can start a task and read its result. Testing `origin.roomId === 'mcp'` fails one hop down (MCP client starts A, A asks B: B's origin is `agent-bridge`, `engine.ts:357`; a room hop is built in `comms/hub.ts:911,955`). So `TaskOrigin` (`shared/comms.ts:90-98`) gains `viaMcpClient?: boolean`:
- set true by `mcpOrigin` (`engine.ts:343-347`), including its `prev.origin` continue branch;
- copied by `bridgeOrigin` (`engine.ts:350-358`) from the caller task's origin, and through the room path at the exact sites below, with **strictest-wins merge** like `approvalCeiling`: true if any task on the chain is true, never cleared (the same OR rule as `tainted`);
- stored with the task origin, so it survives restart and `continue`.
- **Room path, the sites to change (verified on c976ea1).** `originFor` (`comms/hub.ts:947-958`) builds the origin only from `Delivery` fields, and `Delivery` (`hub.ts:109`: `msg, ceiling, humanChain, tainted?`) and `Meta` (`hub.ts:112`: `ceiling, humanChain, auto, tainted?`) carry no client-origin information. So: (a) add `viaMcpClient?: boolean` to `Delivery` and to `Meta`; (b) set it at every dispatch call that sends a bot's message (`hub.ts:457`, `:480`, `:504`, each `this.dispatch(room, msg, ..., { ceiling: this.sendCeiling(ctx, run), humanChain, auto, tainted })`) from the **sending run's context**, read from that run's task origin (`ctx`/`run`), next to the existing `run.tainted` spread; (c) carry it through `hold` (`hub.ts:764` copies `ceiling`, `humanChain`, `tainted` into the held `Delivery`, and the same site must copy the flag); (d) OR it in `originFor` next to `bots.some(d => d.tainted)` (`hub.ts:957`) so one flagged sender flags the whole wake. The room-hop test drives exactly this chain: MCP-started run A posts in a room, bot B is woken, B's connector read is refused (mutation negative: drop the copy at one of the dispatch sites, or in `hold`, and the test fails).
- **Stated limit:** the flag stops an MCP-started run from pulling connector data. It does **not** stop an owner-started run from writing connector data into shared places (a room, workspace files, the knowledge graph, the board) that an MCP-started run can later read. Tainting and the approval cards limit the writes; they do not close that path.
The gateway refuses every connector read for a run whose origin has `viaMcpClient` true ("not available for runs started from an MCP client"); the owner can enable a connector for client-origin runs per connector (D12). Tests: MCP-started run refused; **bridge hop** (MCP starts A, A asks B, B refused); room hop; a continue keeps the flag (mutation negative: drop the copy in `bridgeOrigin` and the bridge-hop test fails). Stated limit: with D12 on, the bearer token's holder can read what the connector can read.

### 4.2 Generic OAuth engine

1. Connect click (admin route). Unauthenticated MCP request, read 401 `WWW-Authenticate`, fetch protected-resource metadata and AS metadata (spec order, issuer must equal the URL's issuer), record issuer.
2. **SSRF guard on every outbound request of this engine (H1).** Remote servers control `resource_metadata`, `authorization_servers`, and the token, registration, revocation and authorization endpoints. Rules: https only (no `http`, no other schemes); `redirect:'manual'` and any redirect is an error (or re-validated as a new request with the same checks, depth 1); each host goes through `checkUrlResolved` (`browser/resolve.ts:13`) so loopback, private, link-local, metadata and unspecified addresses are refused, every resolved address checked; **port 3321 is this engine's own explicit refusal for every host and address class**, not left to `checkUrl`: `classRefusal` blocks that port only for local, private and metadata classes (`url-guard.ts:134`) and `checkUrl` also accepts `http:` (`url-guard.ts:151`), so the engine wraps it: scheme must be `https:`, port 443 unless the owner confirms another, 3321 never (test with a public-IP fake on 3321); response size cap and timeout; JSON only. Production config cannot allow loopback; the test fakes use an injected resolver. Stated limit: Node `fetch` re-resolves the name, so a DNS answer that changes between check and connect (rebinding) is not fully excluded; mitigated by re-checking on every hop, JSON-only size-capped bodies, and no token sent to anything but the issuer-checked endpoints. D11 offers a pinned-address dispatcher (needs a listed `undici` use) as a stricter option.
3a. **Preset issuer reuse (N1).** A hostile generic MCP server can name `treg.to`, `github.com` or any preset issuer as its authorization server to obtain the owner's preset account or pre-registered client. Preset and pre-registered client credentials and tokens are bound to their **pinned resource only** (treg: `https://treg.to/mcp/v2/` and `/mcp/`; GitHub: the shared client). A generic connector whose recorded issuer equals a preset issuer is **refused** by default; if the owner allows it, the confirmation reads "Your <issuer> account will be given to <resource host>" and needs an explicit click, and it gets its own dynamically registered client, never the preset one. Test: a fake resource naming treg's issuer is refused (mutation negative: remove the binding check).
3. **Tokens only to issuer-checked endpoints:** the token, refresh and revocation endpoints must come from the validated AS metadata of the recorded issuer, share its registrable host or be explicitly listed in that metadata, and be re-checked at each use; client credentials and tokens are keyed by issuer + resource.
4. **Show the sign-in host.** Before `openExternal`, the UI shows "You will sign in at `<authorization endpoint host>` (issuer `<issuer>`)" and the owner confirms; for presets (GitHub, treg) the host is pinned and shown as verified.
5. Registration by spec priority (pre-registered, CIMD only if D3, DCR `application_type: native`, else prompt for a client ID).
6. **Loopback listener:** bind `127.0.0.1` only, ephemeral port, 5 minute timeout. `Host` must equal `127.0.0.1:<port>` exactly; GET only; no CORS headers, no cookies. **Only a request carrying the valid `state` consumes the one use**; anything else gets a fixed 404 and does not (a probe cannot burn the flow). **The callback query string is never logged** (neither by core nor in errors). Handles `error=` (show a plain message, validate `iss` first so a forged error cannot be displayed), and the `iss` table: if the AS metadata says `authorization_response_iss_parameter_supported` and `iss` is missing, reject; if present, compare exactly. PKCE S256, `resource`, least scope.
7. **Step-up** (`insufficient_scope`) is only started from an owner click on a button that lists the exact scopes it will request; never automatic, retry limit 2.
8. Tokens stored per 4.4; refresh serialized per connector (4.4).
9. **Disconnect:** one click. If a `revocation_endpoint` exists and the client is public (treg), call it (RFC 7009). **GitHub:** Legion has no client secret, so it cannot call GitHub's token-revocation endpoint (assumption C-GH-6); the Disconnect button says "Removed here. To revoke the grant at GitHub, open github.com/settings/applications" with the link. Local tokens and client info are always deleted.
10. Expired, revoked or tampered state is shown ("Sign in again"), never silent.

**Remote-MCP client file (N3).** The gateway reaches treg and generic servers through one named file, `src/core/connectors/mcp-remote.ts`. It carries the bearer token, so it gets its own tripwire entry (`fetch`; reason: the gateway's MCP client for owner-connected remote servers) and obeys the H1 rules: https only, `checkUrlResolved` on the host, `redirect:'manual'` (any redirect is an error), the port rules above, size cap and timeout, and the token is attached **only to the recorded resource origin** (never to any other origin). **It must pass its own `fetch` to the SDK's `StreamableHTTPClientTransport`**, the way `external-mcp.ts` passes `noRedirectFetch` (`providers/external-mcp.ts:24-25,35`), otherwise the SDK's default `fetch` would bypass these rules. That custom fetch: sets `redirect:'manual'` and treats any redirect as an error; before every request (the POST calls, the initial GET, and the **long-lived SSE GET stream** the transport opens, including its reconnects) checks that the request URL's origin equals the recorded resource origin and passes `checkUrlResolved`; attaches the `Authorization` header there and nowhere else (it deletes any caller-supplied `Authorization` for other origins); and applies the size cap and timeout (the SSE stream gets an idle timeout instead). Test: the SSE GET carries the token only to the recorded origin and is refused with a redirect; a request built for another origin through the transport is refused (mutation negative: swap in the global `fetch` and the test fails). It is the only file in `src/core/connectors/` allowed to import an MCP transport; `external-mcp.ts` stays the only one for the provider path. Test: token absent from requests to a non-resource origin; a redirect is refused; a second connectors file importing a transport fails (mutation negative).

Tripwire entries, each with a reason: `connectors/mcp-remote.ts` (`fetch`), `connectors/oauth/callback.ts` (`inbound-http`), `connectors/oauth/provider.ts` (`fetch`), **`connectors/github/auth.ts` (`fetch`: device-flow endpoints on github.com; M3)**, `connectors/github/client.ts` (`fetch`). Browser via Electron main, no child process. New test: extend the transport/process test (`providers-tripwire.test.ts:31-37` pattern) to `src/core/connectors/**`: **exactly `mcp-remote.ts`** imports an MCP transport; none imports `child_process`, `node:net` or `undici`; only the listed files fetch or listen.

### 4.3 GitHub (two Apps, device flow, shared client)

Device flow: `POST github.com/login/device/code`, poll `.../login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`; honour `interval`, `slow_down`, `authorization_pending`, `expired_token`, `access_denied`, `device_flow_disabled`. The user code and exact `https://github.com/login/device` are shown in Legion's own UI (and a native dialog, D9); the URL opens via `openExternal`. If refresh needs a secret (C-GH-1), sign in again every 8 h, shown plainly.

Two apps: read app first; the write app only when writes are on, as a separate sign-in. **The write app is installed on selected repositories only** (never "All repositories"), and Settings says so at connect time; turning writes off deletes the write token locally and points to github.com/settings/applications for revoking at GitHub.

Shared client `src/core/connectors/github/client.ts` (only GitHub API fetch file; CI panel and Armory import it):

```ts
interface Connection { auth:'github-app'|'pat'|'anonymous'; login?:string; expiresAt?:string;
  permissions?:Record<string,'read'|'write'>;   // GET /user/installations -> installation.permissions
  scopes?:string[];                              // X-OAuth-Scopes (OAuth-style tokens)
  rate:{limit:number;remaining:number;resetAt:string}; }
connection(): Promise<Connection>;
can(area:'contents'|'issues'|'pull_requests'|'actions', level:'read'|'write'): 'yes'|'no'|'unknown';
request(path, init?): Promise<GhResponse>;       // api.github.com only; typed errors
logs(jobId, repo): Promise<{text:string; truncated:boolean}>;   // never returns a URL
rerunFailed(runId, repo) / cancel(runId, repo): Promise<void>;  // WRITE methods (slice 2)
```

- **Write methods are importable only from admin routes and carded handlers (M5).** The write methods live in a separate module `github/writes.ts`; a source test fails if any file other than the gateway's write handlers and the admin-only routes imports it (mutation negative: add an import elsewhere).
- **Log redirect:** `redirect:'manual'`; exactly one redirect, https, only to a host on the pinned storage-host list, **no Authorization forwarded**, size cap, timeout. **The list ships empty and fails closed (every log fetch refuses) until C-GH-2 has recorded the real hostnames**; the signed URL is used inside the client and is never returned to an agent, a log line or a tool result (it is a bearer capability).
- **Idempotency:** reads may be retried once after refreshing on 401; writes never (4.5-H3 rule applies to GitHub writes too).
- Tool surface as before; never offered: merge, API push, branch or repo create/delete, any delete, workflow dispatch.
- **Pinned 2026-10-07 (with the house/skills session):** `GhResponse { status; json; etag?; notModified?; rate:{limit;remaining;resetAt} }`. Errors are thrown as `GhError` kinds `not-connected`, `auth-expired` (401 after one refresh), `forbidden {needs?:'read'|'write'}`, `rate-limited {resetAt}`, `not-found`, `logs-unavailable`, `network {retryable}`, never carrying a URL, header or body. `request()` passes `If-None-Match` and returns `notModified` on 304. A 304 is free of the primary rate limit only when authorized (GitHub docs, REST best practices); anonymous 304s still count against 60/h.
- **Pinned 2026-10-07 (with the CI-panel session):** (1) every repo-scoped method takes a trailing required `repo` ("owner/name"): `logs(jobId, repo)`, and in slice 2 `rerunFailed(runId, repo)` and `cancel(runId, repo)`. `repo` is checked against `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` and a "." or ".." part is refused; a bad repo is a `GhError` `not-found`. (2) Core startup calls `createGitHubClient(deps)` once; every other module uses only `getGitHubClient(): GitHubClient | undefined` (undefined before core start or with no connectors), so one instance does all token refreshes.
- **Pinned 2026-10-07 (writes shape, for slice 2):** `src/core/connectors/github/writes.ts` exports module-level `rerunFailed(runId: number, repo: string): Promise<void>` and `cancel(runId: number, repo: string): Promise<void>` (no factory, no class), throwing `GhError`, never retried. Release B's `isGitHubWrites` in `src/core/ci/wiring.ts` checks exactly these two exports; `wiring.ts` is on the writes import allowlist as an admin-route path.
- **Added 2026-10-07 (agreed with the house/skills session for Release B): `github_ci_wait(repo, runId | branch, timeoutSec)`**, class READ in the shipped table (no card). `timeoutSec` default 600, cap 900; polls through `client.request()` no faster than every 10 s and backs off on rate-limit headers; returns `{status, conclusion, url, failedJobs:[{id,name,conclusion}]}` (tainted like every read); never fetches logs; ends when the run is cancelled or stopped. The CI panel (Release B) adds no agent tools and uses the same result shape.

### 4.4 Encrypted token store

| Piece | How |
|---|---|
| Data key | Random 256-bit key, **created lazily on the first Connect**, never at app start (so a user who never connects gets no macOS Keychain prompt). Wrapped with `safeStorage.encryptStringAsync` into `<dataDir>/connectors/key.bin` (atomic); `isAsyncEncryptionAvailable()` checked first; on read `decryptStringAsync` returns `{result, shouldReEncrypt}`, re-wrap if true. |
| Hand-off | Third line on the core's stdin pipe next to the admin and native secrets (`electron/main.ts:173`), memory only; never env, argv, disk or renderer. Headless core: no key, memory-only connectors. **Ordering, no restart:** today main writes the launch secrets and closes the pipe (`child.stdin?.end(secret + '\n' + native + '\n')`, `electron/main.ts:173`) and `readLaunchSecrets` reads them once (`admin.ts:173-177`). Change: main keeps core's stdin pipe **open** (no `.end`), and core keeps a line listener on it after the launch secrets. On the first Connect, main creates and wraps the key and **sends a later line** (`KEY <64 lowercase hex>\n`; hex rather than base64 because the tripwire counts a base64 decode as its own kind) over the same pipe; core installs it in memory and only then lets the OAuth flow start, so the flow never races a restart. Later launches send the key line right after the secrets when `key.bin` exists. The pipe is only writable by the Electron parent; EOF (main gone) leaves the key in memory as before. **Fallback if keeping the pipe open is not acceptable:** create `key.bin` and restart core **before** the OAuth flow starts (the Connect click is held until core is back and reports the key), never after. Test: the OAuth flow cannot start before the key is installed; a stdin line arriving later is accepted only in the documented form. Test: no `key.bin` and no safeStorage call at app start; first Connect creates it and restarts; a launch with `key.bin` hands the key to the core. |
| Token blob | `<dataDir>/connectors/oauth.json`: AES-256-GCM, random 96-bit IV per write, 16-byte tag checked, **the version byte is bound as AAD** (a downgraded or altered version fails authentication), nothing in clear (no issuer or names). Atomic write, owner-only. |
| **Single writer** | All reads-modify-writes of the blob go through one in-process queue (mutex). A refresh must **persist the rotated refresh token before the new access token is used**, and concurrent refreshes for one connector are coalesced; otherwise two parallel refreshes could lose a rotated refresh token and trigger treg's refresh-reuse detection that revokes the whole token family. |
| Tamper or wrong key | Tag failure = treated as empty, "Sign in again", no crash, file left untouched. |
| macOS | Keychain via `safeStorage`; docs require valid code signing for consistent behaviour: add code signing to packaging needs (D10). |
| Linux | `getSelectedStorageBackend()` of `basic_text` or `unknown` = write nothing; offer "install a keyring" or "don't remember (sign in each launch)". `setUsePlainTextEncryption` never called. |
| Windows | DPAPI via `safeStorage`. |

**Scoped claim (H2).** DPAPI and libsecret let any process running as the same user unwrap what Legion wrapped; an agent in `full` mode with a shell tool is such a process. So the guarantee is only: **Legion's own code never passes tokens to agents, and a file copied off the disk by another user or offline is ciphertext.** It is not a defence against same-user code. Mitigations: (a) the Agent editor warns when an agent has connectors enabled **and** `full` approval **and** a shell tool, and D11 offers blocking that combination; (b) treg's prepaid balance and its per-day spend ceiling are the real hard limit on spend, so owners are told to fund a small balance; (c) the GitHub write app is installed on selected repositories only and its permissions are fixed at registration; (d) the redactor below.

**Redaction at the sink (leak).** `core.log` is readable by agents. A redactor (token-shaped values: `ghu_`, `gho_`, `ghs_`, `ghr_`, `github_pat_`, `Bearer ...`, long base64url, the data key, the signed log URL, callback query strings, device codes) is applied inside the core's single `log()` function (`legion-core.ts:34-38`), which also carries `uncaughtException` (`:134`), and to wrappers on **both `process.stderr.write` and `process.stdout.write`**, because Electron main sends both streams straight into the `core.log` file (`stdio: ['pipe', out, out]`, `electron/main.ts:161`), so Node crash traces and any stray `console.log` are covered. Errors thrown by connector code never embed a header, body, URL query or token. Stated limit: a runtime crash message from a dependency that embeds a secret could still slip past pattern matching; hence tokens are also never placed in URLs or error strings by Legion.

Also excluded: config.json, exports, `/health`, route responses, the UI after connect (last 4 characters at most).

### 4.5 treg connector and spend safety

Preset via the generic engine: `https://treg.to/mcp/v2/` default (catalog-only); `https://treg.to/mcp/` advanced (has `balance`). DCR, PKCE, `resource` = the surface. Off by default; Connect opens treg.to; the owner's own account (no account creation by Legion or an agent). First scopes `treg:catalog treg:read`; "Allow calls" is an owner-click step-up to `treg:call` (C-TR-1).

Classes (shipped table): `catalog_search`, `catalog_get`, `balance`: READ. `call`, `call_media`, `catalog_call_read`, `catalog_call_write`, `catalog_call_media`: **SPEND** (any call can cost money, so all go through `connector_call_write`). `hub_create`, `hub_update`, `feedback`, `review`, `catalog_request`: off. Unlisted treg tools: SPEND.

**Spend procedure inside the handler (H3, M6):**
1. If spending is **blocked** (a previous call's outcome is unknown, or a price drift froze it), refuse with a plain message until the owner clears it in Settings after checking balance (the BSV unknown-outcome rule).
2. The **gateway itself** fetches the price right before the card (`catalog_get`, a read call); the agent's claimed price is ignored. **Unknown or unparseable price: block** (treg refuses unpriced endpoints anyway); never charged as zero.
3. **Reserve the cap atomically** (mutex over the persisted ledger `<dataDir>/connectors/spend.json`: per-call 0.50, session 2, 24 h 5; owner-editable, 0 blocks all) *before* raising the card, as a `reserved{id, amount}` entry. Reserved amounts are released on deny, timeout, or failure before the request was sent. **"Session" = one app launch (core process lifetime), recorded as a launch id in the ledger.** Why: a run or task is too small (an agent can start new tasks to restart a per-run cap), and the owner experiences "this sitting" as the launch; the 24 h cap is the backstop across restarts.
4. Raise the card (4.1) with the **frozen price**; approval binds to that price.
5. **Persist `sent{id, idempotency_key}` to the ledger (fsync, atomic) BEFORE the request leaves**, then send with that `idempotency_key` (treg supports it). **No automatic retry after the request was sent** (writes and spends); a retry after a 401 refresh is allowed for idempotent reads only; for a spend the owner is asked again.
6. On a result, read `cost_usd`. **If `cost_usd` exceeds the approved price, freeze all spending** (blocked state) and tell the owner; record actual cost in the ledger.
7. On timeout, transport error after send, or an unparseable result: outcome is **unknown**; the reservation is kept as spent and spending is blocked until the owner checks the balance and clears it. **Startup recovery:** a `sent` entry with no recorded outcome means the app died mid-call, so it is **unknown and spending is blocked**; a `reserved` entry that never reached `sent` is **released**.
8. **Integrity:** the ledger and the "blocked" flag carry an HMAC-SHA256 under a key derived from the data key (HKDF, label `ledger`); a missing or bad MAC means **blocked** (the owner can reset after checking the balance), so a corrupted or hand-edited file blocks spending. With no data key (headless or memory-only mode) the ledger lives in memory and spending starts blocked after every restart until the owner confirms the balance. **Authority and rollback:** while core runs, the **ledger in core's memory is the authority**; the file is written for restart recovery and is **never re-read during the run** (so a file swapped mid-run changes nothing). An HMAC does not stop a same-user process from restoring an older, validly signed `spend.json` between runs, so **rollback across restarts is part of the H2 same-user limit** (section 4.4), not something this design claims to prevent; the hard limit remains treg's prepaid balance and its per-day ceiling. Tests: kill the core after `sent` and before the outcome (blocked on restart); kill after `reserved` (released); flip a byte in the ledger (blocked); concurrent calls cannot exceed the cap; mutation negative: write `sent` after the request and the kill test fails.
- Taint: results wrapped, run tainted; the card for a spend raised in a tainted run carries the warning.
- Hard limit outside Legion: prepaid balance and treg's per-day ceiling (documented in USAGE.md). Risks stated: treg sees call parameters; calls may publish or send; young third-party service; the licence clause does not apply because Legion bundles no treg code.

### 4.6 Settings nav (D8)

| Group | Items |
|---|---|
| Agents | Claude, Providers, Compaction |
| Doctrine and skills | Doctrine, Armory (when it lands) |
| Connectors | GitHub, treg, MCP servers (existing page; stdio and static-header servers are outside the connector guarantees and the page says so), boat.dev, Blender |
| Legion | Use from Claude (renamed from "Connections"), About |

Phase 1 touches `Settings.tsx` NAV (lines 17-27) and two section components; moving boat.dev and Blender into the group is a later pass.

## 5. Threat model

| Threat | Control | Test or stated limit |
|---|---|---|
| Card never shown in full mode (C1) | Handler calls `ApprovalBroker.request` directly; tools exempt from `canUseTool`; dated exception at `approvals.ts:40` | Real full-mode Claude-path and provider-path run test, mutation negative (route via `guardAsk`); one card per call in `ask` mode |
| Token reaches an agent process | Gateway: tokens only in core; fixed in-process tools; no Authorization in CLI config; scrubbed results | Test scans child env, argv, MCP config, temp dir, results. Limit: same-user code (H2) |
| Same-user process decrypts the store | Scoped claim; warning/block for connectors + full + shell (D11); treg balance and ceiling; write app on selected repos | Stated limit, not testable away |
| Prompt injection via GitHub text, treg results, descriptions, error bodies | External text wrapped, run tainted (incl. error bodies and names not matching `[a-z0-9_-]{1,64}`); descriptions capped; writes and spends carded with taint warning | Test: injected issue text taints; next write card shows warning. Limit: a user approving blindly |
| Model writes through the read tool | Shipped class table; unknown = WRITE (SPEND for treg); annotations are hints; gateway checks class | Test: write via `connector_call_read` refused; unannotated and mislabelled tools land as WRITE (mutation negative) |
| Looping or double spend | Atomic reservation before card, gateway-fetched frozen price, no retry after send, unknown outcome blocks, `cost_usd` drift freezes, price unknown blocks | Tests: concurrent calls cannot exceed cap; timeout blocks next spend; drift freezes. Limit: treg's metadata is the price source |
| Write fired twice | No auto-retry of writes after send | Test: a dropped connection after send does not resend |
| SSRF via discovery (H1) | https only, no redirects, `checkUrlResolved` on every host, never 3321, issuer-checked endpoints, host shown to owner | Tests: private/loopback/metadata IP, redirect, `http:`, port 3321, mismatched issuer all refused. Limit: DNS rebinding race (D11) |
| Callback hijack, rebinding, CSRF | 127.0.0.1, exact Host, valid state only consumes, no CORS, no query logging, one use, 5 min | Tests incl. forged `error=` and missing `iss` |
| Mix-up, wrong AS | Issuer check, binding, `resource`, token only to its resource | Test: token never sent to another host |
| Device-code phishing | Code and exact URL in Legion's UI and native dialog | Limit: social engineering elsewhere |
| Token file theft | AES-256-GCM, version as AAD, safeStorage envelope; Linux `basic_text` writes nothing | Tests: no token bytes in file; tampered or downgraded version = "sign in again"; `basic_text` = no file; key never in logs/argv/env |
| Lost refresh token (concurrent refresh) | Single-writer queue; persist rotated token first; coalesce | Test: parallel refresh keeps the newest token |
| Token or signed URL in logs, crash output, exports | Sink redactor in `log()` and `stderr` wrapper incl. `uncaughtException`; never in URLs or errors | Test greps `core.log` after a failing flow and a thrown error. Limit: dependency crash text |
| MCP bearer reads connector data, including one hop down (R1) | `viaMcpClient` flag propagated through bridge and room hops, strictest wins; connector reads refused when set | Tests: direct, **bridge hop**, room hop, continue; Limit when D12 is on |
| Hostile server names a preset issuer (N1) | Preset credentials bound to pinned resources; generic connector with a preset issuer refused or explicitly confirmed with its own client | Test with mutation negative |
| "Writes always ask" off or reclassified READ leaves no card (N2) | Handler falls back to `guardAsk`; GitHub writes and treg spend never fall back | Tests as 4.1 step 5a |
| Bearer-carrying remote client is an unlisted network path (N3) | `connectors/mcp-remote.ts` listed, H1 rules, token only to the recorded resource origin | Tests as 4.2; transport test allows exactly this file |
| Crash or restart leaves spend state unknown (R5) | `sent` persisted before the request, startup recovery, HMAC ledger, bad MAC = blocked | Kill and tamper tests as 4.5 |
| Gateway results not tainted because of the Legion prefix | Handlers call `markTainted()` themselves | External-text test on the Claude path with mutation negative |
| Public address on port 3321 or `http:` passes `checkUrl` | Engine's own https-only and 3321 refusal | Test with public-IP fake on 3321 and an `http:` endpoint |
| `mcpServers:['*']` grants connectors | Separate explicit `AgentProfile.connectors` opt-in, enforced in gateway | Test: `['*']` gives no connector tools |
| Card hides the harmful part of a long argument | Full text, plain, scrollable | Test: 5,000-char comment shown in full |
| Log redirect leaks token or signed URL | One redirect, pinned hosts, empty list fails closed until C-GH-2, no Authorization, URL never returned | Tests: unlisted host refused; empty list refuses; result contains no URL |
| Write methods reachable from elsewhere | `github/writes.ts` importable only by carded handlers and admin routes | Source test with mutation negative |
| New network surface | Listed files only (`mcp-remote`, callback, provider, github/auth, github/client); the transport/process test is extended to `src/core/connectors` and allows exactly `mcp-remote.ts` to import an MCP transport. The existing tripwire tests keep passing but gain new listed entries and one new scan scope (no "unchanged" claim) | unchanged; planted fetch elsewhere fails |
| Over-broad access | Least scope, read app first, write app on selected repos, owner-click step-up with scopes shown | Limit: installation scope is the user's choice |
| Unrevoked GitHub grant after Disconnect | Local delete plus link to github.com/settings/applications | Limit: Legion has no client secret to revoke remotely (C-GH-6) |

## 6. Phasing

| Phase | Scope |
|---|---|
| 0 | Contract with the CI/Armory session; decisions; register the Apps (section 9); rename "Connections"; record the dated exception in `approvals.ts` |
| 1 | Gateway (handler-raised cards, class tables, taint, client-origin default, `AgentProfile.connectors`, redactor at the log sink) + generic OAuth engine (SSRF guard, callback, provider, discovery, DCR) + encrypted store (envelope, queue, AAD) + GitHub read (device flow, client, anonymous, `can()`) + treg with cards, caps and spend safety + Settings pages + harness fakes (GitHub, MCP+AS, safeStorage) |
| 2 | GitHub writes: write app sign-in (selected repos), `github_*` write handlers, `writes.ts` |
| 3 (other session) | CI panel and Armory on the shared client |
| Later | PAT fallback polish, GitHub remote MCP as custom connector, pinned-address dispatcher |

Gates (repo CLAUDE.md): `npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui`; every new test shown failing under a scratch mutation; independent reviewer re-runs.

## 7. Owner decisions

| Id | Question | Options |
|---|---|---|
| D1 | Write app | Two apps now (recommended) / read only for now |
| D2 | If device-flow refresh needs a secret | Sign in every 8 h (recommended) / ship a secret (no) |
| D3 | Host a Client ID Metadata Document | Skip (recommended) / host one |
| D4 | treg surface | `/mcp/v2/` (recommended) / `/mcp/` |
| D5 | treg caps | 0.50 / 2 / 5 as decided |
| D6 | Generic "writes always ask" | Default ON, owner may turn off per generic connector (recommended) / never off |
| D7 | Linux without keyring | Keyring or memory-only (recommended) / refuse |
| D8 | Nav and rename | Accept / keep "Connections" |
| D9 | Device code display | UI plus native dialog (recommended) / UI only |
| D10 | macOS packaging | Code-sign (needed) / unsigned with re-prompts |
| D11 | Connectors + `full` + shell tool on one agent; DNS pinning | Warn only (recommended) / block that combination; pinned-address dispatcher now or later |
| D12 | Connector reads for MCP-client-origin runs | Off by default (recommended) / on |

## 8. Real-PC checks (append to `claude/tracker-pc-checks.md` when built)

| Id | Area | Steps | Expected | Safety |
|---|---|---|---|---|
| C-SEC-1 | Isolation | Connect GitHub; run an agent; inspect the CLI process command line, environment and temp files (by PID) | No token or key | none |
| C-SEC-2 | Store | Hex-view `oauth.json`; flip one byte; change the version byte; restart | No token text; "Sign in again", no crash | none |
| C-SEC-3 | Windows | `key.bin` unwraps after reboot and after a user password change | Behaviour recorded | none |
| C-SEC-4 | macOS | Signed build, first connect and relaunch | At most one Keychain prompt | none |
| C-SEC-5 | Linux | With and without a keyring | With: file; without: no file, memory-only offered | none |
| C-SEC-6 | Logs | Trigger a failed connect and a thrown error; read `core.log` | No token, code, callback query or signed URL | none |
| C-SEC-7 | Same-user limit | In a full-mode agent with a shell, try to read `oauth.json` and `key.bin` | Record what an agent can reach (documents the limit) | none |
| C-CARD-1 | Full-mode cards | Agent set to full: ask it to comment on a throwaway issue; to make a treg call | Cards appear in full mode; Deny does nothing; one card per call | none (throwaway repo); treg call by owner |
| C-OA-1 | Engine | Connect a local fake, then treg; Disconnect | Host shown before the browser opens; tokens deleted; treg revoke called | treg account owner-only |
| C-OA-2 | Loopback | Callback twice; wrong state; forged `error=`; `localhost` Host | Refused; valid state only consumes | none |
| C-OA-3 | SSRF | Point a custom connector at a server whose metadata names a private/loopback/3321 endpoint | Refused with a plain message | none |
| C-GH-1 | Device flow | Connect read app; force expiry | Refresh works, or visible "sign in again" | real account |
| C-GH-2 | Log redirect | Fetch a failed job's logs | Redirect hosts recorded; list updated; no Authorization sent | none |
| C-GH-3 | Permissions | Read app `can('actions','write')`; then the write app | "Connect with write access", then re-run works | none |
| C-GH-4 | Write card | Comment on a throwaway issue in full mode | Card with full text and taint warning when applicable | none |
| C-GH-5 | Remote MCP | Custom connector at the Copilot MCP with the app's client ID | Record whether it accepts the token | none |
| C-GH-6 | Revocation | Disconnect; check github.com/settings/applications; try revoke API without secret | Confirms local-only removal and the link text | none |
| C-TR-1 | treg scopes | Connect read-only; try a call | Refused until "Allow calls" | owner account |
| C-TR-2 | treg spend | One 1-cent call in full mode | Card with frozen price; `cost_usd` matches; balance drops once | spends money (owner picks) |
| C-TR-3 | treg caps and unknown | Cap below price; kill the network mid-call | Refused before card; after the kill spending is blocked until cleared | none / small spend |
| C-TR-4 | Concurrent refresh | Two agents call at token expiry | One rotated refresh token survives; no revocation by treg | owner account |

## 9. GitHub App registration checklist (orchestrator in the browser, one maintainer OK per step)

Where: github.com, the maintainer's account, Settings > Developer settings > GitHub Apps > New GitHub App (https://github.com/settings/apps/new). Do the read app fully, stop, record the client ID; the write app only when D1 says so. Never click Generate client secret; never download a private key; no second account; no payment.

| Field | "Legion (read)" | "Legion (write)" |
|---|---|---|
| Name (max 34, unique) | `Legion (read)` (fallback `Legion Desktop read`) | `Legion (write)` (fallback `Legion Desktop write`) |
| Description | "Lets the Legion desktop app read repositories, issues, pull requests and CI status for you. Read only." | "Lets the Legion desktop app comment, open issues and pull requests, and re-run CI for you, after you approve each action." |
| Homepage URL | the public Legion repository URL | same |
| Callback URL | empty (ignored for device flow); the homepage URL if the form insists | same |
| Expire user authorization tokens | checked | checked |
| Request user authorization (OAuth) during installation | unchecked | unchecked |
| **Enable Device Flow** | **checked** | **checked** |
| Setup URL | empty | empty |
| Webhook > Active | unchecked | unchecked |
| Repository permissions | Metadata read (mandatory), Contents read, Issues read, Pull requests read, Actions read, Commit statuses read; all else No access | Metadata read, Contents read, Issues **read & write**, Pull requests **read & write**, Actions **read & write** (re-run and cancel; Legion never calls dispatch), Commit statuses read; all else No access |
| Account and organization permissions, events | none | none |
| Where can it be installed | Any account (or "Only on this account" for private testing first) | same |
| After creation | Copy the Client ID only. Install on **selected repositories only** (never "All repositories"). | Same, first on a throwaway test repository |

Notes: PR creation needs Pull requests write and an existing branch (agents push with their own git; Legion's API tools never push). Permissions are fixed at registration, so the read app physically cannot write. A later permission change asks installers to approve again. Proof that device flow is on: one `POST https://github.com/login/device/code` with the client ID returns a user code (C-GH-1).

## 10. Findings to sections, tests, limits

| Id | Section changed | Test or stated limit |
|---|---|---|
| C1 card in full mode | 1, 3, 4.1 (steps 1-7), 5, 6, C-CARD-1 | Real full-mode Claude-path and provider-path test with mutation negative; one card per call in ask mode; dated exception at `approvals.ts:40` |
| H1 SSRF in discovery | 4.2 (steps 2-4), 5, C-OA-3 | Tests for private/loopback/metadata/redirect/http/3321/issuer mismatch; limit: DNS rebinding race, D11 |
| H2 same-user decryption | 4.4 scoped claim, 5, D11, C-SEC-7 | Stated limit; warning or block connectors + full + shell; treg balance and ceiling named as hard limit; write app on selected repos |
| H3 double spend | 4.5 steps 1-7, 4.3 idempotency, 5 | Tests: concurrent cap, unknown outcome blocks, drift freezes, no resend after send |
| Leak: core.log | 4.4 redaction | Test greps `core.log` incl. uncaughtException path; limit: dependency crash text |
| Leak: MCP bearer | 4.1 client-origin, D12, 5 | Test refuses client-origin runs; limit when enabled |
| Leak: GitHub revocation | 4.2 step 9, 4.3, 2, C-GH-6 | Stated limit: local removal plus link to github.com/settings/applications |
| M1 card truncation | 4.1 step 4 | Test: long argument shown in full; UI truncation checked |
| M2 classification | 4.1 classification, 5 | Tests: unknown/mislabelled = WRITE; shipped-table tools cannot be loosened |
| M3 tripwire | 4.2 (entries incl. `github/auth.ts`, extended transport test) | Tripwire tests plus the new `src/core/connectors/**` test |
| M4 `['*']` | 4.1 switches, 5 | Test: `['*']` yields no connector tools |
| M5 write imports | 4.3 (`github/writes.ts`) | Source test with mutation negative |
| M6 unknown price | 4.5 step 2 | Test: unparseable or missing price blocks |
| Enc: AAD | 4.4 | Test: altered version byte fails authentication |
| Enc: single writer | 4.4, 5 | Test: parallel refresh keeps newest token; C-TR-4 |
| Enc: key lazily on first Connect, restart core | 4.4 | Test: no `key.bin` or safeStorage call at app start; first Connect creates it and restarts core; later launch hands the key over |
| LOW names regex, error taint | 4.1 | Tests with markup and out-of-pattern names |
| LOW loopback details | 4.2 step 6 | Tests: valid-state-only consumption, no query logging, `error=` and missing `iss` |
| LOW step-up | 4.2 step 7 | Test: no automatic step-up; scopes listed on the button |
| LOW log-redirect list | 4.3 | Tests: empty list fails closed; no URL returned |
| R1 bridge-proof client origin | 3, 4.1 (client-origin), 5 | Tests: direct, bridge hop, room hop, continue; mutation negative on `bridgeOrigin` |
| R2 / N1 preset issuer reuse | 4.2 step 3a, 5 | Test: fake resource naming treg's issuer refused; confirmation text when allowed |
| R3 / N2 fallback when "always ask" is off | 4.1 step 5a, 5 | Tests: OFF still cards in `ask`; GitHub write and treg spend cannot be switched down |
| R4 / N3 remote-MCP client file | 4.2 (`mcp-remote.ts`, tripwire entries), 5 ("unchanged" claim removed) | Tests: token only to recorded origin, redirect refused, transport test allows exactly one file |
| R5 ledger: sent-before-request, recovery, session, HMAC | 4.5 steps 3, 5, 7, 8 | Kill-after-sent blocks; kill-after-reserved releases; flipped byte blocks; session = app launch (justified in step 3) |
| Small: `mcp__legion_connectors__` prefix and `markTainted` | 4.1 (prefix and taint) | External-text taint test on the Claude path, mutation negative |
| Small: scoped headline claims | Answer first 1 and 3 | Wording only; limits stay in 4.4 and 4.5 |
| Small: wrap stdout as well as stderr | 3, 4.4 redaction | Test: a `console.log` of a token-shaped value does not reach `core.log` |
| Small: port 3321 and `http:` own refusal | 3, 4.2 step 2 | Test: public-IP fake on 3321, `http:` endpoint refused |
| Small: key created lazily, sent over the open stdin pipe on first Connect (restart only as fallback, before OAuth) | 4.4 | Test: no safeStorage call at start; key installed before the OAuth flow starts |
| Rev 6 edit 1: room-path sites and limit | 4.1 (client-origin), 5 | Room-hop test over `Delivery`, `Meta`, dispatch sites `hub.ts:457,480,504`, `hold` `:764`, `originFor` OR; stated limit: owner runs can write connector data into shared places an MCP-started run can read |
| Rev 6 edit 2: `mcp-remote.ts` passes its own `fetch` to the SDK transport | 4.2 (N3 paragraph) | Test: SSE GET and POSTs only to the recorded origin with token, redirects refused, mutation negative with global `fetch` |
| Rev 6 edit 3: ledger rollback | 4.5 step 8, 4.4 (H2 limit) | In-memory ledger is the authority and is never re-read in a run; rollback across restarts is a stated same-user limit; hard limit is treg balance and ceiling |
| Rev 6 edit 4: lazy key without restart race | 4.4 (Hand-off ordering) | Test: OAuth flow starts only after the key line is installed; fallback orders restart before OAuth |
