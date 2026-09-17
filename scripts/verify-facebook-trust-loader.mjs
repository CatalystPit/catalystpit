// Resolution hooks for scripts/verify-facebook-trust.mjs:
//   src/lib/db(.js)   -> the scratch-schema double (shared with verify-enrich-e2e)
//   'server-only'     -> a no-op, so the publisher can be imported by a script
//   './x'             -> './x.js', the way Next's bundler resolves extensionless imports
const DB_DOUBLE = new URL('./verify-enrich-e2e-db.mjs', import.meta.url).href;
const EMPTY = 'data:text/javascript,export default {};';

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: EMPTY, shortCircuit: true, format: 'module' };
  if (/^\.\.?\/(.*\/)?db$/.test(specifier) && /\/src\/lib\//.test(context.parentURL || '')) {
    return { url: DB_DOUBLE, shortCircuit: true, format: 'module' };
  }
  try {
    const res = await next(specifier, context);
    if (/\/src\/lib\/db\.js$/.test(res.url)) return { ...res, url: DB_DOUBLE, shortCircuit: true };
    return res;
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw e;
  }
}
