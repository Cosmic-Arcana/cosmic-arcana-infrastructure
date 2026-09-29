# Cosmic Arcana — handoff

Written 2026-09-29 for an agent with no prior context. Every status was checked against the code, not
the plan text. Paths are relative to the workspace root, which holds all repositories side by side and is
**not** itself a git repository; each service is.

## 1. Product in five lines

1. An AI fortune-teller: the user asks a question, an agent draws tarot cards and writes a reading.
2. Readings are **fiction and entertainment**, never advice and never a factual claim about the future.
3. NASA/astronomical data is real, and is used **only as symbolic context** — imagery, themes, timing
   flavour. It must never be presented as evidence that a prediction works.
4. An AI agent reaches the product through an MCP server, using a delegated (on-behalf-of) token, and
   can only see what the user can see.
5. The project is also an experiment in agent-driven engineering: the workflow itself is part of the product.

## 2. Current state

**Stack.** NestJS 11 + TypeScript (services), Next.js 16 + React 19 + Tailwind 4 + Auth0 (storefront),
PostgreSQL + TypeORM, BullMQ on Redis, MCP SDK v2, jest, eslint+prettier, Docker, GitHub Actions.
Node 22. npm. One repository per service, all under the `Cosmic-Arcana` GitHub org.

| Repo | Role | Ports | Reality check |
| --- | --- | --- | --- |
| `cosmic-arcana-sdk` | shared contracts (`@cosmic-arcana/sdk`), zero runtime deps | — | events, resources, MCP contracts, 20 tests |
| `tarot-service-api` | spreads write side, sole producer of `spread.created` | 3004, db 5433 | complete, 11 e2e tests |
| `history-service-api` | spread-history read side, consumes `spread.created` | 3005, db 5434 | complete, 8 e2e tests |
| `mcp-service-api` | MCP server, agent activity recording | 3003 | one tool, mock data, 15 tests |
| `ai-service-api` | predictions, tarot interpretation | 3001 / tcp 4001 | tarot domain only (75 tests); no transport, no LLM call |
| `nasa-service-api` | NASA data | 3002 / tcp 4002 | **scaffold only**, no domain code (21 tests, all generic) |
| `cosmic-arcana-storefront` | frontend + BFF | 3000 | default page + the new `/agent` dashboard |
| `cosmic-arcana-infrastructure` | CI/CD, release manifests, app validation | — | https://github.com/Cosmic-Arcana/cosmic-arcana-infrastructure |

**What works end to end right now** (verified by running it): create a spread in `tarot-service-api` →
outbox row in the same transaction → relay publishes `spread.created` to BullMQ → `history-service-api`
consumes it, re-queries tarot over HTTP, upserts a denormalised row behind an inbox →
`GET /users/:id/spread-history` returns it, with one correlation id through every log line. Separately:
an MCP session with a bearer token calls `get_previous_readings` and appears live on the dashboard.

**Nothing else talks to anything.** `ai-service-api` and `nasa-service-api` only *listen* on TCP;
there is no `ClientProxy` anywhere in any repo. The storefront has no reading UI.

### Commands

```bash
# databases + broker for local development (workspace root)
docker compose up -d                 # tarot-db 5433, history-db 5434, redis 6379

# any service
npm ci && npm run build && npm run start          # or npm run start:dev
npm test                                          # unit
npm run test:e2e                                  # tarot/history only; needs a running Docker daemon
npm run lint

# sdk
cd cosmic-arcana-sdk && npm ci && npm test && npm run build

# storefront
cd cosmic-arcana-storefront && npm ci && npm run dev     # http://localhost:3000, dashboard at /agent

# application-level validation (infrastructure repo, against a running stack)
node scripts/validate-health.mjs manifests/development.candidate.yml
node scripts/validate-integration.mjs
COMPOSE_ENV_FILE=compose/.env node scripts/validate-contract.mjs
```

**Blocking caveat:** `tarot`, `history`, `mcp` and `storefront` declare
`"@cosmic-arcana/sdk": "github:Cosmic-Arcana/cosmic-arcana-sdk#semver:^0.1.0"`, but tag `v0.1.1` does not
exist yet and their lockfiles still record the old path link, so `npm ci` fails there until F2/F3.
Workaround used so far: `npm install --no-save ../cosmic-arcana-sdk`.

