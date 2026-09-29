#!/usr/bin/env node
// Integration suite: the write side, the broker and the read side, exercised as one application.
import {
  ENDPOINTS,
  assert,
  createSpread,
  historyPage,
  pass,
  request,
  runSuite,
  step,
  uuid,
  waitFor,
} from './lib.mjs';

await runSuite('integration', async () => {
  const question = 'should i take the job?';

  step('create a spread');
  const created = await createSpread(question);
  const spread = created.body;
  assert(spread.spreadId, 'response carries no spreadId');
  pass(`spread ${spread.spreadId} created for user ${created.userId}`);

  step('wait for the projection to reach the read model');
  const page = await waitFor('the spread to appear in history', async () => {
    const response = await historyPage(created.userId);
    return response.status === 200 && response.body.items.length === 1 ? response.body : null;
  });
  const item = page.items[0];
  assert(item.spreadId === spread.spreadId, 'history projected a different spread');
  assert(item.question === question, 'history projected a different question');
  assert(item.prediction === spread.prediction, 'history projected a different prediction');
  // jsonb does not preserve key order, so cards are compared field by field rather than as text.
  assert(
    item.cards.length === spread.cards.length &&
      item.cards.every((card, index) =>
        ['positionKey', 'cardId', 'reversed'].every(
          (field) => card[field] === spread.cards[index][field],
        ),
      ),
    'history projected different cards',
  );
  pass('read model matches the source of truth');

  step('replay the idempotency key');
  const replay = await request(`${ENDPOINTS['tarot-service-api'].base}/spreads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': created.idempotencyKey },
    body: JSON.stringify({ userId: created.userId, question }),
  });
  assert(replay.status === 200, `replay returned ${replay.status}, expected 200`);
  assert(
    replay.headers.get('idempotency-replayed') === 'true',
    'replay did not report idempotency-replayed',
  );
  assert(replay.body.spreadId === spread.spreadId, 'replay returned a different spread');
  pass('replay returned the stored spread and created nothing');

  step('confirm the replay produced no second projection');
  const afterReplay = await historyPage(created.userId);
  assert(afterReplay.body.items.length === 1, 'a replay created a second history row');
  pass('exactly one history row');

  step('unknown spread is not found');
  const missing = await request(`${ENDPOINTS['tarot-service-api'].base}/spreads/${uuid()}`);
  assert(missing.status === 404, `unknown spread returned ${missing.status}, expected 404`);
  pass('unknown spread returns 404');
});
