// On Vercel the Remix app runs on the Node.js runtime, so there is no Cloudflare
// platform proxy. The app still references `context.cloudflare?.env` and
// `context.env?` (all optionally), falling back to `process.env`. We augment the
// AppLoadContext so those optional accesses remain type-safe.

interface CloudflareEnv {
  [key: string]: string | undefined;
}

declare module '@remix-run/node' {
  interface AppLoadContext {
    cloudflare?: {
      env?: CloudflareEnv;
    };
    env?: CloudflareEnv;
  }
}

export {};
