// public/app.js is a plain browser script with no module exports — it can't be
// imported. Rather than copy functions into the tests (where they'd silently
// drift from the shipped code the first time someone edits app.js), this reads
// the REAL source and lifts out individual top-level function declarations by
// brace-matching, then evaluates them in an isolated scope.
//
// Consequence worth knowing: if someone renames or deletes one of these
// functions, the affected test fails loudly at load time rather than passing
// against a stale copy. That's the point.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');

// The client is split across several plain <script> files that all share one
// global scope in the browser (see index.html). Order here mirrors the load
// order there. A tested function may live in any of them, so search all —
// otherwise splitting a file would break tests that have nothing to do with
// the split.
const CLIENT_FILES = ['templates.js', 'app.js'];

let _src = null;
function source() {
  if (_src === null) {
    _src = CLIENT_FILES
      .map(f => readFileSync(join(PUBLIC, f), 'utf8'))
      .join('\n');
  }
  return _src;
}

/**
 * Extract the full text of a top-level `function NAME(...) { ... }`.
 *
 * Finds the end by asking the JS parser rather than brace-counting by hand:
 * try each following `}` as a candidate end and return the first slice that
 * compiles as a function expression. Hand-rolled brace matching needs a full
 * lexer to avoid tripping over braces and quotes inside strings, template
 * literals, regexes and comments — app.js has all four (escapeHtml's
 * /[&<>"]/g regex is enough to break the naive version).
 */
export function extractFunction(name) {
  const src = source();
  const re = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`load-app-fns: function ${name}() not found in public/app.js`);

  const start = m.index;
  for (let i = src.indexOf('{', start); i !== -1; i = src.indexOf('}', i + 1)) {
    if (src[i] !== '}') continue;
    const candidate = src.slice(start, i + 1);
    try {
      // Throws unless `candidate` is a complete, syntactically valid function.
      new Function(`return (${candidate});`);
      return candidate;
    } catch { /* not the end yet — keep going */ }
  }
  throw new Error(`load-app-fns: could not find the end of ${name}() (searched ${CLIENT_FILES.join(', ')})`);
}

/**
 * Build callable versions of the named functions.
 * `deps` supplies anything they close over that isn't a JS/Node global.
 */
export function loadFns(names, deps = {}) {
  const bodies = names.map(extractFunction).join('\n\n');
  const depNames = Object.keys(deps);
  const factory = new Function(
    ...depNames,
    `${bodies}\nreturn { ${names.join(', ')} };`
  );
  return factory(...depNames.map(k => deps[k]));
}

/**
 * Extract a top-level `const NAME = ...;` declaration and evaluate it.
 *
 * Handles multi-line values (arrays of objects, and so on), not just
 * one-liners: as with extractFunction above, the end is found by asking the
 * JS parser — try each following `;` as a candidate terminator and return the
 * first slice that compiles. The earlier single-line-only regex silently
 * failed to find anything spanning more than one line.
 */
export function extractConst(name) {
  const src = source();
  const re = new RegExp(`^const\\s+${name}\\s*=\\s*`, 'm');
  const m = re.exec(src);
  if (!m) {
    throw new Error(`load-app-fns: const ${name} not found (searched ${CLIENT_FILES.join(', ')})`);
  }
  const valueStart = m.index + m[0].length;
  for (let i = src.indexOf(';', valueStart); i !== -1; i = src.indexOf(';', i + 1)) {
    const candidate = src.slice(valueStart, i);
    try {
      return new Function(`return (${candidate});`)();
    } catch { /* not a complete expression yet — keep going */ }
  }
  throw new Error(`load-app-fns: could not evaluate const ${name}`);
}
