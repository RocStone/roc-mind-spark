import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = dirname(fileURLToPath(new URL('../server.js', import.meta.url)));
const repoRoot = dirname(webRoot);
const helper = join(repoRoot, 'scripts', 'installed-app-process.sh');
const installSh = join(repoRoot, 'scripts', 'install-app.sh');
const destBin = '/Applications/Roc Mind Spark.app/Contents/MacOS/RocMindSpark';

function bashEval(body) {
  return execFileSync('bash', ['-c', `source "$1"; ${body}`, 'bash', helper], {
    encoding: 'utf8',
  });
}

function listenOn(port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, pid: process.pid });
    });
    server.on('error', reject);
  });
}

describe('exact executable matching does not use server.js paths', () => {
  test('txt_output_has_exact_path matches the n-prefixed dest binary only', () => {
    const script = `
source "${helper}"
sample() {
  printf '%s\\n' "\$1" | txt_output_has_exact_path "${destBin}"
  echo \$?
}
sample "p12
ftxt
n${destBin}"
sample "p12
ftxt
n/tmp/evil${destBin}"
sample "p12
ftxt
n/opt/homebrew/bin/node"
sample "p12
ftxt
n${destBin}/Contents/MacOS/RocMindSpark"
`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(out, ['0', '1', '1', '1']);
  });

  test('this Node test process is not the installed overlay executable', () => {
    const out = bashEval(`pid_has_exact_executable $$ "${destBin}"; echo $?`);
    assert.equal(out.trim(), '1');
  });

  test('install-app.sh stops only DEST_BIN and never kills Node by server.js path', () => {
    const install = readFileSync(installSh, 'utf8');
    const helperSrc = readFileSync(helper, 'utf8');
    const supervisor = readFileSync(join(repoRoot, 'macos/Sources/RocMindSpark/ServerSupervisor.swift'), 'utf8');
    const heldStop = readFileSync(join(repoRoot, 'macos/Sources/RocMindSpark/HeldProcessStop.swift'), 'utf8');
    // Shell wait for the exact App PID must exceed HeldProcessStop's
    // worst-case 5s graceful + 1s child SIGKILL (6s). 10s is the slack.
    assert.match(helperSrc, /APP_STOP_WAIT_SECONDS=10/);
    assert.match(helperSrc, /must exceed HeldProcessStop/);
    assert.match(install, /stop_exact_installed_app "\$DEST_BIN" "\$APP_STOP_WAIT_SECONDS"/);
    assert.match(install, /wait_port_idle 3034 5/);
    assert.doesNotMatch(install, /stop_our_canvas_listeners/);
    assert.doesNotMatch(install, /while read -r pid; do kill/);
    assert.doesNotMatch(install, /server\.js/);
    assert.doesNotMatch(install, /kill -9/);
    assert.match(helperSrc, /wait_exact_app_exit/);
    assert.match(helperSrc, /pid_has_exact_executable "\$pid" "\$dest_bin"/);
    assert.doesNotMatch(supervisor, /terminatePID/);
    assert.doesNotMatch(supervisor, /isOurServer/);
    assert.doesNotMatch(supervisor, /matchesServerJS/);
    assert.match(supervisor, /HeldProcessStop\.stop/);
    assert.match(heldStop, /process\.terminate\(\)/);
    assert.match(heldStop, /gracefulSeconds \+ killSeconds/);
    assert.match(heldStop, /must wait strictly longer/);
  });
});