Environment variables live in each repo's `.env.example` (`mcp-service-api` and the storefront have
none committed). Secret names only: `ANTHROPIC_API_KEY` (only `ai-service-api`, required when
`NODE_ENV=production`), `NASA_API_KEY`, the `AUTH0_*` set plus `APP_BASE_URL` (storefront, untracked
`.env`), `INFRA_DISPATCH_TOKEN` (org secret, not created yet).

## 3. Decisions (why things look the way they do)

**D1 — One repository per service.** Independent deploys and histories. Rejected: monorepo, because
the point of the experiment is multi-repo agent workflows. Cost: shared code needs a package.

**D2 — CQRS split across two services.** `tarot-service-api` owns the fact and is the only producer of
`spread.created`; `history-service-api` owns the derived read model. Rejected: one service with two
models, and a central projection service — a read model belongs to whoever reads it.

**D3 — Transactional outbox + inbox.** Spread row and outbox row in one transaction; a polling relay
publishes to BullMQ; the consumer writes an inbox row in the same transaction as the projection.
Rejected: publishing from the command handler (loses events on crash) and BullMQ `jobId` alone (dedupes
on add, not on redelivery). CDC is the planned replacement for polling.

**D4 — Thin past-tense events.** `spread.created` carries ids + `occurredAt` only; consumers re-query
`GET /spreads/:id` for content. Rejected: fat events (they turn the broker into a second schema).

**D5 — Contracts as a git dependency.** `@cosmic-arcana/sdk` is installed from its GitHub repo by
semver tag. Rejected: `file:` path links (break in any single-repo checkout — this was the original
blocker) and GitHub Packages (needs a token on every laptop and inside every Docker build).

**D6 — The application version is a manifest of image digests.** `manifests/development.yml` pins each
service's `ghcr.io/...@sha256:...`; a changed service gets a new digest, unchanged ones are reused, never
rebuilt. `latest` is never used for orchestration. Rejected: composing by tag (mutable).

**D7 — One reusable CI workflow.** Six repos call
`Cosmic-Arcana/cosmic-arcana-infrastructure/.github/workflows/service-ci.yml@main` with a ~25-line
caller. Rejected: copying a pipeline into every repo.

**D8 — MCP contracts live in the SDK.** Tool names, `ReadingSummaryV1`, tool I/O and the agent-activity
types are in `@cosmic-arcana/sdk`; zod mirrors sit behind the `@cosmic-arcana/sdk/mcp` subpath with zod
as an optional peer, so non-MCP services never install zod.

**D9 — Agent identity is read, not verified.** `OboTokenIdentityAdapter` decodes `sub` and `act` from
the bearer token **without checking the signature**, behind `AgentIdentityPort`. It is observability,
never authorization, until an authority service exists. Rejected: inventing a verification scheme.

**D10 — Undefined business rules stay behind ports.** `SpreadGeneratorPort` has a deterministic stub;
reading history has a mock adapter. No tarot or prediction semantics were invented.

## 4. Owner rules (how the owner wants work done)

1. **BDD first.** Write Given/When/Then for the behaviour before the code. Existing e2e specs follow
   this literally (`tarot-service-api/test/create-spread.e2e-spec.ts`).
2. **Never invent business rules.** Card meanings, spread shapes, prediction format, retention windows:
   if it is not written down, it goes to section 8 as a question and stays behind a port.
3. **Agentic workflow only.** The owner delegates implementation and keeps architectural control; every
   change is expected to come from an agent session, reviewed by the owner.
4. **Explain decisions before committing, and wait for an explicit OK.** This is a standing rule.
5. **Model assignment.** Repo agent config (`.claude/settings.json` in each repo) pins a high-effort
   model for engineering work; the *product's* own agent is configured as `claude-opus-5`, effort
   `high`, streaming deferred (`ai-service-api/.env.example`: `AI_MODEL`, `AI_EFFORT`). Use the
   strongest available model for architecture, contracts and CI; a cheaper one is fine for mechanical
   edits. Adapt names to whatever models the new tool offers.
6. **Conventions.** Branches `feature/*`, `fix/*`, `chore/*` → `development` → `main`; commits
   `[<n>-<type>]: <lowercase description>`; kebab-case filenames except frontend `.tsx`/`.ts`; comments
   explain *why*; English only; the word "russian" always lowercase; single-line JSON logs through the
   framework logger (never `console.log`) with `correlationId` propagated across every hop.
7. **Keep `progress.md` current** (workspace root) — it is the short state-of-the-world file.

## 5. Unified backlog

Ordered by dependency. `F` foundation (first), `S` services, `X` product/UX, `H` hygiene.
Status: ✅ done · 🟡 partial · ⬜ not started · ❌ abandoned.

