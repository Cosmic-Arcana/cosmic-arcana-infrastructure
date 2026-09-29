#!/usr/bin/env node
// Reads and writes application release manifests. The manifest is the only place that knows which
// service versions form one application, so every workflow goes through this script.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';

const TIERS = new Set(['flow', 'liveness']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const usage = `usage: manifest.mjs <command> [options]

commands:
  show           --file <path>
  services       --file <path> [--tier flow|liveness]
  image          --file <path> --service <name>
  matrix         --file <path>            json array for strategy.matrix
  env            --file <path> [--out <path>]
  contract       --file <path>            prints the pinned contract version
  set-service    --file <path> --service <name> --repository <owner/repo>
                 --image <ghcr ref without digest> --digest <sha256:...>
                 --commit <sha> --tier <flow|liveness>
  promote        --from <candidate> --to <known-good> --run-url <url>
`;

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) {
      throw new Error(`unexpected argument ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
};

const required = (args, ...keys) =>
  keys.map((key) => {
    if (!args[key]) {
      throw new Error(`missing --${key}`);
    }
    return args[key];
  });

const load = (file) => {
  const manifest = parse(readFileSync(file, 'utf8'));
  if (manifest?.version !== 1) {
    throw new Error(`${file}: unsupported manifest version ${manifest?.version}`);
  }
  manifest.services ??= {};
  return manifest;
};

const save = (file, manifest) => writeFileSync(file, stringify(manifest, { lineWidth: 0 }));

/** ghcr.io/cosmic-arcana/tarot-service-api + sha256:... -> one immutable reference. */
const imageRef = (service) => `${service.image}@${service.digest}`;

const envKey = (name) => `${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_IMAGE`;

const selectServices = (manifest, tier) =>
  Object.entries(manifest.services)
    .filter(([, service]) => !tier || service.tier === tier)
    .sort(([a], [b]) => a.localeCompare(b));

const commands = {
  show: (args) => {
    const [file] = required(args, 'file');
    const manifest = load(file);
    const lines = selectServices(manifest).map(
      ([name, service]) => `${name.padEnd(24)} ${service.tier.padEnd(9)} ${imageRef(service)}`,
    );
    return [
      `channel:  ${manifest.channel}`,
      `contract: ${manifest.contracts?.['@cosmic-arcana/sdk'] ?? 'none'}`,
      `services: ${lines.length}`,
      ...lines,
    ].join('\n');
  },

  services: (args) => {
    const [file] = required(args, 'file');
    return selectServices(load(file), args.tier)
      .map(([name]) => name)
      .join(' ');
  },

  image: (args) => {
    const [file, service] = required(args, 'file', 'service');
    const entry = load(file).services[service];
    if (!entry) {
      throw new Error(`${service} is not listed in ${file}`);
    }
    return imageRef(entry);
  },

  matrix: (args) => {
    const [file] = required(args, 'file');
    return JSON.stringify(
      selectServices(load(file)).map(([name, service]) => ({
        service: name,
        tier: service.tier,
        image: imageRef(service),
        commit: service.commit,
      })),
    );
  },

  env: (args) => {
    const [file] = required(args, 'file');
    const manifest = load(file);
    const lines = selectServices(manifest).map(
      ([name, service]) => `${envKey(name)}=${imageRef(service)}`,
    );
    const body = lines.join('\n') + '\n';
    if (args.out) {
      writeFileSync(args.out, body);
      return `wrote ${lines.length} image references to ${args.out}`;
    }
    return body.trimEnd();
  },

  contract: (args) => {
    const [file] = required(args, 'file');
    return load(file).contracts?.['@cosmic-arcana/sdk'] ?? '';
  },

  'set-service': (args) => {
    const [file, service, repository, image, digest, commit, tier] = required(
      args,
      'file',
      'service',
      'repository',
      'image',
      'digest',
      'commit',
      'tier',
    );
    if (!DIGEST_PATTERN.test(digest)) {
      throw new Error(`digest must be sha256:<64 hex>, got ${digest}`);
    }
    if (!TIERS.has(tier)) {
      throw new Error(`tier must be one of ${[...TIERS].join(', ')}`);
    }

    const manifest = load(file);
    manifest.services[service] = {
      repository,
      image,
      digest,
      commit,
      tier,
      updatedAt: new Date().toISOString(),
    };
    manifest.generatedAt = new Date().toISOString();
    if (args.contract) {
      manifest.contracts = { ...manifest.contracts, '@cosmic-arcana/sdk': args.contract };
    }
    save(file, manifest);
    return `${service} -> ${imageRef(manifest.services[service])}`;
  },

  'set-contract': (args) => {
    const [file, version] = required(args, 'file', 'version');
    const manifest = load(file);
    manifest.contracts = { ...manifest.contracts, '@cosmic-arcana/sdk': version };
    manifest.generatedAt = new Date().toISOString();
    save(file, manifest);
    return `@cosmic-arcana/sdk -> ${version}`;
  },

  promote: (args) => {
    const [from, to, runUrl] = required(args, 'from', 'to', 'run-url');
    const candidate = load(from);
    candidate.validatedBy = runUrl;
    candidate.promotedAt = new Date().toISOString();
    save(to, candidate);
    return `promoted ${Object.keys(candidate.services).length} services to ${to}`;
  },
};

const [command, ...rest] = process.argv.slice(2);
const run = commands[command];
if (!run) {
  process.stderr.write(usage);
  process.exit(1);
}

try {
  const output = run(parseArgs(rest));
  if (output) {
    process.stdout.write(`${output}\n`);
  }
} catch (error) {
  process.stderr.write(`manifest: ${error.message}\n`);
  process.exit(1);
}
