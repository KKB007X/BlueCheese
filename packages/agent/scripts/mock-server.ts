/**
 * Fake Roaster API for developing without loading the 35B model.
 *   pnpm tsx packages/agent/scripts/mock-server.ts [port]
 * Mimics: ignores `tools`/`stop`, 400 over 16000 prompt bytes, reasoning_content when think=true,
 * sessions (position grows with each request; DELETE frees), 409 on a busy session, 503 when MOCK_503 is set.
 * Also mimics the newer session API (USAGE.md): per-session settings at creation, PATCH to change them (409 while busy,
 * 400 for bad values, 500 if MOCK_FAIL_RESIZE and the window is over 100000), sliding (window_tokens / spilled_tokens),
 * pinned system prompt (pinned_tokens), and "exceeds slot context" (400) when sliding is off.
 * MOCK_INLINE_THINK=1 sends the reasoning inline as <think>…</think> in the content (tags split across chunks).
 * Also mimics POST /v1/sessions/{id}/save and /restore (snapshots kept in memory by path; 409 on an empty or busy session,
 * 404 when nothing was saved there, 400 when MOCK_SAVE_FAIL is set).
 * MOCK_CUT=1 makes the tool call end in the middle with finish_reason "length" (a reply cut off by the token limit).
 * MOCK_TOOL=name makes the first reply call that tool (default grep); MOCK_TOOL_ARGS is its JSON arguments.
 * GET /_log returns what every chat request looked like (roles, think, max_tokens), for tests.
 * It cannot prove KV reuse (that is the real server's job); it only exercises the client plumbing.
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 8080);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Cfg { context_length: number; cache_route: boolean; route_j: number; route_m: number; route_alpha: number; route_p: number; slide: boolean; keep: number }
const DEFAULT_CFG: Cfg = { context_length: Number(process.env.MOCK_CONTEXT ?? 8192), cache_route: false, route_j: 2, route_m: 12, route_alpha: 1, route_p: 0, slide: true, keep: 64 };
const sessions = new Map<string, { position: number; busy: boolean; turns?: number; cfg: Cfg; pinned: number; carry?: { tools: boolean; explore: boolean } }>();
const log: { session: string; roles: string[]; think: unknown; max_tokens: unknown }[] = [];
const CFG_KEYS = Object.keys(DEFAULT_CFG) as (keyof Cfg)[];
const tokens = (t: string) => Math.ceil(Buffer.byteLength(t) / 3.5);
const info = (id: string, s: { position: number; busy: boolean; cfg: Cfg; pinned: number }) => ({
  id, loaded: true, broken: false, busy: s.busy, position: s.position, context_length: s.cfg.context_length,
  window_tokens: s.cfg.slide ? Math.min(s.position, s.cfg.context_length) : s.position,
  spilled_tokens: s.cfg.slide ? Math.max(0, s.position - s.cfg.context_length) : 0, pinned_tokens: s.pinned, config: s.cfg,
});
/** Validates and applies settings; returns an error message or undefined. */
function applyCfg(s: { cfg: Cfg; busy: boolean }, b: Record<string, unknown>): { code: number; msg: string } | undefined {
  const next: Cfg = { ...s.cfg };
  for (const k of CFG_KEYS) if (k in b) (next as any)[k] = b[k];
  if (!(next.context_length >= 1)) return { code: 400, msg: 'context_length must be >= 1' };
  if (!(next.route_j >= 0 && next.route_j <= 8)) return { code: 400, msg: 'route_j must be 0..8' };
  if (process.env.MOCK_FAIL_RESIZE && next.context_length > 100000) return { code: 500, msg: 'could not resize the context window' };
  s.cfg = next;
  return undefined;
}
const snapshots = new Map<string, { position: number; pinned: number; cfg: Cfg; carry?: { tools: boolean; explore: boolean } }>();
let first = true;
let peak = 0;
const maxSessions = Number(process.env.MOCK_MAX_SESSIONS ?? 99); // like `roaster serve --max-slots`
const json = (res: http.ServerResponse, code: number, o: unknown) =>
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(o));