### F1 — Commit and push the CI/CD system ✅
Why: every caller needs the reusable workflow on `main`. Done 2026-09-29:
https://github.com/Cosmic-Arcana/cosmic-arcana-infrastructure (`f806057`). Still open: F6 token, F8 protection.
Depends on: —. Acceptance: Given the repo exists on GitHub, When a caller runs, Then `service-ci.yml`
resolves and the run reaches the image job.

### F2 — Release the SDK tag `v0.1.1` ⬜
Why: four repos resolve the contracts package by git tag and no tag exists; `cosmic-arcana-sdk/.github/
workflows/ci.yml` creates it on push to `main` when the version is new. Files:
`cosmic-arcana-sdk/package.json`. Depends on: F1. Acceptance: Given a push to main, When CI runs, Then
`v0.1.1` exists and installing that spec in an empty directory exposes `parseSpreadCreatedV1`.

### F3 — Regenerate four lockfiles against the tag ⬜
Why: `npm ci` currently fails in `tarot`, `history`, `mcp`, `storefront` — their lockfiles still record
`"resolved": "../cosmic-arcana-sdk", "link": true`. Files: `package-lock.json` in those four repos.
Depends on: F2. Acceptance: Given a clean clone of each repo, When `npm ci && npm run build` runs,
Then it succeeds without any local path.

### F4 — Fix lint in `ai-service-api` and `nasa-service-api` ⬜
Why: **`npm run lint` fails in both** (4 errors each: unsafe `any` in the idempotency and logging
interceptors, unused `_payload` in the health controller), so their pipelines are red from run one.
Files: `src/common/idempotency/idempotency.interceptor.ts`, `src/common/logging/logging.interceptor.ts`,
`src/health/health.controller.ts`. Depends on: —. Acceptance: `npm run lint` exits 0 in both.

### F5 — Push service CI callers, Dockerfiles and build fixes ⬜
Why: the pipeline files exist locally and are uncommitted in six repos. Files: `.github/workflows/ci.yml`,
`Dockerfile`, `.dockerignore` per repo; plus the `LogLevel` import fix in `ai`/`nasa`
(`src/common/logging/structured-logger.service.ts`, `src/main.ts`). Depends on: F1–F4.
Acceptance: Given a push to `development`, When CI runs, Then lint/build/test pass and an image is
pushed to GHCR by digest.

### F6 — Create the `INFRA_DISPATCH_TOKEN` organisation secret ⬜
Why: without it the dispatch step warns and succeeds, so the manifest silently never moves. Fine-grained,
scoped to `cosmic-arcana-infrastructure` only. Depends on: F1. Acceptance: Given a successful image job,
Then `manifests/development.candidate.yml` gains that service's digest.

### F7 — First green application validation + first release ⬜
Why: proves the whole chain on real infrastructure; only the local equivalent has been run.
Files: `cosmic-arcana-infrastructure/.github/workflows/application-validation.yml`.
Depends on: F5, F6. Acceptance: Given a candidate manifest with both flow services, When validation
runs, Then health/contract/integration all pass and a release `app-<utc>-<sha>` exists with the
manifest attached.

### F8 — Branch protection and required checks ⬜
Why: no branch is protected in any repo, so any branch can rewrite a workflow that holds
`packages: write`. Also disable `can_approve_pull_request_reviews` at org level. Exact commands are in
`docs/ci-cd-implementation.md` §15.7. Depends on: F7 (do not require a check that has never been green).
Acceptance: Given a PR that fails CI, When someone tries to merge to `development` or `main`, Then
GitHub blocks it.

### S1 — Transport handlers for the tarot domain in `ai-service-api` ⬜
Why: the tarot domain (78-card deck, spreads, deterministic seeded draw, shuffle strategies) is
complete and unit-tested but unreachable — only `ai.health.check` has a `@MessagePattern`. Files:
`ai-service-api/src/tarot/*` (exists), needs a controller + module wiring; contracts in
`src/tarot/contracts/`. Depends on: — Acceptance: Given a TCP message `ai.tarot.draw` with a valid
envelope, When the service handles it, Then it returns the drawn cards, and an invalid payload is
rejected without throwing an unhandled error.

