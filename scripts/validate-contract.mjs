#!/usr/bin/env node
// Contract suite: the bytes the running system produces are checked against the contract package
// version pinned in the manifest. The parsers come from the sdk, so nothing is re-implemented here.
import { execFileSync } from 'node:child_process';
import { parseSpreadCreatedV1, parseSpreadDetailsV1 } from '@cosmic-arcana/sdk';
import {
  ENDPOINTS,
  assert,
  createSpread,
  historyPage,
  pass,
  request,
  runSuite,
  step,
  waitFor,
} from './lib.mjs';

const composeFile = process.env.COMPOSE_FILE ?? 'compose/application.yml';
const composeEnvFile = process.env.COMPOSE_ENV_FILE ?? 'compose/.env';

// Reads what the producer actually wrote, with the client that already lives in the container.
const psql = (sql) =>
  execFileSync(
    'docker',
    // prettier-ignore
    ['compose', '-f', composeFile, '--env-file', composeEnvFile,
     'exec', '-T', 'tarot-db', 'psql', '-qAt', '-U', 'tarot', '-d', 'tarot', '-c', sql],
    { encoding: 'utf8' },
  ).trim();

await runSuite('contract', async () => {
  step('create a spread');
  const created = await createSpread('what does the sky say?');
  const spread = created.body;

  step('the published event satisfies the consumer contract');
  const payload = await waitFor('an outbox row for the new spread', () => {
    const row = psql(`select payload::text from outbox where aggregate_id = '${spread.spreadId}'`);
    return row.length > 0 ? row : null;
  });
  const event = parseSpreadCreatedV1(JSON.parse(payload));
  assert(event.spreadId === spread.spreadId, 'event names a different spread');
  assert(event.userId === created.userId, 'event names a different user');
  pass(`spread.created v${event.version} parsed by the pinned contract`);

  step('the spread resource satisfies its contract');
  const resource = await request(
    `${ENDPOINTS['tarot-service-api'].base}/spreads/${spread.spreadId}`,
  );
  assert(resource.status === 200, `GET /spreads/:id returned ${resource.status}`);
  const details = parseSpreadDetailsV1(resource.body);
  assert(details.spreadId === spread.spreadId, 'resource names a different spread');
  pass('SpreadDetailsV1 parsed');

  step('the consumer accepted the event and answers with a valid page');
  const page = await waitFor('the projection', async () => {
    const response = await historyPage(created.userId);
    return response.status === 200 && response.body.items.length === 1 ? response.body : null;
  });
  // Reaching the read model is itself proof that the consumer's parser accepted the produced event.
  assert(Array.isArray(page.items), 'history page has no items array');
  assert(page.nextCursor === null || typeof page.nextCursor === 'string', 'invalid nextCursor');
  const [item] = page.items;
  for (const field of ['spreadId', 'question', 'prediction', 'cards', 'createdAt']) {
    assert(item[field] !== undefined, `history item is missing ${field}`);
  }
  assert(
    item.cards.every(
      (card) =>
        typeof card.positionKey === 'string' &&
        typeof card.cardId === 'string' &&
        typeof card.reversed === 'boolean',
    ),
    'history item carries cards that do not match SpreadCardV1',
  );
  pass('SpreadHistoryPageV1 shape holds end to end');
});
