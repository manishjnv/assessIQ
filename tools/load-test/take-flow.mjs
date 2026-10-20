#!/usr/bin/env node
// Load test for the candidate take flow (about 500 students at the same time).
// Runbook: docs/runbooks/load-test-500.md. Never point this at production
// without the owner's written approval.
//
// Node 22, no dependencies (global fetch).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Public site hosts. A run against any of them is refused unless the owner flag is passed.
export const PRODUCTION_HOSTS = ['assessiq.in', 'www.assessiq.in', 'assessiq.automateedge.cloud'];

export const MAX_CONCURRENCY = 500;
export const WINDOW_MS = 30_000;
export const ERROR_RATE_LIMIT = 0.02; // 2 percent 5xx or network errors
export const P95_LIMIT_MS = 5_000;
export const MIN_WINDOW_SAMPLES = 20; // below this, the window is too small to judge

// Every route the script hits. Keep in step with the runbook.
export const ROUTES = [
  { label: 'take.preview', method: 'POST', path: '/take/start', note: 'anonymous landing summary, creates nothing' },
  { label: 'take.begin', method: 'POST', path: '/take/start', note: 'Begin click, consent true, sets aiq_sess cookie, creates attempt' },
  { label: 'me.attempt.get', method: 'GET', path: '/api/me/attempts/:id', note: 'load questions and timer' },
  { label: 'me.answer.save', method: 'POST', path: '/api/me/attempts/:id/answer', note: 'autosave one answer' },
  { label: 'me.attempt.submit', method: 'POST', path: '/api/me/attempts/:id/submit', note: 'final submit at end of window' },
];

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DEVICE = { coarsePointerOnly: false, maxTouchPoints: 0, screenWidth: 1920 };
const READINESS = {
  browser: { name: 'Chrome', version: '130' },
  screenWidth: 1920,
  screenHeight: 1080,
  downlinkMbps: 10,
  rttMs: 50,
};

// ---------- argument and config handling (exported for unit checks) ----------

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

function intOpt(raw, def, name, min, max, errors) {
  if (raw === undefined || raw === true) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}.`);
    return def;
  }
  return n;
}

// Returns { config, errors }. Refuses a missing BASE_URL and a production host.
export function buildConfig(args, env) {
  const errors = [];
  const rawBase = args['base-url'] ?? env.BASE_URL;
  let base = null;
  if (!rawBase || rawBase === true) {
    errors.push('BASE_URL is required. Set the BASE_URL environment variable or pass --base-url.');
  } else {
    try {
      const u = new URL(rawBase);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push('BASE_URL must start with http:// or https://.');
      else base = `${u.protocol}//${u.host}`;
    } catch {
      errors.push('BASE_URL is not a valid URL.');
    }
  }

  const config = {
    baseUrl: base,
    host: base ? new URL(base).hostname.toLowerCase() : null,
    concurrency: intOpt(args.concurrency ?? env.CONCURRENCY, 50, 'CONCURRENCY', 1, MAX_CONCURRENCY, errors),
    rampSeconds: intOpt(args['ramp-seconds'] ?? env.RAMP_SECONDS, 60, 'RAMP_SECONDS', 0, 3600, errors),
    durationSeconds: intOpt(args['duration-seconds'] ?? env.DURATION_SECONDS, 300, 'DURATION_SECONDS', 30, 7200, errors),
    maxRequests: intOpt(args['max-requests'] ?? env.MAX_REQUESTS, 50_000, 'MAX_REQUESTS', 1, 5_000_000, errors),
    tokensFile: args.tokens && args.tokens !== true ? args.tokens : env.TOKENS_FILE || null,
    dryRun: args['dry-run'] === true,
    outDir: join(HERE, 'out'),
  };

  if (config.host && PRODUCTION_HOSTS.includes(config.host) && args['i-am-sure-production'] !== true) {
    errors.push(
      `Refusing to run: ${config.host} is a production site host. The owner must approve the run. Read the runbook first.`,
    );
  }
  return { config, errors };
}

// Reads one invitation token per line. Blank lines and lines starting with # are skipped.
export function parseTokens(text) {
  const tokens = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  const dupes = tokens.length - new Set(tokens).size;
  if (dupes > 0) throw new Error(`Token file has ${dupes} duplicate token(s). Each invitation works once.`);
  return tokens;
}

