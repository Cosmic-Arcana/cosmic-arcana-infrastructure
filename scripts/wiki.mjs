#!/usr/bin/env node
// Writes the wiki pages, and with --publish pushes them to each repository's wiki.
//
//   npm run wiki                        # writes wiki-out/<repository>/*.md, publishes nothing
//   npm run wiki -- --publish           # pushes to every wiki that exists
//
// GitHub creates a wiki's git repository only when its first page is saved in the web interface, so a
// repository whose wiki has never had a page cannot be pushed to yet. Those are listed, not failed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collect, ORG } from './dependency-graph/collect.mjs';
import { renderDocument } from './dependency-graph/render.mjs';
import { orgPages, repoPages } from './wiki/pages.mjs';

const INFRASTRUCTURE = 'cosmic-arcana-infrastructure';
const OUT = 'wiki-out';
const publish = process.argv.includes('--publish');

const git = (cwd, ...gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const data = await collect();
const graphDocument = renderDocument({ ...data, generatedAt: new Date().toISOString().slice(0, 10) });

const pagesByRepo = Object.fromEntries(
  data.repositories.map((repo) => [
    repo,
    repo === INFRASTRUCTURE ? orgPages({ ...data, graphDocument }) : repoPages({ repo, ...data }),
  ]),
);

const write = (directory, pages) => {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(pages)) {
    writeFileSync(join(directory, name), content);
  }
};

const pushTo = (repo, pages) => {
  const workdir = mkdtempSync(join(tmpdir(), 'wiki-'));
  try {
    try {
      git(workdir, 'clone', '--quiet', `https://github.com/${ORG}/${repo}.wiki.git`, '.');
    } catch {
      return 'no wiki yet: save its first page in the Wiki tab';
    }
    for (const entry of readdirSync(workdir).filter((name) => name.endsWith('.md'))) {
      rmSync(join(workdir, entry));
    }
    write(workdir, pages);
    git(workdir, 'add', '--all');
    if (git(workdir, 'status', '--porcelain') === '') {
      return 'already up to date';
    }
    const number = Number(git(workdir, 'rev-list', '--count', 'HEAD').trim()) + 1;
    git(workdir, 'commit', '--quiet', '-m', `[${number}-docs]: regenerate from the repositories`);
    git(workdir, 'push', '--quiet', 'origin', 'HEAD');
    return 'published';
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
};

for (const [repo, pages] of Object.entries(pagesByRepo)) {
  write(join(OUT, repo), pages);
  if (publish) {
    process.stdout.write(`${repo}: ${pushTo(repo, pages)}\n`);
  }
}
if (!publish) {
  process.stdout.write(`wrote ${Object.keys(pagesByRepo).length} wikis under ${OUT}/\n`);
}
