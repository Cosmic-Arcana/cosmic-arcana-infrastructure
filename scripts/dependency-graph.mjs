#!/usr/bin/env node
// Builds docs/dependency-graph.md from what the repositories and GitHub actually say.
//
//   npm run graph                       # writes docs/dependency-graph.md
//   node scripts/dependency-graph.mjs --out somewhere.md
import { writeFileSync } from 'node:fs';

import { collect } from './dependency-graph/collect.mjs';
import { renderDocument } from './dependency-graph/render.mjs';

const outFlag = process.argv.indexOf('--out');
const out = outFlag === -1 ? 'docs/dependency-graph.md' : process.argv[outFlag + 1];

const { topology, contracts, alerts, footprint } = await collect();

writeFileSync(out, renderDocument({ topology, contracts, alerts, footprint, generatedAt: new Date().toISOString().slice(0, 10) }));
process.stdout.write(`wrote ${out}\n`);
