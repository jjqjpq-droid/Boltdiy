// Committed shim used only for the SSR (server) build.
//
// The transitive `util` browser polyfill (util@0.12.5) does not ship a
// `util/types` submodule. On the Node.js server runtime (Vercel), `undici`
// and other deps import `util/types`, so we redirect those imports here and
// re-export Node's real implementation.
module.exports = require('node:util/types');
