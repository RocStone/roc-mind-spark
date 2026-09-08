#!/usr/bin/env node

/*
 * Run the production Markdown editor through the existing native WKWebView
 * event driver. The driver posts real NSEvents; this file only materializes a
 * fixture around the selected app.js snapshot and reports the page's measured
 * result. It intentionally does not reimplement selection hit testing.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const templatePath = join(here, 'md-production-eval.html');
const appPath = join(root, 'web', 'public', 'app.js');
const cssPath = join(root, 'web', 'public', 'styles.css');
const selectionPath = join(root, 'web', 'public', 'markdown-selection.js');
const runnerPath = join(here, 'md-select-eval.swift');

const DEFAULT_CASES = [
  'mixed-bold-400-nowrap',
  'mixed-bold-400-wrap',
  'mixed-bold-4000-nowrap',
  'mixed-bold-4000-wrap',
];

function usage() {
  return `Usage: node scripts/md-production-eval.mjs [options]

Options:
  --baseline[=REF]       Evaluate git REF (default HEAD) and worktree, then compare them.
  --case NAME             Run one case; repeatable.
  --cases A,B             Run a comma-separated case list.
  --overlay               Use the existing runner's nonactivating overlay panel.
  --runner PATH           Use another md-select-eval.swift path.
  --keep-fixture          Keep generated HTML fixtures and report their directory.
  --help                  Show this help.

Cases contain both English and Chinese bold text. The built-in matrix covers
400 and 4000 source lines with word wrap disabled and enabled.
`;
}

function parseArgs(argv) {
  const options = {
    baselineRef: null,
    cases: [...DEFAULT_CASES],
    overlay: false,
    runner: runnerPath,
    keepFixture: false,
  };
  const selected = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--overlay') {
      options.overlay = true;
      continue;
    }
    if (arg === '--keep-fixture') {
      options.keepFixture = true;
      continue;
    }
    if (arg === '--baseline') {
      options.baselineRef = 'HEAD';
      continue;
    }
    if (arg.startsWith('--baseline=')) {
      options.baselineRef = arg.slice('--baseline='.length) || 'HEAD';
      continue;
    }
    if (arg === '--case') {
      const value = argv[++i];
      if (!value) throw new Error('--case requires a case name');
      selected.push(value);
      continue;
    }
    if (arg.startsWith('--case=')) {
      selected.push(arg.slice('--case='.length));
      continue;
    }
    if (arg === '--cases') {
      const value = argv[++i];
      if (!value) throw new Error('--cases requires a comma-separated list');
      selected.push(...value.split(','));
      continue;
    }
    if (arg.startsWith('--cases=')) {
      selected.push(...arg.slice('--cases='.length).split(','));
      continue;
    }
    if (arg === '--runner') {
      const value = argv[++i];
      if (!value) throw new Error('--runner requires a path');
      options.runner = resolve(process.cwd(), value);
      continue;
    }
    if (arg.startsWith('--runner=')) {
      options.runner = resolve(process.cwd(), arg.slice('--runner='.length));
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (selected.length) options.cases = [...new Set(selected.filter(Boolean))];
  if (!options.cases.length) throw new Error('At least one evaluation case is required');
  return options;
}

function extractMarkdownSource(appSource, label) {
  const marker = '/* ---- Markdown mode: edit the map as text with a live two-way preview (v1) ---- */';
  const start = appSource.indexOf(marker);
  const end = appSource.indexOf('function pushHistory(){', start + marker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not isolate the production Markdown slice in ${label}`);
  }
  return appSource.slice(start, end);
}

function readGitFile(ref, relativePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${relativePath}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`Could not read ${relativePath} from git ${ref}: ${detail}`);
  }
}

function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex');
}

function renderFixture(template, { variant, caseNames, css, appSource, selectionSource }) {
  const replacements = [
    ['/*__PRODUCTION_CSS__*/', css],
    ['/*__PRODUCTION_MD_SOURCE__*/', appSource],
    ['/*__SELECTION_SOURCE__*/', selectionSource],
    ['__VARIANT__', JSON.stringify(variant)],
    ['__CASE_NAMES__', JSON.stringify(caseNames)],
  ];
  let html = template;
  for (const [token, value] of replacements) {
    if (!html.includes(token)) throw new Error(`Fixture token is missing: ${token}`);
    // Use a function replacement: production Markdown contains strings such as
    // `'$'` and `$'` is interpreted specially by String#replace when the
    // replacement is passed as a string, which would splice the rest of the
    // template into the injected script and make WebKit report only "Script
    // error.". A callback inserts the source literally.
    html = html.replace(token, () => value);
  }
  // A closing script tag in an injected source would terminate the fixture
  // before WebKit parses it. The current production sources do not contain one,
  // but fail loudly if that invariant changes instead of running partial code.
  if (/<\/script/i.test(appSource) || /<\/script/i.test(selectionSource)) {
    throw new Error('Production source contains </script>; update fixture injection before evaluating it');
  }
  return html;
}

