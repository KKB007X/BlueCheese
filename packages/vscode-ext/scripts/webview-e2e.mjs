/**
 * No real VS Code needed: loads the BUNDLED extension (dist/extension.js) against a fake `vscode` module, shows the real
 * media/chat.html in jsdom, connects it to a mock Roaster API and clicks through the settings.
 *
 *   pnpm --filter bluecheese-vscode build
 *   pnpm add -Dw jsdom            # test-only dependency (not in package.json by default)
 *   node packages/vscode-ext/scripts/webview-e2e.mjs
 *
 * (JSDOM_FROM=/some/dir makes it look for jsdom there instead.)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, '..');
const repo = path.resolve(extDir, '../..');
const { JSDOM } = createRequire(process.env.JSDOM_FROM ? path.join(process.env.JSDOM_FROM, 'x.js') : import.meta.url)('jsdom');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (name) => console.log(`  ok  ${name}`);
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));
const defaults = Object.fromEntries(Object.entries(manifest.contributes.configuration.properties).map(([k, v]) => [k.replace(/^bluecheese\./, ''), v.default]));

/* ---------- a tiny project and a mock Roaster ---------- */
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-e2e-'));
fs.mkdirSync(path.join(proj, 'src'));
fs.writeFileSync(path.join(proj, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext"},"include":["src"]}');
fs.writeFileSync(path.join(proj, 'src/index.ts'), 'export function buildContext(q: string): string { return q.trim(); }\n');
fs.mkdirSync(path.join(proj, '.bluecheese'));
fs.writeFileSync(path.join(proj, '.bluecheese/mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [path.join(repo, 'packages/core/scripts/fake-mcp-server.mjs')] } } }));
const PORT = 18890;
const mock = spawn(process.execPath, ['--import', 'tsx', path.join(repo, 'packages/agent/scripts/mock-server.ts'), String(PORT)],
  { cwd: repo, env: { ...process.env, MOCK_SLOW_MS: '40', MOCK_EXPLORE: '1' }, stdio: 'ignore' });
const url = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not up */ } await sleep(100); }
const get = async (p) => (await fetch(url + p)).json();

/* ---------- fake `vscode` ---------- */
const overrides = { baseUrl: url, autoStart: false };
const listeners = [];
let provider;
const commands = {};
const vscodeFake = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: (_id, p) => { provider = p; return { dispose() {} }; },
    activeTextEditor: undefined, showInformationMessage: async () => {}, showWarningMessage: async (_m, _o, ...items) => items[0], showTextDocument: async () => {}, showErrorMessage: async () => {},
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: proj } }], isTrusted: true,
    getConfiguration: () => ({
      get: (k) => (k in overrides ? overrides[k] : defaults[k]),
      update: async (k, v) => { overrides[k] = v; for (const l of listeners) l({ affectsConfiguration: () => true }); },
    }),
    onDidChangeConfiguration: (fn) => { listeners.push(fn); return { dispose() {} }; },
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }), onDidSaveTextDocument: () => ({ dispose() {} }),
  },
  ConfigurationTarget: { Global: 1 }, StatusBarAlignment: { Left: 1 },
  Uri: { file: (f) => ({ fsPath: f }) },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeFake : origLoad.call(this, request, ...rest); };
const ext = createRequire(import.meta.url)(path.join(extDir, 'dist/extension.js'));
Module._load = origLoad;
const store = new Map();
ext.activate({ subscriptions: [], extensionPath: extDir, globalState: { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); } } });

/* ---------- the webview in jsdom, wired to the extension host ---------- */
let htmlSet = '', onMsg;
const toWeb = [];
let win;
provider.resolveWebviewView({
  webview: {
    set html(h) { htmlSet = h; }, get html() { return htmlSet; }, cspSource: 'vscode-webview:', options: {},
    postMessage: async (m) => { toWeb.push(m); win?.dispatchEvent(new win.MessageEvent('message', { data: m })); },
    onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
  },
  onDidDispose: () => {},
});
const dom = new JSDOM(htmlSet, { runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { win = w; w.acquireVsCodeApi = () => ({ postMessage: (m) => { void onMsg(m); } }); } });
const doc = dom.window.document, $ = (id) => doc.getElementById(id);
await sleep(100);
const change = (el) => el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const fieldOf = (label) => [...doc.querySelectorAll('#fields .field')].find((f) => f.querySelector('label').textContent === label);

