# Plan: Legion's own servers are loopback-only

Scope: the core HTTP API + SSE + `/mcp` on 127.0.0.1:4747 (`src/core/server.ts`, started by `src/bin/legion-core.ts`). The stdio proxy (`legion-mcp-stdio.ts`) and the Electron main process listen on nothing (a test checks it). Wording is scoped: "Legion's own code ...".

## Unauthenticated routes (before this change and after)
- `GET /health`: only `ok`, `version`, `pid`, `admin` (true/false: a secret exists) and, when asked with a nonce, an HMAC proof (never the secret). No token, path or `.legion` data (tested).
- `OPTIONS *`: 204, no body. Everything else, including unknown paths, is 401 before routing (default-deny gate).

## Threats and controls
| Threat | Control | Test / mutation |
|---|---|---|
| Tunnel (ngrok, cloudflared, port forward) or reverse proxy under another name | C1 Host must be exactly `127.0.0.1:<port>` or `localhost:<port>` (not `[::1]`: Legion does not listen on IPv6), 421, before every route | forged Hosts x 5 routes; drop the check -> fails |
| DNS rebinding (attacker name resolves to 127.0.0.1) | C1 (the browser sends the attacker's Host) | rebinding Host with a valid token still 421 |
| Malicious page in the owner's browser (CSRF, simple POST, fetch, EventSource, WebSocket upgrade) | C3 Origin, if present, must be on a short list; a browser-sent request (`Sec-Fetch-Site` present, which a page cannot set) that is not same-origin needs an allowed Origin; `none` only for GET/HEAD. Bearer token and admin secret remain required. Upgrade requests are plain requests to the same handler (no WebSocket server exists). | cross-site POST with/without token, /mcp, preflight; each rule mutated |
| Origin `null` / `file://` | Accepted only with an Electron User-Agent (a web page cannot set User-Agent). Sandboxed iframes and data: pages send `null` but Chrome's UA, so they are refused. Another local web server's page (`http://127.0.0.1:<other port>`) is refused. | UA unit tests + real server |
| LAN / other machine | C2 remote address must be loopback else the connection is destroyed (`connection` event, plus the request hook); C4 listen only via `listenLoopback` with constant `127.0.0.1`; C5 startup self-check closes the server and exits (code 4) if the bound address is not loopback | fake non-loopback socket, `listen(…,'0.0.0.0')` mutation |
| IPv6 / IPv4-mapped | `::1`, `::ffff:127.x` and `::ffff:7f00:1` pass; `::ffff:` + non-loopback, `::`, link-local fail | address table test |
| Env var / config / CLI changing the host | None is read: host is a constant (`LOOPBACK_HOST`). Port stays configurable (`LEGION_PORT`, config). Source scan fails on any `.listen(` other than the one in net-guard, `0.0.0.0`/`'::'` in a file that can bind, listen option objects, other server constructors, debugger ports, HOST/BIND env, in src and ui/src | `test/net-guard-source.test.ts` with its own mutations |
| Second core on another port | Same code, same guard; its Host check uses its own bound port | n/a (same path) |
| Another local user on a shared PC | Not stopped by loopback alone; the bearer token (config.json, user-only permissions) and the per-launch admin secret still apply | stated limit |
| Electron renderer with remote content | Out of this change: the window loads a local file, navigation and window.open are already denied in main.ts; the guard still checks Origin/UA | stated limit |

## Honest limits
- Another process of the same user on this machine can connect from loopback with the right Host; only the token and admin secret protect then.
- A tunnel the owner sets up that rewrites Host to `127.0.0.1:<port>` and a leaked bearer token still reach the client route list (never admin routes).
- The User-Agent rule trusts that Electron's UA contains `Electron/`; if a future Electron build changes it the app window gets 403 (fails closed, easy to see).
- Not verified here (needs the real PC): what Origin the packaged window really sends (`null` or `file://`; both are accepted with the Electron UA), the Windows firewall prompt on listen (should not appear for 127.0.0.1), the app still loading, a real tunnel test by the owner.