// ---------- metrics ----------

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export const isErrorStatus = (status) => status === 0 || status >= 500;

// Pure stop check over the samples of the last 30 s. state holds p95BreachSince between ticks.
export function evaluateWindow(recent, now, state) {
  const total = recent.length;
  if (total < MIN_WINDOW_SAMPLES) {
    state.p95BreachSince = null;
    return null;
  }
  const errors = recent.filter((s) => isErrorStatus(s.status)).length;
  const rate = errors / total;
  if (rate > ERROR_RATE_LIMIT) {
    return `error rate ${(rate * 100).toFixed(1)} percent over the last 30 s (${errors} of ${total} requests were 5xx or network errors); limit is 2 percent`;
  }
  const p95 = percentile(recent.map((s) => s.ms).sort((a, b) => a - b), 95);
  if (p95 > P95_LIMIT_MS) {
    state.p95BreachSince ??= now;
    if (now - state.p95BreachSince >= WINDOW_MS) {
      return `p95 latency above 5 s for 30 s (last-window p95 ${Math.round(p95)} ms)`;
    }
  } else {
    state.p95BreachSince = null;
  }
  return null;
}

export function summarize(samples) {
  const byLabel = {};
  const statusCounts = {};
  for (const s of samples) {
    const key = s.status === 0 ? 'network' : String(s.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    (byLabel[s.label] ??= []).push(s);
  }
  const routes = {};
  for (const [label, list] of Object.entries(byLabel)) {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b);
    const counts = {};
    for (const s of list) counts[s.status === 0 ? 'network' : String(s.status)] = (counts[s.status === 0 ? 'network' : String(s.status)] ?? 0) + 1;
    routes[label] = {
      count: list.length,
      p50: Math.round(percentile(ms, 50)),
      p95: Math.round(percentile(ms, 95)),
      p99: Math.round(percentile(ms, 99)),
      errors5xxOrNetwork: list.filter((s) => isErrorStatus(s.status)).length,
      statuses: counts,
    };
  }
  return { routes, statusCounts };
}

function printTable(result) {
  const head = ['route', 'count', 'p50 ms', 'p95 ms', 'p99 ms', '5xx+net', 'statuses'];
  const rows = Object.entries(result.routes).map(([k, r]) => [
    k,
    String(r.count),
    String(r.p50),
    String(r.p95),
    String(r.p99),
    String(r.errors5xxOrNetwork),
    Object.entries(r.statuses).map(([s, n]) => `${s}:${n}`).join(' '),
  ]);
  const all = [head, ...rows];
  const widths = head.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  const line = (r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));
  console.log('');
  console.log(`requests: ${result.totals.requests}  requests/s: ${result.totals.requestsPerSecond}  5xx+network: ${result.totals.errors5xxOrNetwork}  429: ${result.totals.rateLimited429}`);
  console.log(`workers: started ${result.workers.started}, begun ${result.workers.begun}, submitted ${result.workers.submitted}, failed to begin ${result.workers.failedBegin}`);
  console.log(`stop reason: ${result.stopReason}`);
}

// ---------- HTTP helpers ----------

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

const jitter = (min, max) => min + Math.random() * (max - min);

export function extractCookie(setCookies, name) {
  for (const c of setCookies) {
    if (c.startsWith(`${name}=`)) return c.split(';')[0];
  }
  return null;
}

