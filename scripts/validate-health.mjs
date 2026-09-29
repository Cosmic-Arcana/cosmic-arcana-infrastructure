#!/usr/bin/env node
// Health suite: every service named in the manifest answers liveness and readiness.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ENDPOINTS, assert, pass, request, runSuite, step, waitFor } from './lib.mjs';

const manifestPath = process.argv[2] ?? 'manifests/development.candidate.yml';

await runSuite('health', async () => {
  const manifest = parse(readFileSync(manifestPath, 'utf8'));
  const services = Object.keys(manifest.services ?? {}).sort();
  assert(services.length > 0, `${manifestPath} lists no services`);

  for (const service of services) {
    const endpoint = ENDPOINTS[service];
    assert(endpoint, `no published endpoint is known for ${service}`);

    step(`${service} ${endpoint.base}`);
    await waitFor(
      `${service} liveness`,
      async () => (await request(`${endpoint.base}${endpoint.live}`)).status === 200,
      { timeoutMs: 60_000 },
    );
    const ready = await request(`${endpoint.base}${endpoint.ready}`);
    assert(
      ready.status === 200,
      `${service} readiness returned ${ready.status}: ${JSON.stringify(ready.body)}`,
    );
    pass(`${service} live and ready (${manifest.services[service].tier})`);
  }
});
