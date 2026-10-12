// Reads the runtime topology out of compose files: which service is configured to talk to which.
// Edges come from configuration (urls, hosts), not from start order, so they say what is called.

const SQL_KEYS = new Set(['DATABASE_URL']);

const environmentOf = (service) => {
  const raw = service?.environment;
  if (!raw) {
    return {};
  }
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw.map((entry) => {
        const at = entry.indexOf('=');
        return at === -1 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
      }),
    );
  }
  return raw;
};

const kindOfImage = (image = '') => {
  if (image.includes('postgres')) {
    return 'database';
  }
  return image.includes('redis') ? 'broker' : 'service';
};

const viaOf = (key, value) => {
  if (SQL_KEYS.has(key)) {
    return 'SQL';
  }
  if (key.endsWith('REDIS_HOST')) {
    return 'Redis';
  }
  if (key.endsWith('_TCP_HOST')) {
    return 'TCP';
  }
  return /^https?:\/\//.test(value) ? 'HTTP' : 'uses';
};

/** Only the host is ever taken from a value, so a password in a connection string stays behind. */
const hostOf = (value) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      return new URL(value).hostname;
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9.-]+$/.test(value) ? value : null;
};

/**
 * `composeDocs` are parsed compose files. Each is read on its own and the edges are unioned: an
 * overlay may point a setting somewhere else (a test proxy), and that must not erase the edge the
 * base file declares.
 */
export const inferTopology = (composeDocs) => {
  const images = new Map();
  for (const doc of composeDocs) {
    for (const [name, service] of Object.entries(doc.services ?? {})) {
      if (service?.image && !images.has(name)) {
        images.set(name, service.image);
      }
      if (!images.has(name)) {
        images.set(name, '');
      }
    }
  }

  const edges = new Map();
  const externals = new Set();
  for (const doc of composeDocs) {
    for (const [from, service] of Object.entries(doc.services ?? {})) {
      for (const [key, rawValue] of Object.entries(environmentOf(service))) {
        const value = String(rawValue);
        const host = hostOf(value);
        if (!host || host === from) {
          continue;
        }
        const via = viaOf(key, value);
        if (images.has(host)) {
          edges.set(`${from}>${host}>${via}`, { from, to: host, via });
        } else if (/^https:\/\//.test(value) && host.includes('.') && !host.endsWith('.invalid')) {
          externals.add(host);
          edges.set(`${from}>${host}>${via}`, { from, to: host, via });
        }
      }
    }
  }

  const nodes = [
    ...[...images].map(([id, image]) => ({ id, kind: kindOfImage(image) })),
    ...[...externals].map((id) => ({ id, kind: 'external' })),
  ];
  return {
    nodes,
    edges: [...edges.values()].sort((a, b) =>
      `${a.from}>${a.to}>${a.via}`.localeCompare(`${b.from}>${b.to}>${b.via}`),
    ),
  };
};
