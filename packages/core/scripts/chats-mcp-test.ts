/**
 * Saved chats (transcript + stored context + restore + recap fallback) and MCP tools (stdio and HTTP servers,
 * approvals, budget, enable/disable), against the mock Roaster API. No model, no Docker, no VS Code:
 *   pnpm tsx packages/core/scripts/chats-mcp-test.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseToolCalls } from '@bluecheese/agent';
import { ChatController, ChatStore, DEFAULT_SETTINGS, McpHub, loadMcpConfig, makeChatTools, makeEditTools, makeTools, checkSource, outlineSource, type ChatRecord, type ControllerSettings, type UiMessage } from '../src/index.js';

const MOCK = path.resolve(import.meta.dirname, '../../agent/scripts/mock-server.ts');
const FAKE = path.resolve(import.meta.dirname, 'fake-mcp-server.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let port = 18950;
const ok = (name: string) => console.log(`  ok  ${name}`);

function project(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-chats-'));
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'src/index.ts'), 'export function buildContext(q: string): string { return q.trim(); }\n');
  return proj;
}

async function withMock(env: Record<string, string>, fn: (url: string, get: (p: string) => Promise<any>) => Promise<void>): Promise<void> {
  const p = port++;
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', MOCK, String(p)], { env: { ...process.env, MOCK_SLOW_MS: '2', ...env }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not up yet */ } await sleep(100); }
  try { await fn(url, async (q) => (await fetch(url + q)).json()); } finally { child.kill(); }
}

function setup(proj: string, url: string, patch: (s: ControllerSettings) => void = () => {}, host = {}) {
  const S: ControllerSettings = structuredClone(DEFAULT_SETTINGS);
  S.baseUrl = url; S.mcp.enabled = false; S.slots = 1; S.chats.reuseSystemPrompt = false;   // the prompt cache has its own tests below
  patch(S);
  const msgs: UiMessage[] = [];
  const ctl = new ChatController(proj, () => S, (m) => { msgs.push(m); }, host);
  const of = <T extends UiMessage['type']>(t: T) => msgs.filter((m) => m.type === t) as Extract<UiMessage, { type: T }>[];
  const texts = (type: string) => msgs.filter((m) => m.type === type).map((m: any) => m.text as string);
  const last = <T extends UiMessage['type']>(t: T) => of(t)[of(t).length - 1];
  return { S, ctl, msgs, of, texts, last };
}

