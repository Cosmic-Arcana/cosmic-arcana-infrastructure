#!/usr/bin/env node
// Loads reading fixtures into a running stack through the real pipeline: each fixture's question is
// asked again for the same user, so tarot draws, writes its outbox row, and history projects it.
// The idempotency key derives from the fixture, so running this twice creates nothing new.
//
//   node scripts/fixtures/seed-fixtures.mjs --file fixtures/readings.v1.ndjson
//
// The cards and predictions of a fresh reading differ from the exported ones (the draw is seeded by
// user, question and day), so the fixtures give a realistic volume and shape, not identical rows.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const options = { file: 'fixtures/readings.v1.ndjson', tarot: 'http://127.0.0.1:3004', concurrency: 20 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!(key in options)) {
    throw new Error(`unknown flag ${process.argv[i]}`);
  }
  options[key] = typeof options[key] === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1];
}

const fixtures = readFileSync(resolve(options.file), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const outcome = { created: 0, alreadyThere: 0, failed: 0 };
let next = 0;

const worker = async () => {
  while (next < fixtures.length) {
    const index = next;
    next += 1;
    const fixture = fixtures[index];
    try {
      const response = await fetch(`${options.tarot}/spreads`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `fixture-${fixture.spreadId}`,
          'x-correlation-id': `fixture-seed-${index}`,
        },
        body: JSON.stringify({ userId: fixture.userId, question: fixture.question }),
      });
      if (response.status === 201) {
        outcome.created += 1;
      } else if (response.status === 200) {
        outcome.alreadyThere += 1;
      } else {
        outcome.failed += 1;
      }
    } catch {
      outcome.failed += 1;
    }
  }
};

await Promise.all(Array.from({ length: options.concurrency }, worker));
process.stdout.write(`${JSON.stringify({ fixtures: fixtures.length, ...outcome })}\n`);
process.exit(outcome.failed === 0 ? 0 : 1);
