# Reading fixtures

`readings.v1.ndjson` — 1,000 synthetic readings (100 users × 10), one JSON object per line:
`schema`, `userId`, `spreadId`, `question`, `cards`, `prediction`, `createdAt`. Questions mix
English, Ukrainian, Japanese, Spanish, French, German and Polish text. Nothing here is real user
data: the users are random UUIDs and the predictions are the stub interpreter's text.

## Load them into a running stack

```bash
node scripts/fixtures/seed-fixtures.mjs --file fixtures/readings.v1.ndjson
```

Each question is asked again for the same user through tarot-service-api, so tarot draws, writes its
outbox row, and history projects it, exactly as a real reading. Running it twice creates nothing
new (the idempotency key derives from the fixture). A fresh reading's cards and prediction differ
from the file's, because the draw is seeded by user, question and day.

## Make a new set

```bash
node scripts/load/generate-spreads.mjs --run .load/run-x --users 200 --questions-per-user 10
node scripts/fixtures/export-fixtures.mjs --run .load/run-x --users 100 --out fixtures/readings.v1.ndjson
```

The export reads through history's public API for the first N users (sorted by id) of the run, so it
is deterministic and needs no database access.
