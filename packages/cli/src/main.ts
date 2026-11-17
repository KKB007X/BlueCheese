import { parseArgs } from 'node:util';
import path from 'node:path';
import {
  RoasterLLM, llmConfigFromEnv, runAgent, AgentConversation, RoasterRuntime, loadProjectConfig, isHealthy,
  type ApiProfile, type AgentEvent,
} from '@bluecheese/agent';
import readline from 'node:readline';
import { makeTools } from '@bluecheese/core';

const HELP = `bc — BlueCheese

  bc ask "<question>" [--steps N] [--ctx N] [--obs BYTES] [--think] [--keep]
                         [--profile NAME] [--url URL] [--keep-api]
                                 ask Roaster, which reads the project with read-only tools. With no --url / BC_BASE_URL,
                                 BlueCheese starts its own API container and stops it afterwards.
  bc chat [same options as ask]  keep ONE session and API alive across questions; follow-ups only pay for
                                 their own tokens. Commands: :reset  :quit
  bc runtime up [--count N] [--profile NAME] [--base-port P] [--max-apis N]
                                 start N API containers (ports from base-port) and leave them running
  bc runtime status              list managed API containers and their health
  bc runtime down                stop every managed API container

Options: --root <dir> (default: the folder you ran the command from)`;

// one-line errors instead of stack traces (RoasterRuntime's exit handlers still run)
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (e) => { console.error(`Error: ${(e as Error)?.message ?? e}`); process.exit(1); });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    // pnpm/npm run scripts from the package folder, so process.cwd() would always be BlueCheese itself; INIT_CWD is where you typed the command
    root: { type: 'string', default: process.env.INIT_CWD ?? process.cwd() },
    steps: { type: 'string' },
    ctx: { type: 'string' },
    keep: { type: 'boolean' },
    'max-tokens': { type: 'string' },
    think: { type: 'boolean' },
    obs: { type: 'string' },
    profile: { type: 'string' },
    url: { type: 'string' },
    'keep-api': { type: 'boolean' },
    count: { type: 'string' },
    'base-port': { type: 'string' },
    'max-apis': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});


/* ---- Roaster API lifecycle ---- */
function makeRuntime() {
  const pc = loadProjectConfig(root);
  const rt = new RoasterRuntime({
    ...pc.runtime,
    ...(values['base-port'] ? { basePort: Number(values['base-port']) } : {}),
    ...(values['max-apis'] ? { maxApis: Number(values['max-apis']) } : {}),
  });
  const base = pc.profiles?.[values.profile ?? 'default'] ?? {};
  if (values.profile && !pc.profiles?.[values.profile]) { console.error(`Unknown profile "${values.profile}" in bluecheese.config.json`); process.exit(1); }
  // a long conversation needs room: chat defaults to a 16K context (about 650 MB for its one session)
  const context = values.ctx ? Number(values.ctx) : cmd === 'chat' ? Math.max(16384, base.context ?? 0) : base.context;
  const profile: ApiProfile = { ...base, ...(context ? { context } : {}) };
  return { rt, profile };
}

