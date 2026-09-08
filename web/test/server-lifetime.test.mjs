import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(fileURLToPath(new URL('../server.js', import.meta.url)));
const serverJS = join(webRoot, 'server.js');
const publicRoot = join(webRoot, 'public');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function waitForExit(child, timeoutMs = 4000) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function startServer({ managed }) {
  const temp = mkdtempSync(join(tmpdir(), 'rms-server-lifetime-'));
  const env = {
    ...process.env,
    PORT: '0',
    DB_PATH: join(temp, 'mindspark.db'),
    PUBLIC: publicRoot,
    OPS_LOG_PATH: join(temp, 'ops.log'),
  };
  if (managed) env.ROC_MINDSPARK_MANAGED_STDIN = '1';
  else delete env.ROC_MINDSPARK_MANAGED_STDIN;

  const child = spawn(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    serverJS,
  ], {
    cwd: webRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not announce a port: ${output}`)), 4000);
      const onChunk = (chunk) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        if (child.exitCode != null || child.signalCode != null) {
          clearTimeout(timer);
          reject(new Error(`server exited before readiness (code=${code}, signal=${signal}): ${output}`));
        }
      });
    });
  } catch (error) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await waitForExit(child).catch(() => {});
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }

  return { child, port, temp };
}

async function startServerWithAbruptParent() {
  const temp = mkdtempSync(join(tmpdir(), 'rms-server-parent-death-'));
  const env = {
    ...process.env,
    PORT: '0',
    DB_PATH: join(temp, 'mindspark.db'),
    PUBLIC: publicRoot,
    OPS_LOG_PATH: join(temp, 'ops.log'),
    ROC_MINDSPARK_MANAGED_STDIN: '1',
  };
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ${JSON.stringify([
      '--disable-warning=ExperimentalWarning',
      serverJS,
    ])}, {
      cwd: ${JSON.stringify(webRoot)},
      env: process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.on('error', error => { console.error(error); process.exit(1); });
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code == null ? 1 : code);
    });
  `;
  const parent = spawn(process.execPath, ['-e', parentScript], {
    cwd: webRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not announce a port: ${output}`)), 4000);
      const onChunk = (chunk) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      parent.stdout.on('data', onChunk);
      parent.stderr.on('data', onChunk);
      parent.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      parent.once('exit', (code, signal) => {
        if (parent.exitCode != null || parent.signalCode != null) {
          clearTimeout(timer);
          reject(new Error(`parent exited before readiness (code=${code}, signal=${signal}): ${output}`));
        }
      });
    });
  } catch (error) {
    if (parent.exitCode == null && parent.signalCode == null) parent.kill('SIGKILL');
    await waitForExit(parent).catch(() => {});
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }

  return { parent, port, temp };
}

async function stopServer(child) {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill('SIGTERM');
  }
  await waitForExit(child);
}

function bindPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function waitForPortFree(port, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const server = await bindPort(port);
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
      await sleep(25);
    }
  }
  throw new Error(`port ${port} remained occupied`);
}

describe('managed canvas server lifetime', () => {
  test('serves while the parent pipe is open, then exits and releases its listener at EOF', async () => {
    const state = await startServer({ managed: true });
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
        headers: { Connection: 'close' },
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.equal(state.child.exitCode, null);

      state.child.stdin.end();
      const result = await waitForExit(state.child);
      assert.equal(result.signal, null);
      assert.equal(result.code, 0);
      await waitForPortFree(state.port);
    } finally {
      if (state.child.exitCode == null && state.child.signalCode == null) {
        await stopServer(state.child);
      }
      rmSync(state.temp, { recursive: true, force: true });
    }
  });

  test('a server without the managed marker stays alive when stdin reaches EOF', async () => {
    const state = await startServer({ managed: false });
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
        headers: { Connection: 'close' },
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();

      state.child.stdin.end();
      await sleep(350);
      assert.equal(state.child.exitCode, null);
      assert.equal(state.child.signalCode, null);
    } finally {
      await stopServer(state.child);
      rmSync(state.temp, { recursive: true, force: true });
    }
  });

  test('a managed server exits when its owning parent is killed abruptly', async () => {
    const state = await startServerWithAbruptParent();
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
        headers: { Connection: 'close' },
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();

      state.parent.kill('SIGKILL');
      const result = await waitForExit(state.parent);
      assert.equal(result.signal, 'SIGKILL');
      await waitForPortFree(state.port);
    } finally {
      if (state.parent.exitCode == null && state.parent.signalCode == null) {
        state.parent.kill('SIGKILL');
        await waitForExit(state.parent);
      }
      rmSync(state.temp, { recursive: true, force: true });
    }
  });
});
