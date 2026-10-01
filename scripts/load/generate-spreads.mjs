import { randomUUID, randomInt } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';

const parseArgs = (argv) => {
  const options = {
    run: '.load/run-000-smoke',
    users: 20,
    questionsPerUser: 10,
    concurrency: 10,
    replayRatio: 0.02,
    conflictRatio: 0.005,
    baseUrl: 'http://127.0.0.1:3004',
    timeoutMs: 30_000,
    abortP99Ms: 2_000,
    abortErrorRate: 0.01,
    abortWindows: 3,
  };
  const keys = {
    '--run': ['run', String],
    '--users': ['users', Number],
    '--questions-per-user': ['questionsPerUser', Number],
    '--concurrency': ['concurrency', Number],
    '--replay-ratio': ['replayRatio', Number],
    '--conflict-ratio': ['conflictRatio', Number],
    '--base-url': ['baseUrl', String],
    '--timeout-ms': ['timeoutMs', Number],
    '--abort-p99-ms': ['abortP99Ms', Number],
    '--abort-error-rate': ['abortErrorRate', Number],
    '--abort-windows': ['abortWindows', Number],
  };
  for (let i = 2; i < argv.length; i += 2) {
    const entry = keys[argv[i]];
    if (!entry) throw new Error(`unknown flag ${argv[i]}`);
    options[entry[0]] = entry[1](argv[i + 1]);
  }
  return options;
};

const TOPICS = [
  'Will my career change direction before the year ends?',
  'Should I accept the job offer from the startup?',
  'Is my relationship with {name} heading somewhere meaningful?',
  'What should I focus on this {period}?',
  'Will moving to {city} bring me the peace I am looking for?',
  'How can I repair the friendship with {name}?',
  'Am I ready to start my own business?',
  'What does the {period} ahead hold for my health and energy?',
  'Should I go back to university and study {subject}?',
  'Will my creative project find its audience?',
  'Is it time to forgive {name}?',
  'What hidden obstacle is blocking my finances?',
  'Should I adopt a {pet}?',
  'How will my family situation evolve this {period}?',
  'Will I find the courage to speak up at work?',
  'Is {city} the right place to raise children?',
  'What lesson is the universe trying to teach me right now?',
  'Should I invest my savings or keep them safe?',
  'Will my long-distance relationship survive the {period}?',
  'Am I on the right spiritual path?',
  'Що чекає на мене в коханні цього {period}?',
  '¿Debería cambiar de trabajo este año?',
  'Est-ce que mon projet à {city} va réussir?',
  '今年は転職すべきですか？',
  'Werde ich in {city} glücklich sein? 🌙',
  'Czy powinienem zaufać {name}?',
];

const FILL = {
  name: ['Anna', 'Marco', 'Olena', 'Kenji', 'Zoë', 'Łukasz', 'Søren', 'Amélie', 'Taras', 'Priya'],
  period: ['month', 'season', 'year', 'week', 'winter', 'summer'],
  city: ['Lisbon', 'Kyiv', 'Berlin', 'Tokyo', 'Kraków', 'Montréal', 'São Paulo', 'Reykjavík'],
  subject: ['astronomy', 'law', 'medicine', 'design', 'philosophy', 'computer science'],
  pet: ['dog', 'cat', 'parrot', 'rabbit'],
};

const CONTEXT = [
  'I have been thinking about this for a long time.',
  'Lately I keep dreaming about the sea and I wake up restless.',
  'My grandmother always said the stars answer only honest questions.',
  'Everything feels uncertain, and I would like a sign.',
  'Friends give me conflicting advice and I no longer trust my own judgement.',
  'Last month I saw a falling star on the night I made the decision.',
  'I feel stuck between what is safe and what I really want.',
  'Moon is full tonight — maybe that matters. Мені потрібна підказка.',
];

const pick = (list) => list[randomInt(list.length)];

const makeQuestion = (topicIndex) => {
  let text = TOPICS[topicIndex].replace(/\{(\w+)\}/g, (_, slot) => pick(FILL[slot]));
  const contextLines = [0, 0, 1, 2, 4][randomInt(5)];
  const pool = [...CONTEXT];
  for (let i = 0; i < contextLines; i += 1) text += ` ${pool.splice(randomInt(pool.length), 1)[0]}`;
  return text.slice(0, 1000);
};

const pickDistinctTopics = (count) => {
  const indexes = TOPICS.map((_, i) => i);
  for (let i = indexes.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
  }
  return indexes.slice(0, count);
};

const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;

