import 'server-only';

// Guarded entry point. The implementation is in wire-sources.mjs; this file adds the build-time
// tripwire, so importing the source roster or decorate() from a client component fails the build
// instead of silently shipping thirty vendor names to browsers. App code imports THIS file.
export * from './wire-sources.mjs';
