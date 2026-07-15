/**
 * Post-install fix for the `util` browser polyfill (0.12.5).
 *
 * `undici` (pulled in transitively by Remix's fetch polyfills) does
 * `require('node:util/types')`. During the Remix/Vite SSR build the
 * `@rollup/plugin-commonjs` resolver strips the `node:` prefix and resolves
 * `util/types` to the installed `util` browser-polyfill package, which has no
 * `util/types` submodule. It then tries to read an extension-less file at
 * `.../util/types` and crashes with ENOENT.
 *
 * pnpm-based approaches (patches, extension-less shim files) don't survive a
 * clean install reliably (the file gets filtered by the package `files`
 * allowlist / content-addressable store on fresh CI installs like Vercel).
 *
 * This script runs after every install and writes real files
 * (`types` and `types.js`) into each installed copy of `util@x` inside
 * `node_modules/.pnpm`, each re-exporting Node's native `node:util/types`.
 * It is idempotent and safe to run repeatedly.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const shim = "'use strict';\nmodule.exports = require('node:util/types');\n";

function fixPnpmStore() {
  const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm');

  if (!existsSync(pnpmDir)) {
    return;
  }

  let fixed = 0;

  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith('util@')) {
      continue;
    }

    const utilDir = join(pnpmDir, entry, 'node_modules', 'util');

    if (!existsSync(utilDir)) {
      continue;
    }

    // Only patch the polyfill package (which ships `util.js`), never anything
    // that already provides types.
    for (const file of ['types', 'types.js']) {
      const target = join(utilDir, file);

      try {
        writeFileSync(target, shim);
        fixed++;
      } catch {
        // ignore write failures (read-only stores, etc.)
      }
    }
  }

  if (fixed > 0) {
    console.log(`[fix-util-types] wrote ${fixed} util/types shim file(s).`);
  }
}

fixPnpmStore();
