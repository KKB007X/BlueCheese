/**
 * Starts and stops Roaster API containers (`roaster api`) from code, so BlueCheese controls the API
 * settings, how many API servers run (up to a limit), and shuts them down when the work is done.
 *
 * `roaster serve` (the model + GPU) is NOT managed here: you run it yourself. It owns the slots; every API
 * container only talks to it over the shared Unix socket.
 *
 * Containers are labelled `bluecheese.managed=1` so they can be found again (`bc runtime status|down`).
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { RoasterLLM } from './llm.js';

export interface RuntimeConfig {
  image: string;          // docker image with the roaster binary
  socketDir: string;      // host folder holding the serve socket (mounted into the api container)
  socketName: string;
  bindHost: string;       // host interface the API ports are published on
  basePort: number;       // first port to try
  maxApis: number;        // hard limit on managed API containers (counted across processes)
  docker: string;         // docker binary
  namePrefix: string;
  healthTimeoutMs: number;
}

export const DEFAULT_RUNTIME: RuntimeConfig = {
  image: 'roaster:dev', socketDir: '/tmp/roaster', socketName: 'roaster.sock', bindHost: '127.0.0.1',
  basePort: 8080, maxApis: 3, docker: 'docker', namePrefix: 'bc-api', healthTimeoutMs: 30_000,
};

/** Settings of one API server (mirrors `roaster api` options, see USAGE.md). */
export interface ApiProfile {
  context?: number;       // --context            default 8192
  maxTokens?: number;     // --max-tokens         default 1024
  think?: boolean;        // --think              default false
  cacheRoute?: boolean;   // --cache-route        default true
  routeJ?: number;        // --route-j   0..8
  routeM?: number;        // --route-m   8..256
  routeAlpha?: number;    // --route-alpha 0..1
  routeP?: number;        // --route-p   0..1
  slide?: boolean;        // --slide     default true (slide the window instead of failing when it is full)
  keep?: number;          // --keep      >= 0, tokens at the start that never slide out
  temp?: number;          // --temp      >= 0
  topP?: number;          // --top-p     (0,1]
  topK?: number;          // --top-k     1..248320
  modelName?: string;     // --model-name
  apiKey?: string;        // ROASTER_API_KEY (passed through the environment, not on the command line)
}

export interface ApiInstance {
  name: string;
  port: number;
  url: string;            // http://host:port
  profile: ApiProfile;
  llm: RoasterLLM;
  owned: boolean;         // started by this process
}

export interface ProjectConfig { runtime?: Partial<RuntimeConfig>; profiles?: Record<string, ApiProfile> }

/** Reads <root>/bluecheese.config.json (optional). Env: BC_ROASTER_IMAGE, BC_SOCKET_DIR. */
export function loadProjectConfig(root: string): ProjectConfig {
  const f = path.join(path.resolve(root), 'bluecheese.config.json');
  const cfg: ProjectConfig = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  cfg.runtime = {
    ...cfg.runtime,
    ...(process.env.BC_ROASTER_IMAGE ? { image: process.env.BC_ROASTER_IMAGE } : {}),
    ...(process.env.BC_SOCKET_DIR ? { socketDir: process.env.BC_SOCKET_DIR } : {}),
  };
  return cfg;
}

const inRange = (name: string, v: number | undefined, lo: number, hi: number) => {
  if (v !== undefined && !(v >= lo && v <= hi)) throw new Error(`profile.${name}=${v} is outside ${lo}..${hi}`);
};

export function validateProfile(p: ApiProfile): void {
  inRange('context', p.context, 1, 1_000_000);
  inRange('maxTokens', p.maxTokens, 1, 1_000_000);
  inRange('routeJ', p.routeJ, 0, 8);
  inRange('routeM', p.routeM, 8, 256);
  inRange('routeAlpha', p.routeAlpha, 0, 1);
  inRange('routeP', p.routeP, 0, 1);
  inRange('keep', p.keep, 0, 1_000_000);
  inRange('temp', p.temp, 0, 100);
  inRange('topP', p.topP, 1e-9, 1);
  inRange('topK', p.topK, 1, 248320);
}

