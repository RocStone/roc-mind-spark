import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import http from 'node:http';
import os from 'node:os';

const root = dirname(fileURLToPath(new URL('../server.js', import.meta.url)));
const {
  LISTEN_HOST,
  PRODUCT_NAME,
  allowedOrigin,
  isAllowedOrigin,
  isAllowedHost,
} = createRequire(import.meta.url)('../listen-bind.js');

describe('listen config', () => {
  test('Mac local mode binds only 127.0.0.1', () => {
    assert.equal(LISTEN_HOST, '127.0.0.1');
  });

  test('server.js listen() call uses the loopback host constant', () => {
    const src = readFileSync(join(root, 'server.js'), 'utf8');
    const bind = readFileSync(join(root, 'listen-bind.js'), 'utf8');
    assert.match(src, /server\.listen\(\s*Number\(PORT\)\s*,\s*LISTEN_HOST/);
    assert.match(bind, /const LISTEN_HOST = '127\.0\.0\.1'/);
  });

  test('isAllowedHost accepts only 127.0.0.1 with the bound port', () => {
    assert.equal(isAllowedHost('127.0.0.1:3034', 3034), true);
    assert.equal(isAllowedHost('127.0.0.1', 3034), true);
    assert.equal(isAllowedHost('localhost:3034', 3034), false);
    assert.equal(isAllowedHost('127.0.0.1:9999', 3034), false);
    assert.equal(isAllowedHost('192.168.1.10:3034', 3034), false);
    assert.equal(isAllowedHost('0.0.0.0:3034', 3034), false);
  });

  test('isAllowedOrigin requires exact http://127.0.0.1:port', () => {
    assert.equal(isAllowedOrigin('http://127.0.0.1:3034', 3034), true);
    assert.equal(isAllowedOrigin('http://localhost:3034', 3034), false);
    assert.equal(isAllowedOrigin('https://127.0.0.1:3034', 3034), false);
    assert.equal(isAllowedOrigin('http://127.0.0.1:9999', 3034), false);
    assert.equal(isAllowedOrigin('http://127.0.0.1:3034/', 3034), false);
    assert.equal(isAllowedOrigin('null', 3034), false);
    assert.equal(isAllowedOrigin('http://192.168.1.10:3034', 3034), false);
  });

  test('product name is stable for the launch health check', () => {
    assert.equal(PRODUCT_NAME, 'roc-mind-spark');
    assert.equal(allowedOrigin(3034), 'http://127.0.0.1:3034');
  });
});

function waitForListen(child, ms = 4000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), ms);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/http:\/\/(127\.0\.0\.1):(\d+)/);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve({ host: m[1], port: Number(m[2]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => { buf += c.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${buf}`));
    });
  });
}

function tcpConnect(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, body };
}

async function preflight(port, origin) {
  const res = await fetch(`http://127.0.0.1:${port}/api/maps`, {
    method: 'OPTIONS',
    headers: origin ? { Origin: origin } : {},
  });
  return { status: res.status, acao: res.headers.get('access-control-allow-origin') };
}

describe('spawned canvas server', () => {
  let child;
  let tmp;
  let host;
  let port;
  let otherPort;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'rms-listen-'));
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'server.js')], {
      cwd: root,
      env: {
        ...process.env,
        PORT: '0',
        DB_PATH: join(tmp, 'mindspark.db'),
        PUBLIC: join(root, 'public'),
        OPS_LOG_PATH: join(tmp, 'ops.log'),
        ROC_MINDSPARK_TOKEN: 'test-token-loopback',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const addr = await waitForListen(child);
    host = addr.host;
    port = addr.port;
    otherPort = port === 9999 ? 9998 : 9999;
  });

  after(() => {
    if (child && !child.killed) child.kill('SIGTERM');
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test('healthz is ok on 127.0.0.1 and echoes the launch nonce, not an API key', async () => {
    const { status, body } = await getJSON(`http://127.0.0.1:${port}/healthz`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.product, 'roc-mind-spark');
    assert.equal(body.token, 'test-token-loopback');
  });

  test('lsof shows the listener bound to 127.0.0.1, not *', () => {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    assert.match(out, new RegExp(`127\\.0\\.0\\.1:${port}`));
    assert.doesNotMatch(out, new RegExp(`\\*:${port}`));
    assert.doesNotMatch(out, new RegExp(`0\\.0\\.0\\.0:${port}`));
  });

  test('non-loopback Host header is rejected', async () => {
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/healthz',
        headers: { Host: 'example.com' },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = raw;
          try { parsed = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(body.error, 'forbidden');
  });

  test('CORS preflight: localhost, https, other port, LAN, missing Origin are 403 with no ACAO', async () => {
    const cases = [
      `http://localhost:${otherPort}`,
      `https://127.0.0.1:${otherPort}`,
      `http://127.0.0.1:${otherPort}`,
      'http://192.168.1.50:3034',
      null,
    ];
    for (const origin of cases) {
      const { status, acao } = await preflight(port, origin);
      assert.equal(status, 403, `expected 403 for Origin ${origin}`);
      assert.equal(acao, null, `expected no ACAO for Origin ${origin}`);
    }
  });

  test('CORS allows only the exact http://127.0.0.1:${boundPort} origin', async () => {
    const exact = `http://127.0.0.1:${port}`;
    const { status, acao } = await preflight(port, exact);
    assert.equal(status, 204);
    assert.equal(acao, exact);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Origin: exact },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), exact);
  });

  test('same-origin request with no Origin is served without ACAO', async () => {
    const { status, headers } = await getJSON(`http://127.0.0.1:${port}/healthz`);
    assert.equal(status, 200);
    assert.equal(headers.get('access-control-allow-origin'), null);
  });

  test('non-loopback interfaces cannot connect', async () => {
    assert.equal(host, '127.0.0.1');
    const lan = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const info of list || []) {
        if (info.internal || info.family !== 'IPv4') continue;
        lan.push(info.address);
      }
    }
    assert.equal(await tcpConnect('127.0.0.1', port), true);
    for (const ip of lan) {
      assert.equal(await tcpConnect(ip, port), false, `should not listen on ${ip}`);
    }
  });
});
