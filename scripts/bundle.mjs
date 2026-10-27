// The offline install bundle: everything an administrator needs to install Glassbox on a machine with no
// registry access, and to check that it is what was released.
//
//   node scripts/bundle.mjs [--out DIR]     → release/glassbox-trace-<version>/
//   node scripts/bundle.mjs --verify DIR    → recompute every SHA-256 in DIR/SHA256SUMS; exit 1 on a mismatch
//
// The folder holds the npm tarball (what `npm i -g` installs; zero dependencies), the standalone viewer
// (dist/glassbox.html, for machines without Node), a CycloneDX 1.5 SBOM, SHA256SUMS in `sha256sum -c` format and
// INSTALL.md. `npm pack` is deterministic for the same tree, so the tarball's hash is reproducible; the SBOM's
// timestamp comes from SOURCE_DATE_EPOCH when set, so a rebuild can match byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The viewer carries the IBM Plex subsets inside it (scripts/build.mjs); they are the only third-party content
// shipped. Listed with their own hashes so a scanner can match them.
export function fontComponents(dir = path.join(root, 'assets/fonts')) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.woff2')).sort();
  return files.map((f) => ({
    type: 'file', 'bom-ref': `font:${f}`, name: f, supplier: { name: 'IBM' }, copyright: 'Copyright 2019 IBM Corp.',
    licenses: [{ license: { id: 'OFL-1.1' } }], hashes: [{ alg: 'SHA-256', content: sha256(fs.readFileSync(path.join(dir, f))) }],
    properties: [{ name: 'glassbox:embedded-in', value: 'dist/glassbox.html' }],
  }));
}

