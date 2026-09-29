# CI/CD audit — Cosmic Arcana

Date: 2026-09-24
Scope: every repository of the Cosmic Arcana application plus the GitHub organization settings that
govern them.

## 1. Method

Inspected on disk: every tracked file of the seven application repositories (`git ls-files`,
`find`), all `package.json` scripts and dependencies, every `.env.example`, the NestJS bootstrap and
module wiring of each service, and the workspace-root `docker-compose.yml`.

Executed to verify claims rather than assume them: `npm test` in all six testable repositories,
`npm run test:e2e` in the two that have end-to-end suites, `npm run build` in the storefront, and a
clean-checkout install simulation (`npm ci` with only `package.json` + `package-lock.json`).

Inspected through the GitHub API: repository metadata, Actions workflows, Actions secrets,
Environments, branch protection, and default workflow permissions for all eight repositories in the
organization.

Could **not** be verified with the current token (`gist, read:org, repo, workflow`):

| Item | Why | Effect on this audit |
| --- | --- | --- |
| GHCR packages in the org | needs `read:packages` | No Dockerfile and no publishing workflow exists in any repository, so nothing can be publishing images. Stated as inference, not observation. |
| Org-level Actions policy and default token permissions | needs org-admin scope | Repository-level values were read instead and are reported below. |

## 2. What the application actually is

| Repository | Stack | State on disk | Runtime role |
| --- | --- | --- | --- |
| `cosmic-arcana-storefront` | Next.js 16, Auth0 | **Does not build** (see 6.4). Default scaffold page, no API routes, no tests | Frontend + BFF (intended) |
| `ai-service-api` | NestJS 11 | Tarot domain complete (78 cards, spreads, deterministic draw), 75 unit tests. No transport handlers, no Anthropic adapter | Predictions, tarot interpretation |
| `nasa-service-api` | NestJS 11 | Scaffold only: config, health, correlation, idempotency, retry. **No NASA domain code at all** | Cosmic data |
| `mcp-service-api` | NestJS 11, MCP SDK v2 | `get_previous_readings` tool backed by a mock adapter | Agent doorway |
| `tarot-service-api` | NestJS 11, TypeORM, BullMQ | Complete write side: aggregate, outbox, relay, HTTP api, 11 e2e tests | Spreads write side |
| `history-service-api` | NestJS 11, TypeORM, BullMQ | Complete read side: consumer, inbox, projection, query api, 8 e2e tests | Spread history read side |
| `cosmic-arcana-sdk` | TypeScript, zero deps | Event/resource contracts + parsers, 8 unit tests | Shared contracts |

`demo-repository` is a GitHub sample repository, not part of the application. It is the **only**
repository in the organization that contains any workflow.

### 2.1 Runtime dependency graph — as verified in code

```text
                      ┌───────────────────────┐
                      │ cosmic-arcana-        │   no API routes yet,
                      │ storefront (3000)     │   build currently fails
                      └───────────────────────┘
                                 ·  (no call exists yet)
                                 ·
   ┌──────────────────────┐            ┌──────────────────────┐
   │ tarot-service-api    │  HTTP GET  │ history-service-api  │
   │ (3004)               │◀───────────│ (3005)               │
   │ postgres 5433        │ /spreads/: │ postgres 5434        │
   └──────────┬───────────┘    id      └──────────▲───────────┘
              │                                   │
              │ outbox relay: spread.created      │ BullMQ consumer
              └──────────────▶ redis 6379 ────────┘

   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │ ai-service-api   │   │ nasa-service-api │   │ mcp-service-api  │
   │ 3001 / tcp 4001  │   │ 3002 / tcp 4002  │   │ 3003 /mcp        │
   │ listens only     │   │ listens only     │   │ mock data only   │
   └──────────────────┘   └──────────────────┘   └──────────────────┘
```

Verification detail: `ClientProxy` / `ClientsModule` appear **nowhere** in any `src/`. Only
`connectMicroservice` appears, in `ai-service-api/src/main.ts` and `nasa-service-api/src/main.ts`.
Both services therefore *listen* on TCP and neither *calls* anything. `ai-service-api` carries
`NASA_SERVICE_TCP_HOST/PORT` config and a `nasa-message-patterns.ts` file, but no client uses them.

**Consequence for this task:** today the "entire application" that can be meaningfully started and
validated is `tarot-service-api` + `history-service-api` + postgres ×2 + redis. The other three
services are isolated processes with a health endpoint; the storefront does not build.

### 2.2 Communication styles

- Synchronous: one call, `history-service-api → tarot-service-api` over HTTP (`fetch`, correlation
  id header, 3 s timeout, contract-validated response).
