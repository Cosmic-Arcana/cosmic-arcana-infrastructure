# cosmic-arcana-infrastructure

[![org](https://img.shields.io/badge/org-Cosmic--Arcana-6d28d9?logo=github)](https://github.com/Cosmic-Arcana)
[![workflows](https://img.shields.io/badge/reusable-service--ci.yml-111827)](.github/workflows/service-ci.yml)
[![manifest](https://img.shields.io/badge/version-image%20digests-0f172a)](manifests/development.yml)

Owns what no single service can own: the shared CI pipeline, the application release manifest, and
the validation that answers one question —

> if we run the whole application with this new version of one service and the existing versions of
> every other, does it still work?

## What lives here

```text
.github/workflows/
  service-ci.yml             reusable pipeline every service calls (lint, build, test, image, dispatch)
  record-candidate.yml       receives service-updated / contract-published, writes the candidate manifest
  application-validation.yml debounce → resolve → validate (health · contract · integration) → promote
  deploy.yml                 manual, environment gated, manifest driven
manifests/
  development.yml            known-good: the last set of digests that passed validation together
  development.candidate.yml  newest known state of every service; what validation runs
compose/application.yml      the application, assembled from image digests
scripts/                     manifest tooling and the three validation suites
docs/                        audit, plan, implementation report
```

## The manifest is the application version

```yaml
services:
  tarot-service-api:
    image: ghcr.io/cosmic-arcana/tarot-service-api
    digest: sha256:…
    commit: 7f3c2ab…
    tier: flow
contracts:
  '@cosmic-arcana/sdk': 0.1.1
```

A service is rebuilt only when its own repository changes. Every other service is reused **by
digest** — immutable, so it cannot go stale. `latest` never appears in orchestration.

`tier: flow` means the service takes part in the application's behaviour and is validated as such;
`tier: liveness` means it is started and must answer its health endpoint, which is all those
services can promise today.

## Local use

```bash
npm ci
npm run manifest -- show --file manifests/development.yml
npm run manifest -- env --file manifests/development.yml --out compose/.env

docker compose -f compose/application.yml --env-file compose/.env up -d --wait \
  $(npm run --silent manifest -- services --file manifests/development.yml --tier flow)

node scripts/validate-health.mjs manifests/development.yml
node scripts/validate-integration.mjs
node scripts/validate-contract.mjs      # needs @cosmic-arcana/sdk installed

docker compose -f compose/application.yml --env-file compose/.env down -v
```

## Adding a service to the application

1. Add `.github/workflows/ci.yml` to the service repository calling `service-ci.yml` with
   `build-image: true` and the right `tier`.
2. Push. Its CI publishes an image and dispatches `service-updated`.
3. The candidate manifest gains the service; the next validation starts it.
4. If it is `tier: flow`, add its endpoint to `scripts/lib.mjs` and its wiring to
   `compose/application.yml`.

## Secrets

| Secret | Where | Why |
| --- | --- | --- |
| `INFRA_DISPATCH_TOKEN` | organization | lets a service repository tell this one that an image exists. Fine-grained, scoped to this repository. Without it, service CI warns and the manifest simply does not move. |

Everything else runs on `GITHUB_TOKEN`.