/** The `docker run` arguments for one API container (pure; unit-testable). */
export function buildDockerArgs(cfg: RuntimeConfig, name: string, port: number, profile: ApiProfile): string[] {
  validateProfile(profile);
  const a = ['--socket', `/run/roaster/${cfg.socketName}`, '--host', '0.0.0.0', '--port', '8080',
    '--context', String(profile.context ?? 8192),
    '--max-tokens', String(profile.maxTokens ?? 1024),
    '--cache-route', (profile.cacheRoute ?? true) ? '1' : '0',
    '--think', (profile.think ?? false) ? '1' : '0'];
  const opt = (flag: string, v: number | string | undefined) => { if (v !== undefined) a.push(flag, String(v)); };
  opt('--route-j', profile.routeJ); opt('--route-m', profile.routeM);
  opt('--route-alpha', profile.routeAlpha); opt('--route-p', profile.routeP);
  if (profile.slide !== undefined) a.push('--slide', profile.slide ? '1' : '0');
  opt('--keep', profile.keep);
  opt('--temp', profile.temp); opt('--top-p', profile.topP); opt('--top-k', profile.topK);
  opt('--model-name', profile.modelName);

  return [
    'run', '-d', '--rm', '--name', name,
    '--label', 'bluecheese.managed=1', '--label', `bluecheese.port=${port}`, '--label', `bluecheese.owner=${process.pid}`,
    '-p', `${cfg.bindHost}:${port}:8080`,
    '-v', `${path.resolve(cfg.socketDir)}:/run/roaster`,
    ...(profile.apiKey ? ['-e', 'ROASTER_API_KEY'] : []),
    cfg.image, 'api', ...a,
  ];
}

