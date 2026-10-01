# Mascot integration: requests for shared files

The mascot work touches only its own files (scripts/build-mascot.py, ui/src/mascot/**, AgentRail.tsx, OpsPanel.tsx,
ui/src/art/**, docs/art/**, CONTRIBUTING.md, test/mascot*.test.ts). These changes need a shared-file owner.

## 1. store.ts: forward `comms.state` (saves a second SSE connection)

The busts already react to `comms.state` (listening / speaking / waiting-bot). Today ui/src/mascot/commsFeed.ts opens its own
ref-counted `api.subscribe` stream. If store.ts forwards the event, the stream is shared and commsFeed also listens for it.

```diff
--- a/ui/src/store.ts
+++ b/ui/src/store.ts
@@ export function handleEvent(e: LegionEvent) {
     case 'vm.updated':
       setState((s) => ({ vms: { ...s.vms, [e.vm.agentId]: e.vm } }));
       break;
+    case 'comms.state':
+      window.dispatchEvent(new CustomEvent('legion:comms', { detail: e }));
+      break;
```

(commsFeed.ts keeps working without this change; the diff only removes the extra connection once it is applied and the
`api.subscribe` call in commsFeed.ts is dropped.)

## 2. Herald art: broken path (maker's file, harness logs one console error per instance)

docs/art/muster/herald/herald.layered.svg contains `<path d="M134,474 C138,488 136,500" ...>`: a cubic with only two points, so the
browser logs `attribute d: Unexpected end of attribute` and skips the segment. Not changed here because the fix redraws a stroke
(the owner approves specific paintings). Suggested: `C138,488 136,500` -> `Q138,488 136,500`, then `python3 scripts/build-mascot.py --all`.

## 3. ui/vite.config.ts: `inlineDynamicImports`

The UI is one IIFE bundle, so the per-bust `import('./data/x.json?raw')` in busts.ts defers `JSON.parse`, not the bytes
(the 12 jsons are about 1.28 MB raw inside the 2.17 MB bundle). Real splitting needs the build to emit chunks next to index.html.

## 4. app.css (optional): the rail busy ring

`.avatar.busy::after` animates `ring 1.6s ease-out infinite` and is the one endless animation left on a working rail row.
bust.css already overrides it for bust avatars with `steps(8)`; the same override in app.css would cover the emoji avatars too.

```diff
-.avatar.busy::after { ... animation: ring 1.6s ease-out infinite; }
+.avatar.busy::after { ... animation: ring 1.6s steps(8) infinite; }
```
