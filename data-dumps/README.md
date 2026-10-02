# Load-run database dumps

`pg_dump` snapshots of the two service databases after the local load runs, about
1,000,000 synthetic readings. Stored via Git LFS.

| File | Database | Restore target |
| --- | --- | --- |
| `tarot.sql.gz` | tarot-service-api | `spread`, `spread_card`, `outbox` |
| `history.sql.gz` | history-service-api | `spread_history`, `inbox` |

The data is **synthetic**: random-UUID users and stub prediction text, generated
by `scripts/load/generate-spreads.mjs`. It is not product data. It exists for
load testing, pagination and UI-volume work, and is reproducible from the script.

## Restore (local compose stack)

```bash
docker compose -f compose/application.yml -f compose/load.yml up -d tarot-db history-db
gzip -dc data-dumps/tarot.sql.gz   | docker compose -f compose/application.yml -f compose/load.yml exec -T tarot-db   psql -U tarot   -d tarot
gzip -dc data-dumps/history.sql.gz | docker compose -f compose/application.yml -f compose/load.yml exec -T history-db psql -U history -d history
```

Pulling the files needs Git LFS installed (`git lfs install`).
