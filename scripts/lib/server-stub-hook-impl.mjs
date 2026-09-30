// The resolver/loader half of server-stub-hook.mjs. See that file for why.
//
// ⚠️ IT STUBS THE BOUNDARY, NEVER THE LOGIC. Only @clerk/nextjs/server and server-only are replaced.
// A specifier that resolves normally is untouched, so the module under test is the real one — the
// point of the exercise is that a missing export or a broken function FAILS here.
const EXTS = ['.js', '.mjs', '.jsx', '/index.js', '/index.mjs'];

const STUBS = new Map([
  ['@clerk/nextjs/server', 'clerk-stub'],
  ['server-only', 'noop-stub'],
]);

export async function resolve(specifier, context, next) {
  const stub = STUBS.get(specifier);
  if (stub) return { url: new URL(`./${stub}.mjs`, import.meta.url).href, shortCircuit: true };
  try {
    return await next(specifier, context);
  } catch (err) {
    if (!specifier.startsWith('.') || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    for (const ext of EXTS) {
      try { return await next(specifier + ext, context); } catch { /* try the next one */ }
    }
    throw err;
  }
}
