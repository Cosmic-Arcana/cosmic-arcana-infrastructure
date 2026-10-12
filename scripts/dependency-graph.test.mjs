import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeAlerts } from './dependency-graph/alerts.mjs';
import { contractEdges, parseContractSpec } from './dependency-graph/contracts.mjs';
import { mermaidId, renderContracts, renderDocument, renderTopology } from './dependency-graph/render.mjs';
import { inferTopology } from './dependency-graph/topology.mjs';

const compose = {
  services: {
    api: {
      image: 'ghcr.io/x/api',
      environment: {
        WORKER_URL: 'http://worker:3000',
        DATABASE_URL: 'postgres://user:hunter2@api-db:5432/api',
        REDIS_HOST: 'redis',
        PEER_TCP_HOST: 'worker',
        UPSTREAM_BASE_URL: 'https://api.example.org',
        SELF_URL: 'http://api:1',
      },
    },
    worker: { image: 'ghcr.io/x/worker', environment: ['QUEUE_REDIS_HOST=redis', 'TOKEN=abc'] },
    'api-db': { image: 'postgres:18-alpine' },
    redis: { image: 'redis:8-alpine' },
  },
};

const edge = (topology, from, to) => topology.edges.find((e) => e.from === from && e.to === to);

describe('inferTopology', () => {
  const topology = inferTopology([compose]);

  it('draws an edge to a service named in a url, with the way it is reached', () => {
    assert.equal(edge(topology, 'api', 'worker')?.via, 'HTTP');
  });

  it('tells a database, a broker and a tcp peer apart from a url by the setting they come from', () => {
    assert.equal(edge(topology, 'api', 'api-db')?.via, 'SQL');
    assert.equal(edge(topology, 'api', 'redis')?.via, 'Redis');
    assert.equal(edge(topology, 'worker', 'redis')?.via, 'Redis');
  });

  it('classifies a node by its image, not by its name', () => {
    const kinds = Object.fromEntries(topology.nodes.map((node) => [node.id, node.kind]));
    assert.deepEqual(kinds, {
      api: 'service',
      worker: 'service',
      'api-db': 'database',
      redis: 'broker',
      'api.example.org': 'external',
    });
  });

  it('shows an https host that is not ours as an external node', () => {
    assert.equal(edge(topology, 'api', 'api.example.org')?.via, 'HTTP');
  });

  it('does not draw a service pointing at itself', () => {
    assert.equal(topology.edges.some((e) => e.from === e.to), false);
  });

  it('never carries a credential from a connection string into the result', () => {
    assert.doesNotMatch(JSON.stringify(topology), /hunter2|abc|user:/);
  });

  it('matches whole host names only, so "redis-cli" or "worker-pool" is not "redis" or "worker"', () => {
    const lookalike = inferTopology([
      { services: { a: { image: 'a', environment: { X_URL: 'http://worker-pool:1' } }, worker: { image: 'w' } } },
    ]);
    assert.deepEqual(lookalike.edges, []);
  });

  it('keeps an edge that only one file mentions, because an overlay may point somewhere else', () => {
    const base = { services: { storefront: { image: 's', environment: { TAROT_BASE_URL: 'http://tarot:3004' } }, tarot: { image: 't' }, ai: { image: 'a' } } };
    const overlay = {
      services: {
        storefront: { environment: { TAROT_BASE_URL: 'http://host.docker.internal:4004' } },
        tarot: { environment: { AI_TCP_HOST: 'ai' } },
      },
    };

    const merged = inferTopology([base, overlay]);

    assert.equal(edge(merged, 'storefront', 'tarot')?.via, 'HTTP');
    assert.equal(edge(merged, 'tarot', 'ai')?.via, 'TCP');
    assert.equal(merged.edges.some((e) => e.to === 'host.docker.internal'), false);
  });

  it('lists each edge once and in a stable order', () => {
    const twice = inferTopology([compose, compose]);

    assert.deepEqual(twice.edges, topology.edges);
    assert.deepEqual(
      topology.edges.map((e) => `${e.from}>${e.to}`),
      [...topology.edges.map((e) => `${e.from}>${e.to}`)].sort(),
    );
  });
});

describe('parseContractSpec', () => {
  it('reads the tag range out of a git dependency on a contracts repository', () => {
    assert.deepEqual(parseContractSpec('github:Cosmic-Arcana/cosmic-arcana-sdk#semver:^0.1.0'), {
      repository: 'cosmic-arcana-sdk',
      range: '^0.1.0',
      source: 'git',
    });
  });

  it('copes with a git dependency pinned to a tag or a branch rather than a range', () => {
    assert.deepEqual(parseContractSpec('github:Cosmic-Arcana/cosmic-arcana-sdk#v0.1.1'), {
      repository: 'cosmic-arcana-sdk',
      range: 'v0.1.1',
      source: 'git',
    });
    assert.equal(parseContractSpec('github:Cosmic-Arcana/cosmic-arcana-sdk').range, 'default branch');
  });

  it('says plainly when it cannot tell where a contracts package comes from', () => {
    assert.deepEqual(parseContractSpec('^0.1.0'), { repository: null, range: '^0.1.0', source: 'registry' });
    assert.deepEqual(parseContractSpec('file:../cosmic-arcana-sdk'), {
      repository: null,
      range: 'file:../cosmic-arcana-sdk',
      source: 'local path',
    });
  });
});

