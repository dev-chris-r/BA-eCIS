// Assembles the committed `portable/` folder: the launch-ready app plus the
// "run with Node.js" README. Runs on plain Node (no .bat, no compiler), so it works
// on a locked-down workstation and inside the git pre-commit hook.
//
// portable/ contents:
//   dist/        - the prebuilt web app (copied from the local dist/ build, which isn't uploaded)
//   server.mjs   - the local-only static server (`node server.mjs`)
//   README.md    - how to install Node from the portal and launch on 127.0.0.1:3000
//
// It copies the already-built dist/, so run `npm run build` first if you changed src.

import { cp, rm, mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portable = path.join(root, 'portable');
const distIndex = path.join(root, 'dist', 'index.html');

if (!existsSync(distIndex)) {
  console.error('[build:portable] dist/index.html not found — run "npm run build" first.');
  process.exit(1);
}

// The README's source (share/README.md) stays on the dev machine and isn't uploaded, so a
// copy of the repo without it keeps the README already in portable/.
const readmeSource = path.join(root, 'share', 'README.md');
const keptReadme = existsSync(readmeSource) ? null : await readFile(path.join(portable, 'README.md')).catch(() => null);

// Empty the folder rather than deleting it. Removing the directory node fails with
// EBUSY whenever anything holds a handle on it - an open Explorer window, a shell
// sitting in portable/, or a running `node server.mjs` started from there - which on
// Windows would block the pre-commit hook. Clearing the contents leaves no stale files
// and cannot be locked out the same way.
await mkdir(portable, { recursive: true });
for (const entry of await readdir(portable)) {
  await rm(path.join(portable, entry), { recursive: true, force: true });
}
await cp(path.join(root, 'dist'), path.join(portable, 'dist'), { recursive: true });
await copyFile(path.join(root, 'server.mjs'), path.join(portable, 'server.mjs'));
if (keptReadme) await writeFile(path.join(portable, 'README.md'), keptReadme);
else if (existsSync(readmeSource)) await copyFile(readmeSource, path.join(portable, 'README.md'));
else console.warn('[build:portable] no README found; portable/ has none.');

console.log('[build:portable] portable/ refreshed (dist + server.mjs + README.md).');
