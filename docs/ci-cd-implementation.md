# CI/CD implementation report — Cosmic Arcana

Date: 2026-09-24
Follows `docs/ci-cd-audit.md` (phase 1) and `docs/ci-cd-plan.md` (phase 2).

## 1. What changed

| Repository | Added | Changed |
| --- | --- | --- |
| `cosmic-arcana-infrastructure` **(new)** | 5 workflows, 2 manifests, application compose file, manifest tooling, 3 validation suites, the three documents | — |
| `ai-service-api` | `ci.yml`, `Dockerfile`, `.dockerignore` | fixed a build-breaking `LogLevel` import |
| `nasa-service-api` | `ci.yml`, `Dockerfile`, `.dockerignore` | same fix |
| `mcp-service-api` | `ci.yml`, `Dockerfile`, `.dockerignore` | consumes the contracts package |
| `tarot-service-api` | `ci.yml`, `Dockerfile`, `.dockerignore` | contracts package by version instead of a path link |
| `history-service-api` | `ci.yml`, `Dockerfile`, `.dockerignore` | same |
| `cosmic-arcana-sdk` | `ci.yml` (verify, tag, notify) | `prepare` script, `exports` map, MCP contracts, version `0.1.1` |
| `cosmic-arcana-storefront` | `ci.yml` | `lib/auth0.ts` and a typed `proxy.ts` so the build passes |

## 2. Why the shape is what it is

The audit found seven repositories, zero workflows and one blocking defect: `@cosmic-arcana/sdk` was
a `file:../cosmic-arcana-sdk` path link, which `npm ci` resolves to a dangling symlink in any
single-repository checkout. Nothing downstream — image build, CI, application validation — can work
before that is fixed, so the contracts package drives the whole design.

Everything else follows the principle stated in the plan: **service CI produces immutable artifacts;
the infrastructure repository owns application state.**

## 3. Workflow architecture

```text
service repo                              cosmic-arcana-infrastructure
────────────                              ────────────────────────────
push / PR / schedule
   │
   └── ci.yml (caller, ~25 lines)
         └── service-ci.yml  (reusable)
               verify ─ lint · build · unit · e2e
               image  ─ buildx → ghcr.io/...@sha256   (never on pull requests)
               dispatch ─ repository_dispatch ─────────▶ record-candidate.yml
                                                          │ serialized, never cancelled
                                                          │ writes development.candidate.yml
                                                          ▼
                                                        application-validation.yml
                                                          debounce 45s   (cancel superseded)
                                                          prepare        (manifest → outputs + artifact)
                                                          resolve        (matrix: service → digest exists)
                                                          validate       (matrix: health · contract · integration)
                                                          promote        (candidate → known-good, release)
                                                          │
                                                          ▼
                                                        deploy.yml (manual, environment gated)

cosmic-arcana-sdk
   └── ci.yml: verify → tag vX.Y.Z → repository_dispatch: contract-published
```

One reusable workflow serves six repositories. A caller passes only what differs: service name,
tier, which test commands exist, whether to build an image.

## 4. How application validation works

1. A service's CI publishes an image and dispatches `service-updated` with `{service, repository,
   image, digest, commit, tier}`.
2. `record-candidate.yml` writes that one service entry into `manifests/development.candidate.yml`
   and commits it. Every other service keeps the digest it already had — unchanged services are
   never rebuilt, they are *referenced*.
3. `application-validation.yml` reads the candidate, uploads it as an artifact (so the run describes
   exactly one manifest even if the branch moves), verifies every digest is pullable, then starts the
   application from those digests with `docker compose … up --wait` and runs three suites in
   parallel:
   - **health** — `/health/live` and `/health/ready` for every service in the manifest;
   - **contract** — creates a spread, reads the row the producer actually wrote
     (`psql` inside the container), parses it with the contract version pinned in the manifest, then
     parses the spread resource and the history page;
   - **integration** — the real flow: create → projection → history, idempotent replay returns the
     stored spread with `idempotency-replayed: true` and creates no second row, unknown spread is
     404.
4. If all three pass, `promote` copies the validated manifest to `manifests/development.yml`,
   commits it and publishes a GitHub release `app-<UTC>-<sha>` with the manifest attached.

A validation result is reproducible from the release manifest plus the workflow version; nothing
depends on "whatever was in the registry at the time".

## 5. Caching

| What | Mechanism | Invalidated by |
| --- | --- | --- |
| npm dependencies | `actions/setup-node` cache keyed on `package-lock.json` | any dependency change |
| Docker layers | BuildKit `type=gha`, scope per service | Dockerfile, sources, base image |
| Unchanged services | **not a cache** — a digest reference in the manifest | nothing; a digest cannot go stale |

Rebuild triggers are per repository, which is exactly the boundary of a service's inputs: source,
dependencies, Dockerfile, build config and workflow all live together. Two cross-repository inputs
are handled explicitly: a contract release dispatches `contract-published`, and a weekly scheduled
run rebuilds images from `development` so a base-image fix lands without waiting for a commit.

## 6. Commit coalescing

Ten pushes in five minutes produce ten cheap recordings and **one** expensive validation:

- recording is serialized and never cancelled (`manifest-candidate-development`,
  `cancel-in-progress: false`), so no service's digest is lost;
- validation cancels superseded runs (per-job groups with `cancel-in-progress: true`) after a 45 s
  debounce, so work that a newer dispatch would discard is never started.

The two-stage split is the point: because the candidate always carries every recent change, the
surviving validation covers the cancelled ones too. Cancelling the *dispatch* instead would silently
drop a service's change.

## 7. Concurrency

| Workflow / job | Group | Cancels |
| --- | --- | --- |
| service CI | `service-ci-<workflow>-<pr or ref>` | yes |
| record candidate | `manifest-candidate-development` | no |
| debounce / prepare / resolve / validate | `application-validation-development-*` | yes |
| promote and release | `application-release-development` | **no** |
| deploy | `application-<environment>` | **no** |

Concurrency is declared per job in the validation workflow rather than per workflow, so cancelling a
superseded validation can never interrupt a promote that is already writing a release.

## 8. Contracts

`@cosmic-arcana/sdk` is consumed as `github:Cosmic-Arcana/cosmic-arcana-sdk#semver:^0.1.0`:

