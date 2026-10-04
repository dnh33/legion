import { planCompaction, applyPlan, PROTECT_FIRST } from "./dist/src/core/providers/compaction.js";
import { firstConversationBreak } from "./dist/src/core/providers/conversation.js";
const conv = [
  { role: "user", content: "do the thing" },
  { role: "assistant", content: null, tool_calls: [
    { id: "c1", type: "function", function: { name: "t", arguments: "{}" } },
    { id: "c2", type: "function", function: { name: "t", arguments: "{}" } },
  ] },
  { role: "tool", content: "result one", tool_call_id: "c1" },
  { role: "tool", content: "result two", tool_call_id: "c2" },
  { role: "assistant", content: "done", tool_calls: [{ id: "c3", type: "function", function: { name: "t", arguments: "{}" } }] },
  { role: "tool", content: "result three", tool_call_id: "c3" },
  { role: "assistant", content: "final answer" },
];
for (const pf of [0, 1, 2, 3, 4]) {
  const p = planCompaction(conv, { window: 200, protectFirst: pf });
  const out = applyPlan(conv, p, { role: "system", content: "SUMMARY" });
  const brk = firstConversationBreak(out);
  console.log(`protectFirst=${pf} headEnd=${p.headEnd} tailStart=${p.tailStart} roles=[${out.map(m=>m.role+(m.tool_call_id?":"+m.tool_call_id:"")).join(",")}] break=${brk===undefined?"NONE(valid)":JSON.stringify(brk)}`);
}
