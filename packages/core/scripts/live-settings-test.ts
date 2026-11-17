/**
 * Controller vs the mock Roaster API (no model, no Docker, no VS Code):
 *   pnpm tsx packages/core/scripts/live-settings-test.ts
 * Covers: session settings applied live (PATCH) without restart, a bad value, changes made during a question,
 * Think toggled mid-question, no-limit tool steps (with the repeat guard), no-limit reply tokens, helper branches
 * defaulting to the number of slots, helper settings applied live, sliding (and the old reset when sliding is off),
 * and a resize the server refuses.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatController, DEFAULT_SETTINGS, type ControllerSettings, type UiMessage } from '../src/index.js';

const MOCK = path.resolve(import.meta.dirname, '../../agent/scripts/mock-server.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let port = 18700;

// a tiny project to index
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-live-'));
fs.mkdirSync(path.join(proj, 'src'));
fs.writeFileSync(path.join(proj, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext"},"include":["src"]}');
fs.writeFileSync(path.join(proj, 'src/index.ts'),
  'export function buildContext(q: string): string { return helper(q); }\nfunction helper(q: string): string { return q.trim(); }\n' +
  'export function retrieve(q: string) { return buildContext(q); }\n');

async function withMock(env: Record<string, string>, fn: (url: string, get: (p: string) => Promise<any>) => Promise<void>): Promise<void> {
  const p = port++;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', MOCK, String(p)], { env: { ...process.env, MOCK_SLOW_MS: '2', ...env }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not up yet */ } await sleep(100); }
  const get = async (q: string) => (await fetch(url + q)).json();
  try { await fn(url, get); } finally { child.kill(); }
}

function setup(url: string, patch: (s: ControllerSettings) => void = () => {}) {
  const S: ControllerSettings = structuredClone(DEFAULT_SETTINGS); S.chats.reuseSystemPrompt = false; // these tests check the first request exactly as before
  S.baseUrl = url; S.profile = { ...S.profile, context: 16384 };
  patch(S);
  const msgs: UiMessage[] = [];
  const ctl = new ChatController(proj, () => S, (m) => { msgs.push(m); });
  const texts = (type: string) => msgs.filter((m) => m.type === type).map((m: any) => m.text as string);
  const convId = () => (ctl as any).conv.id as string;
  return { S, ctl, msgs, texts, convId };
}
const ok = (name: string) => console.log(`  ok  ${name}`);