const dockerStats = () => {
  try {
    const output = execFileSync('docker', ['stats', '--no-stream', '--format', '{{json .}}'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return {
      takenAt: new Date().toISOString(),
      containers: output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    };
  } catch (error) {
    return { takenAt: new Date().toISOString(), error: error.message };
  }
};

const EXPECTED_STATUS = { create: 201, replay: 200, conflict: 409 };

const main = async () => {
  const options = parseArgs(process.argv);
  if (options.questionsPerUser > TOPICS.length) {
    throw new Error(`questions-per-user must be <= ${TOPICS.length}`);
  }
  const runDir = resolve(options.run);
  const runTag = basename(runDir).replace(/[^A-Za-z0-9_-]/g, '-');
  const correlationPrefix = `load-${runTag}`;
  mkdirSync(runDir, { recursive: true });

  const users = Array.from({ length: options.users }, () => ({
    id: randomUUID(),
    topics: pickDistinctTopics(options.questionsPerUser),
  }));
  const totalCreates = options.users * options.questionsPerUser;
  const totalReplays = Math.round(totalCreates * options.replayRatio);
  const totalConflicts = Math.round(totalCreates * options.conflictRatio);
  const totalRequests = totalCreates + totalReplays + totalConflicts;
  const userOrder = users.map((_, i) => i);
  for (let i = userOrder.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [userOrder[i], userOrder[j]] = [userOrder[j], userOrder[i]];
  }

  const out = createWriteStream(resolve(runDir, 'requests.ndjson'), { flags: 'w' });
  const writeLine = async (record) => {
    if (!out.write(`${JSON.stringify(record)}\n`)) await once(out, 'drain');
  };

  const completedPool = [];
  const POOL_LIMIT = 20_000;
  const rememberCompleted = (entry) => {
    if (completedPool.length < POOL_LIMIT) completedPool.push(entry);
    else completedPool[randomInt(POOL_LIMIT)] = entry;
  };

  let createsIssued = 0;
  let replaysLeft = totalReplays;
  let conflictsLeft = totalConflicts;
  let sequence = 0;

  const nextTask = () => {
    const createsLeft = totalCreates - createsIssued;
    const extrasLeft = replaysLeft + conflictsLeft;
    if (createsLeft + extrasLeft === 0) return null;
    const wantExtra =
      extrasLeft > 0 && completedPool.length > 0 && randomInt(createsLeft + extrasLeft) < extrasLeft;
    if (wantExtra || (createsLeft === 0 && completedPool.length > 0)) {
      const original = pick(completedPool);
      const isReplay = randomInt(extrasLeft) < replaysLeft;
      if (isReplay) replaysLeft -= 1;
      else conflictsLeft -= 1;
      return {
        kind: isReplay ? 'replay' : 'conflict',
        userId: original.userId,
        question: isReplay ? original.question : `${original.question} (asked differently ${randomInt(1e6)})`.slice(-1000),
        idempotencyKey: original.idempotencyKey,
        originalN: original.n,
        originalSpreadId: original.spreadId,
      };
    }
    if (createsLeft === 0) return 'wait';
    const index = createsIssued;
    createsIssued += 1;
    const round = Math.floor(index / options.users);
    const userIndex = userOrder[index % options.users];
    const user = users[userIndex];
    return {
      kind: 'create',
      userId: user.id,
      question: makeQuestion(user.topics[round]),
      idempotencyKey: `${runTag}-u${userIndex}-q${round}`,
    };
  };

  const durations = new Float64Array(totalRequests);
  let durationCount = 0;
  const byKindStatus = {};
  let unexpected = 0;
  let replaySpreadIdMismatch = 0;
  let replayHeaderMismatch = 0;
  const errorSamples = [];
  let window = { durations: [], errors: 0, count: 0 };
  let badWindows = 0;
  let abortReason = null;
  const windowLog = [];

  const send = async (task) => {
    sequence += 1;
    const n = sequence;
    const correlationId = `${correlationPrefix}-${n}`;
    const startedAt = performance.now();
    let status = null;
    let spreadId = null;
    let replayed = null;
    let error;
    try {
      const response = await fetch(`${options.baseUrl}/spreads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': task.idempotencyKey,
          'x-correlation-id': correlationId,
        },
        body: JSON.stringify({ userId: task.userId, question: task.question }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      status = response.status;
      const header = response.headers.get('idempotency-replayed');
      replayed = header === null ? null : header === 'true';
      const text = await response.text();
      if (status === 200 || status === 201) {
        spreadId = JSON.parse(text).spreadId ?? null;
      } else if (status !== EXPECTED_STATUS[task.kind]) {
        error = text.slice(0, 300);
      }
    } catch (caught) {
      error = `${caught.name}: ${caught.message}`;
    }
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    durations[durationCount++] = durationMs;

    const isUnexpected = status !== EXPECTED_STATUS[task.kind];
    if (isUnexpected) {
      unexpected += 1;
      if (!error) error = `unexpected status ${status}`;
      if (errorSamples.length < 10) errorSamples.push({ n, kind: task.kind, status, correlationId, error });
    }
    if (task.kind === 'replay' && status === 200) {
      if (spreadId !== task.originalSpreadId) replaySpreadIdMismatch += 1;
      if (replayed !== true) replayHeaderMismatch += 1;
    }
    const kindTotals = (byKindStatus[task.kind] ??= {});
    const statusKey = String(status ?? 'network-error');
    kindTotals[statusKey] = (kindTotals[statusKey] ?? 0) + 1;

    window.count += 1;
    window.durations.push(durationMs);
    if (isUnexpected) window.errors += 1;

    const record = {
      n,
      kind: task.kind,
      userId: task.userId,
      question: task.question,
      idempotencyKey: task.idempotencyKey,
      correlationId,
      status,
      spreadId,
      replayed,
      durationMs,
    };
    if (task.originalN !== undefined) record.originalN = task.originalN;
    if (error) record.error = error;
    await writeLine(record);

    if (task.kind === 'create' && status === 201 && spreadId) {
      rememberCompleted({ n, userId: task.userId, question: task.question, idempotencyKey: task.idempotencyKey, spreadId });
    }
  };

  const statsBefore = dockerStats();
  const startedIso = new Date().toISOString();
  const startedAt = performance.now();

  const ticker = setInterval(() => {
    const sorted = window.durations.sort((a, b) => a - b);
    const p99 = percentile(sorted, 99);
    const errorRate = window.count ? window.errors / window.count : 0;
    const elapsed = (performance.now() - startedAt) / 1000;
    const line = {
      at: new Date().toISOString(),
      done: durationCount,
      total: totalRequests,
      windowRps: Math.round(window.count / 10),
      windowP50: percentile(sorted, 50),
      windowP99: p99,
      windowErrorRate: Math.round(errorRate * 10_000) / 10_000,
      avgRps: Math.round(durationCount / elapsed),
    };
    windowLog.push(line);
    process.stdout.write(`${JSON.stringify(line)}\n`);
    const degraded = (p99 !== null && p99 > options.abortP99Ms) || errorRate > options.abortErrorRate;
    badWindows = degraded ? badWindows + 1 : 0;
    if (badWindows >= options.abortWindows && !abortReason) {
      abortReason = `sustained degradation for ${badWindows} x 10s windows: p99=${p99}ms errorRate=${errorRate}`;
    }
    window = { durations: [], errors: 0, count: 0 };
  }, 10_000);

  const worker = async () => {
    while (!abortReason) {
      const task = nextTask();
      if (task === null) return;
      if (task === 'wait') {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      await send(task);
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  clearInterval(ticker);
  const wallMs = performance.now() - startedAt;
  const endedIso = new Date().toISOString();
  out.end();
  await once(out, 'finish');
  const statsAfter = dockerStats();

  const sorted = Array.from(durations.subarray(0, durationCount)).sort((a, b) => a - b);
  const result = {
    run: runTag,
    correlationIdPrefix: `${correlationPrefix}-`,
    startedAt: startedIso,
    endedAt: endedIso,
    wallTimeSeconds: Math.round(wallMs) / 1000,
    concurrency: options.concurrency,
    users: options.users,
    questionsPerUser: options.questionsPerUser,
    planned: { create: totalCreates, replay: totalReplays, conflict: totalConflicts, total: totalRequests },
    sent: durationCount,
    byKindStatus,
    expectedStatus: EXPECTED_STATUS,
    unexpectedStatusCount: unexpected,
    replaySpreadIdMismatch,
    replayHeaderMismatch,
    throughputRps: Math.round((durationCount / (wallMs / 1000)) * 10) / 10,
    latencyMs: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? null,
    },
    errorSamples,
    windows: windowLog,
    dockerStats: { before: statsBefore, after: statsAfter },
  };

  if (abortReason) {
    writeFileSync(resolve(runDir, 'aborted.json'), `${JSON.stringify({ abortReason, ...result }, null, 2)}\n`);
    process.stdout.write(`ABORTED: ${abortReason}\n`);
    process.exitCode = 2;
    return;
  }
  writeFileSync(resolve(runDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
  const { windows: _windows, dockerStats: _stats, ...brief } = result;
  process.stdout.write(`${JSON.stringify(brief)}\n`);
};

await main();
