/**
 * Sanity checks for a running Roaster API (`roaster api`, default http://127.0.0.1:8080).
 *
 *   pnpm slots                       # solo vs concurrent speed
 *   pnpm slots --slots 3
 *   pnpm slots --protocol-check   # does the model follow our text tool-call protocol?
 *
 * Roaster serves concurrent requests round-robin, one token each, so expect:
 *   per-slot tok/s ≈ solo / N   and   aggregate tok/s ≈ solo.
 * Parallel requests therefore buy overlap, not speed.
 */
import { parseArgs } from 'node:util';
import {
  RoasterLLM, llmConfigFromEnv, renderToolInstructions, parseToolCalls, TOOL_STOP,
  type ChatResult, type ToolSpec,
} from '../src/index.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'), // pnpm forwards a literal "--"
  options: {
    slots: { type: 'string', default: '3' },
    'max-tokens': { type: 'string', default: '160' },
    'protocol-check': { type: 'boolean', default: false },
    repeat: { type: 'string', default: '3' },
    'skip-speed': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const cfg = llmConfigFromEnv();
const llm = new RoasterLLM(cfg);
const slots = Number(values.slots);
const maxTokens = Number(values['max-tokens']);

const PROMPTS = [
  'Explain binary search in about 100 words.',
  'Explain what a hash map is in about 100 words.',
  'Explain how TCP handshakes work in about 100 words.',
  'Explain what a B-tree is in about 100 words.',
];

const summarize = (label: string, r: ChatResult) => {
  const toks = r.usage?.completion_tokens ?? r.chunks;
  const genMs = Math.max(1, r.timings.totalMs - r.timings.ttftMs);
  return {
    request: label,
    'prompt B': r.promptBytes,
    'ttft ms': Math.round(r.timings.ttftMs),
    'total ms': Math.round(r.timings.totalMs),
    tokens: toks,
    'tok/s': +(toks / (genMs / 1000)).toFixed(1),
    finish: r.finishReason ?? '-',
  };
};

const run = (p: string) => llm.chat([{ role: 'user', content: p }], { maxTokens, think: false });

console.log(`Server ${cfg.baseUrl}  model=${cfg.model}\n`);

if (!values['skip-speed']) {
  console.log('1) Single request (note ttft: every request creates a fresh slot and prefills from scratch)');
  const solo = await run(PROMPTS[0]);
  console.table([summarize('solo', solo)]);
  const soloToks = solo.usage?.completion_tokens ?? solo.chunks;
  const soloRate = soloToks / (Math.max(1, solo.timings.totalMs - solo.timings.ttftMs) / 1000);

  console.log(`2) ${slots} concurrent requests (server --max-slots must be >= ${slots})`);
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: slots }, (_, i) => run(PROMPTS[i % PROMPTS.length])));
  const wall = performance.now() - t0;
  console.table(results.map((r, i) => summarize(`slot ${i + 1}`, r)));
  const total = results.reduce((s, r) => s + (r.usage?.completion_tokens ?? r.chunks), 0);
  const agg = total / (wall / 1000);
  console.log(`Aggregate: ${total} tokens in ${Math.round(wall)} ms = ${agg.toFixed(1)} tok/s  (solo: ${soloRate.toFixed(1)} tok/s)`);
  console.log(agg > soloRate * 1.3
    ? 'Aggregate beats solo: you have spare compute, so parallel requests do help.'
    : 'Aggregate ≈ solo: expected for round-robin. Prefer sequential steps with small prompts over parallel subagents.');
  console.log();
}

if (values['protocol-check']) {
  console.log('3) Text tool-call protocol (Roaster ignores native `tools`, so we prompt for <tool_call> ourselves)');
  const tools: ToolSpec[] = [{
    name: 'read_symbol',
    description: 'Read the full source code of a symbol by name.',
    params: { name: { type: 'string', description: 'symbol name, e.g. buildContext' } },
  }];
  const prompt = `${renderToolInstructions(tools)}\n\nTask: show me the source of the function called buildContext.`;
  const n = Number(values.repeat);
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const r = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 200, think: false, stop: TOOL_STOP });
    const { calls, errors } = parseToolCalls(r.content, tools);
    const good = calls.length === 1 && calls[0].name === 'read_symbol' && calls[0].args.name === 'buildContext';
    if (good) ok++;
    console.log(`  run ${i + 1}: ${good ? '✓' : '✗'} style=${calls[0]?.style ?? '-'} stoppedEarly=${!!r.stoppedBy} finish=${r.finishReason ?? '-'} ttft=${Math.round(r.timings.ttftMs / 1000)}s`
      + `\n    raw: ${JSON.stringify(r.content.slice(0, 220))}`
      + (good ? '' : `\n    errors: ${errors.join('; ') || '(none)'}`));
  }
  console.log(`Protocol reliability: ${ok}/${n}`);
  if (ok < n) console.log('If this is flaky, try --cache-route 0 or a higher --route-j on `serve`, or lower temperature.');
}