async function main() {
  /* ---------- settings applied live, without a restart ---------- */
  await withMock({}, async (url, get) => {
    const { S, ctl, texts, convId } = setup(url);
    await ctl.ask('what does buildContext do');
    const s0 = await get(`/v1/sessions/${convId()}`);
    assert.equal(s0.config.context_length, 16384); assert.equal(s0.config.slide, true); assert.equal(s0.config.keep, 64);
    ok('session is created with explicit settings (context, slide, keep)');

    const log0 = await get('/_log');
    const mine = log0.filter((l: any) => l.session === convId());
    assert.deepEqual(mine[0].roles, ['system', 'user']); assert.deepEqual(mine[1].roles, ['user']);
    ok('instructions go in a system message (pinned) once; follow-up steps send only the user message');

    S.profile = { ...S.profile, context: 32768, cacheRoute: false, routeJ: 4, keep: 128 };
    await ctl.applySettings();
    const s1 = await get(`/v1/sessions/${convId()}`);
    assert.equal(s1.config.context_length, 32768); assert.equal(s1.config.cache_route, false);
    assert.equal(s1.config.route_j, 4); assert.equal(s1.config.keep, 128);
    assert.equal(ctl.powerInfo.state, 'on');
    assert.ok(texts('status').some((t) => /Applied without restart: .*context window.*routing.*kept tokens/.test(t)), 'status line');
    ok('context window, routing and keep change on the live session (no restart, still on)');

    S.profile = { ...S.profile, routeJ: 99 };
    const before = texts('error').length;
    await ctl.applySettings(); await ctl.applySettings();
    assert.equal((await get(`/v1/sessions/${convId()}`)).config.route_j, 4);
    assert.equal(texts('error').length, before + 1, 'one error, not two');
    S.profile = { ...S.profile, routeJ: 3 };
    await ctl.applySettings();
    assert.equal((await get(`/v1/sessions/${convId()}`)).config.route_j, 3);
    ok('a bad value is refused, the session keeps the old one, the error is shown once, a good value then applies');
    await ctl.dispose();
  });

  /* ---------- changes during a question ---------- */
  await withMock({ MOCK_SLOW_MS: '40' }, async (url, get) => {
    const { S, ctl, msgs, convId } = setup(url);
    const q = ctl.ask('what does buildContext do');
    while (!ctl.isBusy) await sleep(5);
    // wait for the first step's progress line, then change things mid-question
    for (let i = 0; i < 400 && !msgs.some((m) => m.type === 'progress'); i++) await sleep(10);
    S.think = true;
    S.profile = { ...S.profile, context: 20000 };
    await ctl.applySettings(); // busy: must be deferred, not fail
    assert.notEqual((await get(`/v1/sessions/${convId()}`)).config.context_length, 20000);
    await q; await sleep(300);
    assert.equal((await get(`/v1/sessions/${convId()}`)).config.context_length, 20000);
    ok('a session setting changed during a question is applied the moment it ends');
    const mine = (await get('/_log')).filter((l: any) => l.session === convId());
    assert.equal(mine[0].think, false); assert.equal(mine[mine.length - 1].think, true);
    ok('Think switched on mid-question applies to the next step of that question');
    await ctl.dispose();
  });

  /* ---------- unlimited tool steps and reply tokens ---------- */
  await withMock({ MOCK_STUBBORN: '1' }, async (url, get) => {
    const { S, ctl, texts, convId } = setup(url, (s) => { s.maxSteps = -1; s.maxTokens = -1; });
    await ctl.ask('what does buildContext do');
    const answers = texts('answer');
    assert.equal(answers.length, 1, 'the loop ended');
    const mine = (await get('/_log')).filter((l: any) => l.session === convId());
    assert.ok(mine.length >= 4 && mine.length < 12, `ended after the repeat guard, took ${mine.length} requests`);
    assert.ok(mine.every((l: any) => l.max_tokens === 1_000_000), 'no reply limit sends a huge max_tokens (the window slides)');
    ok('no limit on tool steps: a model that repeats one call is stopped by the repeat guard; no limit on reply tokens');
    S.maxSteps = 1; // and the limit can be lowered again, live
    await ctl.dispose();
  });

  /* ---------- helper branches default to the number of slots ---------- */
  for (const c of [
    { name: 'slots 2, default branches', slots: 2, branches: 0, helpersSeen: 2 },
    { name: 'slots 4, default branches', slots: 4, branches: 0, helpersSeen: 3 }, // the mock asks 3 questions
    { name: 'slots 2, branches 1', slots: 2, branches: 1, helpersSeen: 1 },
    { name: 'slots 2, branches unlimited, helper steps unlimited', slots: 2, branches: -1, helpersSeen: 3, helperSteps: -1 },
  ]) {
    await withMock({ MOCK_EXPLORE: '1' }, async (url) => {
      const { ctl, texts } = setup(url, (s) => { s.slots = c.slots; s.helpers = { ...s.helpers, branches: c.branches, maxSteps: c.helperSteps ?? 3 }; });
      await ctl.ask('compare retrieve and buildContext');
      const progress = texts('progress').join('\n');
      const seen = [1, 2, 3, 4].filter((n) => progress.includes(`helper ${n} ·`)).length;
      assert.equal(seen, c.helpersSeen, `${c.name}: questions run (saw ${seen})`);
      assert.equal(texts('answer').length, 1);
      ok(`explore: ${c.name} → ${c.helpersSeen} question(s)`);
      await ctl.dispose();
    });
  }

  /* ---------- helper settings live ---------- */
  await withMock({ MOCK_EXPLORE: '1' }, async (url, get) => {
    const { S, ctl, convId } = setup(url, (s) => { s.slots = 4; });
    await ctl.ask('compare retrieve and buildContext');
    const ids = (await get('/v1/sessions')).sessions.map((x: any) => x.id as string).filter((id: string) => id !== convId());
    assert.equal(ids.length, 3);
    S.helpers = { ...S.helpers, context: 4096 }; S.profile = { ...S.profile, cacheRoute: false };
    await ctl.applySettings();
    for (const id of ids) {
      const c = (await get(`/v1/sessions/${id}`)).config;
      assert.equal(c.context_length, 4096); assert.equal(c.cache_route, false);
    }
    ok('helper context and routing are changed on the existing helpers (they keep their conversations)');
    S.slots = 2;
    await ctl.applySettings();
    const left = (await get('/v1/sessions')).sessions.length;
    assert.equal(left, 2, `main + 1 helper left, got ${left}`);
    ok('lowering Slots closes idle helpers at once and frees their slots');
    S.helpers = { ...S.helpers, enabled: false };
    await ctl.applySettings();
    assert.equal((await get('/v1/sessions')).sessions.length, 1);
    ok('turning helpers off frees every helper slot');
    await ctl.dispose();
  });

  /* ---------- sliding ---------- */
  await withMock({ MOCK_CONTEXT: '300' }, async (url, get) => {
    const { S, ctl, msgs, texts, convId } = setup(url, (s) => { s.profile = { ...s.profile, context: 300 }; });
    for (let i = 0; i < 4; i++) await ctl.ask(`what does buildContext do, round ${i}`);
    const d = await get(`/v1/sessions/${convId()}`);
    assert.ok(d.position > 300 && d.spilled_tokens > 0, `window slid (position ${d.position}, spilled ${d.spilled_tokens})`);
    assert.ok(d.pinned_tokens > 0, 'system prompt is pinned');
    assert.equal(texts('answer').length, 4); assert.ok(!texts('answer').some((t) => /context is full/.test(t)));
    assert.ok(!texts('status').some((t) => /getting full: reset/.test(t)), 'never reset while sliding');
    const c = msgs.filter((m) => m.type === 'context').pop() as any;
    assert.ok(c && c.spilled > 0 && c.pinned > 0 && c.window <= c.context && c.sliding, JSON.stringify(c));
    ok('with sliding on, a conversation longer than the window keeps going: no reset, the context bar gets window / SSD / pinned');

    S.profile = { ...S.profile, slide: false };
    await ctl.applySettings();
    assert.equal((await get(`/v1/sessions/${convId()}`)).config.slide, false);
    await ctl.ask('and now one more question');
    assert.ok(texts('status').some((t) => /getting full: reset/.test(t)), 'sliding off → the old reset-with-recap');
    ok('sliding can be switched off live; the old reset-with-recap takes over');
    await ctl.dispose();
  });

  /* ---------- reasoning left inline by the server, and events a UI can stream ---------- */
  await withMock({ MOCK_INLINE_THINK: '1' }, async (url) => {
    const { ctl, msgs, texts } = setup(url, (s) => { s.think = true; });
    await ctl.ask('what does buildContext do');
    const toks = msgs.filter((m: any) => m.type === 'trace' && m.event.type === 'token').map((m: any) => m.event);
    const reasoning = toks.filter((t: any) => t.kind === 'reasoning').map((t: any) => t.text).join('');
    const content = toks.filter((t: any) => t.kind === 'content').map((t: any) => t.text).join('');
    assert.ok(reasoning.length > 0 && reasoning.replace(/inline[01] /g, '') === '', `the inline <think> blocks (one per step) are reported as reasoning, tags removed: ${JSON.stringify(reasoning)}`);
    assert.ok(!/think>/.test(content) && !/inline/.test(content), 'and kept out of the content');
    assert.ok(texts('answer')[0] && !/think|inline/.test(texts('answer')[0]), 'and out of the answer');
    ok('a reply that starts with <think>…</think> (tags split across chunks) is shown as reasoning, not as the answer');
    await ctl.dispose();
  });

  await withMock({}, async (url) => {
    const { ctl, msgs } = setup(url);
    await ctl.ask('what does buildContext do');
    const ev = msgs.filter((m: any) => m.type === 'trace' && m.agent === 0).map((m: any) => m.event.type);
    assert.deepEqual(ev.filter((t: string, i: number) => t !== ev[i - 1]).slice(0, 6), ['start', 'turn', 'token', 'call', 'step', 'turn'], 'start → turn → tokens → call (before the tool runs) → step (with the result) → turn …');
    const turn = msgs.find((m: any) => m.type === 'trace' && m.event.type === 'turn') as any;
    assert.ok(turn.event.contextLength > 0 && turn.event.windowTokens >= 0, 'turn carries the window numbers for the context bar');
    const ctx = msgs.filter((m) => m.type === 'context').pop() as any;
    assert.ok(ctx && ctx.context === 16384 && ctx.window > 0 && ctx.pinned > 0, 'a context message follows the answer');
    ok('events for a UI: start → turn → tokens → step; the window numbers for the context bar');
    await ctl.dispose();
  });

  /* ---------- a resize the server refuses ---------- */
  await withMock({ MOCK_FAIL_RESIZE: '1' }, async (url, get) => {
    const { S, ctl, texts, convId } = setup(url);
    await ctl.ask('what does buildContext do');
    S.profile = { ...S.profile, context: 200000 };
    await ctl.applySettings();
    assert.equal((await get(`/v1/sessions/${convId()}`)).config.context_length, 16384);
    assert.ok(texts('error').some((t) => /Could not apply a setting.*resize/.test(t)));
    S.profile = { ...S.profile, context: 24000 };
    await ctl.applySettings();
    assert.equal((await get(`/v1/sessions/${convId()}`)).config.context_length, 24000);
    ok('a resize the server refuses leaves the session as it was and says why; the next value works');
    await ctl.dispose();
  });

  console.log('\nall live-settings checks passed');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
