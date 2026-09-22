// Node module hook that transforms .jsx through Next's own bundled SWC.
//
// ⚠️ THE POINT IS TO TEST THE REAL COMPONENT. Without this, a suite covering a React component can
// only read its source as text — which is the kind of assertion that passes while the rendered
// output is wrong. Transforming with the SAME compiler Next uses means the function under test is
// the function that ships, not a reimplementation of it.
//
// Also resolves extensionless relative imports ('./db') the way the bundler does.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'next/dist/build/swc/index.js';

// Stub modules get a well-formed file URL inside the project so that THEIR own imports (react)
// resolve from node_modules normally. A custom 'cp-stub:' scheme is not a valid resolution base.
const STUB_BASE = new URL('../node_modules/.cp-stubs/', import.meta.url);
const stubUrl = (name) => new URL(`${encodeURIComponent(name)}.mjs`, STUB_BASE).href;
const stubName = (url) => { const m = url.startsWith(STUB_BASE.href) ? decodeURIComponent(url.slice(STUB_BASE.href.length).replace(/.mjs$/, '')) : null; return m; };

// Next subpaths that only the bundler resolves, stubbed with just the surface a component touches
// during a render-only test. Nothing here is under test — a router that is never navigated and a
// next/link that renders an anchor are scaffolding, so that the CHART code can be exercised.
const STUBS = new Map([
  ['next/navigation', `export const useRouter = () => ({ push(){}, replace(){}, refresh(){}, prefetch(){} });
     export const usePathname = () => '/';
     export const useSearchParams = () => new URLSearchParams();
     export const redirect = () => {};`],
  ['next/link', `import React from 'react';
     export default function Link({ href, children, ...rest }) { return React.createElement('a', { href, ...rest }, children); }`],
  ['next/image', `import React from 'react';
     export default function Image(props) { return React.createElement('img', props); }`],
  ['server-only', 'export {};'],
  // cp-shared (imported for the colour tokens alone) pulls the whole auth surface in. None of it
  // is exercised by a render-only chart test, and its real package is ESM-directory-imported in a
  // way plain Node cannot resolve.
  ['@clerk/nextjs', `import React from 'react';
     const Null = () => null;
     export const SignedIn = Null, SignedOut = Null, UserButton = Null, SignInButton = Null,
       SignUpButton = Null, ClerkProvider = ({ children }) => React.createElement(React.Fragment, null, children);
     export const useUser = () => ({ isSignedIn: false, isLoaded: true, user: null });
     export const useAuth = () => ({ isSignedIn: false, isLoaded: true, userId: null });`],
  ['@clerk/nextjs/server', `export const auth = async () => ({ userId: null });
     export const currentUser = async () => null;
     export const clerkClient = async () => ({ users: { getUser: async () => null } });`],
]);

export async function resolve(specifier, context, next) {
  if (STUBS.has(specifier)) return { url: stubUrl(specifier), shortCircuit: true, format: 'module' };
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?jsx?$/.test(specifier)) {
      for (const ext of ['.js', '.jsx', '.mjs']) {
        try { return await next(`${specifier}${ext}`, context); } catch { /* try the next one */ }
      }
    }
    throw e;
  }
}

export async function load(url, context, next) {
  const stub = stubName(url);
  if (stub && STUBS.has(stub)) return { format: 'module', shortCircuit: true, source: STUBS.get(stub) };
  if (!url.endsWith('.jsx')) return next(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const out = await transform(source, {
    filename: fileURLToPath(url),
    jsc: {
      parser: { syntax: 'ecmascript', jsx: true },
      // The classic runtime keeps the output dependent only on `react`, which is installed —
      // the automatic runtime would pull in react/jsx-runtime resolution rules we do not need here.
      transform: { react: { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' } },
      target: 'es2022',
    },
    module: { type: 'es6' },
  });
  // 'use client' is a bundler directive with no meaning in Node; React must be in scope for the
  // classic pragma.
  const code = `import React from 'react';\n${out.code.replace(/^\s*['"]use client['"];?/m, '')}`;
  return { format: 'module', shortCircuit: true, source: code };
}
