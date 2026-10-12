// Which repositories depend on the packages this organization publishes, and on which version.

const OWN_SCOPE = '@cosmic-arcana/';
const SCOPES = [
  ['dependencies', 'runtime'],
  ['peerDependencies', 'peer'],
  ['devDependencies', 'dev'],
];

export const parseContractSpec = (spec) => {
  const git = /^github:[^/]+\/([^#]+)(?:#(.+))?$/.exec(spec);
  if (git) {
    const ref = git[2] ?? '';
    return {
      repository: git[1],
      range: ref.startsWith('semver:') ? ref.slice('semver:'.length) : ref || 'default branch',
      source: 'git',
    };
  }
  if (/^(file|link):/.test(spec)) {
    return { repository: null, range: spec, source: 'local path' };
  }
  return { repository: null, range: spec, source: 'registry' };
};

/** `manifests` maps a repository name to its parsed package.json, or null when it could not be read. */
export const contractEdges = (manifests) => {
  const edges = [];
  for (const [from, manifest] of Object.entries(manifests)) {
    if (!manifest) {
      continue;
    }
    for (const [field, scope] of SCOPES) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (!name.startsWith(OWN_SCOPE)) {
          continue;
        }
        const parsed = parseContractSpec(String(spec));
        edges.push({
          from,
          to: parsed.repository ?? name.slice(OWN_SCOPE.length),
          package: name,
          range: parsed.range,
          source: parsed.source,
          scope,
        });
      }
    }
  }
  return edges.sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
};
