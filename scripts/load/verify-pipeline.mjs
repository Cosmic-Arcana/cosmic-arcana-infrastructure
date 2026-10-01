#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = ['compose', '-f', 'compose/application.yml', '-f', 'compose/load.yml'];
const SERVICES = ['tarot-service-api', 'ai-service-api', 'history-service-api'];
const QUEUE = 'spread.created';
const HISTORY_URL = process.env.HISTORY_URL ?? 'http://localhost:3005';
const REQUIRED_LOG_FIELDS = ['timestamp', 'level', 'service', 'correlationId', 'context', 'message'];
const ALLOWED_LEVELS = new Set(['error', 'warn', 'log', 'debug']);
const BOOTSTRAP_CONTEXTS = new Set(['NestFactory', 'InstanceLoader', 'RoutesResolver', 'RouterExplorer', 'NestApplication', 'NestMicroservice', 'Bootstrap', 'LiveSpreadsHub']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseArgs = (argv) => {
  const options = {
    run: null,
    mode: 'final',
    seed: 1,
    interval: 30,
    drainTimeout: 600,
    fidelity: 500,
    apiUsers: 200,
    pageLimit: 3,
    traces: 100,
    questions: 2000,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in options)) throw new Error(`unknown flag ${argv[i]}`);
    options[key] = typeof options[key] === 'number' ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!options.run) throw new Error('--run <dir> is required');
  if (!['live', 'final'].includes(options.mode)) throw new Error('--mode must be live or final');
  options.run = path.resolve(process.cwd(), options.run);
  return options;
};

const seededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sample = (items, count, random) => {
  const copy = [...items];
  const take = Math.min(count, copy.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
};

const percentiles = (values) => {
  if (values.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const sorted = Float64Array.from(values).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  const round = (v) => Math.round(v * 10) / 10;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) };
};

const pool = async (items, concurrency, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
};

const docker = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', [...COMPOSE, ...args], { cwd: INFRA_ROOT });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString('utf8'));
      const stderr = Buffer.concat(err)
        .toString('utf8')
        .split('\n')
        .filter((line) => line && !line.includes('variable is not set'))
        .join(' ');
      reject(new Error(`docker ${args.slice(0, 3).join(' ')} exited ${code}: ${stderr.slice(0, 500)}`));
    });
    child.stdin.end(input ?? '');
  });

const DATABASES = { tarot: ['tarot-db', 'tarot'], history: ['history-db', 'history'] };

const psql = async (db, sql) => {
  const [container, user] = DATABASES[db];
  const out = await docker(
    ['exec', '-T', container, 'psql', '-U', user, '-d', user, '-At', '-F', '\t', '-q', '-v', 'ON_ERROR_STOP=1'],
    sql,
  );
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
};

const psqlJson = async (db, sql) => (await psql(db, sql)).map(([line]) => JSON.parse(line));

const ms = (column) => `(extract(epoch from ${column}) * 1000)::float8`;
const num = (value) => (value === '' || value === undefined ? null : Number(value));
const sqlIds = (ids) => ids.map((id) => `'${id}'`).join(',');

const queueCounts = async () => {
  const keys = [
    ['wait', 'LLEN'],
    ['active', 'LLEN'],
    ['paused', 'LLEN'],
    ['prioritized', 'ZCARD'],
    ['delayed', 'ZCARD'],
    ['waiting-children', 'ZCARD'],
    ['failed', 'ZCARD'],
    ['completed', 'ZCARD'],
  ];
  const out = await docker(
    ['exec', '-T', 'redis', 'redis-cli'],
    keys.map(([key, cmd]) => `${cmd} bull:${QUEUE}:${key}`).join('\n') + '\n',
  );
  const values = out.trim().split('\n').map(Number);
  const counts = Object.fromEntries(keys.map(([key], i) => [key, values[i]]));
  counts.waiting = counts.wait + counts.paused + counts.prioritized + counts.delayed;
  return counts;
};

const failedJobSamples = async () => {
  const ids = (await docker(['exec', '-T', 'redis', 'redis-cli'], `ZRANGE bull:${QUEUE}:failed 0 4\n`))
    .trim()
    .split('\n')
    .filter(Boolean);
  const reasons = [];
  for (const id of ids) {
    const reason = await docker(['exec', '-T', 'redis', 'redis-cli'], `HGET bull:${QUEUE}:${id} failedReason\n`);
    reasons.push({ jobId: id, failedReason: reason.trim().slice(0, 300) });
  }
  return reasons;
};

class RequestLog {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.rows = [];
    this.malformed = 0;
  }

  poll({ flush = false } = {}) {
    if (!existsSync(this.file)) return this.rows;
    const fd = openSync(this.file, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size > this.offset) {
        const chunk = Buffer.alloc(size - this.offset);
        readSync(fd, chunk, 0, chunk.length, this.offset);
        this.offset = size;
        this.rest = Buffer.concat([this.rest, chunk]);
      }
    } finally {
      closeSync(fd);
    }
    // Only decode up to the last newline: the writer may be mid-line or mid-multibyte-character.
    const cut = flush ? this.rest.length : this.rest.lastIndexOf(0x0a) + 1;
    if (cut > 0) {
      for (const line of this.rest.subarray(0, cut).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.rows.push(JSON.parse(line));
        } catch {
          this.malformed += 1;
        }
      }
      this.rest = this.rest.subarray(cut);
    }
    return this.rows;
  }
}

