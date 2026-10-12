// Turns Dependabot alerts into per-repository counts and a per-package view, so one upgrade that
// would clear alerts in several repositories shows up as one line.

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const RANK = Object.fromEntries(SEVERITIES.map((name, index) => [name, SEVERITIES.length - index]));

/** `alertsByRepo` maps a repository to its alerts, or null when they could not be read. */
export const summarizeAlerts = (alertsByRepo) => {
  const perRepo = {};
  const packages = new Map();

  for (const [repo, alerts] of Object.entries(alertsByRepo)) {
    if (alerts === null) {
      perRepo[repo] = null;
      continue;
    }
    const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    for (const alert of alerts.filter((a) => a.state === 'open')) {
      const severity = alert.security_advisory?.severity;
      if (severity in counts) {
        counts[severity] += 1;
      }
      counts.total += 1;

      const name = alert.dependency?.package?.name ?? 'unknown';
      const entry = packages.get(name) ?? { name, repos: new Set(), severity, patched: new Set() };
      entry.repos.add(repo);
      if (RANK[severity] > RANK[entry.severity]) {
        entry.severity = severity;
      }
      const fixed = alert.security_vulnerability?.first_patched_version?.identifier;
      if (fixed) {
        entry.patched.add(fixed);
      }
      packages.set(name, entry);
    }
    perRepo[repo] = counts;
  }

  const byPackage = [...packages.values()]
    .map((entry) => ({
      name: entry.name,
      repos: [...entry.repos].sort(),
      severity: entry.severity,
      patched: entry.patched.size === 0 ? 'none yet' : [...entry.patched].sort().join(' / '),
    }))
    .sort(
      (a, b) =>
        RANK[b.severity] - RANK[a.severity] || b.repos.length - a.repos.length || a.name.localeCompare(b.name),
    );

  return { perRepo, byPackage };
};
