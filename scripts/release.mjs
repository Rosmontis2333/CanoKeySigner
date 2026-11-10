import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this script through npm run release');
const runNpm = (arguments_, options) => execFileSync(process.execPath, [npmCli, ...arguments_], options);
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (lock.name !== metadata.name || lock.version !== metadata.version || !/^[0-9A-Za-z.+-]+$/.test(metadata.version)) {
  throw new Error('Package and lockfile identity must match before release');
}
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  const requested = Object.entries(metadata[section] ?? {}).sort();
  const locked = Object.entries(lock.packages[''][section] ?? {}).sort();
  if (JSON.stringify(requested) !== JSON.stringify(locked)) throw new Error(`Package and lockfile ${section} differ`);
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';

async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.isDirectory()) {
      for (const child of await files(join(directory, entry.name))) result.push(`${entry.name}/${child}`);
    } else if (entry.isFile()) result.push(entry.name);
    else throw new Error(`Release inputs must be regular files or directories: ${join(directory, entry.name)}`);
  }
  return result;
}

async function checksums(directory, names = undefined) {
  const result = [];
  for (const name of names ?? await files(directory)) {
    const bytes = await readFile(join(directory, name));
    result.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  return result;
}

async function sourceFileNames() {
  const names = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'README.md', '.gitignore'];
  for (const directory of ['src', 'public', 'scripts', 'test', 'docs']) {
    for (const name of await files(join(root, directory))) names.push(`${directory}/${name}`);
  }
  return names.sort();
}
const sourceNames = await sourceFileNames();
const sourceChecksums = await checksums(root, sourceNames);
const releaseRoot = join(root, 'release');
await mkdir(releaseRoot, { recursive: true });
const staging = await mkdtemp(join(releaseRoot, '.staging-'));

try {
  const builds = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const [command, directory] of [['build', 'dist'], ['build:offline', 'dist-offline']]) {
      runNpm(['run', command], { cwd: root, stdio: 'inherit' });
      const current = await checksums(join(root, directory));
      if (pass === 0) {
        builds.push({ directory, files: current });
        await cp(join(root, directory), join(staging, directory), { recursive: true });
      } else if (json(current) !== json(builds.find((build) => build.directory === directory).files)) {
        throw new Error(`${directory} differs between consecutive builds`);
      }
      const html = await readFile(join(root, directory, 'index.html'), 'utf8');
      if (!html.includes(`name="application-version" content="${metadata.version}"`) || html.includes('__CANOKEY_VERSION__')) throw new Error('Build version is missing');
      if (directory === 'dist-offline' && !html.includes("connect-src 'none';")) throw new Error('Offline CSP must prohibit connections');
      if (directory === 'dist-offline') {
        for (const name of current.filter((file) => file.path.endsWith('.js')).map((file) => file.path)) {
          const script = await readFile(join(root, directory, name), 'utf8');
          if (/relay\.walletconnect\.org|eth_sendRawTransaction|eth_getBlockByNumber|api\.devnet\.solana\.com/.test(script)) {
            throw new Error(`Offline build contains a network implementation: ${name}`);
          }
        }
      }
    }
  }

  const dependencies = [];
  for (const path of Object.keys(lock.packages).filter(Boolean).sort()) {
    const entry = lock.packages[path];
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let installed;
    try { installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (installed && (installed.name !== name || installed.version !== entry.version)) throw new Error(`Installed package differs from lockfile: ${path}`);
    const notices = [];
    if (installed) {
      for (const file of (await readdir(join(root, path))).sort()) {
        if (!/^(licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(file)) continue;
        if (!(await stat(join(root, path, file))).isFile()) continue;
        const target = `notices/${path}/${file}`;
        await mkdir(dirname(join(staging, target)), { recursive: true });
        await cp(join(root, path, file), join(staging, target));
        notices.push(target);
      }
    }
    dependencies.push({ path, name, version: entry.version, dev: entry.dev ?? false, optional: entry.optional ?? false,
      resolved: entry.resolved ?? null, integrity: entry.integrity ?? null, license: entry.license ?? installed?.license ?? null,
      installed: Boolean(installed), hasInstallScript: entry.hasInstallScript ?? false,
      installScripts: Object.fromEntries(Object.entries(installed?.scripts ?? {}).filter(([name]) => ['preinstall', 'install', 'postinstall'].includes(name))),
      notices });
  }
  await writeFile(join(staging, 'dependencies.json'), json({ lockfileVersion: lock.lockfileVersion,
    scope: 'All lockfile package entries, including development and platform-optional dependencies. Notice files are copied from installed packages.',
    packagesWithoutNoticeFiles: dependencies.filter((entry) => entry.installed && !entry.notices.length).map((entry) => entry.path),
    packagesWithoutLicenseMetadata: dependencies.filter((entry) => entry.license === null).map((entry) => entry.path), packages: dependencies }));

  for (const name of sourceNames) {
    const target = join(staging, 'source', name);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(root, name), target);
  }
  if (json(await checksums(root, await sourceFileNames())) !== json(sourceChecksums)) throw new Error('Sources changed during release preparation');
  await writeFile(join(staging, 'build-info.json'), json({ name: metadata.name, version: metadata.version,
    environment: { node: process.version, npm: runNpm(['--version'], { encoding: 'utf8' }).trim(), platform: process.platform, architecture: process.arch },
    verification: { consecutiveBuildsMatch: true, offlineNetworkCheck: true },
    configuration: 'Vite uses the invoking environment and local .env files. Local environment files are excluded from the source snapshot. Artifact hashes bind the resulting configuration.',
    sourceSha256: hash(json(sourceChecksums)), sourceFiles: sourceChecksums, builds }));
  const contents = await checksums(staging);
  await writeFile(join(staging, 'SHA256SUMS'), contents.map((file) => `${file.sha256}  ${file.path}\n`).join(''));
  const destination = resolve(releaseRoot, `${metadata.name}-${metadata.version}-${hash(json(contents)).slice(0, 12)}`);
  try { await rename(staging, destination); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || json(await checksums(staging)) !== json(await checksums(destination))) throw error;
  }
  console.log(`Release prepared at ${destination}`);
  console.log(`${dependencies.length} locked packages, ${dependencies.filter((entry) => entry.installed).length} installed packages. See dependencies.json for notice and metadata gaps.`);
} finally { await rm(staging, { recursive: true, force: true }); }
