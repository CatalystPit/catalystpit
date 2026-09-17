// Module resolution hook for scripts/verify-enrich-e2e.mjs.
//   1. src/lib/db(.js) resolves to the scratch-schema test double instead of the production client.
//   2. Extensionless relative imports ('./db', './name-resolver') resolve the way Next's bundler
//      resolves them, by trying '.js'.
const DOUBLE = new URL('./verify-enrich-e2e-db.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (/^\.\.?\/(.*\/)?db$/.test(specifier) && /\/src\/lib\//.test(context.parentURL || '')) {
    return { url: DOUBLE, shortCircuit: true, format: 'module' };
  }
  try {
    const res = await next(specifier, context);
    if (/\/src\/lib\/db\.js$/.test(res.url)) return { ...res, url: DOUBLE, shortCircuit: true };
    return res;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw e;
  }
}