async function main() {
  /* ---------- chats: saved as you go, listed, opened, restored ---------- */
  await withMock({}, async (url, get) => {
    const proj = project();
    const { ctl, of, texts, last } = setup(proj, url);
    ctl.init();
    assert.equal(last('chats').chats.length, 0);
    await ctl.ask('what does buildContext do');
    const store = new ChatStore(proj);
    let list = store.list();
    assert.equal(list.length, 1); assert.equal(list[0].title, 'what does buildContext do'); assert.equal(list[0].turns, 1);
    const rec = store.load(list[0].id)!;
    assert.equal(rec.turns[0].state, 'done'); assert.ok(rec.turns[0].a.length > 0);
    assert.ok(rec.turns[0].tools.some((t) => t.name === 'grep' && t.source === 'builtin' && /buildContext/.test(t.result ?? '')), 'tool call with its result is in the transcript');
    assert.ok(rec.turns[0].speed, 'speed line saved');
    assert.ok(fs.readFileSync(path.join(proj, '.bluecheese', '.gitignore'), 'utf8').includes('*'), 'chats are kept out of git');
    ok('a question and its answer, tools and speed are saved as soon as they happen; .bluecheese is git-ignored');

    await sleep(100);
    const saved = store.load(rec.id)!;
    assert.ok(saved.snapshot && saved.snapshot.path.endsWith(`/${store.projectKey}/${rec.id}`) && saved.snapshot.path.startsWith('/state/bluecheese/'), JSON.stringify(saved.snapshot));
    assert.ok(last('chats').chats[0].contextSavedAt, 'the sidebar knows the context is saved');
    ok('the model\u2019s context is stored on the server after the answer (path = serverDir/project/chat)');

    const firstId = rec.id, pos1 = (await get('/v1/sessions')).sessions[0].position as number;
    await ctl.newChat();
    assert.equal(last('chat').chat.turns.length, 0); assert.notEqual(last('chats').activeId, firstId);
    await ctl.ask('second chat question');
    const log1 = (await get('/_log')).length;
    list = store.list(); assert.equal(list.length, 2); assert.equal(list[0].title, 'second chat question');
    const sid = (await get('/v1/sessions')).sessions[0].id;
    assert.ok((await get(`/v1/sessions/${sid}`)).position < pos1 + 400, 'new chat started from an empty context');
    ok('a new chat is a separate chat; the first one stays in the list');

    await ctl.openChat(firstId);
    assert.equal(last('chat').chat.id, firstId); assert.equal(last('chat').chat.turns[0].q, 'what does buildContext do');
    assert.ok(last('chat').chat.contextSaved);
    await ctl.ask('and a follow-up');
    const reqs = (await get('/_log')).slice(log1).filter((l: any) => l.session === sid);
    assert.deepEqual(reqs[0].roles, ['user'], 'after a restore the system prompt is NOT sent again (it is pinned in the restored context)');
    assert.ok(texts('status').some((t) => /Restored this chat/.test(t)));
    const d = await get(`/v1/sessions/${sid}`);
    assert.ok(d.position >= pos1, `restored context continues from where it was (${d.position} >= ${pos1})`);
    assert.equal(store.load(firstId)!.turns.length, 2);
    ok('opening an older chat restores its stored context; the follow-up carries on from it, with no new system prompt');

    // a fresh controller (VS Code restarted) opens the chat that was open last
    const again = setup(proj, url);
    again.ctl.init();
    assert.equal(again.last('chat').chat.id, firstId); assert.equal(again.last('chats').chats.length, 2);
    ok('after a restart the chat that was open is shown again, with the list');

    await ctl.renameChat(firstId, '  Renamed   chat ');
    assert.equal(store.load(firstId)!.title, 'Renamed chat');
    await ctl.newChat(); await ctl.deleteChat(firstId);
    assert.equal(store.list().length, 1); assert.equal(store.load(firstId), undefined);
    assert.ok(texts('status').some((t) => /stored context is still on the model server/.test(t)));
    assert.equal(store.load('../../etc/passwd'), undefined); assert.equal(store.exists('../x'), false); assert.equal(store.delete('../../x'), false);
    ok('rename and delete work; deleting says where the stored context is; ids cannot escape the chats folder');
    await ctl.dispose(); await again.ctl.dispose();
    void of;
  });

  /* ---------- context cannot be stored: the chat still continues, from a recap ---------- */
  await withMock({ MOCK_SAVE_FAIL: '1' }, async (url, get) => {
    const proj = project();
    const { ctl, texts, last } = setup(proj, url);
    ctl.init();
    await ctl.ask('what does buildContext do'); await sleep(100);
    await ctl.ask('another question'); await sleep(100);
    assert.equal(texts('error').filter((t) => /Could not store this chat/.test(t)).length, 1, 'the problem is shown once, with advice');
    assert.ok(texts('error').some((t) => /Context folder on the server/.test(t)));
    const id = last('chats').activeId;
    await ctl.newChat(); await ctl.ask('x'); await ctl.openChat(id);
    const before = (await get('/_log')).length;
    await ctl.ask('carry on please');
    const mine = (await get('/_log')).slice(before);
    assert.deepEqual(mine[0].roles, ['system', 'user'], 'no stored context: the system prompt is sent again');
    assert.ok(texts('status').some((t) => /short recap of this chat/.test(t)));
    ok('when the context cannot be stored, the error says how to fix it (once), and the chat continues from a recap');
    await ctl.dispose();
  });

  /* ---------- the "never store" setting ---------- */
  await withMock({}, async (url, get) => {
    const proj = project(); const { ctl } = setup(proj, url, (s) => { s.chats.saveContext = 'never'; });
    ctl.init(); await ctl.ask('hello there'); await sleep(100);
    assert.equal(new ChatStore(proj).list()[0].contextSavedAt, undefined);
    ok('"Never (text only)" stores no context; the transcript is still saved');
    await ctl.dispose();
    void get;
  });
  await withMock({}, async (url) => {
    const proj = project(); const { ctl } = setup(proj, url, (s) => { s.chats.saveContext = 'whenLeaving'; });
    ctl.init(); await ctl.ask('hello there'); await sleep(100);
    assert.equal(new ChatStore(proj).list()[0].contextSavedAt, undefined, 'not after the answer');
    await ctl.newChat();
    assert.ok(new ChatStore(proj).list()[0].contextSavedAt, 'but when leaving');
    ok('"When I leave the chat" stores the context when you switch chats');
    await ctl.dispose();
  });

  /* ---------- MCP: config files ---------- */
  {
    const proj = project();
    fs.mkdirSync(path.join(proj, '.vscode'));
    fs.writeFileSync(path.join(proj, '.vscode/mcp.json'), JSON.stringify({ servers: { a: { command: 'x' }, shared: { command: 'old' } } }));
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { b: { url: 'http://x/mcp' }, shared: { command: 'mid' } } }));
    fs.mkdirSync(path.join(proj, '.bluecheese'));
    fs.writeFileSync(path.join(proj, '.bluecheese/mcp.json'), '{ not json');
    const c = loadMcpConfig(proj);
    assert.deepEqual(Object.keys(c.servers).sort(), ['a', 'b', 'shared']); assert.equal(c.servers.shared.config.command, 'mid');
    assert.ok(c.errors.some((e) => /\.bluecheese\/mcp\.json/.test(e)), 'a broken file is reported, not fatal');
    ok('MCP config: .vscode/mcp.json, .mcp.json and .bluecheese/mcp.json are all read (later wins); a broken file is reported');
  }

  /* ---------- MCP: a real server over stdio, through the controller ---------- */
  const mcpProject = () => {
    const proj = project();
    fs.mkdirSync(path.join(proj, '.bluecheese'));
    fs.writeFileSync(path.join(proj, '.bluecheese/mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FAKE] } } }));
    return proj;
  };
  await withMock({ MOCK_TOOL: 'fake__echo', MOCK_TOOL_ARGS: '{"text":"hi there"}' }, async (url, get) => {
    const proj = mcpProject();
    const confirmed: string[] = [];
    const { ctl, of, last, texts } = setup(proj, url, (s) => { s.mcp.enabled = true; }, { confirmMcpServer: async (n: string) => { confirmed.push(n); return true; } });
    ctl.init();
    assert.equal(last('tools').info.servers[0].status, 'off', 'listed before it is connected');
    await ctl.powerOn(); await (ctl as any).mcpReady;
    const info = last('tools').info;
    assert.equal(info.servers[0].status, 'ready'); assert.equal(info.servers[0].version, '1.2.3');
    const names = info.tools.map((t) => t.name);
    for (const n of ['diagnostics', 'list_files', 'find_files', 'grep', 'read_file', 'fake__echo', 'fake__danger', 'fake__big', 'fake__objarg']) assert.ok(names.includes(n), n);
    assert.ok(info.tools.find((t) => t.name === 'fake__echo')!.readOnly && !info.tools.find((t) => t.name === 'fake__danger')!.readOnly);
    assert.deepEqual(confirmed, ['fake']);
    ok('an MCP server over stdio is connected (stray stdout ignored) and its tools are listed beside the built-in ones');

    await ctl.ask('please echo');
    const turn = ctl.activeChat.turns[0];
    assert.equal(turn.state, 'done');
    assert.ok(turn.tools.some((t) => t.name === 'fake__echo' && t.source === 'fake' && /echo: hi there/.test(t.result ?? '')), JSON.stringify(turn.tools));
    assert.equal(of('approval').length, 0, 'a read-only tool runs without asking');
    const req = (await get('/_log'))[0];
    assert.deepEqual(req.roles, ['system', 'user']);
    assert.equal(last('tools').info.tools.find((t) => t.name === 'fake__echo')!.calls, 1, 'usage is counted per chat');
    ok('the model called an MCP tool; the result reached it; the call is in the transcript with its server; usage is counted');
    await ctl.dispose();
    void texts;
  });

  // approvals
  await withMock({ MOCK_TOOL: 'fake__danger', MOCK_TOOL_ARGS: '{"target":"x","force":"true"}' }, async (url) => {
    for (const decision of ['deny', 'once', 'always'] as const) {
      const proj = mcpProject(); const added: string[] = [];
      const { ctl, of } = setup(proj, url, (s) => { s.mcp.enabled = true; }, { confirmMcpServer: async () => true, addAutoApprove: (t: string) => added.push(t) });
      ctl.init(); await ctl.powerOn(); await (ctl as any).mcpReady;
      const q = ctl.ask('delete x');
      for (let i = 0; i < 300 && !of('approval').length; i++) await sleep(20);
      const ap = of('approval')[0];
      assert.ok(ap && ap.tool === 'fake__danger' && ap.server === 'fake' && !ap.readOnly, 'asks before a tool that is not read-only');
      ctl.answerApproval(ap.id, decision); await q;
      const res = ctl.activeChat.turns[0].tools[0]?.result ?? '';
      if (decision === 'deny') assert.match(res, /declined/); else assert.match(res, /deleted x force=true/);
      if (decision === 'always') {
        assert.deepEqual(added, ['fake__danger']);
        await ctl.newChat(); const n = of('approval').length; await ctl.ask('again');
        assert.equal(of('approval').length, n, 'always allow: not asked again');
      }
      assert.equal(of('approvalDone').length >= 1, true);
      await ctl.dispose();
    }
    ok('a tool that is not read-only asks first: Deny tells the model so, Allow once runs it, Always allow remembers it');
  });

  // Stop while waiting for an answer to the prompt
  await withMock({ MOCK_TOOL: 'fake__danger', MOCK_TOOL_ARGS: '{"target":"x"}' }, async (url) => {
    const { ctl, of } = setup(mcpProject(), url, (s) => { s.mcp.enabled = true; }, { confirmMcpServer: async () => true });
    ctl.init(); await ctl.powerOn(); await (ctl as any).mcpReady;
    const q = ctl.ask('delete x');
    for (let i = 0; i < 300 && !of('approval').length; i++) await sleep(20);
    ctl.stop(); await q;
    assert.ok(of('approvalDone').length === 1 && !ctl.isBusy);
    assert.equal(ctl.activeChat.turns[0].state, 'stopped');
    ok('Stop while a tool waits for approval cancels the prompt and ends the question');
    await ctl.dispose();
  });

  // approval 'never', disabled tools, budget
  await withMock({ MOCK_TOOL: 'fake__danger', MOCK_TOOL_ARGS: '{"target":"x"}' }, async (url, get) => {
    const { S, ctl, of, last } = setup(mcpProject(), url, (s) => { s.mcp.enabled = true; s.mcp.approval = 'never'; s.tools.disabled = ['fake__big']; s.mcp.promptBytes = 250; },
      { confirmMcpServer: async () => true });
    ctl.init(); await ctl.powerOn(); await (ctl as any).mcpReady;
    const t = last('tools').info.tools;
    assert.ok(t.find((x) => x.name === 'fake__big')!.enabled === false && !t.find((x) => x.name === 'fake__big')!.inPrompt);
    assert.ok(t.some((x) => x.source === 'mcp' && x.enabled && !x.inPrompt), 'a tool that does not fit the budget is enabled but not offered');
    assert.ok(last('tools').info.promptBytes < 4500);
    await ctl.ask('go');
    assert.equal(of('approval').length, 0); assert.match(ctl.activeChat.turns[0].tools[0].result ?? '', /deleted x/);
    const sys = (await get('/_log'))[0];
    assert.equal(sys.roles[0], 'system');
    ok('"Never ask" runs tools at once; a disabled tool is not offered; tools over the size budget are left out and marked');
    S.tools.disabled = ['fake__danger']; await ctl.newChat(); await ctl.ask('go again');
    assert.equal(ctl.activeChat.turns[0].tools.length, 0, 'a disabled tool the model still calls does not run'); assert.equal(ctl.activeChat.turns[0].state, 'done');
    ok('a tool that was turned off is refused at once if the model still calls it');
    await ctl.dispose();
  });

  // denied server
  await withMock({}, async (url) => {
    const { ctl, last } = setup(mcpProject(), url, (s) => { s.mcp.enabled = true; }, { confirmMcpServer: async () => false });
    ctl.init(); await ctl.powerOn(); await (ctl as any).mcpReady;
    assert.equal(last('tools').info.servers[0].status, 'denied');
    assert.ok(!last('tools').info.tools.some((t) => t.source === 'mcp'));
    ok('a server you do not allow is never started');
    await ctl.dispose();
    const { ctl: c2, last: l2 } = setup(mcpProject(), url, (s) => { s.mcp.enabled = true; });
    c2.init(); await c2.powerOn(); await (c2 as any).mcpReady;
    assert.equal(l2('tools').info.servers[0].status, 'denied', 'no way to ask = not started');
    ok('with no way to ask the person (no host callback), nothing is started');
    await c2.dispose();
  });


  /* ---------- writing files ---------- */
  {
    const proj = project(); const shown = new Map<string, [number, number][]>(); shown.set('src/index.ts', [[1, 1]]);
    const [write, edit] = makeEditTools(proj, { shown }).map((t) => t.run);
    assert.match(String(write({ path: 'src/new/deep/util.ts', content: 'export const a = 1;\nexport const b = 2;' })), /Created src\/new\/deep\/util\.ts \(2 lines\)/);
    assert.equal(fs.readFileSync(path.join(proj, 'src/new/deep/util.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\n', 'folders are created; a final newline is added');
    assert.match(String(write({ path: 'src/new/deep/util.ts', content: 'x' })), /Replaced/);
    assert.match(String(write({ path: 'src/new/deep/util.ts', content: 'y', append: true })), /Appended 1 line\(s\).*now 2 lines/);
    assert.equal(fs.readFileSync(path.join(proj, 'src/new/deep/util.ts'), 'utf8'), 'x\ny\n');
    assert.match(String(edit({ path: 'src/index.ts', old: 'return q.trim();', new: 'return q.trim().toLowerCase();' })), /Edited src\/index\.ts at line 1: 1 line\(s\) replaced by 1/);
    assert.ok(fs.readFileSync(path.join(proj, 'src/index.ts'), 'utf8').includes('toLowerCase'));
    assert.equal(shown.has('src/index.ts'), false, 'lines the model saw are forgotten after a change (numbers moved)');
    assert.match(String(edit({ path: 'src/index.ts', old: 'nope nope', new: 'x' })), /not found/);
    fs.writeFileSync(path.join(proj, 'dup.txt', ), 'a\na\n');
    assert.match(String(edit({ path: 'dup.txt', old: 'a', new: 'b' })), /occurs 3 times|occurs 2 times/);
    assert.match(String(edit({ path: 'dup.txt', old: '', new: 'b' })), /empty/);
    assert.match(String(edit({ path: 'missing.txt', old: 'a', new: 'b' })), /no such file/);
    fs.writeFileSync(path.join(proj, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    edit({ path: 'crlf.txt', old: 'one\ntwo', new: 'ONE\nTWO' });
    assert.equal(fs.readFileSync(path.join(proj, 'crlf.txt'), 'utf8'), 'ONE\r\nTWO\r\nthree\r\n', 'a file keeps its line endings');
    for (const bad of ['../outside.txt', '/etc/passwd', '.git/config', 'node_modules/x/index.js', '.bluecheese/mcp.json', 'src/', '']) {
      assert.match(String(write({ path: bad, content: 'x' })), /^Error/, `refused: ${bad}`);
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-out-')); fs.symlinkSync(outside, path.join(proj, 'link'));
    assert.match(String(write({ path: 'link/evil.txt', content: 'x' })), /^Error.*symlink/); assert.equal(fs.readdirSync(outside).length, 0);
    assert.match(String(write({ path: 'big.txt', content: 'x'.repeat(310_000) })), /over 300 KB/);
    ok('write_file / edit_file: create, replace, append, exact edit (unique match, CRLF kept); refuse paths outside the project, .git, node_modules, .bluecheese, symlink escapes');
  }

  /* ---------- small edits instead of rewrites ---------- */
  {
    const proj = project(); const shown = new Map<string, [number, number][]>();
    const [, , rl] = makeEditTools(proj, { shown }).map((t) => t.run);
    const f = path.join(proj, 'm.js'); const rd = () => fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, 'a\nb\nc\nd\ne\n'); shown.set('m.js', [[1, 5]]);
    assert.match(String(rl({ path: 'm.js', start: 2, end: 3, new: 'B\nC\nC2' })), /Replaced lines 2-3 of m\.js \(2 line\(s\) became 3\)\. Now:\n1: a\n2: B\n3: C\n4: C2\n5: d\n6: e/);
    assert.equal(rd(), 'a\nB\nC\nC2\nd\ne\n', 'trailing newline kept'); assert.equal(shown.has('m.js'), false);
    rl({ path: 'm.js', start: 1, end: 0, new: 'first' }); assert.equal(rd(), 'first\na\nB\nC\nC2\nd\ne\n', 'end = start - 1 inserts');
    rl({ path: 'm.js', start: 8, end: 7, new: 'last' }); assert.equal(rd(), 'first\na\nB\nC\nC2\nd\ne\nlast\n', 'start = lines + 1 appends');
    rl({ path: 'm.js', start: 2, end: 4, new: '' }); assert.equal(rd(), 'first\nC2\nd\ne\nlast\n', 'empty text deletes');
    assert.match(String(rl({ path: 'm.js', start: 0, end: 1, new: 'x' })), /^Error: start 0/); assert.match(String(rl({ path: 'm.js', start: 9, end: 9, new: 'x' })), /^Error: start 9/);
    assert.match(String(rl({ path: 'm.js', start: 2, end: 99, new: 'x' })), /^Error: end 99/); assert.match(String(rl({ path: 'm.js', start: 'a', end: 1, new: 'x' })), /^Error: start and end/);
    assert.match(String(rl({ path: '../x', start: 1, end: 1, new: 'x' })), /^Error/); assert.equal(rd(), 'first\nC2\nd\ne\nlast\n', 'a refused or invalid call changes nothing');
    fs.writeFileSync(f, 'one\r\ntwo\r\nthree\r\n'); rl({ path: 'm.js', start: 2, end: 2, new: 'TWO' }); assert.equal(rd(), 'one\r\nTWO\r\nthree\r\n', 'line endings kept');
    fs.writeFileSync(f, 'no trailing newline\nlast'); rl({ path: 'm.js', start: 2, end: 2, new: 'LAST' }); assert.equal(rd(), 'no trailing newline\nLAST', 'no newline is added where there was none');
    ok('replace_lines: replace, insert, append, delete by line numbers; shows the result; bounds are checked; line endings and the final newline are kept');

    const [, ed] = makeEditTools(proj).map((t) => t.run);
    fs.writeFileSync(f, 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n');
    const m1 = String(ed({ path: 'm.js', old: 'if (x) {\n  return 1;\n}', new: 'y' }));
    assert.match(m1, /not found.*exist at 2-4 but with different spacing or indentation.*2:     if \(x\) \{\n3:         return 1;\n4:     \}.*replace_lines\(start=2, end=4\)/s, m1);
    const m2 = String(ed({ path: 'm.js', old: 'return 2; // gone', new: 'y' })); assert.match(m2, /^Error: the old text was not found/); assert.match(m2, /Read the file again/);
    const m3 = String(ed({ path: 'm.js', old: 'function f(a) {', new: 'y' })); assert.match(m3, /closest text is near line 1:\n1: function f\(\) \{/, m3);
    ok('edit_file that does not match says why: same lines with other indentation (with the exact text and line numbers), or the closest text, so the next call is a small fix');
  }

  /* ---------- syntax checks and outlines: cheap feedback that points at the lines ---------- */
  {
    const bad = (f: string, src: string) => checkSource(f, src).issues;
    assert.deepEqual(bad('a.js', 'const a = 1;\nexport function f() { return a }\n'), [], 'ES module syntax is fine'); assert.deepEqual(bad('a.tsx', 'const x: number = 1; const e = <div>{x}</div>;'), []);
    const js = bad('a.js', 'const a = 1;\nfunction f( {\n  return a;\n}\n'); assert.ok(js.length && js[0].line >= 2 && js[0].line <= 3, JSON.stringify(js));
    const html = '<!DOCTYPE html>\n<html>\n<head>\n<style>\n body { color: red; }\n</style>\n</head>\n<body>\n<script>\nlet a = 1;\nfunction go() {\n  return a +;\n}\n</script>\n</body>\n</html>\n';
    const hi = bad('i.html', html); assert.equal(hi.length, 1); assert.equal(hi[0].line, 12, 'the line number is the line in the HTML file, not in the script: ' + JSON.stringify(hi));
    assert.deepEqual(bad('i.html', html.replace('+;', '+ 1;')), [], 'a good page has no issues');
    const cut = bad('i.html', html.split('</script>')[0] + 'let z = ['); assert.ok(cut.some((i) => /never closed.*cut off/.test(i.message)), JSON.stringify(cut));
    assert.ok(bad('i.html', '<html>\n<body>\n<p>hi</p>\n').some((i) => /ends before <\/html>/.test(i.message)));
    assert.ok(bad('s.css', 'a { color: red;\nb { }\n').some((i) => /never closed/.test(i.message)));
    assert.ok(bad('i.html', '<style>\na { color: red;\n</style>\n').some((i) => /CSS in <style>/.test(i.message)));
    const js2 = bad('d.json', '{\n  "a": 1,\n  "b": }\n'); assert.ok(js2.length && js2[0].line >= 1, JSON.stringify(js2)); assert.deepEqual(bad('d.json', '{"a": 1}'), []);
    assert.equal(checkSource('x.rs', 'fn main() {').checked, false, 'other file types are not checked');
    const py = checkSource('t.py', 'def f(:\n    pass\n');
    if (py.checked) { assert.equal(py.issues[0].line, 1); assert.deepEqual(checkSource('t.py', 'def f():\n    return 1\n').issues, []); } else console.log('  (python not installed here: Python check skipped)');
    const ol = outlineSource('m.ts', 'import x from "y";\nexport class A {\n  go(a: number) {\n    return a;\n  }\n}\nfunction helper() {\n  return 1;\n}\nconst arrow = () => 2;\n');
    assert.match(ol, /^10 lines\.\n\s+2-6  export class A \{\n\s+3-5    {0,2}go\(a: number\) \{\n\s+7-9  function helper\(\) \{\n\s+10-10  const arrow = \(\) => 2;/, ol);
    assert.match(outlineSource('t.py', 'import os\n\nclass A:\n    def f(self):\n        return 1\n\n    def g(self):\n        return 2\n\ndef top():\n    pass\n'), /3-8  class A\n\s+4-5\s+def f\(self\)\n\s+7-8\s+def g\(self\)\n\s+10-11  def top\(\)/);
    const oh = outlineSource('i.html', html); assert.match(oh, /4-6  <style>/); assert.match(oh, /9-14  <script>\n[\s\S]*11-13\s+function go\(\) \{/, oh);
    ok('syntax checks with the right line numbers (JS/TS/JSX, an inline <script> reported at its line in the HTML file, JSON, Python, CSS, truncated HTML); outlines of TS, Python and HTML with line ranges');
  }
  {
    const proj = project(); const tools = Object.fromEntries(makeTools(proj).map((t) => [t.spec.name, t.run])); const [write, edit, rl] = makeEditTools(proj).map((t) => t.run);
    const big = Array.from({ length: 70 }, (_, i) => `function f${i}() { return ${i}; }`).join('\n');
    const r1 = String(write({ path: 'src/big.js', content: big })); assert.match(r1, /Created src\/big\.js \(70 lines\)\.\nSyntax check: OK \(JavaScript\)\.\nOutline \(line numbers for read_file \/ replace_lines\):\n70 lines\.\n\s+1-1  function f0\(\)/, r1);
    const r2 = String(write({ path: 'src/bad.js', content: 'const a = 1;\nfunction f( {\n  return a;\n}\n' })); assert.match(r2, /Syntax check found \d+ problem\(s\) in JavaScript:\n  line [23]:\d+: .*\n    .*\n[\s\S]*Fix only these lines.*Do not rewrite or re-read the whole file\./, r2);
    assert.ok(!/Outline/.test(r2), 'no outline for a broken file: fix it first');
    const r3 = String(rl({ path: 'src/bad.js', start: 2, end: 2, new: 'function f() {' })); assert.match(r3, /Syntax check: OK/, 'after the fix the check says so: ' + r3);
    assert.match(String(edit({ path: 'src/bad.js', old: 'return a;', new: 'return a +;' })), /Syntax check found \d+ problem/, 'edits are checked too');
    assert.doesNotMatch(String(write({ path: 'src/part.js', content: 'function f() {\n  return 1;\n', partial: true })), /Syntax check/, 'a cut-off part is not checked: it is not finished');
    assert.match(String(write({ path: 'src/part.js', content: '}\n', append: true })), /When the whole file is written, call check_file\./);
    assert.match(String(tools.check_file({ path: 'src/part.js' })), /Syntax check: OK \(JavaScript\)\. The checker finds syntax errors only/);
    assert.match(String(tools.check_file({ path: 'src/bad.js' })), /problem\(s\)/); assert.match(String(tools.check_file({ path: 'nope.js' })), /no such file/); assert.match(String(tools.check_file({ path: '../x' })), /outside the project/);
    write({ path: 'notes.rs', content: 'fn main() {' }); assert.match(String(tools.check_file({ path: 'notes.rs' })), /not available for this kind of file/);
    assert.doesNotMatch(String(write({ path: 'notes2.rs', content: 'fn main() {}' })), /Syntax/, 'unknown types add nothing');
    assert.match(String(tools.outline({ path: 'src/big.js' })), /^src\/big\.js: 70 lines\./); assert.match(String(tools.outline({ path: '../x' })), /outside/);
    ok('every change is followed by a syntax check (and an outline for a new big file); a broken file says which lines and not to rewrite; a cut-off part is not checked until finished; check_file and outline tools work');
  }

  // a call whose code has unescaped quotes is not silently cut short
  {
    const { makeEditTools: mk } = await import('../src/index.js');
    const specs = mk(project()).map((t) => t.spec);
    const broken = '<tool_call>{"name": "write_file", "arguments": {"path": "a.js", "content": "const s = "hi";\\nconsole.log("x", s);\\n"}}</tool_call>';
    const r = parseToolCalls(broken, specs);
    assert.deepEqual(r.errors, []); assert.deepEqual(r.calls[0].args, { path: 'a.js', content: 'const s = "hi";\nconsole.log("x", s);\n' }, 'inner quotes stay in the text; nothing is cut off');
    const ok1 = parseToolCalls('<tool_call>{"name": "write_file", "arguments": {"path": "a.js", "content": "x = \\"q\\";\\n"}}</tool_call>', specs);
    assert.equal(ok1.calls[0].args.content, 'x = "q";\n', 'valid JSON is untouched');
    const w = mk(project())[0]; const sv = w.salvage!(broken.replace('</tool_call>', '').replace('}}', '') );
    assert.ok(sv && sv.args.content === 'const s = "hi";\nconsole.log("x", s);\n' && /nothing needs to be sent again/.test(sv.note), JSON.stringify(sv));
    ok('unescaped quotes in code no longer cut the content short; a call with a broken format is recovered and written as it was, with a note that nothing needs to be sent again');
  }

  // code goes in raw with the XML call style: no JSON escaping needed
  {
    const [w] = makeEditTools(project()).map((t) => t.spec);
    const code = 'function f(a) {\n  return "quoted" + \'x\' + a; // \\n kept\n}';
    const r = parseToolCalls(`<tool_call><function=write_file><parameter=path>src/f.js</parameter><parameter=content>\n${code}\n</parameter></function></tool_call>`, [w]);
    assert.deepEqual(r.errors, []); assert.equal(r.calls[0].args.path, 'src/f.js'); assert.equal(r.calls[0].args.content, code);
    ok('multi-line code with quotes and backslashes arrives intact in the XML call style');
  }


  // small models get parameter names and formats wrong: accept the usual variants, and teach when it still fails
  {
    const { makeTools } = await import('../src/index.js');
    const specs = makeTools('.').map((t) => t.spec);
    const one = (t: string) => parseToolCalls(t, specs);
    for (const t of ['{"name":"read_file","arguments":{"file":"tetris.py"}}', '{"name":"read_file","arguments":{"file_path":"tetris.py"}}', '{"name":"read_file","arguments":{"filename":"tetris.py","start":1}}',
      '{"name":"read_file","arguments":{"tetris":"tetris.py"}}', 'read_file(tetris.py)', "read_file('tetris.py')", '<function=read_file><parameter=file>tetris.py</parameter></function>']) {
      const r = one(`<tool_call>${t}</tool_call>`);
      assert.equal(r.calls[0]?.args.path, 'tetris.py', `${t} -> ${JSON.stringify(r)}`);
    }
    const bad = one('<tool_call>{"name":"read_file","arguments":{}}</tool_call>');
    assert.match(bad.errors[0], /missing argument\(s\): path\. You sent \{\}\. Write it like this: <tool_call>\{"name":"read_file","arguments":\{"path":"<path>"\}\}<\/tool_call>/, bad.errors[0]);
    assert.deepEqual(one('<tool_call>{"name":"grep","arguments":{"query":"x"}}</tool_call>').calls[0].args, { pattern: 'x' });
    ok('a wrong parameter name (file, file_path, a stray key), a bare read_file(x) and the XML style with a wrong name are all understood; a still-wrong call gets what it sent and an example back');
  }

  // the model garbles the tag sometimes (<tooltool_call>): still a call; and the prompt shows ONE format only
  {
    const { makeTools, makeEditTools } = await import('../src/index.js');
    const { renderToolInstructions } = await import('@bluecheese/agent');
    const specs = [...makeTools('.'), ...makeEditTools('.')].map((t) => t.spec);
    for (const t of ['<tooltool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tooltool_call>', '<tool-call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool-call>',
      '<toolcall>{"name":"read_file","arguments":{"path":"a.ts"}}', '<tooltool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>']) {
      const r = parseToolCalls(t, specs); assert.deepEqual(r.errors, [], t); assert.equal(r.calls[0]?.args.path, 'a.ts', t);
    }
    const w = makeEditTools(project())[0];
    const k = w.salvage!('<tooltool_call>{"name": "write_file", "arguments": {"path": "index.html", "content": "<!DOCTYPE html>\\n<html>\\n<head>\\n<sty');
    assert.deepEqual(k!.args, { path: 'index.html', content: '<!DOCTYPE html>\n<html>\n<head>\n', append: false, partial: true }, 'a cut-off call with the garbled tag is salvaged too');
    const prompt = renderToolInstructions(specs);
    assert.ok(!/<function=|<parameter=/.test(prompt), 'the prompt advertises only the JSON format');
    ok('a garbled tool-call tag (<tooltool_call>, <tool-call>, <toolcall>) is still a call, also when cut off; the prompt shows a single format');
  }

  /* ---------- searching the chat (also what slid out of the context) ---------- */
  {
    const proj = project(); const store = new ChatStore(proj);
    const mk = (title: string, turns: [string, string, string?][]): ChatRecord => {
      const c = store.create(); c.title = title;
      c.turns = turns.map(([q, a, res], i) => ({ id: `t${i}`, at: i, q, a, state: 'done' as const, tools: res ? [{ name: 'read_file', args: { path: 'src/db.ts' }, ms: 1, source: 'builtin', result: res }] : [] }));
      return c;
    };
    const old = mk('Database work', [['how do we connect to postgres', 'Use the pool in src/db.ts', 'const pool = new Pool({ max: 20, connectionTimeoutMillis: 4000 })'], ['and the weather?', 'no idea'], ['tell me a story', 'once upon a time']]);
    const other = mk('Other chat', [['kubernetes ingress question', 'use nginx']]); other.updatedAt = Date.now() + 1;
    old.turns.push({ id: 'now', at: 9, q: 'what was the connection timeout we saw earlier', a: '', state: 'stopped', tools: [] });
    store.save(old); store.save(other);
    const [search, readTurn] = makeChatTools(() => ({ chat: old, skipTurn: 'now' }), store, 1200).map((t) => t.run);
    const r1 = String(search({ query: 'connection timeout' }));
    assert.match(r1, /turn 1 · read_file\(.*\) result\] .*connectionTimeoutMillis: 4000/, r1);
    assert.ok(!/what was the connection timeout/.test(r1), 'the question being asked right now is not a hit');
    assert.match(String(search({ query: 'kubernetes' })), /nothing found/); assert.match(String(search({ query: 'kubernetes', all_chats: true })), /chat "Other chat" · turn 1 · you/);
    assert.match(String(search({ query: '!' })), /Error/);
    const t1 = String(readTurn({ turn: 1 })); assert.match(t1, /Turn 1\nYou: how do we connect to postgres\nTools used:\n- read_file\(.*\) → const pool.*\nAnswer: Use the pool in src\/db\.ts/);
    assert.match(String(readTurn({ turn: 4 })), /no turn 4/);
    old.turns[0].a = 'z'.repeat(3000); const cut = String(readTurn({ turn: 1 })); assert.match(cut, /Continue: read_turn\(turn=1, offset=\d+\)/);
    assert.ok(String(readTurn({ turn: 1, offset: Number(/offset=(\d+)/.exec(cut)![1]) })).includes('zzz'));
    ok('search_chat finds text in old questions, answers and tool results (skipping the question being asked); all_chats looks in other chats; read_turn reads a turn and continues with an offset');
  }

  /* ---------- the model writes a file, through the controller ---------- */
  await withMock({ MOCK_TOOL: 'write_file', MOCK_TOOL_ARGS: JSON.stringify({ path: 'src/hello.ts', content: 'export const hello = "hi";' }) }, async (url) => {
    for (const decision of ['deny', 'once', 'always'] as const) {
      const proj = project(); const added: string[] = [];
      const { ctl, of } = setup(proj, url, () => {}, { addAutoApprove: (t: string) => added.push(t) });
      ctl.init();
      const q = ctl.ask('create a hello file');
      for (let i = 0; i < 300 && !of('approval').length; i++) await sleep(20);
      const ap = of('approval')[0];
      assert.ok(ap && ap.tool === 'write_file' && ap.server === '' && !ap.readOnly && (ap.args as any).path === 'src/hello.ts', 'asks before changing files');
      assert.equal(fs.existsSync(path.join(proj, 'src/hello.ts')), false, 'nothing is written before the answer');
      ctl.answerApproval(ap.id, decision); await q;
      assert.equal(fs.existsSync(path.join(proj, 'src/hello.ts')), decision !== 'deny');
      if (decision !== 'deny') assert.equal(fs.readFileSync(path.join(proj, 'src/hello.ts'), 'utf8'), 'export const hello = "hi";\n');
      else assert.match(ctl.activeChat.turns[0].tools[0].result ?? '', /declined/);
      if (decision === 'always') { assert.deepEqual(added, ['write_file']); fs.rmSync(path.join(proj, 'src/hello.ts')); await ctl.newChat(); const n = of('approval').length; await ctl.ask('again'); assert.equal(of('approval').length, n); assert.ok(fs.existsSync(path.join(proj, 'src/hello.ts'))); }
      await ctl.dispose();
    }
    ok('write_file through the controller: the person is asked first (Deny writes nothing, Allow once writes, Always allow is remembered)');
    const proj = project(); const { ctl, of } = setup(proj, url, (s) => { s.edits.approval = 'never'; });
    ctl.init(); await ctl.ask('create a hello file');
    assert.equal(of('approval').length, 0); assert.ok(fs.existsSync(path.join(proj, 'src/hello.ts')));
    ok('"Never ask" lets the model write without a prompt');
    const t = (ctl as any).plan().find((p: any) => p.spec.name === 'write_file'); assert.equal(t.readOnly, false);
    await ctl.dispose();
  });


  // a tool call cut off by the reply limit: the complete lines that were written are kept (after the usual approval), and the model is told where to continue
  for (const cut of ['1', 'hybrid']) await withMock({ MOCK_TOOL: 'write_file', MOCK_CUT: cut }, async (url) => {
    for (const mode of ['never', 'ask'] as const) {
      const proj = project(); const { ctl, of } = setup(proj, url, (s) => { s.edits.approval = mode; s.maxTokens = 600; });
      ctl.init();
      const q = ctl.ask('write a big file');
      if (mode === 'ask') {
        for (let i = 0; i < 300 && !of('approval').length; i++) await sleep(20);
        const ap = of('approval')[0];
        assert.ok(ap && (ap.args as any).path === 'big.py' && (ap.args as any).content === 'def f():\n    return 1\n', 'the card shows exactly the part that will be written');
        ctl.answerApproval(ap.id, 'once');
      }
      await q;
      assert.equal(fs.readFileSync(path.join(proj, 'big.py'), 'utf8'), 'def f():\n    return 1\n', 'the lines that arrived are written');
      const res = ctl.activeChat.turns[0].tools[0].result ?? '';
      assert.match(res, /Created big\.py \(2 lines\)/); assert.match(res, /hit the 600-token limit.*only the first 2 line\(s\) were written.*last written line is: "return 1".*Do NOT start over.*append=true.*under about 40 lines/s, res);
    }
    ok('a write_file cut off by the token limit keeps the complete lines that arrived (the approval card shows them) and tells the model where to continue with append (' + (cut === 'hybrid' ? '<tool_call> + <function=…>{json}' : 'JSON') + ' style)');
  });
  {
    const { makeEditTools } = await import('../src/index.js');
    const [w, e] = makeEditTools(project());
    assert.equal(w.salvage!('<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "no newline yet'), undefined, 'not even one complete line: nothing is written');
    assert.equal(w.salvage!('<tool_call>{"name": "write_file", "arguments": {"path": "a.p'), undefined, 'a cut-off path is never used');
    const s = w.salvage!('<function=write_file>{"arguments": {"path": "i.html", "append": true, "content": "<a href=\\"x\\">\\n  <b>t\\u00e9st</b>\\n  <i>cut'); 
    assert.deepEqual(s!.args, { path: 'i.html', content: '<a href="x">\n  <b>tést</b>\n', append: true, partial: true }, 'escapes undone, cut at the last complete line, append kept');
    const x = w.salvage!('<tool_call><function=write_file><parameter=path>x.js</parameter><parameter=content>\nconst a = 1;\nconst b = 2;\nconst c');
    assert.deepEqual(x!.args, { path: 'x.js', content: 'const a = 1;\nconst b = 2;\n', append: false, partial: true }, 'the XML style works too');
    assert.equal(e.salvage, undefined, 'edit_file is never half-applied');
    ok('salvage: escapes are undone, the cut is at the last complete line, a cut-off path or a first partial line is never written, edit_file is never half-applied');
  }
  {
    const { makeTools } = await import('../src/index.js');
    const { makeEditTools } = await import('../src/index.js');
    const specs = [...makeTools('.'), ...makeEditTools('.')].map((t) => t.spec);
    for (const t of ['<function=write_file>{"arguments": {"path": "a.html", "content": "<p>\\n</p>"}}</function>', '<tool_call><function=write_file>{"path": "a.html", "content": "<p>\\n</p>"}</function></tool_call>',
      '<function=write_file>\n{"name": "write_file", "arguments": {"path": "a.html", "content": "<p>\\n</p>"}}']) {
      const r = parseToolCalls(t, specs);
      assert.deepEqual(r.errors, [], t); assert.equal(r.calls[0]?.name, 'write_file'); assert.deepEqual(r.calls[0].args, { path: 'a.html', content: '<p>\n</p>' }, t);
    }
    ok('the mixed style the model wrote (<function=NAME>{json}, with or without the <tool_call> wrapper) is understood');
  }

  /* ---------- the system prompt's KV cache, reused by new chats ---------- */
  await withMock({ MOCK_TOOL: 'grep', MOCK_TOOL_ARGS: '{"pattern":"buildContext"}' }, async (url, get) => {
    const proj = project(); const mk = (patch: (s: ControllerSettings) => void = () => {}) => setup(proj, url, (s) => { s.chats.reuseSystemPrompt = true; patch(s); });
    const reqs = async (from: number) => (await get('/_log')).slice(from) as { session: string; roles: string[]; max_tokens: number }[];
    const A = mk(); A.ctl.init();
    let n = (await get('/_log')).length;
    await A.ctl.ask('first question');
    let r = await reqs(n);
    assert.deepEqual(r.map((x) => x.roles.join('+')), ['system+user', 'user', 'user'].slice(0, 3).filter((_, i) => i < r.length), JSON.stringify(r));
    assert.equal(r[0].max_tokens, 1, 'the first new chat sends the system prompt alone, with a one-token reply');
    assert.ok(r.slice(1).every((x) => x.roles.join() === 'user'), 'the question and its tool step carry no system prompt: it is already in the context');
    assert.ok(A.texts('status').some((t) => /Reading the system prompt once and caching it/.test(t)));
    assert.ok(A.ctl.activeChat.turns[0].tools.some((t) => t.name === 'grep'), 'tools work the same in a primed chat');
    assert.equal(A.texts('error').length, 0);
    ok('the first new chat reads the system prompt once (system alone, 1-token reply), stores its KV cache, and the question follows without the prompt');

    await sleep(100); await A.ctl.newChat();
    n = (await get('/_log')).length;
    await A.ctl.ask('second chat question');
    r = await reqs(n);
    assert.ok(r.every((x) => x.roles.join() === 'user' && x.max_tokens !== 1), 'the second new chat does not read the system prompt again: ' + JSON.stringify(r));
    assert.ok(A.texts('status').some((t) => /Reused the cached system prompt/.test(t)));
    assert.ok(A.ctl.activeChat.turns[0].tools.some((t) => t.name === 'grep'));
    ok('the next new chat restores the stored cache: no system prompt, no priming, tools still work');

    await A.ctl.dispose();
    const B = mk(); B.ctl.init(); await B.ctl.newChat(); n = (await get('/_log')).length;
    await B.ctl.ask('after a restart');
    r = await reqs(n);
    assert.ok(r.every((x) => x.roles.join() === 'user' && x.max_tokens !== 1) && B.texts('status').some((t) => /Reused the cached system prompt/.test(t)));
    ok('it survives a restart of BlueCheese (the cache lives on the server)');
    await B.ctl.dispose();

    // a different tool list = a different prompt = a different cache
    const C = mk((s) => { s.tools.disabled = ['grep']; }); C.ctl.init(); await C.ctl.newChat(); n = (await get('/_log')).length;
    await C.ctl.ask('with fewer tools');
    r = await reqs(n); assert.equal(r[0].max_tokens, 1, 'a changed prompt is primed again'); assert.ok(C.texts('status').some((t) => /Reading the system prompt once/.test(t)));
    ok('changing the tools or the prompt makes a new cache (the old one is never reused for a different prompt)');
    await C.ctl.dispose();

    // the old way when switched off or when the context is not stored
    for (const patch of [(s: ControllerSettings) => { s.chats.reuseSystemPrompt = false; }, (s: ControllerSettings) => { s.chats.saveContext = 'never'; }]) {
      const D = mk(patch); D.ctl.init(); await D.ctl.newChat(); n = (await get('/_log')).length;
      await D.ctl.ask('plain');
      r = await reqs(n); assert.equal(r[0].roles.join('+'), 'system+user'); assert.notEqual(r[0].max_tokens, 1);
      await D.ctl.dispose();
    }
    ok('switched off (or with "Never" for the context), the system prompt goes with the first question as before');
  });
  await withMock({ MOCK_SAVE_FAIL: '1' }, async (url, get) => {
    const proj = project(); const A = setup(proj, url, (s) => { s.chats.reuseSystemPrompt = true; });
    A.ctl.init(); await A.ctl.ask('hello'); await sleep(50); await A.ctl.newChat();
    const n = (await get('/_log')).length; await A.ctl.ask('again');
    const r = ((await get('/_log')).slice(n)) as { roles: string[]; max_tokens: number }[];
    assert.ok(A.texts('status').some((t) => /could not be stored for other chats/.test(t)), A.texts('status').join(' | '));
    assert.equal(A.ctl.activeChat.turns[0].state, 'done');
    assert.equal(r.filter((x) => x.max_tokens === 1).length, 0, 'after one failure it does not try to cache again this session (no repeated priming)');
    assert.equal(r[0].roles.join('+'), 'system+user', 'and falls back to sending the prompt with the question');
    ok('if the cache cannot be stored, the chat still works, it says so once, and later chats go back to the normal way');
    await A.ctl.dispose();
  });

  /* ---------- MCP over HTTP, plain JSON and SSE replies ---------- */
  for (const sse of [false, true]) {
    let session = 0; const seenHeaders: http.IncomingHttpHeaders[] = [];
    const srv = http.createServer(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c;
      if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
      seenHeaders.push(req.headers);
      const m = JSON.parse(raw);
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      let result: any;
      if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'web', version: '9' } };
      else if (m.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
      else result = { content: [{ type: 'text', text: 'pong' }] };
      const body = JSON.stringify({ jsonrpc: '2.0', id: m.id, result });
      const h: Record<string, string> = { 'Mcp-Session-Id': 'S' + (++session > 0 ? 1 : 0) };
      if (sse) { res.writeHead(200, { ...h, 'Content-Type': 'text/event-stream' }); res.end(`event: message\ndata: ${body}\n\n`); }
      else { res.writeHead(200, { ...h, 'Content-Type': 'application/json' }); res.end(body); }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const proj = project(); fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { web: { url: `http://127.0.0.1:${(srv.address() as any).port}/mcp`, headers: { Authorization: 'Bearer ${env:BC_TEST_TOKEN}' } } } }));
    process.env.BC_TEST_TOKEN = 'tok';
    const hub = new McpHub({ root: proj, confirm: async () => true });
    await hub.start();
    const sv = hub.servers[0];
    assert.equal(sv.status, 'ready', sv.error); assert.equal(sv.transport, 'http'); assert.equal(sv.tools[0].fullName, 'web__ping');
    assert.equal(await hub.call(sv.tools[0], {}), 'pong');
    assert.equal(seenHeaders.at(-1)!['mcp-session-id'], 'S1', 'the session id is sent back'); assert.equal(seenHeaders.at(-1)!.authorization, 'Bearer tok', '${env:…} is expanded in headers');
    await hub.stop(); srv.close();
    ok(`MCP over Streamable HTTP (${sse ? 'SSE' : 'JSON'} replies): connects, lists, calls; session id and headers are sent`);
  }

  /* ---------- MCP client details ---------- */
  {
    const proj = mcpProject(); const hub = new McpHub({ root: proj, confirm: async () => true });
    await hub.start();
    const [echo, , big, objarg] = hub.servers[0].tools;
    assert.equal((await hub.call(big, {})).length, 5000);
    assert.equal(await hub.call(objarg, { list: '[1,2,3]' }), 'list is array of 3');
    const ac = new AbortController(); ac.abort();
    await assert.rejects(hub.call(echo, { text: 'x' }, ac.signal), /cancelled/);
    ok('array/object arguments given as JSON text are turned back into JSON; a cancelled call is cancelled');
    await hub.stop();
    const bad = project(); fs.writeFileSync(path.join(bad, '.mcp.json'), JSON.stringify({ mcpServers: { nope: { command: 'definitely-not-a-command-xyz' } } }));
    const h2 = new McpHub({ root: bad, confirm: async () => true }); await h2.start();
    assert.equal(h2.servers[0].status, 'error'); assert.match(h2.servers[0].error ?? '', /command not found/);
    ok('a server that cannot start is reported with the reason and does not stop anything else');
    await h2.stop();
  }

  console.log('\nall chats / MCP checks passed');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
