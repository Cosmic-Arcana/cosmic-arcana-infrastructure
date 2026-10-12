// Turns the inferred data into Markdown with Mermaid, which GitHub draws in files, wikis and issues.
// Output is sorted and has no clock in it except the date it is given, so regenerating shows only
// what really changed.

const ORG = 'https://github.com/Cosmic-Arcana';

export const mermaidId = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');

const nodeLine = ({ id, kind }) => {
  const key = mermaidId(id);
  if (kind === 'database' || kind === 'broker') {
    return `  ${key}[(${id})]:::store`;
  }
  return kind === 'external' ? `  ${key}(${id}):::external` : `  ${key}[${id}]`;
};

export const renderTopology = ({ nodes, edges }) =>
  [
    'flowchart LR',
    ...[...nodes].sort((a, b) => a.id.localeCompare(b.id)).map(nodeLine),
    ...edges.map((edge) => `  ${mermaidId(edge.from)} -->|${edge.via}| ${mermaidId(edge.to)}`),
    '  classDef store fill:#eef2ff,stroke:#6366f1;',
    '  classDef external stroke-dasharray: 4 3;',
  ].join('\n');

export const renderContracts = (edges) => {
  const targets = [...new Set(edges.map((edge) => edge.to))].sort();
  return [
    'flowchart LR',
    ...targets.map((id) => `  ${mermaidId(id)}[${id}]:::contract`),
    ...edges.map((edge) => {
      const arrow = edge.scope === 'runtime' ? '-->' : '-.->';
      return `  ${mermaidId(edge.from)} ${arrow}|${edge.range}| ${mermaidId(edge.to)}`;
    }),
    '  classDef contract fill:#fef3c7,stroke:#d97706;',
  ].join('\n');
};

const fence = (body) => ['```mermaid', body, '```'].join('\n');
const cell = (value) => (value === null || value === undefined ? 'n/a' : String(value));

const footprintTable = (footprint, alerts) =>
  [
    '| Repository | Direct | Dev | Packages in the graph | Open alerts (critical / high / medium / low) |',
    '| --- | ---: | ---: | ---: | --- |',
    ...[...footprint]
      .sort((a, b) => a.repo.localeCompare(b.repo))
      .map((row) => {
        const counts = alerts.perRepo[row.repo];
        const open = counts
          ? `${counts.critical} / ${counts.high} / ${counts.medium} / ${counts.low}`
          : 'n/a';
        return `| [${row.repo}](${ORG}/${row.repo}/security/dependabot) | ${cell(row.direct)} | ${cell(row.dev)} | ${cell(row.total)} | ${open} |`;
      }),
  ].join('\n');

const packagesTable = (byPackage, limit = 12) =>
  [
    '| Package | Worst | Repositories | Fixed in |',
    '| --- | --- | --- | --- |',
    ...byPackage
      .slice(0, limit)
      .map((p) => `| \`${p.name}\` | ${p.severity} | ${p.repos.length}: ${p.repos.join(', ')} | ${p.patched} |`),
  ].join('\n');

const contractsTable = (contracts) =>
  [
    '| Repository | Depends on | Version it asks for | Used at |',
    '| --- | --- | --- | --- |',
    ...contracts.map((e) => `| ${e.from} | ${e.package} | \`${e.range}\` (${e.source}) | ${e.scope} |`),
  ].join('\n');

export const renderDocument = ({ topology, contracts, alerts, footprint, generatedAt }) =>
  [
    '# Dependency graph',
    '',
    `This page is generated, on ${generatedAt}. Do not edit it by hand: run \`npm run graph\` in`,
    '`cosmic-arcana-infrastructure` to refresh it. Everything below is read from the repositories and from',
    "GitHub's own dependency data; nothing is drawn from memory.",
    '',
    '## Who calls whom',
    '',
    'Read from the compose files that start the application for validation. An arrow means a service is',
    'configured with the address of another; it is not a promise about traffic. Redis carries the BullMQ',
    'queues, so two services pointing at it may be the producer and the consumer of the same event; the',
    "contracts package says which. Dashed boxes are services outside this organization.",
    '',
    fence(renderTopology(topology)),
    '',
    '## Who depends on our contracts',
    '',
    'Solid arrows are needed at runtime, dashed ones only to build or as a peer.',
    '',
    fence(renderContracts(contracts)),
    '',
    contractsTable(contracts),
    '',
    '## Third-party footprint and open alerts',
    '',
    'Direct and dev counts come from each `package.json`; the package total is what GitHub\'s dependency',
    'graph sees in the lockfile; the alerts are Dependabot\'s open ones.',
    '',
    footprintTable(footprint, alerts),
    '',
    '## What to upgrade first',
    '',
    'The same package often appears in several repositories, so one upgrade clears several alerts.',
    'Worst severity first, then the package that touches the most repositories.',
    '',
    packagesTable(alerts.byPackage),
    '',
    "## GitHub's own views",
    '',
    'Per repository: **Insights → Dependency graph** (every package, and what depends on it),',
    '**Security → Dependabot** (the alerts), and **Insights → Dependency graph → Export SBOM**.',
    '',
    ...[...footprint]
      .sort((a, b) => a.repo.localeCompare(b.repo))
      .map((row) => `- [${row.repo}](${ORG}/${row.repo}/network/dependencies)`),
    '',
  ].join('\n');
