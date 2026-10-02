import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { stringify } from 'yaml';

const DIGEST = `sha256:${'a'.repeat(64)}`;

const manifestWith = (names) => {
  const services = Object.fromEntries(
    names.map((name) => [
      name,
      { repository: `Cosmic-Arcana/${name}`, image: `ghcr.io/cosmic-arcana/${name}`, digest: DIGEST, commit: 'c0ffee', tier: 'flow' },
    ]),
  );
  const file = join(mkdtempSync(join(tmpdir(), 'manifest-')), 'candidate.yml');
  writeFileSync(file, stringify({ version: 1, channel: 'development', services }));
  return file;
};

const run = (...args) =>
  execFileSync('node', ['scripts/manifest.mjs', ...args], { encoding: 'utf8' }).trim();

const failure = (...args) => {
  try {
    run(...args);
  } catch (error) {
    return String(error.stderr);
  }
  return null;
};

describe('manifest missing', () => {
  it('prints nothing when every named service is in the manifest', () => {
    const file = manifestWith(['tarot-service-api', 'history-service-api']);

    assert.equal(run('missing', '--file', file, '--services', 'tarot-service-api,history-service-api'), '');
  });

  it('names exactly the services that are not in the manifest, in the order asked', () => {
    const file = manifestWith(['tarot-service-api']);

    assert.equal(
      run('missing', '--file', file, '--services', 'tarot-service-api,mcp-service-api,ai-service-api'),
      'mcp-service-api ai-service-api',
    );
  });

  it('tells a service that is absent from one that merely has a similar name', () => {
    const file = manifestWith(['tarot-service-api-legacy']);

    assert.equal(run('missing', '--file', file, '--services', 'tarot-service-api'), 'tarot-service-api');
  });

  it('refuses a call that names no services, so a typo cannot read as "nothing is missing"', () => {
    const file = manifestWith(['tarot-service-api']);

    assert.match(failure('missing', '--file', file, '--services', '') ?? '', /missing --services/);
    assert.match(failure('missing', '--file', file) ?? '', /missing --services/);
  });

  it('ignores stray spaces and empty entries in the list', () => {
    const file = manifestWith(['tarot-service-api']);

    assert.equal(run('missing', '--file', file, '--services', ' tarot-service-api , ,mcp-service-api '), 'mcp-service-api');
  });
});