/** Run `fn` with an LLM client: an explicit URL if given, otherwise a managed API container that is stopped afterwards. */
async function withLlm<T>(fn: (llm: RoasterLLM, profile: ApiProfile) => Promise<T>): Promise<T> {
  const url = values.url ?? process.env.BC_BASE_URL;
  if (url) return fn(new RoasterLLM({ ...llmConfigFromEnv(), baseUrl: url.replace(/\/$/, '') }), {});

  const { rt, profile } = makeRuntime();
  rt.installExitHandlers();
  const t0 = performance.now();
  console.error(`[api] starting a Roaster API container (context ${profile.context ?? 8192}, cache-route ${(profile.cacheRoute ?? true) ? 1 : 0})…`);
  const api = await rt.start(profile);
  console.error(`[api] ${api.name} ready at ${api.url} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  try {
    return await fn(api.llm, profile);
  } finally {
    if (values['keep-api']) { rt.release(); console.error(`[api] left running at ${api.url} (bc runtime down to stop)`); }
    else { await rt.stopAll(); console.error(`[api] ${api.name} stopped`); }
  }
}

function printEvent(e: AgentEvent) {
  const sec = (ms: number) => (ms / 1000).toFixed(1) + 's';
  if (e.type === 'start') {
    console.error(`[start] ${e.primed ? 'follow-up' : 'first message'} ${e.firstPromptBytes} B (~${Math.round(e.firstPromptBytes / 3.4)} tokens)` +
      (e.carriedBytes ? `, includes ${e.carriedBytes} B recap of the earlier conversation` : '') +
      (e.shrunk.length || e.dropped.length ? `  shrunk: ${e.shrunk.join(',') || '-'}  dropped: ${e.dropped.join(',') || '-'}` : ''));
    return;
  }
  if (e.type === 'turn' || e.type === 'token' || e.type === 'call') return; // streaming detail for UIs (the step line that follows has the result)
  if (e.type === 'slide') {
    console.error(`[slide] ${e.spilledTokens} tokens are now on SSD (window ${e.windowTokens ?? '?'}); code read earlier may be read again`);
    return;
  }
  const what = e.call
    ? `→ ${e.call.name}(${JSON.stringify(e.call.args).slice(0, 80)})${e.call.repaired ? ' [repaired]' : ''} result ${e.observationBytes} B`
    : e.note ? `! ${e.note}` : '→ answer';
  const u = e.usage ? ` usage ${e.usage.prompt_tokens ?? '?'}p/${e.usage.completion_tokens ?? '?'}c` : '';
  console.error(`[step ${e.n}] ttft ${sec(e.ttftMs)} total ${sec(e.totalMs)} ctx ${e.contextTokens ?? '?'}${u}  ${what}`);
}

const [cmd, ...rest] = positionals;
const root = path.resolve(values.root!);

switch (cmd) {
  case 'ask': {
    const q = rest.join(' ').trim();
    if (!q) { console.error('Usage: bc ask "<question>"'); process.exit(1); }
    const res = await withLlm((llm, profile) => runAgent({
      llm,
      tools: makeTools(root, { maxBytes: Number(values.obs ?? 1200) }),
      maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : values.think ? 1500 : undefined,
      think: values.think,
      maxObservationBytes: Number(values.obs ?? 1200) + 250,
      task: q,
      maxSteps: Number(values.steps ?? 8),
      contextLength: Number(values.ctx ?? profile.context ?? 8192),
      keepSession: values.keep,
      onEvent: printEvent,
    }));
    console.error(`[done] ${res.reason} after ${res.steps} step(s) in ${(res.totalMs / 1000).toFixed(0)}s`);
    console.log(res.answer || '(no answer)');
    if (res.truncated) console.error('(answer was cut off at the token limit; raise --max-tokens)');
    break;
  }
  case 'chat': {
    await withLlm(async (llm, profile) => {
      const conv = new AgentConversation(llm, Number(values.ctx ?? profile.context ?? 8192));
      const tools = makeTools(root, { maxBytes: Number(values.obs ?? 1200), shown: conv.shown });
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: 'bluecheese> ', terminal: false });
      console.error('Ask about the code. :reset clears the context, :quit exits.');
      rl.prompt();
      try {
        for await (const raw of rl) {
          const line = raw.trim();
          if (line === ':quit' || line === ':q') break;
          if (line === ':reset') { await conv.reset(); console.error('(context reset)'); rl.prompt(); continue; }
          if (!line) { rl.prompt(); continue; }
          try {
            if (await conv.maybeReset()) console.error('(context was getting full: reset, keeping a short recap of the last answers)');
            const res = await runAgent({
              llm, conversation: conv, tools, task: line,
              maxSteps: Number(values.steps ?? 8), maxObservationBytes: Number(values.obs ?? 1200) + 250, onEvent: printEvent,
              maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : values.think ? 1500 : undefined,
      think: values.think,
            });
            console.error(`[done] ${res.reason} after ${res.steps} step(s) in ${(res.totalMs / 1000).toFixed(0)}s`);
            if (res.reason === 'context_full') console.error('(the context is full: type :reset, or ask a narrower question)');
            console.log(res.answer || '(no answer)');
            if (res.truncated) console.error('(answer was cut off at the token limit; type "continue" for the rest)');
            if (res.reason !== 'context_full') conv.record(line, res.answer);
          } catch (e) { console.error(`Error: ${(e as Error).message}`); }
          rl.prompt();
        }
      } finally { rl.close(); await conv.close().catch(() => {}); }
    });
    break;
  }
  case 'runtime': {
    const sub = rest[0];
    const { rt, profile } = makeRuntime();
    if (sub === 'up') {
      const n = Number(values.count ?? 1);
      const apis = await rt.startMany(n, profile);
      rt.release(); // keep running after this command exits
      for (const a of apis) console.log(`${a.name}  ${a.url}`);
      console.log(`\nUse one with: export BC_BASE_URL=${apis[0].url}`);
      console.log('Stop all with: bc runtime down');
    } else if (sub === 'status') {
      const list = await rt.discover();
      if (!list.length) console.log('No managed API containers running.');
      for (const a of list) console.log(`${a.name}  ${a.url}  ${(await isHealthy(a.url)) ? 'healthy' : 'NOT responding'}`);
      console.log(`limit: ${rt.cfg.maxApis}   socket: ${rt.cfg.socketDir}/${rt.cfg.socketName}   image: ${rt.cfg.image}`);
    } else if (sub === 'down') {
      const names = await rt.stopAll({ all: true });
      console.log(names.length ? `Stopped: ${names.join(', ')}` : 'Nothing to stop.');
    } else {
      console.error('Usage: bc runtime up|status|down');
      process.exit(1);
    }
    break;
  }
  default:
    console.log(HELP);
}