const createLeakScanner = (questions) => {
  const prefixLength = 12;
  const candidates = [...new Set(questions)].filter((q) => q.length >= prefixLength);
  const byPrefix = new Map();
  for (const question of candidates) {
    const key = question.slice(0, prefixLength);
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(question);
  }
  const minLength = candidates.length ? Math.min(...candidates.map((q) => q.length)) : Infinity;
  const scanText = (text) => {
    if (text.length < minLength || UUID_RE.test(text)) return null;
    for (let i = 0; i <= text.length - minLength; i += 1) {
      const hits = byPrefix.get(text.substr(i, prefixLength));
      if (!hits) continue;
      for (const question of hits) if (text.startsWith(question, i)) return question;
    }
    return null;
  };
  const scanValue = (value) => {
    if (typeof value === 'string') return scanText(value);
    if (value && typeof value === 'object') {
      for (const inner of Object.values(value)) {
        const hit = scanValue(inner);
        if (hit) return hit;
      }
    }
    return null;
  };
  return { scanText, scanValue, sampled: candidates.length };
};

const TRACE_STEPS = {
  'tarot:inbound POST /spreads': (s, e) =>
    s === 'tarot-service-api' && e.message === 'inbound handled' && e.method === 'POST' && e.route === '/spreads',
  'tarot:outbound ai call': (s, e) => s === 'tarot-service-api' && e.context === 'AiSpreadGenerator' && e.message === 'outbound call completed',
  'tarot:outbox publish': (s, e) => s === 'tarot-service-api' && e.context === 'OutboxRelay' && e.message === 'outbound publish completed',
  'ai:draw': (s, e) => s === 'ai-service-api' && e.message === 'inbound handled' && e.messagePattern === 'draw',
  'ai:interpret': (s, e) => s === 'ai-service-api' && e.message === 'inbound handled' && e.messagePattern === 'interpret',
  'history:job handled': (s, e) => s === 'history-service-api' && e.context === 'SpreadCreatedProcessor' && e.message === 'inbound job handled',
};

const scanServiceLogs = (service, { leak, traceIds, traces, jobOutcomes }) =>
  new Promise((resolve, reject) => {
    const stats = {
      service,
      lines: 0,
      nonJson: 0,
      nonJsonSamples: [],
      missingField: {},
      nullField: {},
      nullCorrelationByMessage: {},
      levels: {},
      unexpectedLevels: {},
      wrongServiceName: 0,
      nonLowercaseMessages: {},
      warnErrorGroups: {},
      questionLeaks: 0,
      questionLeakSamples: [],
    };
    const child = spawn('docker', [...COMPOSE, 'logs', '--no-log-prefix', service], { cwd: INFRA_ROOT });
    child.stderr.resume();
    child.on('error', reject);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.length === 0) return;
      stats.lines += 1;
      let entry = null;
      if (line.startsWith('{')) {
        try {
          entry = JSON.parse(line);
        } catch {
          entry = null;
        }
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        stats.nonJson += 1;
        if (stats.nonJsonSamples.length < 5) stats.nonJsonSamples.push(line.slice(0, 300));
        const hit = leak.scanText(line);
        if (hit) {
          stats.questionLeaks += 1;
          if (stats.questionLeakSamples.length < 5) stats.questionLeakSamples.push(line.slice(0, 400));
        }
        return;
      }
      for (const field of REQUIRED_LOG_FIELDS) {
        if (!(field in entry)) stats.missingField[field] = (stats.missingField[field] ?? 0) + 1;
        else if (entry[field] === null || entry[field] === '') {
          stats.nullField[field] = (stats.nullField[field] ?? 0) + 1;
          if (field === 'correlationId') {
            const key = `${entry.context}|${entry.message}`;
            stats.nullCorrelationByMessage[key] = (stats.nullCorrelationByMessage[key] ?? 0) + 1;
          }
        }
      }
      stats.levels[entry.level] = (stats.levels[entry.level] ?? 0) + 1;
      if (!ALLOWED_LEVELS.has(entry.level)) stats.unexpectedLevels[entry.level] = (stats.unexpectedLevels[entry.level] ?? 0) + 1;
      if (entry.service !== service) stats.wrongServiceName += 1;
      if (typeof entry.message === 'string' && entry.message !== entry.message.toLowerCase()) {
        stats.nonLowercaseMessages[entry.message.slice(0, 80)] = (stats.nonLowercaseMessages[entry.message.slice(0, 80)] ?? 0) + 1;
      }
      if (entry.level === 'warn' || entry.level === 'error' || entry.level === 'fatal') {
        const key = `${entry.level}|${entry.context}|${entry.message}|${entry.errorName ?? ''}|${(entry.errorMessage ?? '').slice(0, 120)}`;
        const group = (stats.warnErrorGroups[key] ??= { count: 0, sample: line.slice(0, 500) });
        group.count += 1;
      }
      const hit = leak.scanValue(entry);
      if (hit) {
        stats.questionLeaks += 1;
        if (stats.questionLeakSamples.length < 5) stats.questionLeakSamples.push(line.slice(0, 400));
      }
      if (traceIds.has(entry.correlationId)) {
        const trace = traces.get(entry.correlationId);
        for (const [step, matches] of Object.entries(TRACE_STEPS)) if (matches(service, entry)) trace[step] = (trace[step] ?? 0) + 1;
      }
      if (service === 'history-service-api' && entry.context === 'SpreadCreatedProcessor' && entry.message === 'inbound job handled') {
        const outcomes = (jobOutcomes[entry.eventId] ??= {});
        outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
      }
    });
    lines.on('close', () => resolve(stats));
  });