- Asynchronous: one event, `spread.created`, produced by `tarot-service-api` through a transactional
  outbox and consumed by `history-service-api` from a BullMQ queue on a shared Redis.
- Declared but unused: the TCP message patterns `ai.*` and `nasa.*`.

## 3. Contracts

| Contract | Where | Versioned | Consumers |
| --- | --- | --- | --- |
| `SpreadCreatedV1` + envelope | `cosmic-arcana-sdk` | yes, `version: 1` in the payload, parser rejects others | tarot (producer), history (consumer) |
| `SpreadDetailsV1` | `cosmic-arcana-sdk` | by type name | tarot (server), history (client) |
| `SpreadHistoryPageV1` | `cosmic-arcana-sdk` | by type name | history (server), storefront (future) |
| `ai.*`, `nasa.*` TCP payloads | inside `ai-service-api/src` | no | nobody (no client exists) |

The SDK is consumed as a **path dependency**:

```json
"@cosmic-arcana/sdk": "file:../cosmic-arcana-sdk"
```

Verified failure mode in a single-repository checkout (what CI does):

```text
npm ci            -> exit 0   (lockfile records {"resolved": "../cosmic-arcana-sdk", "link": true})
node_modules/@cosmic-arcana/sdk -> dangling symlink
require('@cosmic-arcana/sdk')   -> MODULE_NOT_FOUND
```

So CI would not fail at install time; it would fail later, during build or test, with an error that
does not name the real cause. This is the single largest blocker to per-repository CI today.

## 4. Builds and images

- **Dockerfiles: none.** No repository contains a `Dockerfile` or `.dockerignore`.
- **Compose: one file**, at the workspace root, untracked by any repository. It provides
  infrastructure only — `postgres:18-alpine` ×2 and `redis:8-alpine` — not the services.
- **Image registry: nothing published.** No build or push workflow exists anywhere.
- **Image identity: not applicable yet.** No tags, no digests, no `latest` — because no images.
- **Reusable artifacts today:** only the npm dependency cache and the two container images used by
  tests. Nothing else is produced.

Services are started from source (`npm run start`, `node dist/main`) against locally published
compose ports. Verified working end to end by hand for tarot + history.

## 5. Build/versioning/release state

| Aspect | Observed |
| --- | --- |
| Branches | `main` + `development` everywhere, `feature/*` in three repos |
| Divergence | `development` ahead of `main` by 6 / 6 / 1 / 1 commits (ai, nasa, mcp, storefront), 0 in the three new repos |
| Tags | **none in any repository** |
| Versions | `0.0.1` (services), `0.1.0` (sdk, storefront) — never bumped |
| Releases | none |
| Deployment config | none — no Kubernetes, Terraform, Helm, Fly, Vercel or any other target |
| Infrastructure repo | **does not exist** |

## 6. Tests — inventory and measured cost

| Repository | Command | Suites / tests | Measured | Needs |
| --- | --- | --- | --- | --- |
| `ai-service-api` | `npm test` | 8 / 75 | ~1 s | nothing |
| `nasa-service-api` | `npm test` | 2 / 21 | ~1 s | nothing |
| `mcp-service-api` | `npm test` | 2 / 5 | ~2 s | nothing |
| `cosmic-arcana-sdk` | `npm test` | 1 / 8 | <1 s | nothing |
| `tarot-service-api` | `npm run test:e2e` | 3 / 11 | see 6.2 | Docker: postgres + redis (testcontainers) |
| `history-service-api` | `npm run test:e2e` | 2 / 8 | see 6.2 | Docker: postgres + redis (testcontainers) |
| `cosmic-arcana-storefront` | — | none | — | — |

### 6.1 `npm test` fails in the two new services

`tarot-service-api` and `history-service-api` inherit the Nest jest block (`rootDir: src`,
`testRegex: .*\.spec\.ts$`) but keep all their tests under `test/*.e2e-spec.ts`. Verified:

```text
tarot npm test   exit=1     # "no tests found"
history npm test exit=1
```

Any naive CI that runs `npm test` on every repository fails on these two for the wrong reason.

### 6.2 End-to-end suites

Both suites start their own `postgres:18-alpine` and `redis:8-alpine` through testcontainers in a
Jest `globalSetup`, run migrations, and drive the real command/query buses, the real relay and the
real BullMQ worker. They need a working Docker daemon and the images in the local cache; a cold image
pull adds minutes. Wall-clock measurements are recorded in §6.5.

### 6.3 Application-level tests