// CycloneDX 1.5. The serial number is derived from the tarball's hash, so the same release always has the same one.
export function sbom({ pkg, tarball, viewer, fonts, timestamp }) {
  const ref = `pkg:npm/${pkg.name}@${pkg.version}`;
  const h = tarball.sha256;
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return {
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${uuid}`, version: 1,
    metadata: {
      timestamp,
      tools: { components: [{ type: 'application', name: 'glassbox scripts/bundle.mjs', version: pkg.version }] },
      component: {
        type: 'application', 'bom-ref': ref, name: pkg.name, version: pkg.version, purl: ref, description: pkg.description,
        supplier: { name: pkg.author }, licenses: [{ license: { id: pkg.license } }], hashes: [{ alg: 'SHA-256', content: h }],
        externalReferences: [{ type: 'vcs', url: String(pkg.repository && pkg.repository.url || '').replace(/^git\+/, '') }, { type: 'website', url: pkg.homepage }],
        properties: [{ name: 'glassbox:runtime-dependencies', value: String(Object.keys(pkg.dependencies || {}).length) }, { name: 'glassbox:engine', value: `node ${pkg.engines && pkg.engines.node}` }],
      },
    },
    components: [
      { type: 'file', 'bom-ref': 'file:glassbox-viewer.html', name: 'glassbox-viewer.html', version: pkg.version, description: 'The standalone viewer (dist/glassbox.html); also inside the tarball', hashes: [{ alg: 'SHA-256', content: viewer.sha256 }], licenses: [{ license: { id: pkg.license } }] },
      ...fonts,
    ],
    dependencies: [{ ref, dependsOn: fonts.map((f) => f['bom-ref']) }],
    // Complete: no runtime npm dependencies; dev dependencies (playwright, for tests) are not shipped.
    compositions: [{ aggregate: 'complete', assemblies: [ref] }],
  };
}

export const sumsText = (entries) => entries.map((e) => `${e.sha256}  ${e.name}`).join('\n') + '\n';
export function verify(dir) {
  const lines = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n').filter((l) => l.trim());
  return lines.map((l) => { const [want, name] = l.split(/\s+\*?/); const p = path.join(dir, name); const got = fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null; return { name, ok: got === want, want, got }; });
}

export function installText({ pkg, tarball }) {
  const v = pkg.version, tgz = tarball.name;
  return `# Glassbox ${v}: offline install

This folder installs Glassbox on a machine with no access to the npm registry. Glassbox has no runtime
dependencies, so the tarball is everything; it needs Node.js ${pkg.engines.node}. Nothing it runs opens a network connection
(docs/IT.md in the package lists every file it reads and writes).

| File | What it is |
|---|---|
| \`${tgz}\` | the npm package, exactly as published |
| \`glassbox-viewer.html\` | the viewer on its own: open it in a browser and drop a transcript on it; no Node needed |
| \`sbom.cdx.json\` | CycloneDX 1.5 SBOM: the package, the viewer, and the IBM Plex fonts inside the viewer (OFL-1.1) |
| \`SHA256SUMS\` | SHA-256 of every file here |

## 1. Check the files

Linux / macOS:

    sha256sum -c SHA256SUMS        (macOS: shasum -a 256 -c SHA256SUMS)

Windows (PowerShell), compare each hash with the line in SHA256SUMS:

    Get-FileHash -Algorithm SHA256 ${tgz}, glassbox-viewer.html, sbom.cdx.json, INSTALL.md

The published package's provenance (which GitHub Actions run built it) is on npmjs.com for the same version;
the tarball here has the same SHA-256 as \`npm pack glassbox-trace@${v}\`.

## 2. Install for every user

From an administrator prompt, with an npm prefix every user can read (the default on Linux/macOS when run with
sudo; on Windows set one first, e.g. \`npm config set prefix "C:\\Program Files\\nodejs" --location=global\`):

    npm install --global --offline --no-audit --no-fund ./${tgz}
    glassbox --version

## 3. Turn it on through Claude Code's managed settings (optional)

    glassbox managed --hook --statusline --temp redact            prints the settings, changes nothing
    glassbox managed --hook --statusline --temp redact --install  writes managed-settings.d/glassbox.json

\`--install\` writes Glassbox's own file next to the organisation's managed-settings.json (C:\\Program Files\\ClaudeCode,
/Library/Application Support/ClaudeCode or /etc/claude-code), so it never edits yours. Hooks, the status line and the
temp-folder policy are each optional; \`--guard\` adds the loop guard, \`--temp deny\` stops \`glassbox open\` writing
transcripts to the temp folder at all. \`glassbox managed --uninstall\` removes the file.

## 4. Remove

    glassbox managed --uninstall
    npm uninstall --global ${pkg.name}
`;
}

export function bundle(opts = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = path.resolve(opts.out || path.join(root, 'release', `${pkg.name}-${pkg.version}`));
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  // npm is a .cmd on Windows, so it needs the shell (and a quoted path, only there: without a shell the quotes
  // reach npm as part of the path); node itself must not go through it,
  // or "C:\Program Files\nodejs\node.exe" splits at the space.
  const run = (cmd, args, shell = false) => { const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(-400)}`); return r.stdout; };
  run(process.execPath, [path.join(root, 'scripts', 'build.mjs')]);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', process.platform === 'win32' ? JSON.stringify(out) : out], process.platform === 'win32'))[0];
  const tgzPath = path.join(out, packed.filename);
  const tarball = { name: packed.filename, sha256: sha256(fs.readFileSync(tgzPath)), files: packed.files.length, size: packed.size };
  fs.copyFileSync(path.join(root, 'dist', 'glassbox.html'), path.join(out, 'glassbox-viewer.html'));
  const viewer = { name: 'glassbox-viewer.html', sha256: sha256(fs.readFileSync(path.join(out, 'glassbox-viewer.html'))) };
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const timestamp = new Date(epoch ? Number(epoch) * 1000 : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(path.join(out, 'sbom.cdx.json'), JSON.stringify(sbom({ pkg, tarball, viewer, fonts: fontComponents(), timestamp }), null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'INSTALL.md'), installText({ pkg, tarball }));
  const entries = [tarball.name, 'glassbox-viewer.html', 'sbom.cdx.json', 'INSTALL.md'].map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(out, name))) }));
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), sumsText(entries));
  return { out, tarball, entries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const at = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--verify')) {
    const res = verify(path.resolve(at('--verify') || '.'));
    for (const r of res) console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name}`);
    process.exit(res.every((r) => r.ok) ? 0 : 1);
  }
  const r = bundle({ out: at('--out') });
  console.log(`${r.out}\n${r.entries.map((e) => `  ${e.sha256}  ${e.name}`).join('\n')}\n  (${r.tarball.files} files in the tarball, ${Math.round(r.tarball.size / 1024)} KB)`);
}