async function run() {
  /* ----- the settings list ----- */
  const fields = [...doc.querySelectorAll('#fields .field')];
  const hidden = Object.entries(manifest.contributes.configuration.properties).filter(([, v]) => v['x-panel'] === false).map(([k]) => k.replace(/^bluecheese\./, ''));
  assert.deepEqual(hidden.sort(), ['helpers.slots'].filter(() => false).concat(['mcp.autoApprove', 'slots', 'think', 'tools.disabled']).sort());
  assert.equal(fields.length, Object.keys(defaults).length - hidden.length, 'every setting is listed except Think, Slots and the two lists the Tools view manages');
  assert.ok(!fieldOf('Thinking'), 'Think is not in the list');
  assert.ok(!fieldOf('Slots to use'), 'Slots is not duplicated in the list');
  // the header is just a status dot, the state and the gear: no switch, API address, slots or project path
  const top = $('top');
  assert.ok(top.contains($('powerState')) && top.contains($('gear')) && top.contains($('statusDot')));
  for (const id of ['power', 'powerDetail', 'slots', 'project']) assert.ok(!top.contains($(id)) && $('connection').contains($(id)), `${id} lives in Settings → Connection, not the header`);
  assert.ok(!$('quick').classList.contains('hidden') && $('quick').textContent === 'Connect', 'when off, a small Connect button shows in the header');
  ok('header is a status dot, the state and the gear; the switch, API address, slots and project folder are in Settings');
  assert.equal(doc.querySelectorAll('#fields input[type=range]').length, 4, 'sliders only for temperature, top-p and the two routing fractions');
  assert.ok(fields.every((f) => f.querySelector('.badge')), 'every setting says when it applies');
  assert.deepEqual([...new Set([...doc.querySelectorAll('.badge')].map((b) => b.textContent))].sort(), ['applies now', 'needs restart', 'next conversation', 'next question']);
  ok(`${fields.length} settings listed, 4 sliders, each with an "applies" tag; Think is not among them`);

  const restartLabels = [...doc.querySelectorAll('.badge.restart')].map((b) => b.closest('.field').querySelector('label').textContent).sort();
  assert.deepEqual(restartLabels, ['API max tokens', 'Docker image', 'First API port', 'Max API containers', 'Project folder', 'Socket folder', 'Use existing API at']);
  ok('only Docker / connection settings need a restart');

  /* ----- unlimited ----- */
  const steps = fieldOf('Max tool steps');
  const cb = steps.querySelector('.special input'), num = steps.querySelector('input[type=number]');
  assert.equal(num.value, '8'); assert.ok(!cb.checked);
  cb.checked = true; change(cb); await sleep(20);
  assert.equal(overrides.maxSteps, -1); assert.ok(num.classList.contains('hidden'));
  cb.checked = false; change(cb); await sleep(20);
  assert.equal(overrides.maxSteps, 8, 'leaving Unlimited brings the old number back');
  num.value = '12'; change(num); await sleep(20); assert.equal(overrides.maxSteps, 12);
  cb.checked = true; change(cb); cb.checked = false; change(cb); await sleep(20);
  assert.equal(overrides.maxSteps, 12, 'it remembers the last number you typed');
  for (const label of ['Helper tool steps', 'Reply token limit']) {
    const f = fieldOf(label), c = f.querySelector('.special input');
    assert.ok(c, `${label} has an Unlimited option`);
    c.checked = true; change(c); await sleep(10);
  }
  assert.equal(overrides['helpers.maxSteps'], -1); assert.equal(overrides.answerTokens, -1);
  ok('Max tool steps, Helper tool steps and Reply token limit have Unlimited (-1), remember the last number');

  /* ----- helper branches: same as slots by default ----- */
  const br = fieldOf('Helper branches per call'), sel = br.querySelector('select');
  assert.equal(overrides['helpers.branches'], undefined, 'not set by the user');
  assert.equal(sel.value, '0'); assert.deepEqual([...sel.options].map((o) => o.textContent), ['Number', 'Same as slots', 'Unlimited']);
  assert.ok(br.querySelector('input[type=number]').classList.contains('hidden'));
  sel.value = '-1'; change(sel); await sleep(20); assert.equal(overrides['helpers.branches'], -1);
  sel.value = 'num'; change(sel); await sleep(20); assert.equal(overrides['helpers.branches'], 4);
  sel.value = '0'; change(sel); await sleep(20); assert.equal(overrides['helpers.branches'], 0);
  ok('Helper branches default to "Same as slots"; Number / Unlimited work');

  const idle = fieldOf('Stop API when idle (min)');
  assert.equal(idle.querySelector('.special span').textContent, 'Never');
  ok('"Stop API when idle" shows Never (0) as a checkbox');

  /* ----- the Think toggle next to the chat box ----- */
  assert.equal($('toolbar').nextElementSibling.id, 'inputRow', 'Think sits directly above the chat box');
  const think = $('think');
  think.checked = true; change(think); await sleep(20);
  assert.equal(overrides.think, true);
  assert.ok(/slower/.test($('thinkHint').textContent));
  overrides.think = false; for (const l of listeners) l({ affectsConfiguration: () => true }); await sleep(20);
  assert.equal(think.checked, false, 'changing Think in VS Code settings moves the toggle');
  ok('Think toggle sits above the chat box, writes the setting, follows changes made elsewhere');

  /* ----- connect, then change settings: no restart ----- */
  const power = $('power'); power.checked = true; change(power);
  for (let i = 0; i < 100 && $('powerState').textContent !== 'On'; i++) await sleep(50);
  assert.equal($('powerState').textContent, 'On');
  assert.ok($('quick').classList.contains('hidden'), 'no Connect button once connected');

  const ctxNum = fieldOf('Context length').querySelector('input[type=number]');
  ctxNum.value = '12288'; change(ctxNum); await sleep(20);
  assert.ok($('restartBar').classList.contains('hidden'), 'no restart bar for the context window');
  const port = fieldOf('First API port').querySelector('input[type=number]');
  port.value = '9090'; change(port); await sleep(20);
  assert.ok(!$('restartBar').classList.contains('hidden'), 'a Docker setting does ask for a restart');
  port.value = '8080'; change(port); $('restartBar').classList.add('hidden');
  ok('after connecting: the context window needs no restart bar, a Docker setting does');

  /* ----- a question, with settings changed while it runs ----- */
  overrides.maxSteps = 8; overrides.answerTokens = 600;
  $('box').value = 'what does buildContext do';
  click($('send'));
  for (let i = 0; i < 300 && !doc.querySelector('.trace details.tool'); i++) await sleep(20);
  assert.ok(doc.querySelector('.trace details.tool.running'), 'the tool being run shows as a running one-line row');
  think.checked = true; change(think);            // Think, mid-question
  ctxNum.value = '20000'; change(ctxNum);          // context window, mid-question
  await sleep(20);
  // the answer must appear while it is still being written, growing as tokens arrive
  const lens = []; let bubbleWhileBusy = false, sawThinkingOpen = false;
  for (let i = 0; i < 1200 && $('send').dataset.state === 'stop'; i++) {
    const b = [...doc.querySelectorAll('.bot')].pop();
    if (b) { bubbleWhileBusy = true; if (lens[lens.length - 1] !== b.textContent.length) lens.push(b.textContent.length); }
    if (doc.querySelector('details.think[open] .thinking')?.textContent) sawThinkingOpen = true;
    await sleep(8);
  }
  assert.ok(bubbleWhileBusy, 'an answer bubble exists while the question is still running');
  assert.ok(lens.length >= 5 && lens.every((n, i) => i === 0 || n > lens[i - 1]), `the answer grew token by token: ${lens.slice(0, 8).join(',')}… (${lens.length} sizes)`);
  ok(`the answer streams into the chat as it is written (${lens.length} growth steps seen)`);
  if (sawThinkingOpen) ok('thinking text was visible, open, while it was being written');

  const bots = [...doc.querySelectorAll(".bot")];
  assert.equal(bots.length, 1, 'one answer bubble (the streamed one was finalised, not duplicated)');
  assert.ok(!/tool_call/.test(bots[0].textContent), 'no tool-call text leaked into the answer');
  assert.ok(lens[lens.length - 1] <= bots[0].textContent.length, 'the finished answer is at least as long as the last streamed one');   // polling every 8 ms can miss the last tokens

  const log = (await get('/_log')).filter((l) => l.roles.includes('user'));
  const mainSession = log[0].session;
  const mine = log.filter((l) => l.session === mainSession);
  assert.equal(mine[0].think, false); assert.equal(mine[mine.length - 1].think, true);
  ok('Think flipped in the toolbar during a question reaches that question\u2019s next step');
  for (let i = 0; i < 50; i++) { if ((await get(`/v1/sessions/${mainSession}`)).config.context_length === 20000) break; await sleep(50); }
  assert.equal((await get(`/v1/sessions/${mainSession}`)).config.context_length, 20000);
  assert.equal($('powerState').textContent, 'On');
  ok('context window changed in the panel during a question is on the server right after it, still connected');

  /* ----- what the model did: thin lines, no boxes ----- */
  const tr = doc.querySelector('details.trace');
  assert.ok(tr && !tr.open, 'the activity collapses into one line when the answer arrives');
  assert.match(tr.querySelector('summary').textContent, /^explore · 1 tool call · 3 helpers · [\d.]+s$/);
  assert.equal(doc.querySelectorAll('.steps, details.step').length, 0, 'no boxed step blocks any more');
  const exploreRow = [...tr.querySelectorAll('details.tool')].find((d) => d.querySelector('.tn').textContent === 'explore');
  assert.ok(exploreRow, 'the explore tool is one row');
  assert.equal(exploreRow.querySelector('.ta').textContent, '3 questions');
  assert.match(exploreRow.querySelector('.tt').textContent, /^[\d.]+s$/);
  assert.equal(exploreRow.querySelectorAll(':scope > .inner > details.helper').length, 3, 'helper branches sit inside the explore row');
  assert.ok([...exploreRow.querySelectorAll('details.helper')].every((h) => /^helper \d+\d* step/.test(h.textContent.trim()) || /helper \d/.test(h.querySelector('summary').textContent)));
  assert.ok(/call/.test(exploreRow.textContent) && /result \u00b7 \d+ B/.test(exploreRow.textContent), 'the call and the result are inside the row, one click away');
  assert.ok(tr.querySelectorAll('details.tool').length >= 4, 'explore + each helper\u2019s own tool rows');
  assert.ok(![...tr.querySelectorAll('details.tool')].some((d) => d.open || d.classList.contains('running')), 'every tool row is closed and finished');
  ok('activity: one collapsed line per question; each tool is a single row (name, what it was asked, time); helpers nested in the explore row');

  const thought = [...tr.querySelectorAll('details.think')];
  assert.ok(thought.length >= 1, 'a Thinking line exists (Think was on for the later steps)');
  assert.match(thought[0].querySelector('summary').textContent, /^thought for [\d.]+s$/);
  assert.ok(/think0 think1/.test(thought[0].querySelector('.thinking').textContent), 'the reasoning text is there');
  assert.ok(thought.every((d) => !d.open), 'thinking collapses once it is done');
  ok('thinking: shown as it is written, then "thought for Ns" you can open');

  /* ----- speed under the answer, and the context bar under the text box ----- */
  const speed = bots[0].nextElementSibling;
  assert.ok(speed.classList.contains('speed'), 'the speed line sits directly under the answer');
  assert.match(speed.textContent, /^prefill [\d.\u2013]+ \u00b7 decode [\d.\u2013]+ tok\/s \u00b7 [\d.]+s$/, speed.textContent);
  assert.ok(!doc.getElementById('stats') && !/avg:/.test(doc.body.textContent), 'no averages / totals footer');
  ok(`speed line under the answer: "${speed.textContent}"`);

  assert.equal($('inputRow').nextElementSibling.id, 'ctx', 'the context bar is right under the text box');
  assert.match($('ctxText').textContent, /^[\d.]+k? \/ 20k/, $('ctxText').textContent);
  assert.ok(parseFloat($('ctxUsed').style.width) > 0 && parseFloat($('ctxPin').style.width) > 0, 'window and pinned segments are drawn');
  ok(`context bar: "${$('ctxText').textContent}"`);
  assert.ok($('ctx').contains($('ctxText')) && $('ctx').querySelector('.ctxnote'), 'the context bar description sits under the bar, at the bottom');
  ok('context bar description is under the bar');

  /* ----- the system prompt is editable in Settings ----- */
  const sp = $('sysPrompt');
  assert.ok(sp && sp.value.length > 40, 'the system prompt shows the built-in text until it is changed');
  sp.value = 'You are a terse code reviewer.'; change(sp); await sleep(30);
  assert.equal(overrides.systemPrompt, 'You are a terse code reviewer.', 'edited prompt is saved to the setting');
  assert.ok(fieldOf('System prompt').querySelector('.badge.reset'), 'tagged: next conversation');
  fieldOf('System prompt').querySelector('button.secondary').click(); await sleep(30);   // Restore default
  assert.equal(overrides.systemPrompt, '', 'restoring the default stores an empty prompt');
  ok('system prompt: edit, save, restore default');

  /* ----- replies are rendered as markdown, code blocks have a copy button ----- */
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'answer', text: '## Title\nSome **bold**, *italic* and `code`.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```' } }));
  const md = [...doc.querySelectorAll('.bot')].pop();
  assert.ok(md.querySelector('h2') && md.querySelector('strong') && md.querySelector('em') && md.querySelector('p code') && md.querySelectorAll('ul li').length === 2, 'headings, bold, italic, inline code and lists are rendered');
  assert.equal(md.querySelector('.codeblock code').textContent, 'const a = 1;');
  assert.equal(md.querySelector('.codeblock .lang').textContent, 'ts');
  assert.ok(md.querySelector('button.copy'), 'code blocks have a Copy button');
  ok('markdown: headings, bold, italic, inline code, lists, code block with copy button');



  /* ----- reply limit picker and "Run to the end" ----- */
  const rl = $('replyLimit');
  assert.deepEqual([...rl.options].map((o) => o.textContent), ['Reply: 600', 'Reply: 1500', 'Reply: 3000', 'Reply: 6000', 'Reply: Unlimited']);
  assert.equal(rl.value, String(overrides.answerTokens ?? 1500), 'shows the current limit');
  rl.value = '3000'; change(rl); await sleep(40); assert.equal(overrides.answerTokens, 3000);
  rl.value = '-1'; change(rl); await sleep(40); assert.equal(overrides.answerTokens, -1, 'Unlimited is one click away, no trip to Settings');
  assert.equal(fieldOf('Reply token limit').querySelector('input[type=checkbox]').checked, true, 'the Settings checkbox follows');
  rl.value = '1500'; change(rl); await sleep(40);
  overrides.answerTokens = 1234; for (const l of listeners) l({ affectsConfiguration: () => true }); await sleep(60);
  assert.ok([...rl.options].some((o) => o.value === '1234') && rl.value === '1234', 'a custom value set in Settings is shown too');
  overrides.answerTokens = 1500; for (const l of listeners) l({ affectsConfiguration: () => true }); await sleep(60);
  assert.equal($('auto').checked, false);
  $('auto').checked = true; change($('auto')); await sleep(600);
  assert.deepEqual([overrides.answerTokens, overrides.maxSteps, overrides['edits.approval']], [-1, -1, 'never'], 'Run to the end: no reply limit, no step limit, no prompts');
  for (const l of listeners) l({ affectsConfiguration: () => true }); await sleep(60); assert.equal($('auto').checked, true, 'the pill follows the settings');
  $('auto').checked = false; change($('auto')); await sleep(600);
  assert.deepEqual([overrides.answerTokens, overrides.maxSteps, overrides['edits.approval']], [1500, 8, 'ask'], 'turning it off puts the old values back');
  ok('toolbar: reply-limit picker (with Unlimited, following Settings) and "Run to the end" (asks once, sets all three, restores the old values)');


  /* ----- live tool calls and the live context bar (events as the agent sends them) ----- */
  const ev = (type, e, agent = 0) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: type === 'trace' ? { type: 'trace', agent, event: e } : { type, ...e } }));
    ev('trace', { type: 'start', session: 's', firstPromptBytes: 3400, shrunk: [], dropped: [], primed: false, carriedBytes: 0 });
  ev('trace', { type: 'turn', n: 1, position: 1000, windowTokens: 1000, contextLength: 16000, pinnedTokens: 100, spilledTokens: 0 });
  assert.match($('ctxText').textContent, /^~2\.0k \/ 16k$/, `the bar counts the prompt being read at once: ${$('ctxText').textContent}`);
  const tok = (text) => ev('trace', { type: 'token', kind: 'content', text });
  tok('<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "print(1)');
  let row = doc.querySelector('details.tool.running');
  assert.ok(row && row.open, 'a tool row opens as soon as the call starts being written');
  assert.equal(row.querySelector('.tn').textContent, 'write_file', 'its name appears as soon as it is written');
  assert.match(row.querySelector('pre.stream').textContent, /"path": "a\.py", "content": "print\(1\)/, 'the call text streams into the row');
  assert.ok(row.querySelector('pre.stream').textContent.startsWith('<tool_call>'), 'the raw text is shown with its tool_call tag, nothing hidden');
  assert.match(row.querySelector('.ts').textContent, /writing the call/);
  await sleep(120); tok('\\nprint(2)'); assert.match(row.querySelector('pre.stream').textContent, /print\(2\)$/, 'and keeps growing');
  assert.match($('ctxText').textContent, /^~2\.0k/, 'the context bar estimate follows the tokens');
  const before = $('ctxText').textContent;
  for (let i = 0; i < 400; i++) tok('x'); await sleep(150); tok('y');
  assert.notEqual($('ctxText').textContent, before, 'the bar keeps moving while the model writes');
  await sleep(300); assert.match(row.querySelector('.tt').textContent, /^\d+\.\ds$/, 'the row has a live timer');
  ev('trace', { type: 'call', n: 1, call: { name: 'write_file', args: { path: 'a.py', content: 'print(1)\nprint(2)' } } });
  assert.ok(row.open && row.classList.contains('running') && !row.querySelector('pre.stream'), 'the finished call replaces the raw text');
  assert.equal(row.querySelector('.ta').textContent, 'a.py · 2 lines', 'the line shows the path and size, not the code'); assert.match(row.querySelector('.ts').textContent, /running/);
  assert.match(row.querySelector('.inner').textContent, /path: a\.py\ncontent: \nprint\(1\)\nprint\(2\)/, 'the call is shown in full, readable, before it runs');
  ev('approval', { id: 'live1', tool: 'write_file', server: '', args: { path: 'a.py' }, readOnly: false });
  assert.match(row.querySelector('.ts').textContent, /waiting for you/, 'the row says it is waiting for you');
  ev('approvalDone', { id: 'live1' });
  ev('trace', { type: 'step', n: 1, ttftMs: 1000, totalMs: 4000, call: { name: 'write_file', args: { path: 'a.py', content: 'print(1)\nprint(2)' } }, observationBytes: 28, observation: 'Created a.py (2 lines).', usage: { prompt_tokens: 900, completion_tokens: 80 } });
  assert.ok(!row.open && !row.classList.contains('running'), 'when it is done the row folds to one line');
  assert.match(row.querySelector('summary').textContent, /write_file.*a\.py · 2 lines.*✓ Created a\.py \(2 lines\)\./, 'with the outcome on the line: ' + row.querySelector('summary').textContent);
  assert.match(row.querySelector('.inner').textContent, /result · 28 B/);
  ev('trace', { type: 'turn', n: 2, position: 1900, windowTokens: 1900, contextLength: 16000, pinnedTokens: 100, spilledTokens: 0 });
  assert.match($('ctxText').textContent, /^~1\.9k|^~2\.0k/, 'the next step starts from the exact number');
  ev('context', { window: 2100, context: 16000, pinned: 100, spilled: 0, position: 2100, sliding: true });
  assert.equal($('ctxText').textContent, '2.1k / 16k', 'exact numbers replace the estimate');
  ev('trace', { type: 'turn', n: 3, position: 2100, windowTokens: 2100, contextLength: 16000, pinnedTokens: 100, spilledTokens: 0 });
  ev('trace', { type: 'step', n: 3, ttftMs: 10, totalMs: 20, call: { name: 'read_file', args: { path: 'nope' } }, observationBytes: 22, observation: 'Error: no such file: nope' });
  assert.equal([...doc.querySelectorAll('details.tool.err')].length, 1, 'a failed call is marked');
  // a call that fails (cut off, bad format) keeps its row and everything the model wrote
  ev('trace', { type: 'turn', n: 4, position: 2200, windowTokens: 2200, contextLength: 16000, pinnedTokens: 100, spilledTokens: 0 });
  tok('<function=write_file>{"arguments": {"path": "index.html", "content": "<!DOCTYPE html>\\n<html>\\n'); await sleep(120);
  tok('<body>LAST-TOKENS-INSIDE-THROTTLE'); // arrives within the paint throttle: must still be kept
  ev('trace', { type: 'step', n: 4, ttftMs: 5, totalMs: 9000, note: 'bad tool call: your reply hit the 600-token limit while you were writing the tool call, so it was cut off and nothing ran.' });
  const failed = [...doc.querySelectorAll('details.tool')].pop();
  assert.ok(failed && failed.classList.contains('err') && !failed.classList.contains('running') && !failed.open, 'the failed call stays as a marked row, not deleted');
  assert.match(failed.querySelector('summary').textContent, /write_file.*✗ your reply hit the 600-token limit/);
  assert.match(failed.querySelector('pre.stream').textContent, /<!DOCTYPE html>[\s\S]*LAST-TOKENS-INSIDE-THROTTLE/, 'everything the model wrote is still there to open and copy');
  assert.match(failed.textContent, /select and copy it/);
  assert.equal([...doc.querySelectorAll('details.tool.err')].length, 2, 'both failed calls are still there');
  ok('a call that fails keeps its row with everything the model wrote (nothing is deleted), marked with the reason');
  ev('answer', { text: 'Done.', truncated: false, seconds: 5 });
  assert.match([...doc.querySelectorAll('details.trace')].pop().querySelector('summary').textContent, /write_file → read_file/, 'the folded trace names the tools in order');
  ok('live: the tool row opens when the call starts, streams the call text, shows it in full, says "waiting for you", folds with a ✓/✗ outcome; the context bar grows while the model writes (~) and snaps to exact numbers');

  /* ----- no Reset button in Settings any more ----- */
  assert.ok(![...doc.querySelectorAll('#settingsView button')].some((b) => /^reset/i.test(b.textContent)) && !$('reset'), 'no Reset button in Settings');
  assert.ok([...doc.querySelectorAll('#settingsView button')].some((b) => b.textContent === 'Apply to a new chat'), 'the system prompt\u2019s button starts a new chat instead');
  ok('the Reset conversation button is gone from Settings; the prompt editor offers "Apply to a new chat"');

  /* ----- settings: the new drop-downs ----- */
  const sc = fieldOf('Save the context').querySelector('select');
  assert.deepEqual([...sc.options].map((o) => o.textContent), ['After every answer', 'When I leave the chat', 'Never (text only)']);
  sc.value = 'whenLeaving'; change(sc); await sleep(20); assert.equal(overrides['chats.saveContext'], 'whenLeaving');
  sc.value = 'afterEachAnswer'; change(sc); await sleep(20);
  assert.ok(fieldOf('Ask before MCP tools run').querySelector('select') && fieldOf('Context folder on the server'));
  ok('settings: Save the context / Ask before MCP tools run are drop-downs; the chats and MCP settings are listed');

  /* ----- the sidebar of chats ----- */
  const rows = () => [...doc.querySelectorAll('#dlist .crow2')];
  assert.ok($('drawer').classList.contains('hidden'));
  click($('menu')); await sleep(20);
  assert.ok(!$('drawer').classList.contains('hidden') && !$('scrim').classList.contains('hidden'), 'the list of chats opens');
  assert.equal(rows().length, 1); assert.ok(rows()[0].classList.contains('active'));
  assert.equal(rows()[0].querySelector('.ct').textContent, 'what does buildContext do');
  assert.match($('dproj').textContent, /chats in this folder/); assert.ok(doc.querySelector('.dgroup').textContent === 'Today');
  for (let i = 0; i < 100 && !rows()[0].querySelector('.saved'); i++) await sleep(50);
  assert.ok(rows()[0].querySelector('.saved'), 'the row says the context is saved');
  assert.match(rows()[0].querySelector('.cm').textContent, /1 message/);
  assert.equal($('chatTitle').textContent, 'what does buildContext do');
  ok('sidebar: the chat is listed (grouped by day, active, "context saved"), the title shows in the header');

  click($('dnew')); await sleep(60);
  assert.ok($('drawer').classList.contains('hidden'), 'starting a chat closes the list');
  assert.equal(doc.querySelectorAll('.msg.user').length, 0); assert.ok(doc.querySelector('.welcome'), 'an empty chat shows a hint');
  $('box').value = 'second question about helpers'; click($('send'));
  for (let i = 0; i < 400 && $('send').dataset.state === 'stop'; i++) await sleep(25);
  await sleep(150); click($('menu')); await sleep(20);
  assert.equal(rows().length, 2); assert.equal(rows()[0].querySelector('.ct').textContent, 'second question about helpers'); assert.ok(rows()[0].classList.contains('active'));
  ok('New chat: empty chat, the old one stays in the list; the new one is added on top');

  click(rows()[1]); await sleep(80);
  assert.ok($('drawer').classList.contains('hidden'));
  assert.equal([...doc.querySelectorAll('.msg.user')].map((n) => n.textContent).join('|'), 'what does buildContext do');
  assert.ok(doc.querySelector('.bot') && doc.querySelector('.bot').textContent.length > 20, 'the saved answer is shown');
  assert.match(doc.querySelector('details.trace summary').textContent, /tool call/, 'with its tool calls folded');
  assert.ok(doc.querySelector('.speed') && /prefill/.test(doc.querySelector('.speed').textContent), 'and the speed line');
  assert.ok([...doc.querySelectorAll('details.tool .tn')].some((n) => n.textContent === 'explore' || n.textContent === 'grep'));
  ok('opening an older chat shows its whole transcript: question, folded tool calls, answer, speed');

  click($('menu')); await sleep(20);
  $('dsearch').value = 'helpers'; $('dsearch').dispatchEvent(new dom.window.Event('input', { bubbles: true })); await sleep(20);
  assert.equal(rows().length, 1); $('dsearch').value = 'zzz'; $('dsearch').dispatchEvent(new dom.window.Event('input', { bubbles: true })); await sleep(20);
  assert.equal(rows().length, 0); assert.ok(doc.querySelector('.dempty'));
  $('dsearch').value = ''; $('dsearch').dispatchEvent(new dom.window.Event('input', { bubbles: true })); await sleep(20);
  ok('search filters the list');

  const secondRow = rows()[0];
  click(secondRow.querySelectorAll('.acts button')[0]); await sleep(10);
  const inp = secondRow.querySelector('input.rename'); assert.ok(inp, 'rename opens a text box');
  inp.value = 'Helpers chat'; inp.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(60);
  assert.equal(rows()[0].querySelector('.ct').textContent, 'Helpers chat');
  const del = rows()[0].querySelectorAll('.acts button')[1];
  click(del); await sleep(10); assert.equal(rows().length, 2, 'the first click only asks'); assert.equal(del.textContent, 'Delete?');
  click(del); await sleep(80); assert.equal(rows().length, 1);
  ok('rename (inline) and delete (second click confirms) work');
  click($('dclose'));

  /* ----- the tools view ----- */
  click($('toolsBtn')); await sleep(20);
  assert.ok(!$('toolsView').classList.contains('hidden') && $('chatView').classList.contains('hidden'));
  for (let i = 0; i < 100 && !doc.querySelector('#toolsList .trow .tname[title]') ; i++) await sleep(20);
  const toolRows = () => [...doc.querySelectorAll('#toolsList .trow')];
  const rowOf = (n) => toolRows().find((r) => r.querySelector('.tname').textContent === n);
  for (let i = 0; i < 150 && !rowOf('fake__echo'); i++) await sleep(50);
  for (const n of ['diagnostics', 'list_files', 'find_files', 'grep', 'read_file', 'search_chat', 'read_turn', 'write_file', 'edit_file', 'explore']) assert.ok(rowOf(n), `built-in tool ${n} is listed`);
  assert.ok(rowOf('fake__echo') && rowOf('fake__danger'), 'the MCP server\u2019s tools are listed (the server was allowed once, then started)');
  assert.ok(rowOf('fake__echo').querySelector('.bdg.ro') && /runs without asking/.test(rowOf('fake__echo').textContent), 'read-only MCP tool: runs without asking');
  assert.ok(!rowOf('fake__danger').querySelector('.bdg.ro') && /asks first/.test(rowOf('fake__danger').textContent), 'other MCP tool: asks first');
  const groups = [...doc.querySelectorAll('#toolsList .tgroup')].map((g) => g.textContent);
  assert.ok(groups[0].startsWith('Built-in') && groups.some((g) => g.startsWith('fake') && /stdio/.test(g)), groups.join(' | '));
  assert.ok(doc.querySelector('#toolsList .sdot.ready'), 'the server shows as connected');
  assert.match($('toolsCount').textContent, /^\d+ tools?$/); assert.match($('toolsSum').textContent, /offered to the model/);
  assert.ok([...doc.querySelectorAll('#toolsList .bdg.use')].some((b) => /used/.test(b.textContent)), 'tools the model used in this chat show how many times');
  assert.ok(/asks first/.test(rowOf('write_file').textContent) && !rowOf('write_file').querySelector('.bdg.ro') && rowOf('search_chat').querySelector('.bdg.ro'), 'file-changing tools ask first, chat search is read-only');
  ok('tools view: built-in tools and the MCP server\u2019s tools, where each comes from, read-only / asks first, usage, size of the prompt');

  const cb2 = rowOf('grep').querySelector('input'); cb2.checked = false; change(cb2); await sleep(60);
  assert.deepEqual(overrides['tools.disabled'], ['grep']);
  assert.ok(rowOf('grep').classList.contains('off'), 'the row is dimmed once the tool is off');
  rowOf('grep').querySelector('input').checked = true; change(rowOf('grep').querySelector('input')); await sleep(60);
  assert.deepEqual(overrides['tools.disabled'], []);
  rowOf('fake__echo').querySelector('.tname').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(!rowOf('fake__echo').querySelector('.tsig').classList.contains('hidden') && /fake__echo\(text: string\)/.test(rowOf('fake__echo').querySelector('.tsig').textContent));
  ok('a tool can be turned off and on from the list; clicking a name shows how the model calls it');
  click($('toolsChip')); click($('toolsBtn')); await sleep(10);
  assert.ok($('toolsView').classList.contains('hidden'));

  /* ----- approval card for an MCP tool ----- */
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'approval', id: 'ap1', tool: 'fake__danger', server: 'fake', args: { target: 'x' }, readOnly: false } }));
  const card = doc.querySelector('.approval'); assert.ok(card && /fake__danger/.test(card.textContent) && /target: x/.test(card.textContent));
  assert.deepEqual([...card.querySelectorAll('button')].map((b) => b.textContent), ['Allow once', 'Always allow', 'Deny']);
  click(card.querySelectorAll('button')[0]);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'approvalDone', id: 'ap1' } }));
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'approval', id: 'ap2', tool: 'write_file', server: '', args: { path: 'a.ts', content: 'line1\nline2' }, readOnly: false } }));
  const wc = [...doc.querySelectorAll('.approval')].pop(); assert.match(wc.querySelector('.ah').textContent, /Allow write_file to change your files\?/); assert.match(wc.querySelector('pre').textContent, /path: a\.ts\ncontent: \nline1\nline2/);
  assert.equal(card.querySelectorAll('button').length, 0); assert.match(card.querySelector('.done').textContent, /Allow once/);
  ok('an MCP tool that needs approval shows a card with Allow once / Always allow / Deny, which settles into a line');

  /* ----- the message log shows what was applied ----- */
  const statuses = toWeb.filter((m) => m.type === 'status').map((m) => m.text);
  assert.ok(statuses.some((t) => /Applied without restart: .*context window/.test(t)), statuses.join('\n'));
  ok('the panel says what was applied without restart');
}

try { await run(); console.log('\nall webview checks passed'); }
catch (e) { console.error(e); process.exitCode = 1; }
finally { await (ext.deactivate?.() ?? 0); mock.kill(); process.exit(process.exitCode ?? 0); }