**None exist.** No test in any repository starts more than one service. The one cross-service path
(`history → tarot`) is covered by a test double, not by the real service. There is no contract test
suite, no consumer-driven contract verification, and no smoke test.

### 6.4 Storefront does not build

```text
npm run build
Module not found: Can't resolve './lib/auth0'   (proxy.ts:1)
```

`proxy.ts` imports `./lib/auth0`; `lib/` does not exist. The storefront cannot be part of any
application validation until this is fixed.

### 6.5 Measured timings

Measured on this machine (Docker Desktop, images already in the local cache):

| Command | Wall clock | Jest's own time |
| --- | --- | --- |
| `tarot-service-api` `npm run test:e2e` (11 tests) | 3 s | 0.77 s |
| `history-service-api` `npm run test:e2e` (8 tests) | 3 s | 0.70 s |
| same, first run of the session (containers cold) | ~31 s | 0.66 s |
| any unit suite | 1–2 s | — |

The cost is container startup, not test execution. On a GitHub-hosted runner the first pull of
`postgres:18-alpine` and `redis:8-alpine` has to be paid as well, which is why image caching is a
deliberate part of the plan.

## 7. GitHub Actions — current state

```text
ai-service-api            workflows: 0   secrets: 0   environments: 0   protection: none
nasa-service-api          workflows: 0   secrets: 0   environments: 0   protection: none
mcp-service-api           workflows: 0   secrets: 0   environments: 0   protection: none
cosmic-arcana-storefront  workflows: 0   secrets: 0   environments: 0   protection: none
tarot-service-api         workflows: 0   secrets: 0   environments: 0   protection: none
history-service-api       workflows: 0   secrets: 0   environments: 0   protection: none
cosmic-arcana-sdk         workflows: 0   secrets: 0   environments: 0   protection: none
demo-repository           workflows: 4   secrets: 0   environments: 0   protection: none
```

`demo-repository` holds the only workflows in the organization:

| Workflow | Trigger | Notes |
| --- | --- | --- |
| `Proof HTML` | `push`, `workflow_dispatch` | Was passing on 0 files (no checkout step) until fixed on a branch; not application CI |
| `Auto Assign` | `issues`, `pull_request` | Fails on pull requests: the action only understands issue context |
| `Agent approval check` | `pull_request`, `pull_request_review` | Requires a human approval on agent-authored pull requests |
| `CI failure auto-fix` | `workflow_run` of Proof HTML | Asks Claude to repair a failed run; skips while `ANTHROPIC_API_KEY` is unset |

Repository default workflow permissions (read from `tarot-service-api`):

```json
{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": true}
```

## 8. Answers to the audit questions

**Application (1–8).** (1) Seven repositories, of which five are services, one is the frontend/BFF
and one is a contracts package. (2) All under the `Cosmic-Arcana` GitHub organization, cloned side by
side in one workspace. (3) Verified graph in §2.1: only `history → tarot` (sync) and
`tarot → redis → history` (async); the storefront and the ai/nasa/mcp services have no edges yet.
(4) Synchronous: `history → tarot` HTTP. (5) Asynchronous: `spread.created` over BullMQ. (6) Shared:
`SpreadCreatedV1`, `SpreadDetailsV1`, `SpreadHistoryPageV1`. (7) In `cosmic-arcana-sdk`. (8) tarot and
history depend on the SDK; nothing else does.

**Builds (9–15).** (9) `nest build` (services), `tsc` (sdk), `next build` (storefront). (10) Docker
images are not built at all. (11) Nowhere. (12) Nothing — no image identity exists. (13) No, because
there are no images. (14) `latest` is not used anywhere, for the same reason. (15) Only the npm cache
and test container images; no build artifact is currently produced or reused.

**Testing (16–21).** (16) See §6. (17) None. (18) No. (19) **No** — services have no images, the
compose file covers infrastructure only and lives outside every repository, and the storefront does
not build. (20) Unit suites ~1–2 s each; e2e cost is dominated by container startup. (21) Docker,
postgres ×2, redis, plus `NASA_API_KEY` and `ANTHROPIC_API_KEY` once those services do real work, and
Auth0 credentials for the storefront.

**GitHub Actions (22–35).** (22)–(24) Nothing is triggered in any application repository; the four
`demo-repository` workflows are the only ones that run. (25)–(35) Reusable workflows, `workflow_call`,
`workflow_dispatch` (except the demo), `repository_dispatch`, `matrix`, `needs`, `concurrency`,
artifacts, caching, Environments and deployment approvals: **none are used anywhere**.

