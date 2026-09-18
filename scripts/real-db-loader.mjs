// Resolution hooks for scripts that run REAL server modules against the REAL database:
//   'server-only'  -> a no-op, so server modules can be imported by a script
//   './x'          -> './x.js', the way Next's bundler resolves extensionless imports
// No database double. Anything imported here talks to DATABASE_URL.
const EMPTY = 'data:text/javascript,export default {};';

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: EMPTY, shortCircuit: true, format: 'module' };
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    throw e;
  }
}