### S2 — Anthropic adapter in `ai-service-api` ⬜
Why: no prediction is possible — there is no Anthropic SDK dependency, only `ANTHROPIC_API_KEY` /
`AI_MODEL` / `AI_EFFORT` in config. Needs structured output, prompt caching, refusal handling,
`maxRetries: 0` (the app owns retries) and its own timeout; the shared `RETRY_TIMEOUT_MS` of 5s is far
too short. Files: new `src/prediction/*`. Depends on: S1. Acceptance: Given a question and cards, When
the adapter is called, Then it returns a structured interpretation and a refusal becomes a typed error.

### S3 — Prediction use case ⬜
Why: the core product loop. The agent decides when to fetch previous readings through MCP; the service
does not fetch them itself. Files: `ai-service-api/src/prediction/*`. Depends on: S2.
Acceptance: Given a user question, When the prediction use case runs, Then it returns cards +
interpretation, and the fictional framing is explicit in the output.

### S4 — `nasa-service-api` domain ⬜
Why: the repo is a scaffold; `nasa.cosmic.snapshot`, `nasa.cosmic.apod`, `nasa.cosmic.near-earth-objects`
are declared in `src/common/messaging/message-patterns.ts` and implemented nowhere. Files: new
`src/cosmic/*`. Depends on: —. Acceptance: Given a valid API key, When `nasa.cosmic.apod` is called, Then
normalised data comes back from cache or upstream, and an upstream failure degrades instead of throwing.

### S5 — Wire `ai-service-api` → `nasa-service-api` over TCP ⬜
Why: `NASA_SERVICE_TCP_HOST/PORT` and a client-side pattern file exist, but no `ClientProxy` is
registered anywhere in the workspace. Enrichment must degrade to "no cosmic data" on failure.
Depends on: S2, S4. Acceptance: Given NASA data is available, When a prediction is built, Then it
carries symbolic cosmic context; Given NASA is down, When a prediction is built, Then it still
succeeds without it.

### S6 — `authority-service-api` (identity + on-behalf-of tokens) ⬜
Why: five TODOs across three repos wait for it (`grep -rn "TODO(auth"`). It issues the user's token and
exchanges it for a downscoped read-only agent token carrying `act` (RFC 8693) — one source of claims for
both the BFF and the MCP path. Files: new repo. Depends on: —. Acceptance: Given a signed-in user, When
an agent requests delegated access, Then it gets a read-only token (`sub` = user, `act` = agent) and the
MCP server rejects unsigned or expired tokens.

### S7 — Replace the MCP mock reading history with the real read model ⬜
Why: `MockReadingHistoryAdapter` returns fixtures. The real source is `history-service-api`'s read
model, reachable either through its API or through the planned PostgreSQL MCP server with row-level
security. Files: `mcp-service-api/src/readings/*`. Depends on: S6. Acceptance: Given a user with
readings, When the agent calls `get_previous_readings`, Then it receives that user's real readings and
never another user's.

### S8 — PostgreSQL MCP + `cosmic_agent` schema with RLS ⬜
Why: the architecture gives the agent a restricted, user-scoped database path enforced by the resource,
not by the caller. Files: none yet; `mcp-service-api/CLAUDE.md` has the intended diagram.
Depends on: S6, S7. Acceptance: Given an agent token for user A, When it queries the agent schema,
Then only user A's rows are visible, enforced by RLS rather than by query text.

### X1 — Storefront reading flow ⬜
Why: the product has no user-facing loop; `app/page.tsx` is the Next.js default page. Needs BFF routes
for creating a spread and listing history, plus the UI. Files: `cosmic-arcana-storefront/app/*`.
Depends on: F3 (so the SDK installs), S3 for real predictions (the stub generator works meanwhile).
Acceptance: Given a signed-in user asking a question, When they submit it, Then a reading appears and
is listed in their history.

### X2 — Agent dashboard persistence and audit ⬜ (dashboard itself ✅)
Why: `InMemoryAgentActivityStore` keeps 200 events per user in one process — fine live, useless after a
restart and wrong behind more than one replica. The `AgentActivityStore` port already exists. Files:
`mcp-service-api/src/agent/in-memory-agent-activity.store.ts`. Depends on: —. Acceptance: after a
restart, `/agent` still lists past sessions.

### X3 — Smartwatch integration ⬜
Why: listed by the owner in `CLAUDE.md` ("MOORE" 1). No code, no platform, no scope defined.
Depends on: X1. Acceptance: undefined — see question Q7.

### X4 — "Driver injection" ⬜
Why: listed by the owner in `CLAUDE.md` ("MOORE" 2), described only as "driver may be with AI feature
such as mcp server". Meaning is not derivable from the code. Depends on: — Acceptance: undefined —
see question Q8.

