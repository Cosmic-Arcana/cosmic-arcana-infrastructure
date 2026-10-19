#!/usr/bin/env node
// Builds docs/dependency-graph.md from what the repositories and GitHub actually say.
//
//   npm run graph                       # writes docs/dependency-graph.md
//   node scripts/dependency-graph.mjs --out somewhere.md
//
// Manifests are read from the public raw files, so that part needs only a network. Package totals and
// Dependabot alerts need the `gh` CLI signed in with access to the repositories; without it those
// cells say "n/a" instead of the run failing.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

import { summarizeAlerts } from './dependency-graph/alerts.mjs';
import { contractEdges } from './dependency-graph/contracts.mjs';
import { renderDocument } from './dependency-graph/render.mjs';
import { inferTopology } from './dependency-graph/topology.mjs';

const ORG = 'Cosmic-Arcana';
const REPOSITORIES = [
  'ai-service-api',
  'arcana-prng-fingerprint',
  'arcana-rng-lab',
  'cosmic-arcana-extension',
  'cosmic-arcana-infrastructure',
  'cosmic-arcana-mobile',
  'cosmic-arcana-sdk',
  'cosmic-arcana-storefront',
  'history-service-api',
  'mcp-service-api',
  'nasa-service-api',
  'tarot-service-api',
];
// Changes land on development first, so that is the state worth drawing; some repositories only have main.
const BRANCHES = ['development', 'main'];
const COMPOSE_FILES = ['compose/application.yml', 'compose/e2e-ci.yml'];

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) {
      pairs.push([value.slice(2), all[index + 1]]);
    }
    return pairs;
  }, []),
);
const out = args.out ?? 'docs/dependency-graph.md';

const warn = (message) => process.stderr.write(`warning: ${message}\n`);

const readManifest = async (repo) => {
  for (const branch of BRANCHES) {
    const response = await fetch(`https://raw.githubusercontent.com/${ORG}/${repo}/${branch}/package.json`);
    if (response.ok) {
      return response.json();
    }
  }
  return null;
};

const gh = (...apiArgs) => JSON.parse(execFileSync('gh', ['api', ...apiArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

const sbomTotal = (repo) => {
  try {
    return gh(`repos/${ORG}/${repo}/dependency-graph/sbom`).sbom.packages.length;
  } catch {
    warn(`could not read the dependency graph of ${repo}`);
    return null;
  }
};

const openAlerts = (repo) => {
  try {
    const pages = gh('--paginate', '--slurp', `repos/${ORG}/${repo}/dependabot/alerts?state=open&per_page=100`);
    return pages.flat();
  } catch {
    warn(`could not read the Dependabot alerts of ${repo}`);
    return null;
  }
};

const manifests = {};
for (const repo of REPOSITORIES) {
  manifests[repo] = await readManifest(repo);
}

const composeDocs = COMPOSE_FILES.map((file) => parse(readFileSync(file, 'utf8'), { logLevel: 'error' }));

const footprint = REPOSITORIES.map((repo) => ({
  repo,
  direct: manifests[repo] ? Object.keys(manifests[repo].dependencies ?? {}).length : null,
  dev: manifests[repo] ? Object.keys(manifests[repo].devDependencies ?? {}).length : null,
  total: sbomTotal(repo),
}));
const alerts = summarizeAlerts(Object.fromEntries(REPOSITORIES.map((repo) => [repo, openAlerts(repo)])));

writeFileSync(
  out,
  renderDocument({
    topology: inferTopology(composeDocs),
    contracts: contractEdges(manifests),
    alerts,
    footprint,
    generatedAt: new Date().toISOString().slice(0, 10),
  }),
);
process.stdout.write(`wrote ${out}\n`);