describe('contractEdges', () => {
  const manifests = {
    tarot: { dependencies: { '@cosmic-arcana/sdk': 'github:Cosmic-Arcana/cosmic-arcana-sdk#semver:^0.1.0', nestjs: '^11' } },
    mcp: {
      dependencies: { '@cosmic-arcana/sdk': 'github:Cosmic-Arcana/cosmic-arcana-sdk#semver:^0.1.0' },
      peerDependencies: { zod: '^4' },
    },
    sdk: { name: '@cosmic-arcana/sdk', peerDependencies: { zod: '^4' } },
    unreadable: null,
  };

  it('has one edge per repository that depends on one of our packages, and none for third parties', () => {
    const edges = contractEdges(manifests);

    assert.deepEqual(
      edges.map((e) => `${e.from}>${e.to}`),
      ['mcp>cosmic-arcana-sdk', 'tarot>cosmic-arcana-sdk'],
    );
  });

  it('records whether the dependency is needed at runtime or only to build', () => {
    const edges = contractEdges({ web: { devDependencies: { '@cosmic-arcana/sdk': 'github:Cosmic-Arcana/cosmic-arcana-sdk#semver:^0.1.0' } } });

    assert.equal(edges[0].scope, 'dev');
  });

  it('skips a repository whose manifest could not be read instead of failing', () => {
    assert.doesNotThrow(() => contractEdges({ gone: null }));
  });
});

describe('summarizeAlerts', () => {
  const alert = (name, severity, patched = null, state = 'open') => ({
    state,
    dependency: { package: { name, ecosystem: 'npm' } },
    security_advisory: { severity, summary: `${name} is vulnerable`, ghsa_id: `GHSA-${name}` },
    security_vulnerability: { first_patched_version: patched ? { identifier: patched } : null },
  });

  const summary = summarizeAlerts({
    a: [alert('handlebars', 'critical', '4.7.9'), alert('lodash', 'low', '4.17.22')],
    b: [alert('handlebars', 'critical', '4.7.9'), alert('minimatch', 'high', null), alert('old', 'high', '1.0.0', 'fixed')],
    c: [],
    d: null,
  });

  it('counts open alerts per repository by severity, and says n/a where it could not ask', () => {
    assert.deepEqual(summary.perRepo.a, { critical: 1, high: 0, medium: 0, low: 1, total: 2 });
    assert.deepEqual(summary.perRepo.b, { critical: 1, high: 1, medium: 0, low: 0, total: 2 });
    assert.deepEqual(summary.perRepo.c, { critical: 0, high: 0, medium: 0, low: 0, total: 0 });
    assert.equal(summary.perRepo.d, null);
  });

  it('ignores an alert that is no longer open', () => {
    assert.equal(summary.byPackage.some((p) => p.name === 'old'), false);
  });

  it('groups by package so one upgrade can be seen to fix several repositories', () => {
    const handlebars = summary.byPackage.find((p) => p.name === 'handlebars');

    assert.deepEqual(handlebars.repos, ['a', 'b']);
    assert.equal(handlebars.severity, 'critical');
    assert.equal(handlebars.patched, '4.7.9');
  });

  it('puts the worst severity first, then the package that touches most repositories', () => {
    assert.deepEqual(
      summary.byPackage.map((p) => p.name),
      ['handlebars', 'minimatch', 'lodash'],
    );
  });

  it('says so when no fixed version exists yet', () => {
    assert.equal(summary.byPackage.find((p) => p.name === 'minimatch').patched, 'none yet');
  });
});

describe('rendering', () => {
  const topology = inferTopology([compose]);

  it('makes node ids Mermaid accepts from names with dashes and dots', () => {
    assert.equal(mermaidId('tarot-service-api'), 'tarot_service_api');
    assert.equal(mermaidId('api.example.org'), 'api_example_org');
  });

  it('renders every edge with its label, and databases as cylinders', () => {
    const text = renderTopology(topology);

    assert.match(text, /^flowchart LR/);
    assert.match(text, /api -->\|HTTP\| worker/);
    assert.match(text, /api_db\[\(api-db\)\]/);
    assert.match(text, /api -->\|SQL\| api_db/);
  });

  it('renders contract dependencies pointing at the package they use', () => {
    const text = renderContracts([{ from: 'tarot', to: 'cosmic-arcana-sdk', range: '^0.1.0', scope: 'runtime' }]);

    assert.match(text, /tarot -->\|\^0\.1\.0\| cosmic_arcana_sdk/);
  });

  it('shows the real repository name on every box, not the id Mermaid needs', () => {
    const text = renderContracts([{ from: 'tarot-service-api', to: 'cosmic-arcana-sdk', range: '^0.1.0', scope: 'runtime' }]);

    assert.match(text, /tarot_service_api\[tarot-service-api\]/);
    assert.match(text, /cosmic_arcana_sdk\[cosmic-arcana-sdk\]:::contract/);
  });

  it('draws a build-only dependency dashed', () => {
    const text = renderContracts([{ from: 'web', to: 'cosmic-arcana-sdk', range: '^0.1.0', scope: 'dev' }]);

    assert.match(text, /web -\.->\|\^0\.1\.0\| cosmic_arcana_sdk/);
  });

  it('writes a whole document that says it is generated and how to regenerate it', () => {
    const doc = renderDocument({
      topology,
      contracts: [],
      alerts: summarizeAlerts({ a: [] }),
      footprint: [{ repo: 'a', direct: 3, dev: 2, total: 10 }],
      generatedAt: '2026-10-13',
    });

    assert.match(doc, /generated/i);
    assert.match(doc, /npm run graph/);
    assert.match(doc, /```mermaid/);
    assert.match(doc, /2026-10-13/);
  });

  it('is the same text on every run for the same input, so a regeneration shows only real changes', () => {
    const input = { topology, contracts: [], alerts: summarizeAlerts({ a: [] }), footprint: [], generatedAt: 'x' };

    assert.equal(renderDocument(input), renderDocument(input));
  });
});
