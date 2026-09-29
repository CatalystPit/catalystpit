// The resolver half of node-resolve-hook.mjs. See that file for why.
const EXTS = ['.js', '.mjs', '.jsx', '/index.js', '/index.mjs'];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    // Only a relative specifier Node could not find is retried, and only by appending the extensions
    // the bundler would have tried. Anything else is re-thrown untouched.
    if (!specifier.startsWith('.') || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    for (const ext of EXTS) {
      try { return await next(specifier + ext, context); } catch { /* try the next one */ }
    }
    throw err;
  }
}