http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const url = req.url ?? '';

  if (req.method === 'GET' && url === '/_stats') return json(res, 200, { sessionsNow: sessions.size, peakSessions: peak, ids: [...sessions.keys()] });
  if (req.method === 'GET' && url === '/_log') return json(res, 200, log);
  if (req.method === 'GET' && url === '/health') return json(res, 200, { status: 'ok' });
  const m = /^\/v1\/sessions(?:\/([^/]+))?(?:\/(\w+))?$/.exec(url);
  if (m) {
    const id = m[1] ? decodeURIComponent(m[1]) : undefined; const action = m[2];
    if (!id) {
      if (req.method === 'POST') {
        const b = raw ? JSON.parse(raw) : {}; const sid = b.id ?? 'new';
        if (!sessions.has(sid) && sessions.size >= maxSessions) return json(res, 503, { error: { message: 'could not create slot' } });
        const ns = { position: 0, busy: false, cfg: { ...DEFAULT_CFG }, pinned: 0 };
        const bad = applyCfg(ns, b); if (bad) return json(res, bad.code, { error: { message: bad.msg } });
        sessions.set(sid, ns); peak = Math.max(peak, sessions.size); return json(res, 200, info(sid, ns));
      }
      return json(res, 200, { sessions: [...sessions].map(([k, v]) => ({ id: k, ...v })) });
    }
    const s = sessions.get(id);
    if (!s) return json(res, 404, { error: { message: 'no such session' } });
    if (req.method === 'DELETE') { if (s.busy) return json(res, 409, { error: { message: 'busy' } }); sessions.delete(id); return json(res, 200, { deleted: true }); }
    if (req.method === 'PATCH' || action === 'config') {
      if (s.busy) return json(res, 409, { error: { message: 'session is busy' } });
      const bad = applyCfg(s, raw ? JSON.parse(raw) : {}); if (bad) return json(res, bad.code, { error: { message: bad.msg } });
      return json(res, 200, info(id, s));
    }
    if (action === 'save') {
      if (process.env.MOCK_SAVE_FAIL) return json(res, 400, { error: { message: 'invalid path' } });
      const b = raw ? JSON.parse(raw) : {};
      if (s.busy || s.position === 0) return json(res, 409, { error: { message: 'busy or empty' } });
      snapshots.set(String(b.path), { position: s.position, pinned: s.pinned, cfg: { ...s.cfg }, carry: s.carry });
      return json(res, 200, { ...info(id, s), saved_to: b.path, saved_bytes: 40000 * s.position + 65_000_000 });
    }
    if (action === 'restore') {
      const b = raw ? JSON.parse(raw) : {};
      if (s.busy) return json(res, 409, { error: { message: 'busy' } });
      const snap = snapshots.get(String(b.path));
      if (!snap) return json(res, 404, { error: { message: 'no saved context in that directory' } });
      s.position = snap.position; s.pinned = snap.pinned; s.carry = snap.carry; s.cfg.context_length = Math.max(s.cfg.context_length, snap.cfg.context_length);
      return json(res, 200, info(id, s));
    }
    if (action === 'reset') { s.position = 0; s.pinned = 0; return json(res, 200, { ok: true }); }
    if (action === 'stop' || action === 'unload' || action === 'load') return json(res, 200, { ok: true });
    return json(res, 200, info(id, s));
  }

  if (req.method !== 'POST' || !url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
  const j = JSON.parse(raw);
  let prompt = (j.messages as { content: string }[]).map((x) => x.content).join('\n');
  const priming = j.max_tokens === 1;   // BlueCheese sends the system prompt alone once, to cache it
  if (Buffer.byteLength(prompt) > 16000) return json(res, 400, { error: 'prompt too long' });
  if (process.env.MOCK_503 && first) { first = false; return json(res, 503, { error: { message: 'could not create slot' } }); }

  const sid = j.session ?? 'default';
  let s = sessions.get(sid);
  if (!s) {
    if (sessions.size >= maxSessions) return json(res, 503, { error: { message: 'could not create slot' } });
    s = { position: 0, busy: false, cfg: { ...DEFAULT_CFG }, pinned: 0 }; sessions.set(sid, s); peak = Math.max(peak, sessions.size);
  }
  if (s.busy) return json(res, 409, { error: { message: 'session busy' } });
  if (j.reset) { s.position = 0; s.pinned = 0; }
  const msgs = j.messages as { role: string; content: string }[];
  log.push({ session: sid, roles: msgs.map((m) => m.role), think: j.think, max_tokens: j.max_tokens });
  // a system message only counts while the context is empty, and is then pinned
  const sys = s.position === 0 ? msgs.find((m) => m.role === 'system') : undefined;
  if (sys) s.pinned = tokens(sys.content);
  // the tool instructions live in the pinned system prompt: a follow-up in a primed session still has them (the mock looks for them in the request text)
  if (priming && prompt.includes('You can call tools')) { s.carry = { tools: true, explore: prompt.includes('explore(') }; }
  else if (s.carry && !priming) { if (s.carry.tools) prompt += '\nYou can call tools' + (s.carry.explore ? ' explore(' : ''); s.carry = undefined; }
  const need = tokens(prompt);
  if (!s.cfg.slide && s.position + need + Math.min(j.max_tokens ?? 100, 100) > s.cfg.context_length) {
    return json(res, 400, { error: { message: 'Prompt plus requested generation exceeds slot context' } });
  }
  s.busy = true;
  s.turns = (s.turns ?? 0) + 1;
  s.position += need;

  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let closedEarly = false;
  res.on('close', () => { s!.busy = false; if (!res.writableEnded) { closedEarly = true; console.log('[mock] client closed stream early (generation stopped)'); } });

  let n = 0;
  if (j.think && process.env.MOCK_INLINE_THINK) {
    // a server that leaves the reasoning inline, with the tags split across chunks
    for (const part of ['<thi', 'nk>inline0 ', 'inline1 </thi', 'nk>\n']) { await sleep(10); send({ choices: [{ delta: { content: part } }] }); n++; }
  } else if (j.think) { for (let i = 0; i < 5; i++) { await sleep(10); send({ choices: [{ delta: { reasoning_content: `think${i} ` } }] }); } }

  const isHelper = prompt.includes('You are a code helper');
  const wantsExplore = !priming && !!process.env.MOCK_EXPLORE && !isHelper && prompt.includes('explore(') && !prompt.includes('<tool_response>');
  const wantsTool = process.env.MOCK_STUBBORN ? !prompt.includes('Do not write a tool call') : process.env.MOCK_REPEAT ? s.turns <= 3 : !priming && prompt.includes('You can call tools') && !prompt.includes('<tool_response>');
  const toolName = process.env.MOCK_TOOL ?? 'grep';
  const toolArgs = process.env.MOCK_TOOL_ARGS ?? JSON.stringify({ pattern: process.env.MOCK_REPEAT ? 'retrieve' : 'buildContext' });
  const text = wantsExplore
    ? '<tool_call>{"name": "explore", "arguments": {"questions": "what does retrieve do\\nwhat does shortestPath do\\nwhat does repoMap do"}}</tool_call>'
    : wantsTool
    ? (process.env.MOCK_CUT
      // cut off by the token limit in the middle of a long file, with no closing tag
      ? (process.env.MOCK_CUT === 'hybrid'
        ? `<tool_call>\n<function=${toolName}>{"arguments": {"path": "big.py", "content": "def f():\\n    return 1\\n    x = 2`   // the shape a real model wrote: wrapper, function tag, JSON
        : `<tool_call>{"name": "${toolName}", "arguments": {"path": "big.py", "content": "def f():\\n    return 1\\n`)
      : `<tool_call>{"name": "${toolName}", "arguments": ${toolArgs}}</tool_call>`)
    : Array.from({ length: Math.min(j.max_tokens ?? 100, 100) }, (_, i) => `${i + 1} `).join('');
  for (let i = 0; i < text.length && !closedEarly; i += 4) {
    await sleep(Number(process.env.MOCK_SLOW_MS ?? 12));
    send({ choices: [{ delta: { content: text.slice(i, i + 4) } }] });
    n++;
  }
  s.position += n;
  if (!closedEarly) {
    send({ choices: [{ delta: {}, finish_reason: process.env.MOCK_CUT && wantsTool ? 'length' : 'stop' }], usage: { prompt_tokens: need, completion_tokens: n } });
    res.write('data: [DONE]\n\n');
    res.end();
  }
}).listen(port, () => console.log(`mock Roaster API on http://127.0.0.1:${port}/v1`));
