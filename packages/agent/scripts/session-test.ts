/**
 * Does session KV reuse actually pay off, and does the tool-call round trip work across turns?
 *   pnpm tsx packages/agent/scripts/session-test.ts
 *
 * Turn 1  : ~150-token prompt (pays full prefill)
 * Turn 2  : a ~10-token follow-up in the SAME session (should be far cheaper than turn 1 if KV is reused)
 * Turn 3-4: tool-call round trip (model calls a tool, we send the result as the next user message)
 * Turn 5  : client-side disconnect mid-generation, then a follow-up (is the session still healthy?)
 * Slow on purpose-built hardware: expect a few minutes at ~7 tok/s prefill.
 */
import {
  RoasterLLM, llmConfigFromEnv, renderToolInstructions, parseToolCalls, type ToolSpec,
} from '../src/index.js';

const llm = new RoasterLLM(llmConfigFromEnv());
const id = `bc-test-${Math.floor(Math.random() * 1e6)}`;
const tools: ToolSpec[] = [{
  name: 'read_symbol', description: 'Read the full source code of a symbol by name.',
  params: { name: { type: 'string', description: 'symbol name' } },
}];

const filler = (tokens: number) => {
  let s = '';
  for (let i = 0; s.length < tokens * 3.5; i++) s += `function handler${i}(req${i}) { return store${i}.get(req${i}.id) + ${i * 7}; }\n`;
  return s.slice(0, Math.floor(tokens * 3.5));
};

const rows: Record<string, unknown>[] = [];
const pos = async () => {
  for (let i = 0; i < 20; i++) {           // a busy session reports only {busy:true}; wait until it is idle
    const d = (await llm.sessionInfo(id)).data;
    if (d && d.busy !== true && d.position !== undefined) return d.position;
    await new Promise((r) => setTimeout(r, 400));
  }
  return '?';
};

async function turn(label: string, content: string, extra: { stop?: string[]; maxTokens?: number } = {}) {
  const before = await pos();
  const r = await llm.chat([{ role: 'user', content }], { session: id, maxTokens: extra.maxTokens ?? 60, stop: extra.stop, think: false });
  const after = await pos();
  rows.push({
    turn: label, 'sent B': r.promptBytes, 'ttft s': +(r.timings.ttftMs / 1000).toFixed(1),
    'total s': +(r.timings.totalMs / 1000).toFixed(1), 'ctx before': before, 'ctx after': after, finish: r.finishReason ?? '-',
  });
  console.table([rows[rows.length - 1]]);
  return r;
}

console.log(`session ${id} on ${llm.cfg.baseUrl}\n`);
const created = await llm.createSession(id, 8192);
if (created.status >= 300) console.log('createSession →', created.status, JSON.stringify(created.data).slice(0, 200));

try {
  await turn('1 big prompt', `${filler(150)}\n\nIgnore the code above. Reply with the single word: ready`);
  await turn('2 short follow-up', 'Reply with the single word: ok');

  const sys = renderToolInstructions(tools);
  const t3 = await turn('3 ask for tool', `${sys}\n\nTask: show me the source of the function called buildContext.`, { maxTokens: 120 });
  const { calls, errors } = parseToolCalls(t3.content, tools);
  console.log(`  tool call parsed: ${calls.length === 1 ? '✓ ' + JSON.stringify(calls[0].args) : '✗ ' + (errors.join('; ') || JSON.stringify(t3.content.slice(0, 150)))}`);
  console.log(`  finished by itself: ${t3.finishReason === 'stop'}  raw tail: ${JSON.stringify(t3.content.slice(-60))}`);

  const t4 = await turn('4 tool result', '<tool_response>\nfunction buildContext(g, seeds, budget) { /* packs graph nodes under a token budget */ }\n</tool_response>', { maxTokens: 80 });
  console.log(`  final answer (first 160 chars): ${JSON.stringify(t4.content.slice(0, 160))}`);

  const t5 = await turn('5 disconnect early', 'Count from 1 to 40, separated by spaces.', { stop: ['5'], maxTokens: 120 });
  console.log(`  stopped by client: ${t5.stoppedBy ? 'yes' : 'no'}`);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('  session after stop:', JSON.stringify((await llm.sessionInfo(id)).data));
  const t6 = await turn('6 after disconnect', 'Reply with the single word: alive');
  console.log(`  reply after disconnect: ${JSON.stringify(t6.content.slice(0, 80))}  (coherent? then cut-off turns are safe)`);
} finally {
  const d = await llm.deleteSession(id);
  console.log(`\ndeleteSession → ${d.status}`);
}
console.log('\nSummary'); console.table(rows);
console.log('If turn 2 ttft ≈ turn 1 ttft, the context is NOT being reused. If it is much lower, sessions work.');
