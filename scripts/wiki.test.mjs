import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeAlerts } from './dependency-graph/alerts.mjs';
import { orgPages, repoPages } from './wiki/pages.mjs';

const topology = {
  nodes: [
    { id: 'storefront', kind: 'service' },
    { id: 'tarot', kind: 'service' },
    { id: 'ai', kind: 'service' },
    { id: 'tarot-db', kind: 'database' },
    { id: 'unrelated', kind: 'service' },
  ],
  edges: [
    { from: 'storefront', to: 'tarot', via: 'HTTP' },
    { from: 'tarot', to: 'ai', via: 'TCP' },
    { from: 'tarot', to: 'tarot-db', via: 'SQL' },
    { from: 'unrelated', to: 'ai', via: 'TCP' },
  ],
};
const contracts = [{ from: 'tarot', to: 'sdk', range: '^0.1.0', scope: 'runtime' }];
const alerts = summarizeAlerts({
  tarot: [{ state: 'open', dependency: { package: { name: 'multer' } }, security_advisory: { severity: 'high' }, security_vulnerability: {} }],
  sdk: null,
});
const descriptions = { tarot: 'The write side.', storefront: 'The frontend.', ai: 'The mind.', sdk: 'Contracts.', 'tarot-db': undefined };
const repositories = ['ai', 'sdk', 'storefront', 'tarot'];
const context = { topology, contracts, alerts, descriptions, repositories, footprint: [{ repo: 'tarot', direct: 4, dev: 2, total: 99 }] };
const home = (repo) => repoPages({ repo, ...context })['Home.md'];

describe('a repository wiki home page', () => {
  it('opens with the repository description exactly as GitHub holds it', () => {
    assert.match(home('tarot'), /^# tarot\n\nThe write side\./);
  });

  it('says who the service calls and by what, and who calls it', () => {
    const page = home('tarot');

    assert.match(page, /Calls[\s\S]*\[ai\]\(https:\/\/github\.com\/Cosmic-Arcana\/ai\/wiki\) over TCP/);
    assert.match(page, /`tarot-db` over SQL/);
    assert.match(page, /Called by[\s\S]*\[storefront\]\(https:\/\/github\.com\/Cosmic-Arcana\/storefront\/wiki\) over HTTP/);
  });

  it('draws only the neighbours of the service, not the whole stack', () => {
    const page = home('tarot');

    assert.match(page, /```mermaid/);
    assert.match(page, /storefront -->\|HTTP\| tarot/);
    assert.doesNotMatch(page, /unrelated -->/);
  });

  it('names the contracts package it depends on and the version it asks for', () => {
    assert.match(home('tarot'), /\[sdk\]\(https:\/\/github\.com\/Cosmic-Arcana\/sdk\/wiki\)[^\n]*`\^0\.1\.0`/);
  });

  it('says a repository is outside the running stack instead of inventing calls', () => {
    const page = home('sdk');

    assert.match(page, /not part of the running stack/i);
    assert.doesNotMatch(page, /Called by/);
  });

  it('shows its open alerts, and says n/a where GitHub could not be asked', () => {
    assert.match(home('tarot'), /0 critical, 1 high, 0 medium, 0 low/);
    assert.match(home('sdk'), /n\/a/);
  });

  it('links to the pages GitHub itself keeps for security and dependencies', () => {
    const page = home('tarot');

    assert.match(page, /github\.com\/Cosmic-Arcana\/tarot\/security\/policy/);
    assert.match(page, /github\.com\/Cosmic-Arcana\/tarot\/network\/dependencies/);
  });

  it('has a sidebar that leads back to the organization architecture', () => {
    assert.match(repoPages({ repo: 'tarot', ...context })['_Sidebar.md'], /cosmic-arcana-infrastructure\/wiki\/Architecture/);
  });

  it('is the same text on every run, so a republish shows only real changes', () => {
    assert.deepEqual(repoPages({ repo: 'tarot', ...context }), repoPages({ repo: 'tarot', ...context }));
  });
});

describe('the organization wiki pages', () => {
  const pages = orgPages({ ...context, graphDocument: '# Dependency graph\n\nbody text\n' });

  it('lists every repository with its description and a link to its wiki', () => {
    assert.match(pages['Home.md'], /\[tarot\]\(https:\/\/github\.com\/Cosmic-Arcana\/tarot\/wiki\)[^\n]*The write side\./);
    assert.match(pages['Home.md'], /\[sdk\]\(https:\/\/github\.com\/Cosmic-Arcana\/sdk\/wiki\)/);
  });

  it('draws the whole stack on the architecture page', () => {
    assert.match(pages['Architecture.md'], /unrelated -->\|TCP\| ai/);
  });

  it('carries the generated dependency graph without a second title', () => {
    assert.match(pages['Dependency-graph.md'], /body text/);
    assert.doesNotMatch(pages['Dependency-graph.md'], /^# Dependency graph/m);
  });

  it('points the security page at the policy and at private reporting', () => {
    assert.match(pages['Security.md'], /Report a vulnerability/);
    assert.match(pages['Security.md'], /Cosmic-Arcana\/\.github\/blob\/main\/SECURITY\.md/);
  });
});
