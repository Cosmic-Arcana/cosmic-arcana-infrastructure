import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const compose = parse(read('compose/application.yml'), { logLevel: 'error' });
const backends = Object.entries(compose.services)
  .filter(([name]) => name.endsWith('-service-api'))
  .map(([name, service]) => ({ name, short: name.replace('-service-api', ''), port: service.environment.HTTP_PORT ?? service.environment.PORT }));

const dockerAvailable = () => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('edge nginx configuration', () => {
  it('knows every backend of the application', () => {
    assert.ok(backends.length >= 5);
  });

  for (const { name, short, port } of backends) {
    it(`routes ${short}.localhost to ${name}:${port}`, () => {
      const conf = read(`nginx/conf.d/${short}.conf`);
      assert.match(conf, new RegExp(`server_name ${short}\\.localhost;`));
      assert.match(conf, new RegExp(`set \\$upstream http://${name}:${port};`));
    });
  }

  it('discards a client-supplied X-Forwarded-For on the public listener', () => {
    assert.doesNotMatch(read('nginx/conf.d/storefront.conf'), /proxy_add_x_forwarded_for/);
  });

  it('is accepted by nginx', { skip: !dockerAvailable() && 'docker is not available' }, () => {
    const nginx = fileURLToPath(new URL('nginx/', root));
    const image = /image: (nginx:\S+)/.exec(read('compose/edge.yml'))[1];
    execFileSync(
      'docker',
      ['run', '--rm', '-v', `${nginx}nginx.conf:/etc/nginx/nginx.conf:ro`, '-v', `${nginx}conf.d:/etc/nginx/conf.d:ro`, '-v', `${nginx}snippets:/etc/nginx/snippets:ro`, image, 'nginx', '-t'],
      { stdio: 'pipe' },
    );
  });
});
