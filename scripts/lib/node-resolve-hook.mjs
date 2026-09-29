// Let plain Node load the app's extensionless relative imports.
//
// ⚠️ WHY THIS EXISTS. App modules are written for the bundler: `import { db } from './db'` with no
// extension, which webpack resolves and Node does not. That is fine for the app and it means a
// verification script cannot import a real production module — so a script either duplicates the
// logic it is meant to be checking, or checks nothing. Duplicating a 90-line SQL statement to "verify"
// it is the worst of the options.
//
// Used as: node --import ./scripts/lib/node-resolve-hook.mjs --env-file=.env.local <script>
//
// It only ever ADDS extensions to a specifier Node already failed on, in the order the bundler would
// try them. It cannot change which module a working import resolves to.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./node-resolve-hook-impl.mjs', import.meta.url), pathToFileURL('./'));