function parseRunnerJSON(stdout, stderr, label) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`${label} produced no JSON on stdout${stderr ? `\n${stderr}` : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // Keep the parser tolerant of a future runner banner while requiring the
    // payload itself to be valid JSON.
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch { /* report the original output below */ }
    }
    throw new Error(`${label} produced invalid JSON:\n${text}${stderr ? `\n[stderr]\n${stderr}` : ''}`);
  }
}

function runSwiftFixture(fixturePath, options, label) {
  if (!existsSync(options.runner)) throw new Error(`WK runner not found: ${options.runner}`);
  const args = [];
  if (options.overlay) args.push('--overlay');
  args.push(fixturePath);
  const result = spawnSync('swift', [options.runner, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${label} failed to launch Swift runner: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [
      result.error ? result.error.message : '',
      result.stderr ? String(result.stderr).trim() : '',
      result.stdout ? String(result.stdout).trim() : '',
    ].filter(Boolean).join('\n');
    throw new Error(`${label} exited with status ${result.status ?? 'unknown'}${details ? `:\n${details}` : ''}`);
  }
  return parseRunnerJSON(result.stdout, result.stderr, label);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricSummary(row) {
  if (!row || typeof row !== 'object') return null;
  const geometry = row.geometry || {};
  const selection = row.selection || {};
  return {
    frames: finiteNumber(row.frames),
    mouseMoves: finiteNumber(row.mouseMoves),
    mouseProcessingCpuMs: finiteNumber(row.mouseProcessingCpuMs),
    durationMs: finiteNumber(row.durationMs),
    selectionChanges: finiteNumber(row.selectionChanges),
    listenersReleased: row.listenersReleased === true,
    selection: {
      start: finiteNumber(selection.start),
      end: finiteNumber(selection.end),
      length: finiteNumber(selection.length),
      anchorOffset: finiteNumber(selection.anchorOffset),
      focusOffset: finiteNumber(selection.focusOffset),
      targetOffsetFromBrowser: finiteNumber(selection.targetOffsetFromBrowser),
      text: typeof selection.text === 'string' ? selection.text : '',
    },
    geometry: {
      exactHit: geometry.exactHit === true,
      withinLine: geometry.withinLine === true,
      absDx: finiteNumber(geometry.absDx),
      absDy: finiteNumber(geometry.absDy),
      distancePx: finiteNumber(geometry.distancePx),
      offsetDelta: finiteNumber(geometry.offsetDelta),
    },
  };
}

function rowsByName(payload) {
  const rows = new Map();
  for (const row of payload?.cases || []) {
    if (row && typeof row.name === 'string') rows.set(row.name, row);
  }
  return rows;
}

function comparePayloads(baselinePayload, currentPayload, caseNames) {
  const baseline = rowsByName(baselinePayload);
  const current = rowsByName(currentPayload);
  const cases = {};
  for (const name of caseNames) {
    const b = baseline.get(name);
    const c = current.get(name);
    const bm = metricSummary(b);
    const cm = metricSummary(c);
    const delta = {};
    for (const key of ['frames', 'mouseMoves', 'mouseProcessingCpuMs', 'durationMs', 'selectionChanges']) {
      if (bm && cm && bm[key] != null && cm[key] != null) delta[key] = +(cm[key] - bm[key]).toFixed(3);
      else delta[key] = null;
    }
    cases[name] = {
      baseline: bm,
      current: cm,
      delta,
      selectionChanged: !!(bm && cm && (
        bm.selection.start !== cm.selection.start
        || bm.selection.end !== cm.selection.end
        || bm.selection.text !== cm.selection.text
      )),
      geometryChanged: !!(bm && cm && (
        bm.geometry.exactHit !== cm.geometry.exactHit
        || bm.geometry.offsetDelta !== cm.geometry.offsetDelta
      )),
    };
  }
  return { cases };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const template = readFileSync(templatePath, 'utf8');
  const css = readFileSync(cssPath, 'utf8');
  const currentApp = readFileSync(appPath, 'utf8');
  const currentSelection = readFileSync(selectionPath, 'utf8');
  const tempRoot = mkdtempSync(join(tmpdir(), 'roc-md-production-'));
  const fixturePaths = [];

  const evaluate = (variant, appSource, selectionSource) => {
    const fixture = renderFixture(template, {
      variant,
      caseNames: options.cases,
      css,
      appSource: extractMarkdownSource(appSource, variant),
      selectionSource,
    });
    const fixturePath = join(tempRoot, `${variant}.html`);
    writeFileSync(fixturePath, fixture, 'utf8');
    fixturePaths.push(fixturePath);
    return runSwiftFixture(fixturePath, options, variant);
  };

  try {
    const currentPayload = evaluate('worktree', currentApp, currentSelection);
    const result = {
      schema: 'roc-mind-spark/md-production-eval/v1',
      generatedAt: new Date().toISOString(),
      runner: 'scripts/md-select-eval.swift',
      runnerMode: options.overlay ? 'overlay-panel' : 'regular-window',
      cases: options.cases,
      source: {
        worktree: {
          path: 'web/public/app.js',
          sha256: sourceHash(currentApp),
          selectionModule: 'web/public/markdown-selection.js',
        },
      },
      evaluation: currentPayload,
    };

    if (options.baselineRef) {
      const baselineApp = readGitFile(options.baselineRef, 'web/public/app.js');
      const baselinePayload = evaluate(`baseline-${options.baselineRef.replace(/[^A-Za-z0-9_.-]/g, '_')}`, baselineApp, '');
      result.source.baseline = {
        ref: options.baselineRef,
        path: 'web/public/app.js',
        sha256: sourceHash(baselineApp),
        selectionModule: 'legacy selection in app.js',
      };
      result.baseline = baselinePayload;
      result.comparison = comparePayloads(baselinePayload, currentPayload, options.cases);
    }

    if (options.keepFixture) {
      result.fixtureDirectory = tempRoot;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    if (!options.keepFixture) rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
