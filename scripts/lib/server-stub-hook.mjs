// Let a verification script IMPORT AND RUN a real server module that pulls in Clerk.
//
// Used as: node --import ./scripts/lib/server-stub-hook.mjs --env-file=.env.local <script>
//
// ⚠️ WHY THIS EXISTS. lib/entitlements.js is the single source of truth for Free/Pro/Elite, and it
// imports @clerk/nextjs/server, so it cannot be imported outside Next. Every check of it was
// therefore a grep — and a grep is what let 050af15a ship: it moved isRealtime out of that module,
// re-exported six of nine names, and the call sites kept reading
// `isRealtime(tier) && !beta` inside a catch that swallowed the resulting TypeError. Pro and Elite
// users were served delayed data and 118 green assertions never noticed, because the TEXT was right.
//
// So the hook stubs only the boundary modules a pure entitlement decision has no business touching —
// Clerk's server bindings and `server-only` — and leaves everything else to resolve normally. The
// functions under test are the real ones, loaded from the real file. It extends the extension
// behaviour of node-resolve-hook so a script needs one hook rather than two.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./server-stub-hook-impl.mjs', import.meta.url), pathToFileURL('./'));
