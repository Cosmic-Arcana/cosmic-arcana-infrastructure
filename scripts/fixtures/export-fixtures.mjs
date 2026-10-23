#!/usr/bin/env node
// Exports a small, deterministic sample of readings from a running stack as NDJSON fixtures.
//
//   node scripts/fixtures/export-fixtures.mjs --run .load/run-005 --users 100 --out fixtures/readings.v1.ndjson
//
// The users come from a load run's request log, the readings from history's public API, so this
// needs no database access and exports exactly what a client of the application can see.
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SCHEMA = 'reading-fixture.v1';

const options = { run: null, users: 100, out: 'fixtures/readings.v1.ndjson', history: 'http://127.0.0.1:3005' };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '');
  if (!(key in options)) {
    throw new Error(`unknown flag ${process.argv[i]}`);
  }
  options[key] = typeof options[key] === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1];
}
if (!options.run) {
  throw new Error('--run <load run directory> is required');
}

const collectUsers = async (runDir) => {
  const users = new Set();
  const lines = createInterface({ input: createReadStream(resolve(runDir, 'requests.ndjson')) });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.kind === 'create' && request.status === 201) {
      users.add(request.userId);
    }
  }
  return [...users].sort();
};

const readAll = async (userId) => {
  const items = [];
  let cursor = null;
  do {
    const query = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await fetch(`${options.history}/users/${userId}/spread-history?${query}`);
    if (!response.ok) {
      throw new Error(`history answered ${response.status} for a user`);
    }
    const page = await response.json();
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
};

const chosen = (await collectUsers(options.run)).slice(0, options.users);
if (chosen.length === 0) {
  throw new Error(`no created readings found in ${options.run}/requests.ndjson`);
}

const rows = [];
for (const userId of chosen) {
  const items = await readAll(userId);
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const item of items) {
    rows.push(JSON.stringify({ schema: SCHEMA, userId, ...item }));
  }
}

mkdirSync(dirname(resolve(options.out)), { recursive: true });
writeFileSync(resolve(options.out), `${rows.join('\n')}\n`);
process.stdout.write(`exported ${rows.length} readings of ${chosen.length} users to ${options.out}\n`);
