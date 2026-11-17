/**
 * Finds which request field Roaster's JSON parser rejects (HTTP 400 "not valid JSON").
 *   pnpm tsx packages/agent/scripts/probe-api.ts
 * Each variant is sent on its own. A variant is "accepted" if the server answers 200 or is still
 * generating after 4 s (we then close the connection, which frees the slot).
 */
import { llmConfigFromEnv } from '../src/index.js';

const cfg = llmConfigFromEnv();
const msg = (content: string) => ({ messages: [{ role: 'user', content }] });

const variants: [string, Record<string, unknown>][] = [
  ['messages only', { ...msg('Say ok.') }],
  ['+ stream:true', { ...msg('Say ok.'), stream: true }],
  ['+ model', { ...msg('Say ok.'), model: cfg.model, stream: true }],
  ['+ temperature', { ...msg('Say ok.'), temperature: 0.2, stream: true }],
  ['+ max_tokens', { ...msg('Say ok.'), max_tokens: 8, stream: true }],
  ['+ think:false', { ...msg('Say ok.'), think: false, stream: true }],
  ['+ stream_options', { ...msg('Say ok.'), stream: true, stream_options: { include_usage: true } }],
  ['+ top_k', { ...msg('Say ok.'), top_k: 20, stream: true }],
  ['+ top_p', { ...msg('Say ok.'), top_p: 0.9, stream: true }],
  ['newline in content', { ...msg('line one\nline two'), stream: true }],
  ['quotes + backslash in content', { ...msg('say "hi" and C:\\path'), stream: true }],
  ['non-ASCII in content', { ...msg('café — naïve → ok'), stream: true }],
  ['everything our client sends', {
    model: cfg.model, ...msg('Say ok.'), stream: true, stream_options: { include_usage: true },
    temperature: 0.2, max_tokens: 8, think: false,
  }],
];

for (const [label, body] of variants) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  let verdict: string;
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (res.ok) { verdict = `✓ ${res.status}`; await res.body?.cancel().catch(() => {}); }
    else verdict = `✗ ${res.status} ${(await res.text()).slice(0, 140)}`;
  } catch (e) {
    verdict = (e as Error).name === 'AbortError' ? '✓ accepted (still generating after 4 s)' : `✗ ${(e as Error).message}`;
  } finally { clearTimeout(timer); }
  console.log(`${verdict.startsWith('✓') ? '✓' : '✗'} ${label.padEnd(32)} ${verdict.slice(2)}`);
  if (verdict.startsWith('✗')) console.log(`    body: ${JSON.stringify(body)}`);
  await new Promise((r) => setTimeout(r, 400)); // let the slot close
}
