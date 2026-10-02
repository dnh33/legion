# VM notes (boat.dev)

Short operating notes for the per-agent cloud VMs. Design is in [ARCHITECTURE.md](ARCHITECTURE.md#vm-manager).

## Setting the VM size and switching a VM on or off

Each agent has `vm.enabled`, `vm.size` (`small`, `default`, `large`) and `vm.idleStopMinutes`. Change them in the agent's settings (pencil icon in the thread header), or with `PATCH /api/agents/<id>` and body `{"vm":{"size":"default"}}` (an admin route: the app does this for you). Do not edit `~/.legion/state.json` while Legion runs: Legion keeps state in memory and rewrites the file, so the edit is lost.

`default` works on every boat.dev plan. `large` needs a paid plan. On a free trial boat.dev answers `403 trial_machine_class_not_allowed`; Legion then starts the VM at `default`, shows "Running at default size" in the Computer card and keeps the configured size, so it returns to `large` on its own once the plan allows it.

A running VM keeps its size; a changed setting applies the next time it is stopped and started (a stopped VM picks it up when it resumes).

## When a start keeps failing

Press **Start** (or **Retry**) in the Computer card, or let the agent call `vm_start`. The record of a failed start is never reused: a fresh sandbox is built from the agent's current settings. Common messages:

| Message starts with | Meaning | Fix |
|---|---|---|
| This boat.dev API key cannot sandbox.resume (or another action) | The key lacks that permission | Create a full-access key in boat.dev, paste it in Settings, boat.dev |
| This boat.dev account is on a free trial… | The size is not allowed on a trial | Use Default, or upgrade |
| Claude is not configured on boat.dev | `vm_claude` needs Claude connected on boat.dev's Agents page | Connect it there; the tool returns by itself within 5 minutes (or press Check again in Settings) |

If `vm_stop` says boat.dev still reports the VM up, or that it could not confirm, the stop request was sent but the VM may still be running and billing: check the Computer card or the boat.dev dashboard, or call stop again. A start and a stop for the same agent never overlap; a stop during a start waits for the start to finish and then stops it.

Settings, boat.dev shows **Key permissions** with a **Check again** button. The check only reads and asks about a sandbox id that cannot exist, so it never creates a VM or costs money. "Not refused" means boat.dev did not refuse the action at that moment; a real call can still be refused, and then it appears in the same list. If boat.dev cannot be reached, is rate limiting or has a server error, the check says so and gives no verdict on the key (only a rejected key is reported as rejected). Pasting a different key, or removing it, starts the findings over.

## Usage and cost

`vm_start`, `vm_exec` and `vm_stop` return `runtimeSeconds` (the current run) and `todaySeconds` (the local day, all runs). `vm_usage` returns the same without touching the VM. The Computer card shows one line. The numbers are Legion's own uptime measure (ready to stop), not boat.dev's bill.

Legion has no built-in prices. To see an estimate, enter your hourly price per size and a currency label in Settings, boat.dev, Cost estimate (stored as `boat.rates` and `boat.currency` in `config.json`). Estimates are labelled as such and use today's uptime times the rate of the VM's size. The prices are read from your config each time; the app keeps a copy for display and does not use it past 10 minutes old: the cost then reads "cost unknown" until a fresh copy arrives.

Only the app window (admin) sees the prices, the key probe results and the refused-action list; an MCP-class token gets `configured`, whether Claude is set up and whether the account is on a trial, nothing more.

## Not verified against the real boat.dev

The three error bodies (`api_key_action_forbidden`, `trial_machine_class_not_allowed`, `provider_not_configured`) come from a real report; the rest of the wire behaviour (for example whether `provider_not_configured` is answered before a sandbox lookup, so the probe can see it) is covered by a fake server only.