const loadRequests = (runDir) => {
  const log = new RequestLog(path.join(runDir, 'requests.ndjson'));
  log.poll({ flush: true });
  return { rows: log.rows, malformed: log.malformed };
};

const deepEqualStructural = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => deepEqualStructural(item, b[i]));
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  return keysA.length === keysB.length && keysA.every((key, i) => key === keysB[i] && deepEqualStructural(a[key], b[key]));
};

const check = (id, name, failures, metrics, evidence = {}, notes = []) => ({
  id,
  name,
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  failures,
  metrics,
  evidence,
  notes,
});

const fetchHistoryPage = async (userId, limit, cursor) => {
  const url = new URL(`/users/${userId}/spread-history`, HISTORY_URL);
  url.searchParams.set('limit', String(limit));
  if (cursor) url.searchParams.set('cursor', cursor);
  const headers = { accept: 'application/json', 'x-correlation-id': `verify-${randomUUID()}` };
  if (process.env.INTERNAL_SERVICE_TOKEN) headers['x-internal-token'] = process.env.INTERNAL_SERVICE_TOKEN;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${url.pathname} -> ${response.status}`);
  return response.json();
};

const runFinal = async (options, drain = null) => {
  const random = seededRandom(options.seed);
  const startedAt = Date.now();
  const { rows, malformed } = loadRequests(options.run);
  const summaryPath = path.join(options.run, 'summary.json');
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;

  const [spreadRows, cardRows, outboxRows, historyRows, inboxRows, queue] = await Promise.all([
    psql('tarot', `select id, user_id, idempotency_key, ${ms('created_at')} from spread`),
    psql('tarot', 'select spread_id, count(*) from spread_card group by spread_id'),
    psql(
      'tarot',
      `select id, aggregate_id, event_type, status, correlation_id, ${ms('created_at')}, ${ms('published_at')} from outbox`,
    ),
    psql(
      'history',
      `select spread_id, user_id, ${ms('created_at')}, ${ms('projected_at')}, (deleted_at is not null) from spread_history`,
    ),
    psql('history', `select event_id, event_type, ${ms('processed_at')} from inbox`),
    queueCounts(),
  ]);

  const tarot = new Map(spreadRows.map(([id, userId, key, created]) => [id, { id, userId, key, createdMs: num(created) }]));
  const tarotByKey = new Map([...tarot.values()].map((s) => [s.key, s]));
  const tarotByUser = new Map();
  for (const s of tarot.values()) {
    if (!tarotByUser.has(s.userId)) tarotByUser.set(s.userId, new Set());
    tarotByUser.get(s.userId).add(s.id);
  }
  const cardCounts = new Map(cardRows.map(([id, count]) => [id, Number(count)]));
  const outboxByAggregate = new Map();
  const outboxIds = new Set();
  for (const [id, aggregateId, eventType, status, correlationId, created, published] of outboxRows) {
    outboxIds.add(id);
    if (!outboxByAggregate.has(aggregateId)) outboxByAggregate.set(aggregateId, []);
    outboxByAggregate
      .get(aggregateId)
      .push({ id, eventType, status, correlationId, createdMs: num(created), publishedMs: num(published) });
  }
  const historyCounts = new Map();
  const history = new Map();
  for (const [spreadId, userId, created, projected, deleted] of historyRows) {
    historyCounts.set(spreadId, (historyCounts.get(spreadId) ?? 0) + 1);
    history.set(spreadId, { spreadId, userId, createdMs: num(created), projectedMs: num(projected), deleted: deleted === 't' });
  }
  const inbox = new Map(inboxRows.map(([eventId, eventType, processed]) => [eventId, { eventType, processedMs: num(processed) }]));

  const byStatus = {};
  const byKindStatus = {};
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    byKindStatus[`${row.kind}:${row.status}`] = (byKindStatus[`${row.kind}:${row.status}`] ?? 0) + 1;
  }
  const created = rows.filter((r) => r.status === 201);
  const replays = rows.filter((r) => r.status === 200);
  const conflicts = rows.filter((r) => r.status === 409);
  const others = rows.filter((r) => ![200, 201, 409].includes(r.status));
  const createdById = new Map();
  const createdByKey = new Map();
  const dupSpreadIds = [];
  const dupKeys = [];
  for (const row of created) {
    if (createdById.has(row.spreadId)) dupSpreadIds.push(row.spreadId);
    else createdById.set(row.spreadId, row);
    if (createdByKey.has(row.idempotencyKey)) dupKeys.push(row.idempotencyKey);
    else createdByKey.set(row.idempotencyKey, row);
  }
  const runSpreadIds = [...createdById.keys()];
  const runKeys = new Set(rows.map((r) => r.idempotencyKey));

  const checks = [];

  {
    const missing = runSpreadIds.filter((id) => !tarot.has(id));
    const mismatched = runSpreadIds.filter((id) => {
      const s = tarot.get(id);
      const r = createdById.get(id);
      return s && (s.userId !== r.userId || s.key !== r.idempotencyKey);
    });
    const createdReplayedFlag = created.filter((r) => r.replayed === true).map((r) => r.n);
    const wrongCardCount = runSpreadIds.filter((id) => tarot.has(id) && cardCounts.get(id) !== 3);
    const wrongReplays = replays.filter((r) => {
      const original = createdByKey.get(r.idempotencyKey)?.spreadId ?? tarotByKey.get(r.idempotencyKey)?.id;
      return r.spreadId !== original || r.replayed !== true;
    });
    const conflictWrong = conflicts.filter((r) => {
      const stored = tarotByKey.get(r.idempotencyKey);
      return stored && (!createdById.has(stored.id) || stored.userId !== createdByKey.get(r.idempotencyKey)?.userId);
    });
    const runKeyRows = [...tarot.values()].filter((s) => runKeys.has(s.key));
    const extraRows = runKeyRows.filter((s) => !createdById.has(s.id));
    const kindMismatch = rows.filter(
      (r) => (r.kind === 'create' && r.status !== 201) || (r.kind === 'replay' && r.status !== 200) || (r.kind === 'conflict' && r.status !== 409),
    );
    const failures = [];
    if (missing.length) failures.push(`${missing.length} 201 spreads missing in tarot`);
    if (dupSpreadIds.length) failures.push(`${dupSpreadIds.length} spreadIds returned by more than one 201`);
    if (dupKeys.length) failures.push(`${dupKeys.length} idempotency keys got more than one 201`);
    if (mismatched.length) failures.push(`${mismatched.length} tarot rows disagree with request userId/key`);
    if (createdReplayedFlag.length) failures.push(`${createdReplayedFlag.length} 201s flagged replayed`);
    if (wrongReplays.length) failures.push(`${wrongReplays.length} replays returned a different spreadId or replayed!=true`);
    if (conflictWrong.length) failures.push(`${conflictWrong.length} conflict keys point to a non-run spread`);
    if (extraRows.length) failures.push(`${extraRows.length} tarot rows for run keys without a 201`);
    if (others.length) failures.push(`${others.length} requests with status outside 200/201/409`);
    if (kindMismatch.length) failures.push(`${kindMismatch.length} kind/status mismatches`);
    if (wrongCardCount.length) failures.push(`${wrongCardCount.length} run spreads without exactly 3 cards`);
    if (malformed) failures.push(`${malformed} malformed requests.ndjson lines`);
    const otherByStatus = {};
    for (const r of others) {
      const key = `${r.status}`;
      otherByStatus[key] ??= { count: 0, samples: [] };
      otherByStatus[key].count += 1;
      if (otherByStatus[key].samples.length < 5) otherByStatus[key].samples.push({ n: r.n, kind: r.kind, error: r.error ?? null });
    }
    checks.push(
      check(
        1,
        'idempotent writes',
        failures,
        {
          requests: rows.length,
          byKindStatus,
          created201: created.length,
          uniqueRunSpreads: runSpreadIds.length,
          presentInTarot: runSpreadIds.length - missing.length,
          replays200: replays.length,
          conflicts409: conflicts.length,
          tarotRowsForRunKeys: runKeyRows.length,
        },
        {
          missing: missing.slice(0, 5),
          dupSpreadIds: dupSpreadIds.slice(0, 5),
          wrongReplays: wrongReplays.slice(0, 5).map((r) => ({ n: r.n, spreadId: r.spreadId, replayed: r.replayed })),
          extraRows: extraRows.slice(0, 5).map((s) => s.id),
          otherStatuses: otherByStatus,
          kindMismatch: kindMismatch.slice(0, 5).map((r) => ({ n: r.n, kind: r.kind, status: r.status })),
          wrongCardCount: wrongCardCount.slice(0, 5),
        },
      ),
    );
  }

  const runEventIds = [];
  {
    const notOne = [];
    const unpublished = [];
    const correlationMismatch = [];
    const publishLag = [];
    for (const id of runSpreadIds) {
      const events = (outboxByAggregate.get(id) ?? []).filter((e) => e.eventType === 'spread.created');
      if (events.length !== 1) notOne.push({ spreadId: id, count: events.length });
      for (const event of events) {
        runEventIds.push(event.id);
        if (event.status !== 'published' || event.publishedMs === null) unpublished.push(event.id);
        else publishLag.push(event.publishedMs - event.createdMs);
        const requested = createdById.get(id).correlationId;
        if (requested && requested !== event.correlationId) correlationMismatch.push({ spreadId: id, requested, stored: event.correlationId });
      }
    }
    const pendingGlobal = outboxRows.filter((r) => r[3] !== 'published');
    const now = Date.now();
    const oldestPendingS = pendingGlobal.length ? Math.round((now - Math.min(...pendingGlobal.map((r) => num(r[5])))) / 1000) : 0;
    const failures = [];
    if (notOne.length) failures.push(`${notOne.length} run spreads without exactly one spread.created row`);
    if (unpublished.length) failures.push(`${unpublished.length} run events not published`);
    if (pendingGlobal.length) failures.push(`${pendingGlobal.length} outbox rows pending overall (oldest ${oldestPendingS}s)`);
    if (correlationMismatch.length) failures.push(`${correlationMismatch.length} outbox correlationIds differ from the request`);
    checks.push(
      check(
        2,
        'outbox',
        failures,
        { runEvents: runEventIds.length, published: runEventIds.length - unpublished.length, pendingGlobal: pendingGlobal.length, publishLagMs: percentiles(publishLag) },
        { notOne: notOne.slice(0, 5), unpublished: unpublished.slice(0, 5), correlationMismatch: correlationMismatch.slice(0, 5) },
        ['outbox.created_at is set to spread.created_at (request receipt, before the ai draw/interpret calls), so publish lag includes generation time'],
      ),
    );
  }

  const logContext = {
    leak: createLeakScanner(sample([...new Set(rows.map((r) => r.question))], options.questions, random)),
    traceIds: new Set(),
    traces: new Map(),
    jobOutcomes: {},
  };
  const traceSample = sample(runSpreadIds, options.traces, random).map((id) => {
    const event = (outboxByAggregate.get(id) ?? [])[0];
    return { spreadId: id, correlationId: event?.correlationId ?? createdById.get(id).correlationId };
  });
  for (const { correlationId } of traceSample) {
    logContext.traceIds.add(correlationId);
    logContext.traces.set(correlationId, {});
  }
  const logStats = await Promise.all(SERVICES.map((service) => scanServiceLogs(service, logContext)));

  {
    const missing = runSpreadIds.filter((id) => !history.has(id));
    const duplicated = [...historyCounts].filter(([, count]) => count > 1).map(([id]) => id);
    const runUsers = new Set(created.map((r) => r.userId));
    const notInTarot = [...history.keys()].filter((id) => !tarot.has(id));
    const extraForRunUsers = [...history.values()].filter((h) => runUsers.has(h.userId) && !createdById.has(h.spreadId));
    const userMismatch = runSpreadIds.filter((id) => history.has(id) && history.get(id).userId !== tarot.get(id)?.userId);
    const createdMismatch = runSpreadIds.filter((id) => history.has(id) && tarot.has(id) && Math.abs(history.get(id).createdMs - tarot.get(id).createdMs) > 0.5);
    const deleted = runSpreadIds.filter((id) => history.get(id)?.deleted);
    const inboxMissing = runEventIds.filter((id) => !inbox.has(id));
    const inboxNotInOutbox = [...inbox.keys()].filter((id) => !outboxIds.has(id));
    const inboxWrongType = runEventIds.filter((id) => inbox.has(id) && inbox.get(id).eventType !== 'spread.created');
    const appliedTwice = Object.entries(logContext.jobOutcomes).filter(([, o]) => (o.applied ?? 0) > 1).map(([id, o]) => ({ eventId: id, ...o }));
    const runEventSet = new Set(runEventIds);
    let duplicateOutcomes = 0;
    let appliedForRun = 0;
    for (const [eventId, outcomes] of Object.entries(logContext.jobOutcomes)) {
      duplicateOutcomes += outcomes.duplicate ?? 0;
      if (runEventSet.has(eventId) && outcomes.applied) appliedForRun += 1;
    }
    const failures = [];
    if (missing.length) failures.push(`${missing.length} run spreads missing in spread_history`);
    if (duplicated.length) failures.push(`${duplicated.length} duplicated spread_history rows`);
    if (notInTarot.length) failures.push(`${notInTarot.length} spread_history rows with no tarot spread`);
    if (extraForRunUsers.length) failures.push(`${extraForRunUsers.length} extra spread_history rows for run users`);
    if (userMismatch.length) failures.push(`${userMismatch.length} history rows with a different userId`);
    if (createdMismatch.length) failures.push(`${createdMismatch.length} history rows with a different createdAt`);
    if (inboxMissing.length) failures.push(`${inboxMissing.length} published run events missing from inbox`);
    if (inboxNotInOutbox.length) failures.push(`${inboxNotInOutbox.length} inbox rows with no outbox event`);
    if (inboxWrongType.length) failures.push(`${inboxWrongType.length} inbox rows with the wrong event type`);
    if (appliedTwice.length) failures.push(`${appliedTwice.length} events applied more than once (logs)`);
    checks.push(
      check(
        3,
        'history projection',
        failures,
        {
          runSpreads: runSpreadIds.length,
          historyRows: runSpreadIds.length - missing.length,
          softDeleted: deleted.length,
          inboxRowsForRun: runEventIds.length - inboxMissing.length,
          appliedLogLinesForRun: appliedForRun,
          duplicateDeliveriesAbsorbed: duplicateOutcomes,
        },
        {
          missing: missing.slice(0, 5),
          duplicated: duplicated.slice(0, 5),
          notInTarot: notInTarot.slice(0, 5),
          extraForRunUsers: extraForRunUsers.slice(0, 5).map((h) => h.spreadId),
          inboxMissing: inboxMissing.slice(0, 5),
          inboxNotInOutbox: inboxNotInOutbox.slice(0, 5),
          appliedTwice: appliedTwice.slice(0, 5),
        },
      ),
    );
  }

  {
    const ids = sample(runSpreadIds.filter((id) => tarot.has(id) && history.has(id)), options.fidelity, random);
    let tarotDetails = [];
    let historyDetails = [];
    if (ids.length) {
      [tarotDetails, historyDetails] = await Promise.all([
        psqlJson(
          'tarot',
          `select json_build_object('id', s.id, 'userId', s.user_id, 'question', s.question, 'prediction', s.prediction,
             'createdMs', ${ms('s.created_at')},
             'cards', coalesce((select json_agg(json_build_object('positionKey', c.position_key, 'cardId', c.card_id, 'reversed', c.reversed) order by c.ordinal)
                                from spread_card c where c.spread_id = s.id), '[]'::json))
           from spread s where s.id in (${sqlIds(ids)})`,
        ),
        psqlJson(
          'history',
          `select json_build_object('id', spread_id, 'userId', user_id, 'question', question, 'prediction', prediction,
             'createdMs', ${ms('created_at')}, 'cards', cards)
           from spread_history where spread_id in (${sqlIds(ids)})`,
        ),
      ]);
    }
    const historyById = new Map(historyDetails.map((h) => [h.id, h]));
    const mismatches = [];
    for (const t of tarotDetails) {
      const h = historyById.get(t.id);
      const fields = [];
      if (!h) fields.push('missing');
      else {
        if (t.userId !== h.userId) fields.push('userId');
        if (t.question !== h.question) fields.push('question');
        if (t.prediction !== h.prediction) fields.push('prediction');
        if (Math.abs(t.createdMs - h.createdMs) > 0.5) fields.push('createdAt');
        if (!deepEqualStructural(t.cards, h.cards)) fields.push('cards');
      }
      if (fields.length) mismatches.push({ spreadId: t.id, fields });
    }
    const failures = [];
    if (tarotDetails.length !== ids.length) failures.push(`fetched ${tarotDetails.length}/${ids.length} tarot spreads`);
    if (mismatches.length) failures.push(`${mismatches.length}/${ids.length} sampled spreads differ`);
    checks.push(check(4, 'fidelity tarot vs history', failures, { sampled: ids.length, matched: ids.length - mismatches.length }, { mismatches: mismatches.slice(0, 5) }));
  }

  {
    const users = sample([...new Set(created.map((r) => r.userId))], options.apiUsers, random);
    const problems = [];
    let pages = 0;
    let items = 0;
    let maxPages = 0;
    await pool(users, 8, async (userId) => {
      const seen = new Set();
      const ordered = [];
      let cursor = null;
      let userPages = 0;
      try {
        do {
          const page = await fetchHistoryPage(userId, options.pageLimit, cursor);
          userPages += 1;
          if (page.items.length > options.pageLimit) problems.push({ userId, problem: `page of ${page.items.length} > limit` });
          for (const item of page.items) {
            if (seen.has(item.spreadId)) problems.push({ userId, problem: 'duplicate across pages', spreadId: item.spreadId });
            seen.add(item.spreadId);
            ordered.push(item);
          }
          cursor = page.nextCursor;
          if (userPages > 10_000) throw new Error('pagination did not terminate');
        } while (cursor);
      } catch (error) {
        problems.push({ userId, problem: error.message });
        return;
      }
      pages += userPages;
      items += ordered.length;
      maxPages = Math.max(maxPages, userPages);
      for (let i = 1; i < ordered.length; i += 1) {
        const a = ordered[i - 1];
        const b = ordered[i];
        const ta = Date.parse(a.createdAt);
        const tb = Date.parse(b.createdAt);
        if (!(ta > tb || (ta === tb && a.spreadId > b.spreadId))) {
          problems.push({ userId, problem: 'order violation', at: i, prev: [a.createdAt, a.spreadId], next: [b.createdAt, b.spreadId] });
          break;
        }
      }
      const expected = new Set([...(tarotByUser.get(userId) ?? [])].filter((id) => !history.get(id)?.deleted));
      const missingIds = [...expected].filter((id) => !seen.has(id));
      const extraIds = [...seen].filter((id) => !expected.has(id));
      if (missingIds.length || extraIds.length) problems.push({ userId, problem: 'set mismatch', missing: missingIds.slice(0, 3), missingCount: missingIds.length, extra: extraIds.slice(0, 3) });
    });
    const failures = problems.length ? [`${new Set(problems.map((p) => p.userId)).size}/${users.length} users with problems`] : [];
    checks.push(
      check(
        5,
        'history API pagination',
        failures,
        { users: users.length, pageLimit: options.pageLimit, pages, items, maxPagesPerUser: maxPages },
        { problems: problems.slice(0, 5) },
        ['order is created_at DESC, spread_id DESC (typeorm-spread-history.repository.ts findByUser)'],
      ),
    );
  }

  {
    const failures = [];
    if (queue.failed) failures.push(`${queue.failed} failed jobs`);
    if (queue.waiting || queue.active) failures.push(`waiting=${queue.waiting} active=${queue.active} after drain`);
    const samples = queue.failed ? await failedJobSamples() : [];
    checks.push(check(6, 'bullmq', failures, queue, { failedSamples: samples }));
  }

  {
    const failures = [];
    const perService = {};
    let leaks = 0;
    for (const stats of logStats) {
      const groups = Object.entries(stats.warnErrorGroups)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([key, value]) => ({ key, count: value.count, sample: value.sample }));
      perService[stats.service] = {
        lines: stats.lines,
        nonJson: stats.nonJson,
        levels: stats.levels,
        missingField: stats.missingField,
        nullField: stats.nullField,
        unexpectedLevels: stats.unexpectedLevels,
        wrongServiceName: stats.wrongServiceName,
        questionLeaks: stats.questionLeaks,
        warnErrorGroups: groups.slice(0, 20),
        nullCorrelationByMessage: stats.nullCorrelationByMessage,
        nonLowercaseMessages: stats.nonLowercaseMessages,
        nonJsonSamples: stats.nonJsonSamples,
        questionLeakSamples: stats.questionLeakSamples,
      };
      leaks += stats.questionLeaks;
      const tag = stats.service.replace('-service-api', '');
      if (stats.nonJson) failures.push(`${tag}: ${stats.nonJson} non-JSON lines`);
      const missing = Object.values(stats.missingField).reduce((a, b) => a + b, 0);
      if (missing) failures.push(`${tag}: ${missing} missing required fields ${JSON.stringify(stats.missingField)}`);
      const bootstrapNullCorrelation = Object.entries(stats.nullCorrelationByMessage)
        .filter(([key]) => BOOTSTRAP_CONTEXTS.has(key.split('|')[0]))
        .reduce((sum, [, count]) => sum + count, 0);
      perService[stats.service].bootstrapNullCorrelation = bootstrapNullCorrelation;
      const nullFields = { ...stats.nullField };
      if (nullFields.correlationId) nullFields.correlationId -= bootstrapNullCorrelation;
      const nulls = Object.values(nullFields).reduce((a, b) => a + b, 0);
      if (nulls) failures.push(`${tag}: ${nulls} null required fields outside bootstrap ${JSON.stringify(nullFields)}`);
      if (Object.keys(stats.unexpectedLevels).length) failures.push(`${tag}: levels outside error|warn|log|debug ${JSON.stringify(stats.unexpectedLevels)}`);
      if (stats.wrongServiceName) failures.push(`${tag}: ${stats.wrongServiceName} lines with a wrong service field`);
      if (stats.questionLeaks) failures.push(`${tag}: ${stats.questionLeaks} lines contain raw question text`);
    }
    const incompleteTraces = [];
    const stepCoverage = Object.fromEntries(Object.keys(TRACE_STEPS).map((step) => [step, 0]));
    for (const { spreadId, correlationId } of traceSample) {
      const trace = logContext.traces.get(correlationId);
      const missingSteps = Object.keys(TRACE_STEPS).filter((step) => !trace[step]);
      for (const step of Object.keys(TRACE_STEPS)) if (trace[step]) stepCoverage[step] += 1;
      if (missingSteps.length) incompleteTraces.push({ spreadId, correlationId, missingSteps });
    }
    if (incompleteTraces.length) failures.push(`${incompleteTraces.length}/${traceSample.length} sampled traces incomplete`);
    checks.push(
      check(
        7,
        'structured logs',
        failures,
        {
          linesByService: Object.fromEntries(logStats.map((s) => [s.service, s.lines])),
          levelsByService: Object.fromEntries(logStats.map((s) => [s.service, s.levels])),
          questionsSampled: logContext.leak.sampled,
          questionLeaks: leaks,
          tracesSampled: traceSample.length,
          traceStepCoverage: stepCoverage,
        },
        { perService, incompleteTraces: incompleteTraces.slice(0, 5) },
        ['correlationId is null on nest bootstrap lines (no use case in flight); counted per service as bootstrapNullCorrelation, not failed'],
      ),
    );
  }

  {
    const endToEnd = [];
    const consumeLag = [];
    for (const id of runSpreadIds) {
      const t = tarot.get(id);
      const h = history.get(id);
      if (!t || !h) continue;
      endToEnd.push(h.projectedMs - t.createdMs);
      const event = (outboxByAggregate.get(id) ?? [])[0];
      if (event?.publishedMs) consumeLag.push(h.projectedMs - event.publishedMs);
    }
    checks.push(
      check(
        8,
        'end-to-end latency',
        endToEnd.length ? [] : ['no run spreads projected'],
        { endToEndMs: percentiles(endToEnd), publishToProjectedMs: percentiles(consumeLag) },
        {},
        ['end-to-end = history.spread_history.projected_at - tarot.spread.created_at (created_at is taken when the request is received)'],
      ),
    );
  }

  const result = {
    run: path.basename(options.run),
    generatedAt: new Date().toISOString(),
    durationS: Math.round((Date.now() - startedAt) / 1000),
    seed: options.seed,
    summaryPresent: Boolean(summary),
    loadSummary: summary ? { sent: summary.sent, byKindStatus: summary.byKindStatus, throughputRps: summary.throughputRps, startedAt: summary.startedAt, endedAt: summary.endedAt } : null,
    drain,
    overall: checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL',
    checks,
  };
  writeFileSync(path.join(options.run, 'verification.json'), `${JSON.stringify(result, null, 2)}\n`);
  printTable(result);
  return result;
};

const printTable = (result) => {
  const lines = [`verification ${result.run}  overall=${result.overall}  (${result.durationS}s)`];
  for (const c of result.checks) {
    const m = c.metrics;
    const formatters = {
      1: (m) => `201=${m.created201} unique=${m.uniqueRunSpreads} inTarot=${m.presentInTarot} 200=${m.replays200} 409=${m.conflicts409} keyRows=${m.tarotRowsForRunKeys}`,
      2: (m) => `events=${m.runEvents} published=${m.published} pending=${m.pendingGlobal} lag p50/p95/max=${m.publishLagMs.p50}/${m.publishLagMs.p95}/${m.publishLagMs.max}ms`,
      3: (m) => `history=${m.historyRows}/${m.runSpreads} inbox=${m.inboxRowsForRun} applied=${m.appliedLogLinesForRun} dupAbsorbed=${m.duplicateDeliveriesAbsorbed} deleted=${m.softDeleted}`,
      4: (m) => `matched=${m.matched}/${m.sampled}`,
      5: (m) => `users=${m.users} pages=${m.pages} items=${m.items} maxPages=${m.maxPagesPerUser}`,
      6: (m) => `wait=${m.wait} active=${m.active} delayed=${m.delayed} failed=${m.failed} completed=${m.completed}`,
      7: (m) => `lines=${Object.values(m.linesByService).join('/')} leaks=${m.questionLeaks}/${m.questionsSampled}q traces=${m.tracesSampled}`,
      8: (m) => m.endToEndMs ? `e2e p50/p95/max=${m.endToEndMs.p50}/${m.endToEndMs.p95}/${m.endToEndMs.max}ms` : '',
    };
    const key = formatters[c.id](m);
    lines.push(`${String(c.id).padEnd(2)} ${c.name.padEnd(24)} ${c.status.padEnd(4)} ${key}`);
    for (const failure of c.failures) lines.push(`     - ${failure}`);
  }
  console.log(lines.join('\n'));
};

const liveSnapshot = async (since) => {
  const sinceSql = since ? `'${new Date(since).toISOString()}'` : 'now()';
  const [[tarotRow], [historyRow], queue] = await Promise.all([
    psql(
      'tarot',
      `select (select count(*) from spread where created_at >= ${sinceSql}),
              (select count(*) from outbox where status = 'pending'),
              coalesce((select extract(epoch from now() - min(created_at)) from outbox where status = 'pending'), 0)`,
    ),
    psql(
      'history',
      `select count(*),
              coalesce(percentile_cont(0.5) within group (order by extract(epoch from projected_at - created_at))
                       filter (where projected_at > now() - interval '30 seconds'), 0),
              coalesce(max(extract(epoch from projected_at - created_at)) filter (where projected_at > now() - interval '30 seconds'), 0)
       from spread_history where created_at >= ${sinceSql}`,
    ),
    queueCounts(),
  ]);
  return {
    tarot: Number(tarotRow[0]),
    pending: Number(tarotRow[1]),
    oldestPendingS: Number(tarotRow[2]),
    history: Number(historyRow[0]),
    e2eP50S: Number(historyRow[1]),
    e2eMaxS: Number(historyRow[2]),
    queue,
  };
};

const runLive = async (options) => {
  const log = new RequestLog(path.join(options.run, 'requests.ndjson'));
  const summaryPath = path.join(options.run, 'summary.json');
  let since = null;
  const findSince = async () => {
    const ids = log.rows.filter((r) => r.status === 201 && r.spreadId).slice(0, 200).map((r) => r.spreadId);
    if (!ids.length) return null;
    const [[minMs]] = await psql('tarot', `select ${ms('min(created_at)')} from spread where id in (${sqlIds(ids)})`);
    return minMs ? Number(minMs) - 5_000 : null;
  };
  const print = (s) => {
    const creates = log.rows.filter((r) => r.status === 201).length;
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] req=${log.rows.length} creates201=${creates} tarot=${s.tarot} outboxPending=${s.pending} (oldest ${Math.round(s.oldestPendingS)}s) ` +
        `queue wait=${s.queue.waiting} active=${s.queue.active} failed=${s.queue.failed} history=${s.history} backlog=${s.tarot - s.history} ` +
        `e2e(last30s) p50=${s.e2eP50S.toFixed(1)}s max=${s.e2eMaxS.toFixed(1)}s`,
    );
  };

  while (!existsSync(summaryPath)) {
    log.poll();
    since ??= await findSince();
    print(await liveSnapshot(since));
    await sleep(options.interval * 1000);
  }

  log.poll({ flush: true });
  since ??= await findSince();
  console.log(`summary.json present; waiting for drain (timeout ${options.drainTimeout}s)`);
  const drainStarted = Date.now();
  let lastPrint = 0;
  let snapshot;
  for (;;) {
    snapshot = await liveSnapshot(since);
    const drained = snapshot.pending === 0 && snapshot.queue.waiting === 0 && snapshot.queue.active === 0;
    if (drained || Date.now() - drainStarted > options.drainTimeout * 1000) {
      print(snapshot);
      const drain = { drained, waitedS: Math.round((Date.now() - drainStarted) / 1000), atEnd: snapshot };
      console.log(drained ? `drained after ${drain.waitedS}s` : `DID NOT DRAIN within ${options.drainTimeout}s`);
      return runFinal(options, drain);
    }
    if (Date.now() - lastPrint >= options.interval * 1000) {
      print(snapshot);
      lastPrint = Date.now();
    }
    await sleep(5_000);
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const result = options.mode === 'live' ? await runLive(options) : await runFinal(options);
  process.exitCode = result.overall === 'PASS' ? 0 : 1;
};

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 2;
});
