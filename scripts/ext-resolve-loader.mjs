// Module resolution hook: resolve extensionless relative imports ('./db', '../market-data') the
// way Next's bundler does, by retrying with '.js'.
//
// Unlike verify-enrich-e2e-loader.mjs this substitutes NOTHING — the real database client, the
// real KV and the real provider adapter are loaded. A probe that measures production behaviour
// has to run production modules; swapping one of them out is how a measurement becomes a fiction.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw e;
  }
}