async function call(ctx, route, path, { body, cookie } = {}) {
  const headers = {
    Accept: 'application/json',
    Origin: ctx.config.baseUrl,
    'User-Agent': DESKTOP_UA,
    'Sec-CH-UA-Mobile': '?0',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const started = performance.now();
  let status = 0;
  let json = null;
  let res = null;
  try {
    res = await fetch(ctx.config.baseUrl + path, {
      method: route.method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctx.signal,
    });
    status = res.status;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
  } catch {
    status = 0;
  }
  if (ctx.stopped && status === 0) return { status: 0, json: null, res: null }; // aborted by a stop, not an error
  ctx.record(route.label, status, performance.now() - started);
  return { status, json, res };
}

// ---------- one candidate ----------

async function runCandidate(ctx, token, index) {
  const { config } = ctx;
  const startAt = Date.now();
  const deadline = startAt + config.durationSeconds * 1000;
  ctx.counts.started++;
  await sleep(index * (config.rampSeconds * 1000) / config.concurrency, ctx.signal);
  if (ctx.stopped) return;
  const begunDeadline = Date.now() + config.durationSeconds * 1000;

  const pv = await call(ctx, ROUTES[0], '/take/start', { body: { token, preview: true } });
  if (pv.status !== 200) return ctx.counts.failedBegin++;

  const begin = await call(ctx, ROUTES[1], '/take/start', {
    body: { token, consent: true, device: DEVICE, readiness: READINESS },
  });
  const cookieHeader = begin.res ? extractCookie(begin.res.headers.getSetCookie?.() ?? [], 'aiq_sess') : null;
  if (begin.status !== 201 || !begin.json?.attempt_id || !cookieHeader) return ctx.counts.failedBegin++;
  ctx.counts.begun++;
  const attemptId = begin.json.attempt_id;
  const cookie = cookieHeader;

  const view = await call(ctx, ROUTES[2], `/api/me/attempts/${attemptId}`, { cookie });
  const answerable = (view.json?.questions ?? []).filter((q) => q.type === 'mcq' || q.type === 'subjective');
  let rev = 0;
  let turn = 0;
  while (!ctx.stopped && Date.now() < Math.min(deadline, begunDeadline) && answerable.length > 0) {
    await sleep(jitter(5_000, 9_000), ctx.signal); // a few seconds between autosaves
    if (ctx.stopped || Date.now() >= deadline) break;
    const q = answerable[turn % answerable.length];
    turn++;
    const answer = q.type === 'mcq' ? { selected: Math.floor(Math.random() * 2) } : { response: `load test answer ${turn}` };
    const saved = await call(ctx, ROUTES[3], `/api/me/attempts/${attemptId}/answer`, {
      cookie,
      body: { question_id: q.question_id, answer, client_revision: rev, time_spent_seconds: 7 },
    });
    const header = Number.parseInt(saved.res?.headers.get('X-Client-Revision') ?? '', 10);
    rev = Number.isFinite(header) ? header : rev + 1;
    if (turn % 6 === 0) await call(ctx, ROUTES[2], `/api/me/attempts/${attemptId}`, { cookie });
  }

  if (ctx.stopped) return;
  const submit = await call(ctx, ROUTES[4], `/api/me/attempts/${attemptId}/submit`, { cookie, body: {} });
  if (submit.status >= 200 && submit.status < 300) ctx.counts.submitted++;
}

// ---------- run ----------

async function run(config, tokens) {
  const controller = new AbortController();
  const samples = [];
  const recent = [];
  const counts = { started: 0, begun: 0, submitted: 0, failedBegin: 0 };
  const ctx = {
    config,
    counts,
    signal: controller.signal,
    stopped: false,
    stopReason: null,
    startedAt: new Date(),
    record(label, status, ms) {
      const s = { t: Date.now(), label, status, ms };
      samples.push(s);
      recent.push(s);
      if (samples.length >= config.maxRequests) stop(`STOP LIMIT: MAX_REQUESTS reached (${config.maxRequests})`);
    },
  };
  const stop = (reason) => {
    if (ctx.stopped) return;
    ctx.stopped = true;
    ctx.stopReason = reason;
    controller.abort();
  };
  ctx.stop = stop;

  const state = { p95BreachSince: null };
  const monitor = setInterval(() => {
    const now = Date.now();
    while (recent.length && recent[0].t < now - WINDOW_MS) recent.shift();
    const reason = evaluateWindow(recent, now, state);
    if (reason) stop(`STOP LIMIT: ${reason}`);
  }, 1000);
  const onSigint = () => stop('interrupted by operator (Ctrl+C)');
  process.on('SIGINT', onSigint);

  const t0 = Date.now();
  const workers = tokens.slice(0, config.concurrency).map((tok, i) => runCandidate(ctx, tok, i));
  await Promise.allSettled(workers);
  clearInterval(monitor);
  process.off('SIGINT', onSigint);
  const finishedAt = new Date();
  if (!ctx.stopped) ctx.stopReason = 'completed: all workers finished their window';

  const elapsed = (Date.now() - t0) / 1000;
  const errors = samples.filter((s) => isErrorStatus(s.status)).length;
  const { routes, statusCounts } = summarize(samples);
  const result = {
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stopReason: ctx.stopReason,
    config: {
      baseUrl: config.baseUrl,
      concurrency: config.concurrency,
      rampSeconds: config.rampSeconds,
      durationSeconds: config.durationSeconds,
      maxRequests: config.maxRequests,
    },
    totals: {
      requests: samples.length,
      requestsPerSecond: Number((samples.length / Math.max(elapsed, 0.001)).toFixed(1)),
      errors5xxOrNetwork: errors,
      errorRate: samples.length ? Number((errors / samples.length).toFixed(4)) : 0,
      rateLimited429: statusCounts['429'] ?? 0,
      elapsedSeconds: Number(elapsed.toFixed(1)),
    },
    statusCounts,
    routes,
    workers: { ...counts },
  };
  return result;
}

function usage() {
  return `take-flow.mjs - candidate take-flow load test (about 500 students)

Usage:
  node tools/load-test/take-flow.mjs --base-url <url> --tokens <file> [options]
  node tools/load-test/take-flow.mjs --help

Required:
  BASE_URL or --base-url   Origin of the TEST server, for example https://test.example.com
  --tokens <file>          One invitation token per line, for a TEST TENANT. Create them first.

Options (flag or env var of the same name):
  --concurrency / CONCURRENCY           Simulated candidates, 1 to ${MAX_CONCURRENCY}. Default 50.
  --ramp-seconds / RAMP_SECONDS         Seconds to start all candidates. Default 60.
  --duration-seconds / DURATION_SECONDS Seconds each candidate stays in the test. Default 300.
  --max-requests / MAX_REQUESTS         Stop after this many requests. Default 50000.
  --dry-run                             Print the plan and check inputs. Sends no request.
  --i-am-sure-production                Allow a production host. NEVER pass this without the owner.

Stop limits (abort all workers, print the reason):
  error rate above 2 percent (5xx or network) over any 30 s window
  p95 latency above 5 s for 30 s
  total requests above MAX_REQUESTS

Exit codes: 0 completed, 2 bad input, 3 production refused, 4 stopped by a limit, 1 crash.

Routes hit:
${ROUTES.map((r) => `  ${r.method.padEnd(4)} ${r.path.padEnd(32)} ${r.label}`).join('\n')}

Output: JSON in tools/load-test/out/ (gitignored). Tokens are never written.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) {
    console.log(usage());
    return 0;
  }
  const { config, errors } = buildConfig(args, process.env);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    const refused = errors.some((e) => e.startsWith('Refusing'));
    return refused ? 3 : 2;
  }
  if (!config.tokensFile) {
    console.error('error: --tokens <file> is required (one invitation token per line, test tenant only).');
    return 2;
  }
  let tokens;
  try {
    tokens = parseTokens(readFileSync(config.tokensFile, 'utf8'));
  } catch (e) {
    console.error(`error: cannot read tokens: ${e.message}`);
    return 2;
  }
  if (tokens.length < config.concurrency) {
    console.error(`error: ${tokens.length} token(s) for concurrency ${config.concurrency}. Create one token per candidate.`);
    return 2;
  }

  if (config.dryRun) {
    console.log('DRY RUN. No request is sent.');
    console.log(JSON.stringify({ ...config, tokensFile: '(given)', tokensLoaded: tokens.length }, null, 2));
    console.log('Routes:');
    for (const r of ROUTES) console.log(`  ${r.method} ${r.path} (${r.label}): ${r.note}`);
    console.log(`Stop limits: error rate > ${ERROR_RATE_LIMIT * 100}% over ${WINDOW_MS / 1000} s; p95 > ${P95_LIMIT_MS} ms for ${WINDOW_MS / 1000} s; requests > ${config.maxRequests}.`);
    return 0;
  }

  console.log(`Starting: ${config.concurrency} candidates against ${config.baseUrl}, ramp ${config.rampSeconds} s, window ${config.durationSeconds} s.`);
  const result = await run(config, tokens);
  printTable(result);

  mkdirSync(config.outDir, { recursive: true });
  const file = join(config.outDir, `take-flow-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`Result written to ${file}`);
  return result.stopReason.startsWith('STOP LIMIT') ? 4 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