function sh(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { env: env ?? process.env, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${bin} ${args[0]} failed: ${String(stderr || err.message).trim()}`)) : resolve(String(stdout))));
}

const portFree = (port: number, host: string) => new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.once('listening', () => s.close(() => resolve(true)));
  s.listen(port, host);
});

export function isHealthy(url: string, apiKey?: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = http.get(`${url}/health`, { timeout: timeoutMs, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} }, (res) => {
        res.resume(); resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); } // an unparsable address is simply "not healthy"
  });
}

export class RoasterRuntime {
  readonly cfg: RuntimeConfig;
  private owned = new Map<string, ApiInstance>();
  private handlersInstalled = false;

  constructor(cfg: Partial<RuntimeConfig> = {}) { this.cfg = { ...DEFAULT_RUNTIME, ...cfg }; }

  /** Managed containers currently running, from any process (found by label). */
  async discover(): Promise<ApiInstance[]> {
    const out = await sh(this.cfg.docker, ['ps', '--filter', 'label=bluecheese.managed=1',
      '--format', '{{.Names}}|{{.Label "bluecheese.port"}}']);
    const found: ApiInstance[] = [];
    for (const line of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [name, p] = line.split('|');
      const port = Number(p);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue; // a container without a usable port label
      const url = `http://${this.cfg.bindHost}:${port}`;
      found.push(this.owned.get(name) ?? {
        name, port, url, profile: {}, owned: false,
        llm: new RoasterLLM({ baseUrl: url, model: 'roaster' }),
      });
    }
    return found;
  }

  list(): ApiInstance[] { return [...this.owned.values()]; }

  /* ------------------------------ roaster serve ------------------------------ */
  // BlueCheese never starts or stops `roaster serve`: you run it yourself. We only look for its socket.

  socketPath(): string { return path.join(this.cfg.socketDir, this.cfg.socketName); }

  /** Is there a Unix socket where `roaster serve` should be listening? (A cheap check; it does not connect.) */
  serveSocketPresent(): boolean {
    try { return fs.statSync(this.socketPath()).isSocket(); } catch { return false; }
  }

  /** Start one API server. Throws if the limit is reached or `serve` is not running. */
  async start(profile: ApiProfile = {}, port?: number): Promise<ApiInstance> {
    const [inst] = await this.startMany(1, profile, port === undefined ? undefined : [port]);
    return inst;
  }

  /** Start `count` API servers on consecutive free ports, in parallel. All use the same profile. */
  async startMany(count: number, profile: ApiProfile = {}, ports?: number[]): Promise<ApiInstance[]> {
    if (count < 1) throw new Error('count must be >= 1');
    validateProfile(profile);
    this.ensureServe();

    const running = await this.discover();
    if (running.length + count > this.cfg.maxApis) {
      throw new Error(`API limit: ${running.length} running + ${count} requested > maxApis=${this.cfg.maxApis}. ` +
        `Stop some (bc runtime down) or raise maxApis in bluecheese.config.json.`);
    }
    const chosen = ports ?? await this.allocatePorts(count, new Set(running.map((r) => r.port)));
    if (chosen.length !== count) throw new Error('ports/count mismatch');
    // start in parallel, but never leave half a batch running if one container fails
    const results = await Promise.allSettled(chosen.map((p) => this.startOne(p, profile)));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      await Promise.all(results.flatMap((r) => (r.status === 'fulfilled' ? [this.stop(r.value.name).catch(() => {})] : [])));
      throw failure.reason;
    }
    return results.map((r) => (r as PromiseFulfilledResult<ApiInstance>).value);
  }

  private ensureServe() {
    if (!this.serveSocketPresent()) {
      throw new Error(`No roaster serve socket at ${this.socketPath()}. Start \`roaster serve\` first (with the same socket folder), ` +
        `or set the socket folder in the settings (docker.socketDir).`);
    }
  }

  private async allocatePorts(count: number, taken: Set<number>): Promise<number[]> {
    const found: number[] = [];
    for (let p = this.cfg.basePort; p < this.cfg.basePort + 200 && found.length < count; p++) {
      if (!taken.has(p) && await portFree(p, this.cfg.bindHost)) found.push(p);
    }
    if (found.length < count) throw new Error(`Could not find ${count} free ports from ${this.cfg.basePort}`);
    return found;
  }

  private async startOne(port: number, profile: ApiProfile): Promise<ApiInstance> {
    const name = `${this.cfg.namePrefix}-${port}`;
    const args = buildDockerArgs(this.cfg, name, port, profile);
    const env = profile.apiKey ? { ...process.env, ROASTER_API_KEY: profile.apiKey } : process.env;
    await sh(this.cfg.docker, args, env);

    const url = `http://${this.cfg.bindHost}:${port}`;
    const inst: ApiInstance = {
      name, port, url, profile, owned: true,
      llm: new RoasterLLM({ baseUrl: url, model: profile.modelName ?? 'roaster', apiKey: profile.apiKey }),
    };
    this.owned.set(name, inst);

    const deadline = Date.now() + this.cfg.healthTimeoutMs;
    while (!(await isHealthy(url, profile.apiKey))) {
      if (Date.now() > deadline) {
        const logs = await sh(this.cfg.docker, ['logs', '--tail', '30', name]).catch(() => '(no logs)');
        await this.stop(name).catch(() => {});
        throw new Error(`${name} did not become healthy within ${this.cfg.healthTimeoutMs} ms. Last logs:\n${logs}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return inst;
  }

  /** Stop one API (by container name or port). Its sessions disappear with it. */
  async stop(nameOrPort: string | number): Promise<void> {
    const name = typeof nameOrPort === 'number' || /^\d+$/.test(String(nameOrPort))
      ? `${this.cfg.namePrefix}-${nameOrPort}` : String(nameOrPort);
    this.owned.delete(name);
    await sh(this.cfg.docker, ['stop', '-t', '5', name]);
  }

  /** Stop what this process started, or with `all`, every managed container (any process). */
  async stopAll(opts: { all?: boolean } = {}): Promise<string[]> {
    const names = opts.all ? (await this.discover()).map((i) => i.name) : [...this.owned.keys()];
    await Promise.all(names.map((n) => this.stop(n).catch(() => {})));
    return names;
  }

  /** Forget containers started here, so they keep running after this process exits (`bc runtime up`). */
  release(): void { this.owned.clear(); }

  /** Make sure containers started by this process are removed on exit, Ctrl+C and SIGTERM. */
  installExitHandlers(): void {
    if (this.handlersInstalled) return;
    this.handlersInstalled = true;
    const cleanup = () => {
      for (const name of this.owned.keys()) {
        try { execFileSync(this.cfg.docker, ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* already gone */ }
      }
      this.owned.clear();
    };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { cleanup(); process.exit(130); });
  }
}