### H1 — Align jest config in `tarot`/`history` ⬜
Why: `npm test` exits 1 in both ("no tests found") — the inherited config looks for `*.spec.ts` under
`src` while every test is `test/*.e2e-spec.ts`; CI works around it with an empty unit command. Files:
`package.json` jest block. Acceptance: `npm test` runs real tests or the script is removed.

### H2 — Decide on `chore/lighthouse-ci` (storefront) ⬜
Why: a pushed, unmerged branch (`81a47cc`) with `lighthouserc.json` and a Lighthouse workflow
(treosh/lighthouse-ci-action; thresholds for performance, a11y, SEO, bundle size). Predates the shared CI
design; nobody decided. A stale worktree sits at `cosmic-arcana-storefront/.claude/worktrees/chore+lighthouse-ci/`.
Acceptance: merged into `development` or deleted, worktree removed.

### H3 — Decide on `claude/nasa-service-architecture-ej6s6h` ⬜
Why: an unmerged branch on four repos (`ai`, `nasa`, `mcp`, `storefront`), 1 ahead / 6 behind
`development` on nasa. It adds a versioning script that bumps semver from the commit message and keeps
`package.json`, the lockfile and a `v<x.y.z>` tag in sync — overlapping F2. Acceptance: adopted
repo-wide or deleted.

### H4 — Outbox/inbox retention ⬜
Why: published outbox rows and inbox rows grow without bound. Files:
`tarot-service-api/src/database/migrations/*`, `history-service-api/src/database/migrations/*`.
Acceptance: Given rows older than the retention window, When the sweep runs, Then they are removed and
redelivery of a pruned event still cannot double-apply.

### H5 — Event fan-out beyond one consumer ⬜
Why: a BullMQ queue is a work queue, not a topic. The agent's "previous readings" projection (S7) would
**compete** with `history-service-api` for jobs instead of getting its own copy. Files:
`cosmic-arcana-sdk/src/contracts/spread-created.v1.ts`, `tarot-service-api/src/outbox/outbox-relay.service.ts`.
Depends on: must land before S7. Acceptance: one event published, both consumers apply it exactly once.

### H6 — Close out `demo-repository` PR #1 ⬜
Why: an open PR fixing the sample repo's `Proof HTML` workflow (it had no checkout step and passed on
0 files). Not part of the product. Acceptance: merged or closed.

### H7 — Replace the polling outbox relay with CDC 🟡 (documented, not built)
Why: polling works and is deliberate; reading the WAL (Debezium) removes the poll load and the
publish/commit gap. Files: `tarot-service-api/src/outbox/outbox-relay.service.ts`. Acceptance: a
committed spread is published from the WAL, with no relay polling.

### Done (do not redo)
✅ tarot write side (outbox, idempotency) · ✅ history read side (inbox, keyset pagination) · ✅ contracts
package with parsers · ✅ MCP contracts in the SDK · ✅ agent activity recording + `/agent` dashboard ·
✅ CI/CD workflows, Dockerfiles, manifests, three validation suites (locally verified, unpushed — F1) ·
✅ storefront build fixed · ✅ `nest build` fixed in `ai`/`nasa`.

❌ Superseded: a separate "command layer" service as drawn in `CLAUDE.md` (tarot-service-api is that
layer for spreads) · publishing the SDK to GitHub Packages (D5) · the event name `reading.created` —
the implemented fact is `spread.created`, though `CLAUDE.md` and `notes.md` still say the old name.

## 6. In-flight (what was happening when work paused)

Work paused immediately before committing the CI/CD build-out and the agent dashboard. **Nothing is
pushed.** Uncommitted, by repo:

- `cosmic-arcana-infrastructure/` — entire repo; `git init` done, one commit containing only this file,
  everything else staged.
- `cosmic-arcana-sdk` (branch `main`) — MCP contracts (`src/contracts/mcp/`, `src/mcp/`), `exports` map,
  `prepare` script, version `0.1.1`, `.github/workflows/ci.yml`.
- `mcp-service-api` (`feature/previous-readings-tool`) — `src/agent/*` (identity, store, recorder,
  controller), tool rewired to SDK contracts, `src/readings/reading-summary.schema.ts` **deleted**
  (moved into the SDK), Dockerfile, CI caller.
- `cosmic-arcana-storefront` (`development`) — `app/agent/*`, `app/api/agent-activity/*`,
  `lib/agent-activity.ts`, `lib/auth0.ts`, typed `proxy.ts`, CI caller, completed lockfile.
