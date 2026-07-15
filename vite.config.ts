import { vitePlugin as remixVitePlugin } from '@remix-run/dev';
import { vercelPreset } from '@vercel/remix/vite';
import UnoCSS from 'unocss/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import tsconfigPaths from 'vite-tsconfig-paths';
import * as dotenv from 'dotenv';

// Load environment variables from multiple files
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
dotenv.config();

export default defineConfig((config) => {
  return {
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    },
    build: {
      target: 'esnext',
      rollupOptions: config.isSsrBuild
        ? {
            // Keep `undici` out of the server bundle entirely. Rolling it up
            // makes the bundler try to load `util/types` from the `util`
            // browser polyfill (which has no such submodule) and crashes.
            // Vercel's Node runtime provides `undici` and `node:util` natively.
            external: ['undici'],
          }
        : {},
    },
    ssr: {
      external: ['undici'],
    },
    plugins: [
      // The transitive `util` browser polyfill (0.12.5) has no `util/types`
      // submodule, so the server build crashes when `undici` imports it.
      // Force any `util/types` request (bare specifier or the pre-resolved
      // polyfill path) to Node's native `node:util/types`.
      config.isSsrBuild && {
        name: 'redirect-util-types-to-node',
        enforce: 'pre' as const,
        resolveId(source: string) {
          if (source === 'util/types' || /[\\/]util[\\/]types$/.test(source)) {
            return { id: 'node:util/types', external: true };
          }

          return null;
        },
      },
      // Only polyfill Node built-ins for the client bundle. The Vercel server
      // runtime is Node.js and provides the real modules, so polyfilling there
      // breaks packages like `undici` that import `util/types`.
      !config.isSsrBuild &&
        nodePolyfills({
          include: ['buffer', 'process', 'util', 'stream'],
          globals: {
            Buffer: true,
            process: true,
            global: true,
          },
          protocolImports: true,
          exclude: ['child_process', 'fs', 'path'],
        }),
      {
        name: 'buffer-polyfill',
        transform(code, id) {
          if (id.includes('env.mjs')) {
            return {
              code: `import { Buffer } from 'buffer';\n${code}`,
              map: null,
            };
          }

          return null;
        },
      },
      remixVitePlugin({
        presets: [vercelPreset()],
        future: {
          v3_fetcherPersist: true,
          v3_relativeSplatPath: true,
          v3_throwAbortReason: true,
          v3_lazyRouteDiscovery: true,
        },
      }),
      UnoCSS(),
      tsconfigPaths({ ignoreConfigErrors: true }),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
    ],
    server: {
      host: '0.0.0.0',
      port: 5000,
      strictPort: true,
      allowedHosts: true,
    },
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OPENAI_LIKE_API_MODELS',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
    ],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    test: {
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/tests/preview/**', // Exclude preview tests that require Playwright
      ],
    },
  };
});

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}
