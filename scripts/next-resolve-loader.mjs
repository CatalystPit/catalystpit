// Lets plain `node scripts/*.mjs` import the app's modules.
//
// The app is written for Next's resolver, which accepts extensionless relative imports
// (`from './schema'`). Node's ESM resolver does not, so any script that reaches db.js or
// evidence.js dies on ERR_MODULE_NOT_FOUND. This hook retries a failed relative specifier with the
// extensions Next would have tried, and changes nothing else.
//
// Use: node --import ./scripts/next-resolve-loader.mjs scripts/<script>.mjs
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

if (!process.env.__NEXT_RESOLVE_HOOK) {
  process.env.__NEXT_RESOLVE_HOOK = '1';
  register('./next-resolve-loader.mjs', pathToFileURL(import.meta.filename));
}

const CANDIDATES = ['.js', '.mjs', '.jsx', '/index.js', '/index.mjs'];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw err;
    for (const ext of CANDIDATES) {
      try { return await next(specifier + ext, context); } catch { /* try the next one */ }
    }
    throw err;
  }
}