- `ai-service-api` (`feature/tarot-domain`), `nasa-service-api` (`feature/idempotency-and-retry`) —
  build fix, Dockerfile, CI caller.
- `tarot-service-api`, `history-service-api` (`main`) — SDK dependency as a git spec, Dockerfile, CI caller.

No stashes anywhere. Local `main`/`development` in `sdk`, `tarot`, `history` have no upstream configured
even though the branches exist on GitHub (they were pushed over HTTPS with an explicit URL, because the
SSH key `id_ed25519_home` is passphrase-protected and no agent identity is loaded).

**Exact next step:** decide the commit/push plan per repo (the branches above are where the work sits),
then run backlog F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8 in that order.

## 7. Traps (things that looked right and were not)

1. **`npm ci` "succeeds" with a broken SDK link.** The old `file:` dependency exits 0 and leaves a dangling
   symlink; it fails later as `MODULE_NOT_FOUND`. Check the lockfile for `"resolved": "../cosmic-arcana-sdk"`.
2. **`npm test` passing does not mean the service builds.** ts-jest applies different compiler settings;
   `nest build` was broken in `ai` and `nasa` for weeks while their tests were green. Always run
   `npm run build`.
3. **`npm run lint` auto-fixes.** Every repo's lint script passes `--fix`, so formatting problems vanish
   silently in CI and only real errors fail. Run `npx eslint src` for the honest picture
   (`nasa-service-api` then shows 47 problems, 43 of them formatting).
4. **Postgres `jsonb` does not preserve key order.** Comparing serialised JSON between the write model and
   the read model fails even when the data matches; compare field by field.
5. **The MCP server is stateless per request.** Without an `mcp-session-id` header every call would look
   like a new session; `mcp-service-api/src/mcp/mcp.controller.ts` groups those under
   `stateless:<agent>`.
6. **The `ai-service-api` image will not start with `NODE_ENV=production`** unless `ANTHROPIC_API_KEY` is
   set — its own config schema requires it there. The application compose file runs liveness-tier
   services in development mode for this reason.
7. **`@nestjs/bullmq` only registers workers if a queue is registered.** A `@Processor` alone is silently
   ignored; `history-service-api/src/spread-history/spread-history.module.ts` calls `registerQueue` purely
   to load the explorer.
8. **`@nestjs/cqrs` `EventBus` does not await handlers.** The projection is dispatched as a *command* so a
   failure can fail the BullMQ job and be retried.
9. **Docker is required for `test:e2e`** (testcontainers starts `postgres:18-alpine` and
   `redis:8-alpine`); a cold image pull turns a 3-second suite into ~30 seconds.
10. **`demo-repository`'s sample workflows are broken by default** — not a reference.

## 8. Open questions for the product owner

Q1. What is a spread, concretely? Which spread types exist, how many cards each, and what are the
position names? (`tarot-service-api/src/spreads/application/ports/spread-generator.port.ts` stores
`positionKey`, `cardId`, `reversed` as a placeholder.)

Q2. What shape is a prediction? Plain text, or sections (summary, per-card meaning, advice)? Is there a
length limit, a tone specification, a required disclaimer?

Q3. Which card set is canonical — the 78-card deck already implemented in `ai-service-api/src/tarot/`,
or something else? Do reversed cards carry separate meanings, and where do they live?

Q4. How exactly may NASA data appear in a reading? Only as imagery and mood, or may it influence which
cards are drawn? What phrasing keeps it clearly symbolic?

Q5. How long is a reading kept, and may a user delete one? This decides outbox/inbox retention (H4) and
whether the read model needs a delete path.

Q6. What may an agent see about past readings — the summary only (current `ReadingSummaryV1`), or the
full prediction text? Should a user be able to revoke an agent's access, and what happens to the
activity feed then?

Q7. Smartwatch integration: which platform (watchOS, Wear OS, both), and which part of the product runs
there — a notification, a one-card draw, the full reading?

Q8. "Driver injection": what does this mean in product terms? Which driver, injected into what, and what
should the MCP server do with it?

Q9. Where does this deploy? No target exists (no Kubernetes, Terraform, Helm or cloud account), so
`deploy.yml` is a gated stub that prints the manifest it would apply.

Q10. Is a billed AI call acceptable inside application validation? Today the generator is a deterministic
stub, which keeps validation free and repeatable; using the real model would make it neither.