- `npm ci` resolves it from the lockfile's exact commit, so builds are reproducible;
- the package's `prepare` script builds `dist/` at install time;
- no registry credentials are needed anywhere — CI, Docker builds and laptops all work the same way;
- a version is released by its git tag, created by the SDK's own CI when `package.json` changes.

**Deviation from the plan (§12).** The plan preferred GitHub Packages and listed the git dependency
as the fallback "if the friction outweighs the benefit". It does: GitHub Packages requires a token
even for public packages, which would mean a `read:packages` PAT on every developer machine and a
BuildKit secret in every Docker build. The publish path is a small change away if that trade ever
flips: swap the dependency spec and re-add the `.npmrc` plumbing (both were written and removed in
this implementation, and the history shows exactly what they looked like).

The contract suite installs the manifest's pinned version and parses what the running system
produces, so a contract change is validated against the current application before any service
adopts it.

## 9. The release manifest

```yaml
version: 1
channel: development
contracts:
  '@cosmic-arcana/sdk': 0.1.1
services:
  tarot-service-api:
    repository: Cosmic-Arcana/tarot-service-api
    image: ghcr.io/cosmic-arcana/tarot-service-api
    digest: sha256:…
    commit: …
    tier: flow
```

`scripts/manifest.mjs` is the only writer and the only reader: `set-service`, `set-contract`,
`promote`, plus `show`, `services`, `image`, `matrix` and `env` for the workflows. It validates
digests (`sha256:` + 64 hex) and tiers, so a malformed dispatch cannot poison the manifest.

## 10. Artifacts

| Artifact | From | To |
| --- | --- | --- |
| `candidate-manifest` | prepare | validate, promote |
| `diagnostics-<suite>` (compose ps, logs, manifest) | failed validation | humans |

Image digests travel as job outputs, not artifacts. The manifest travels as a committed file *and* an
artifact: the file is the state, the artifact is the immutable snapshot this run judged.

## 11. Rollback

Deployment is manifest-driven, so rollback is "deploy the previous release tag" — no rebuild, no
reverted commit, no ambiguity about which versions were running together. `deploy.yml` downloads the
manifest attached to the chosen release, verifies every digest is still pullable, and (once a target
exists) applies it. Today it stops at the verification step and prints what it would deploy.

## 12. Security

- Every workflow declares `permissions: contents: read`; the four jobs that need more declare it
  themselves: `packages: write` (image push), `contents: write` (manifest commits, tags, releases),
  `packages: read` (digest checks).
- Pull requests run lint, build and tests only. The image job is gated on
  `github.event_name != 'pull_request'`, so a fork can neither publish an image nor reach the
  dispatch token. `pull_request_target` is not used anywhere.
- Cross-repository dispatch uses `INFRA_DISPATCH_TOKEN`, a fine-grained token scoped to the
  infrastructure repository. When it is absent, the dispatch step prints a warning and succeeds, so
  the pipeline degrades instead of failing with a secret error.
- The registry is GHCR with `GITHUB_TOKEN`. No cloud credentials exist yet; when they do, OIDC with
  an environment-scoped role is the documented path.
- Still open, and recorded here rather than silently accepted: no branch protection exists, so a
  branch can still change a privileged workflow (§14).

## 13. What was verified, and how

Verified locally:

