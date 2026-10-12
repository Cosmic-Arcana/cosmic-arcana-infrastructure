// Builds the wiki pages from the same data as the dependency graph, so a wiki cannot drift from the
// repositories: everything it says about calls, contracts and alerts is read, not written by hand.
import { renderContracts, renderTopology } from '../dependency-graph/render.mjs';

const ORG = 'https://github.com/Cosmic-Arcana';
const INFRASTRUCTURE = 'cosmic-arcana-infrastructure';
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const wikiLink = (repo) => `[${repo}](${ORG}/${repo}/wiki)`;
const fence = (body) => ['```mermaid', body, '```'].join('\n');
const oneLine = (text) => text.replace(/\s+/g, ' ').trim();
const describe = (description) => (description ? oneLine(description) : 'No description is set on GitHub yet.');

const nameOf = (id, repositories) => (repositories.includes(id) ? wikiLink(id) : `\`${id}\``);

const alertLine = (counts) =>
  counts ? SEVERITIES.map((severity) => `${counts[severity]} ${severity}`).join(', ') : 'n/a (GitHub could not be asked)';

const neighbourhood = (topology, repo) => {
  const edges = topology.edges.filter((edge) => edge.from === repo || edge.to === repo);
  const ids = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return { nodes: topology.nodes.filter((node) => ids.has(node.id)), edges };
};

const stackSection = (topology, repo, repositories) => {
  const near = neighbourhood(topology, repo);
  if (near.edges.length === 0) {
    return ['## Where it sits', '', 'This repository is not part of the running stack, so it calls no service and no service calls it.'];
  }
  const calls = near.edges.filter((edge) => edge.from === repo);
  const callers = near.edges.filter((edge) => edge.to === repo);
  const list = (edges, pick) => edges.map((edge) => `- ${nameOf(pick(edge), repositories)} over ${edge.via}`);
  return [
    '## Where it sits',
    '',
    'Read from the compose files that start the application for validation.',
    '',
    fence(renderTopology(near)),
    ...(calls.length ? ['', '### Calls', '', ...list(calls, (edge) => edge.to)] : []),
    ...(callers.length ? ['', '### Called by', '', ...list(callers, (edge) => edge.from)] : []),
  ];
};

const contractsSection = (contracts, repo, repositories) => {
  const uses = contracts.filter((edge) => edge.from === repo);
  const usedBy = contracts.filter((edge) => edge.to === repo);
  if (uses.length === 0 && usedBy.length === 0) {
    return [];
  }
  return [
    '## Contracts',
    '',
    ...uses.map((edge) => `- Depends on ${nameOf(edge.to, repositories)}, asking for \`${edge.range}\` (${edge.scope})`),
    ...usedBy.map((edge) => `- Used by ${nameOf(edge.from, repositories)}, which asks for \`${edge.range}\` (${edge.scope})`),
    '',
  ];
};

const securitySection = (repo, alerts, footprint) => {
  const row = footprint.find((entry) => entry.repo === repo);
  const packages = row && row.total !== null ? [`Packages in GitHub's dependency graph: ${row.total}.`] : [];
  return [
    '## Security and dependencies',
    '',
    `Open Dependabot alerts: ${alertLine(alerts.perRepo[repo])}.`,
    ...packages,
    '',
    `- [Security policy](${ORG}/${repo}/security/policy)`,
    `- [Dependabot alerts](${ORG}/${repo}/security/dependabot)`,
    `- [Dependency graph](${ORG}/${repo}/network/dependencies)`,
  ];
};

const sidebar = () =>
  [
    '**Organization**',
    '',
    `- [Architecture](${ORG}/${INFRASTRUCTURE}/wiki/Architecture)`,
    `- [Security](${ORG}/${INFRASTRUCTURE}/wiki/Security)`,
    `- [Dependency graph](${ORG}/${INFRASTRUCTURE}/wiki/Dependency-graph)`,
    `- [All repositories](${ORG}/${INFRASTRUCTURE}/wiki)`,
    '',
  ].join('\n');

export const repoPages = ({ repo, topology, contracts, alerts, descriptions, repositories, footprint }) => ({
  'Home.md':
    [
      `# ${repo}`,
      '',
      describe(descriptions[repo]),
      '',
      ...stackSection(topology, repo, repositories),
      '',
      ...contractsSection(contracts, repo, repositories),
      ...securitySection(repo, alerts, footprint),
      '',
      `Generated from the repositories by \`npm run wiki\` in ${wikiLink(INFRASTRUCTURE)}; edits made here are overwritten.`,
    ].join('\n') + '\n',
  '_Sidebar.md': sidebar(),
});

const intro = [
  'A Next.js frontend and BFF in front of NestJS microservices. Writes and reads are separated: the',
  'service that owns a fact announces it through a transactional outbox, and every read model is built',
  'by the service that owns it. A database per service, one Redis as the broker, and an MCP server as',
  "the agent's only doorway into the application.",
].join('\n');

const securityPage = ({ repositories, alerts }) =>
  [
    '# Security',
    '',
    'Report a vulnerability privately: open the **Security** tab of the affected repository and choose',
    `**Report a vulnerability**. The full policy is in [SECURITY.md](${ORG}/.github/blob/main/SECURITY.md).`,
    '',
    'Every repository has private vulnerability reporting, secret scanning with push protection, and Dependabot alerts.',
    '',
    '| Repository | Open alerts |',
    '| --- | --- |',
    ...repositories.map((repo) => `| [${repo}](${ORG}/${repo}/security/dependabot) | ${alertLine(alerts.perRepo[repo])} |`),
    '',
  ].join('\n');

export const orgPages = ({ topology, contracts, alerts, descriptions, repositories, graphDocument }) => ({
  'Home.md':
    [
      '# Cosmic Arcana',
      '',
      'Every repository keeps its own wiki, generated from the repositories themselves.',
      '',
      '| Repository | What it is |',
      '| --- | --- |',
      ...repositories.map((repo) => `| ${wikiLink(repo)} | ${describe(descriptions[repo])} |`),
      '',
      `Start with [Architecture](${ORG}/${INFRASTRUCTURE}/wiki/Architecture).`,
    ].join('\n') + '\n',
  'Architecture.md':
    [
      '# Architecture',
      '',
      intro,
      '',
      '## Who calls whom',
      '',
      fence(renderTopology(topology)),
      '',
      '## Who depends on our contracts',
      '',
      fence(renderContracts(contracts)),
      '',
    ].join('\n'),
  'Security.md': securityPage({ repositories, alerts }),
  'Dependency-graph.md': graphDocument.replace(/^# .*\n+/, ''),
  '_Sidebar.md': sidebar(),
});