describe('graceful App exit vs SIGKILL gate', () => {
  test('SIGTERM is sent only after an immediate exact-executable re-check', () => {
    const script = `
source "${helper}"
kill() { echo "signal:$1"; }
pid_is_running() { return 0; }
pid_has_exact_executable() { [ "$1" = 10 ]; }
terminate_if_still_exact_app 10 /Applications/Roc\\ Mind\\ Spark.app/Contents/MacOS/RocMindSpark
terminate_if_still_exact_app 11 /Applications/Roc\\ Mind\\ Spark.app/Contents/MacOS/RocMindSpark
`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(out, 'signal:10');
  });

  test('filter_still_exact_app_pids drops exited and reused PIDs, so SIGKILL is skipped', () => {
    const script = `
source "${helper}"
pid_is_running() {
  case "\$1" in
    10|11) return 0 ;;
    *) return 1 ;;
  esac
}
pid_has_exact_executable() {
  [ "\$1" = 10 ]
}
filter_still_exact_app_pids /Applications/Roc\\ Mind\\ Spark.app/Contents/MacOS/RocMindSpark 10 11 12
`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(out, '10');
  });

  test('wait_exact_app_exit returns 0 when the App PID list becomes empty, without SIGKILL', () => {
    const script = `
source "${helper}"
countf="$(mktemp)"
echo 0 > "\$countf"
list_exact_app_pids() {
  local n
  n="\$(cat "\$countf")"
  n=\$((n+1))
  echo "\$n" > "\$countf"
  if [ "\$n" -lt 3 ]; then
    echo 4242
  fi
}
# 5 here is a fixture timeout for the stub PID list, not APP_STOP_WAIT_SECONDS.
wait_exact_app_exit /fake/RocMindSpark 5
echo wait_rc=\$?
rm -f "\$countf"
`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(out, 'wait_rc=0');
  });

  test('wait_exact_app_exit times out while a stub App PID remains, without sending signals', () => {
    const script = `
source "${helper}"
list_exact_app_pids() { echo 4242; }
wait_exact_app_exit /fake/RocMindSpark 1
echo wait_rc=\$?
`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    assert.equal(out, 'wait_rc=1');
  });
});

describe('pre-existing listeners are reported, never killed', () => {
  const children = [];
  const temps = [];

  after(() => {
    for (const child of children) {
      if (child && child.exitCode == null) child.kill('SIGKILL');
    }
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  test('report_port_listeners does not terminate a foreign occupant', async () => {
    const { server, port } = await listenOn(0);
    try {
      const before = execFileSync('/usr/sbin/lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
      assert.ok(before);
      const reported = bashEval(`report_port_listeners ${port}`).trim();
      assert.equal(reported, before);
      const after = execFileSync('/usr/sbin/lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
      assert.equal(after, before);
    } finally {
      server.close();
    }
  });

  test('wait_port_idle only waits and reports; it does not kill the listener', async () => {
    const { server, port } = await listenOn(0);
    try {
      const before = execFileSync('/usr/sbin/lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
      const out = bashEval(`wait_port_idle ${port} 1; echo wait_rc=\$?`).trim();
      assert.match(out, /wait_rc=1/);
      const after = execFileSync('/usr/sbin/lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
      assert.equal(after, before);
    } finally {
      server.close();
    }
  });

  test('a hand-started Node with this repo server.js is not claimed or stopped', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'rms-hand-'));
    temps.push(tmp);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(webRoot, 'server.js')], {
      cwd: webRoot,
      env: {
        ...process.env,
        PORT: '0',
        DB_PATH: join(tmp, 'mindspark.db'),
        PUBLIC: join(webRoot, 'public'),
        OPS_LOG_PATH: join(tmp, 'ops.log'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(buf)), 4000);
      const onData = (chunk) => {
        buf += chunk.toString();
        const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (c) => { buf += c.toString(); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code}: ${buf}`));
      });
    });
    const pid = String(child.pid);
    const claimed = bashEval(`pid_has_exact_executable ${pid} "${destBin}"; echo $?`).trim();
    assert.equal(claimed, '1');
    bashEval(`report_port_listeners ${port}`);
    assert.equal(child.exitCode, null);
    const still = execFileSync('/usr/sbin/lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
    assert.ok(still.split('\n').includes(pid));
    child.kill('SIGTERM');
  });
});

describe('GH_OAUTH is blank in the Mac canvas', () => {
  test('app.js does not ship an upstream OAuth worker URL or client id', () => {
    const src = readFileSync(join(webRoot, 'public/app.js'), 'utf8');
    assert.match(src, /const GH_OAUTH = \{ clientId: '', workerUrl: '' \}/);
    assert.doesNotMatch(src, /mindspark-oauth\.githubpage\.workers\.dev/);
    assert.doesNotMatch(src, /Ov23liCukvrI3Zs9p3Px/);
  });
});
