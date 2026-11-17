/**
 * How does time-to-first-token scale with prompt size? (Roaster re-prefills every request.)
 *   pnpm tsx packages/agent/scripts/prefill-test.ts            # sizes 100, 400, 800 (approx tokens)
 *   pnpm tsx packages/agent/scripts/prefill-test.ts 100 500 2000 4000   # warning: slow if prefill is ~7 tok/s
 * Each size runs once, one at a time. ttft includes slot creation, so the smallest size shows the fixed cost.
 */
import { RoasterLLM, llmConfigFromEnv } from '../src/index.js';

const llm = new RoasterLLM(llmConfigFromEnv());
const sizes = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [100, 400, 800];

// ~3.5 bytes/token; varied lines so tokenizers can't collapse them
const filler = (tokens: number) => {
  let s = '';
  for (let i = 0; s.length < tokens * 3.5; i++) s += `function handler${i}(req${i}) { return store${i}.get(req${i}.id) + ${i * 7}; }\n`;
  return s.slice(0, Math.floor(tokens * 3.5));
};

const rows = [];
for (const size of sizes) {
  const prompt = `${filler(size)}\n\nIgnore the code above. Reply with the single word: ok`;
  const r = await llm.chat([{ role: 'user', content: prompt }], { maxTokens: 4, think: false });
  const ptoks = r.usage?.prompt_tokens ?? Math.round(r.promptBytes / 3.5);
  rows.push({
    'target tok': size,
    'prompt B': r.promptBytes,
    'prompt tok': ptoks,
    'ttft s': +(r.timings.ttftMs / 1000).toFixed(1),
    'prefill tok/s': +(ptoks / (r.timings.ttftMs / 1000)).toFixed(1),
  });
  console.table([rows[rows.length - 1]]);
}
console.log('\nSummary'); console.table(rows);
console.log('Rule of thumb: an agent step costs ttft(prompt size) + output tokens / decode tok/s.');