| Check | Result |
| --- | --- |
| YAML parses (11 workflows + compose) | all pass |
| GitHub Actions schema (`@action-validator/cli`) | all 11 valid (three missing input descriptions found and fixed) |
| `manifest.mjs` set-service / env / matrix / image / show | correct output, digest and tier validation reject bad input |
| Unit suites: ai 75, nasa 21, mcp 15, sdk 20 | pass |
| e2e suites: tarot 11, history 8 | pass |
| `npm run build` in every repository | passes — **after fixing a pre-existing break in ai and nasa** |
| Storefront `next build` | passes with and without Auth0 environment variables |
| Service image build + run + health endpoints | ai-service image: 65 MB, runs as `node`, health endpoints answer, structured logs with correlation ids |
| **Full application validation, locally** | tarot and history images built from their Dockerfiles, started through `compose/application.yml`, all three suites run: health ✓, contract ✓, integration ✓ |
| MCP contracts moved into the SDK, MCP service still green | pass |

Requires a real Actions run (stated rather than assumed):

- `workflow_call` resolution across repositories, `repository_dispatch` delivery, and the
  `workflow_run` chain from recording to validation;
- GHCR push, digest output and `type=gha` cache behaviour;
- concurrency and cancellation semantics under real bursts;
- the first `npm ci` of `tarot`, `history` and `mcp` against the published SDK tag: their lockfiles
  still record the old path link and must be regenerated once `v0.1.1` exists (§15, step 3).

### 13.1 Pre-existing defects found while verifying

1. **`nest build` failed in `ai-service-api` and `nasa-service-api`** (TS1272: `LogLevel` imported as
   a value in a decorated constructor). The unit suites passed because ts-jest does not apply
   `isolatedModules` + `emitDecoratorMetadata` the same way, so this had been invisible. Fixed by
   importing the type with `import type`; the same fix was already in the two newest services.
2. **The storefront did not build** (`proxy.ts` imported a missing `./lib/auth0`, then an implicit
   `any`). Fixed with a five-line `lib/auth0.ts` and a typed request parameter.
3. **An `ai-service-api` image cannot start with `NODE_ENV=production` unless `ANTHROPIC_API_KEY`
   is set** — its own config schema requires it there. The application compose file therefore runs
   the liveness-tier services in development mode; a real deployment must supply the key.
4. **The integration suite caught a false difference in its own assertion**: Postgres `jsonb` does
   not preserve key order, so comparing serialised cards failed even though the data matched. The
   suite now compares field by field. Worth recording because it is exactly the class of bug an
   application-level test is supposed to surface early.
5. **`npm test` exits 1 in tarot and history** (their jest config looks for `*.spec.ts` under `src`,
   while their tests are `test/*.e2e-spec.ts`). Not changed: their callers pass `test-command: ''`
   and `e2e-command: npm run test:e2e`, which is honest about what those repositories have. Aligning
   the jest config is a follow-up.

## 14. Remaining limitations

- No branch protection and no required checks; `can_approve_pull_request_reviews` is still enabled
  organization-wide. Both are one API call each and are listed in §15.
- `ai`, `nasa` and `mcp` are liveness-only in the manifest: they have no behaviour to validate yet.
- The storefront is not in the manifest — it has no image and no routes worth validating.
- Compose is not production-like; there is no production target to be like.
- Outbox and inbox retention, and application-level tracing across services, are untouched.

## 15. Ordered migration steps

1. Push `cosmic-arcana-infrastructure` (workflows must exist on `main` before any caller can use
   them).
2. Push `cosmic-arcana-sdk`. Its CI tags `v0.1.1` and dispatches `contract-published`.
3. Regenerate the lockfiles of `tarot`, `history` and `mcp` (`npm install`) so they resolve the
   published tag, and commit them.
4. Push the service repositories. Their first CI run builds images and seeds the candidate manifest.
5. Create the `INFRA_DISPATCH_TOKEN` organization secret (fine-grained, contents: read/write on
   `cosmic-arcana-infrastructure` only). Until it exists, service CI warns instead of dispatching.
6. Run `application-validation.yml` manually once (`workflow_dispatch`) to prove the chain.
7. Enable branch protection on `main` and `development` with the CI check required, and disable
   Actions review approval:
   ```bash
   gh api -X PUT /repos/Cosmic-Arcana/<repo>/branches/main/protection \
     -f 'required_status_checks[strict]=true' -f 'required_status_checks[contexts][]=ci' \
     -F 'enforce_admins=false' -F 'required_pull_request_reviews[required_approving_review_count]=1' \
     -F 'restrictions=null'
   gh api -X PUT /orgs/Cosmic-Arcana/actions/permissions/workflow \
     -F can_approve_pull_request_reviews=false
   ```
8. Add `staging` and `production` environments with required reviewers before `deploy.yml` does
   anything real.

## 16. Follow-ups worth doing

- Align the jest configuration in tarot and history so `npm test` means something there.
- Publish OpenAPI descriptions for the two HTTP services and validate them in the contract suite.
- Replace the polling outbox relay with CDC once the write volume justifies it (already noted in the
  relay's own comment).
- Give the agent's "previous readings" projection its own queue when it arrives — one BullMQ queue
  per event type cannot fan out to two consumers.
- Add retention jobs for the outbox and inbox tables.
