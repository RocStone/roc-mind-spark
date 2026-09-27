// Spawns the real web/server.js on an ephemeral loopback port with a
// throw-away database, for HTTP-level API tests.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const webRoot = dirname(fileURLToPath(new URL('../../server.js', import.meta.url)));

export async function startApiServer() {
  const temp = mkdtempSync(join(tmpdir(), 'rms-server-api-'));
  const env = {
    ...process.env,
    PORT: '0',
    DB_PATH: join(temp, 'mindspark.db'),
    PUBLIC: join(webRoot, 'public'),
    OPS_LOG_PATH: join(temp, 'ops.log'),
  };
  delete env.ROC_MINDSPARK_MANAGED_STDIN;
  delete env.IMPORT_TOKEN;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(webRoot, 'server.js')], {
    cwd: webRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + output)), 5000);
    const onChunk = (chunk) => {
      output += chunk.toString();
      const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('server exited ' + code + ': ' + output)); });
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    base,
    origin: base,
    async stop() {
      if (child.exitCode == null && child.signalCode == null) {
        const exited = new Promise(r => child.once('exit', r));
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(temp, { recursive: true, force: true });
    },
  };
}

// Raw request helper: lets a test control Origin, Content-Type and chunking,
// which fetch() does not always allow.
export function rawRequest(port, { method = 'GET', path = '/', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    (async () => {
      for (const c of chunks) {
        if (!req.write(c)) await new Promise(r => req.once('drain', r));
        // Yield so separate writes tend to arrive as separate 'data' chunks.
        await new Promise(r => setImmediate(r));
      }
      req.end();
    })().catch(reject);
  });
}

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function sampleMap(id, extra = {}) {
  return { id, title: 'T ' + id, rootId: 'r', nodes: { r: { id: 'r', text: 'Root', parent: null, x: 0, y: 0 } }, ...extra };
}