**Failure/race conditions (36–41).** (36)–(41) All are hypothetical today: with zero workflows, ten
commits cause zero validation runs, nothing can conflict, and no release state exists to corrupt.
They become real the moment the target design lands, and are addressed in the plan.

**Security (42–48).** (42) Repository default token permission is `read`; the demo workflows declare
their own `permissions` blocks. (43) `contents: write` is currently required only by the demo
auto-fix workflow, which pushes a fix commit. (44) No cloud credentials exist anywhere. (45) OIDC is
not used. (46) No secrets exist, so nothing is exposed; note that `can_approve_pull_request_reviews`
is `true` org-wide by default, which lets a workflow token approve pull requests — the agent approval
check already ignores bot approvals for that reason. (47) `pull_request_target` is not used anywhere;
only `pull_request`, correctly. (48) **Yes, today**: no branch is protected, so any branch can change
a workflow, and there is no required review or status check.

## 9. Race conditions, bottlenecks, waste

Nothing runs, so there is nothing to measure. The risks the target design must avoid, given the shape
of this system:

1. **Fan-out on a shared contract.** A change in `cosmic-arcana-sdk` affects two services today and
   more later. Naively triggering every dependent repository on every SDK commit multiplies cost.
2. **Duplicated workflow logic.** Six repositories share one build/test shape (NestJS + npm + jest).
   Copying a workflow into each is the obvious failure mode.
3. **Expensive application validation per commit.** Starting the full stack per commit is the single
   most expensive operation and the one most in need of coalescing.
4. **Test-container cost.** Every e2e suite pulls postgres and redis. Without a warm cache this
   dominates runtime.
5. **No image identity.** Without immutable digests there is no way to say "these exact versions form
   one application", so every validation would have to rebuild everything from source.

## 10. Security concerns to carry into the design

1. No branch protection anywhere: a feature branch can rewrite a workflow that will later run with
   write permissions. Must be fixed before any workflow gets `packages: write`.
2. `can_approve_pull_request_reviews: true` lets the Actions token approve pull requests.
3. Secrets do not exist yet, so the first workflow that needs `ANTHROPIC_API_KEY` or `NASA_API_KEY`
   defines the blast radius. Fork pull requests must never see them.
4. The storefront keeps real Auth0 credentials in an untracked `.env`; nothing prevents a future
   commit from adding it, since `.gitignore` covers `.env` but no secret scanning or push protection
   is enabled.
5. Publishing the SDK and images will require `packages: write`; that permission must exist only in
   the jobs that publish, never at workflow level.

## 11. What already works well

- Every service shares one shape: NestJS 11, npm, jest, eslint+prettier, joi-validated env, the same
  structured logger and correlation id propagation. A single reusable CI workflow can serve all of
  them.
- `.env.example` exists and matches the validation schema in four repositories, so a container's
  configuration surface is already documented.
- The tarot/history pair has real, meaningful tests that exercise transactions, idempotency, the
  relay and the broker — a solid base for application-level validation.
- Contracts already exist as a versioned package with strict parsers; that is exactly the artifact a
  contract stage needs.
- Branch convention (`main` / `development` / `feature|fix|chore/*`) and commit convention are
  consistent across repositories.

## 12. What has to change

| # | Change | Why |
| --- | --- | --- |
| 1 | Publish the SDK as a real package (GitHub Packages) and consume it by version | `file:` links cannot survive a single-repository checkout |
| 2 | Add a `Dockerfile` per service | Nothing can be validated as an application without images |
| 3 | Create an infrastructure repository owning the application compose file, the release manifest and application validation | There is no home for application-level state today |
| 4 | One reusable service CI workflow, called by every repository | Six near-identical pipelines otherwise |
| 5 | Publish images to GHCR by digest; never `latest` for orchestration | Reproducible application releases |
| 6 | Fix `npm test` in tarot/history (or call the right script from CI) | Currently exits 1 |
| 7 | Fix the storefront build | Otherwise it can never join validation |
| 8 | Branch protection + required checks on `main` and `development` | Workflows will hold write permissions |
| 9 | Coalescing and concurrency rules for application validation | Ten commits must not mean ten full-stack runs |
| 10 | Decide the trigger from service CI to application validation (`repository_dispatch`) | Cross-repository orchestration has no mechanism today |

## 13. Current flow, drawn honestly

```text
developer push (any branch, any repo)
            |
            v
        (nothing)

manual, on a laptop:
  docker compose up -d      # infrastructure only, file lives outside every repo
  npm run build && node dist/main   # per service, from source
  npm run test:e2e          # tarot, history: testcontainers
  curl                      # manual end-to-end check
```

That is the entire CI/CD system as of this audit: correct, verified, and empty.
