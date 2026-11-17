import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, readdir, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { ConfigWebServer } from '../dist/web-config/server.js';
import { parseWebArgs, resolveWebOptions, validateWebConfig } from '../dist/web-config/options.js';
import { configSchema, resolveField, validateFormTypes } from '../dist/web-config/schema.js';

const project = path.basename(process.cwd()).replace('mcp-', '');
const baseConfig = () => project === 'gateway' ? { services: [] } : project === 'ssh' ? { servers: {} } : {
  databases: [{ key: 'test', type: 'mysql', readonly: true, connection: { host: '127.0.0.1', databaseName: 'unused', user: 'unused', password: '${KEEP_RAW}' } }]
};
const port = async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
};
const fixture = async (t, reload = () => {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), `mcp-${project}-web-`));
  const configPath = path.join(directory, 'config.json');
  const config = baseConfig();
  await writeFile(configPath, JSON.stringify(config));
  const listenPort = await port();
  const server = new ConfigWebServer({ project, configPath, args: ['--web'], defaultPort: listenPort,
    validate: value => { if (value.invalid) throw new Error('invalid draft'); }, reload });
  await server.start();
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${listenPort}`;
  const request = async (pathname = '/api/config', body, headers = {}) => fetch(url + pathname, {
    method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', Origin: url } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { configPath, directory, request, config, url, server };
};

test('Web defaults, overrides, conflicts and port validation', () => {
  assert.equal(resolveWebOptions(undefined, [], 3100).effective.enabled, false);
  assert.equal(resolveWebOptions({ enabled: true }, ['--no-web'], 3100).effective.enabled, false);
  const enabled = resolveWebOptions({ port: 3101 }, ['--web', '--web-port', '3109'], 3100);
  assert.equal(enabled.effective.enabled, true);
  assert.equal(enabled.effective.port, 3109);
  assert.equal(enabled.sources.enabled, '命令行');
  assert.equal(resolveWebOptions(undefined, ['--web-port', '3109'], 3100).effective.enabled, false);
  assert.deepEqual(parseWebArgs(['--config', 'file.json', '--http', '--port', '3000', '--web']).remaining, ['--config', 'file.json', '--http', '--port', '3000']);
  for (const args of [['--web', '--no-web'], ['--web', '--web'], ['--web-port', '0'], ['--web-port', '65536'], ['--web-host']]) assert.throws(() => parseWebArgs(args));
  assert.throws(() => validateWebConfig({ enabled: 'true' }));
});

test('Static assets, token-free access, Host/Origin and bounded API', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).status, 200);
  const page = await (await f.request('/')).text();
  const script = page.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await f.request(script)).status, 200);
  assert.equal((await f.request('/api/config', undefined, { Authorization: '' })).status, 200);
  const rejectedHost = await new Promise((resolve, reject) => {
    http.get(f.url + '/api/config', { headers: { Host: 'attacker.test' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await f.request('/api/config', undefined, { Origin: 'https://attacker.test' })).status, 403);
  const current = await (await f.request()).json();
  assert.equal((await f.request('/api/config', current, { Origin: '' })).status, 403);
  assert.equal((await f.request('/api/config', { ...current, padding: 'x'.repeat(2 * 1024 * 1024) })).status, 400);
  assert.equal((await f.request('/api/config')).headers.get('cache-control'), 'no-store');
});

test('Save preserves raw secrets, optional fields and unknown properties; detects stale saves', async t => {
  let reloads = 0;
  const f = await fixture(t, () => { reloads++; });
  const current = await (await f.request()).json();
  const next = { ...current.config, custom: { password: '${RAW_VALUE}', extra: null } };
  const result = await (await f.request('/api/config', { config: next, revision: current.revision })).json();
  assert.equal(result.loaded, true);
  assert.equal(reloads, 1);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), next);
  assert.equal(Object.hasOwn(next, 'web'), false);
  assert.equal((await f.request('/api/config', { config: current.config, revision: current.revision })).status, 409);
  assert.equal((await readdir(f.directory)).some(file => file.endsWith('.tmp')), false);
  const latest = await (await f.request()).json();
  await writeFile(f.configPath, JSON.stringify({ ...next, outside: true }));
  assert.equal((await f.request('/api/config', latest)).status, 409);
});

test('Read-only startup settings, type errors and original validation cannot be bypassed through JSON', async t => {
  const f = await fixture(t);
  const current = await (await f.request()).json();
  for (const change of [{ web: { enabled: false } }, { invalid: true }, project === 'gateway' ? { services: false } : { maxSessions: '32' }]) {
    assert.equal((await f.request('/api/config', { config: { ...current.config, ...change }, revision: current.revision })).status, 400);
  }
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), current.config);
  assert.equal((await f.request('/api/validate', current)).status, 200);
});

test('Concurrent saves serialize and reload failures report saved-but-not-loaded', async t => {
  const f = await fixture(t, () => { throw new Error('reload intentionally failed'); });
  const current = await (await f.request()).json();
  const requests = await Promise.all([1, 2].map(version => f.request('/api/config', { config: { ...current.config, version }, revision: current.revision })));
  assert.deepEqual(requests.map(response => response.status).sort(), [200, 409]);
  const result = await requests.find(response => response.status === 200).json();
  assert.equal(result.saved, true);
  assert.equal(result.loaded, false);
  assert.match(result.loadError, /intentionally/);
});

test('Runtime settings retain startup values after external file change', async t => {
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, web: { enabled: false, port: 3123 } }));
  const current = await (await f.request()).json();
  assert.equal(current.web.effective.enabled, true);
  assert.equal(current.web.restartRequired, true);
  assert.equal(current.config.web.port, 3123);
});

test('Unreadable target fails without touching the retained original or leaving temporary files', async t => {
  const f = await fixture(t);
  const current = await (await f.request()).json();
  // 用目录替换目标，模拟保存时不可写的路径；原始文件保留在夹具内。
  await rename(f.configPath, f.configPath + '.original');
  await mkdir(f.configPath);
  const result = await f.request('/api/config', current);
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(await readFile(f.configPath + '.original', 'utf8')), current.config);
  assert.equal((await readdir(f.directory)).some(file => file.endsWith('.tmp')), false);
});

test('Port collision leaves the first listener working; remote listening is refused', async t => {
  const f = await fixture(t);
  const second = new ConfigWebServer({ project, configPath: f.configPath, args: ['--web'], defaultPort: Number(new URL(f.url).port), validate: () => {}, reload: () => {} });
  await assert.rejects(second.start(), /EADDRINUSE/);
  await second.close();
  assert.equal((await f.request()).status, 200);
  const remote = new ConfigWebServer({ project, configPath: f.configPath, args: ['--web', '--web-host', '0.0.0.0'], defaultPort: await port(), validate: () => {}, reload: () => {} });
  await assert.rejects(remote.start(), /127\.0\.0\.1/);
});

test('Web binding is fixed to loopback and obsolete remote settings are rejected', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com', 'localhost', '::1']) {
    assert.throws(() => validateWebConfig({ host }), /127\.0\.0\.1/);
    assert.throws(() => parseWebArgs(['--web-host', host]), /127\.0\.0\.1/);
  }
  assert.equal(resolveWebOptions({ host: '127.0.0.1' }, [], 3100).effective.host, '127.0.0.1');
  assert.equal(resolveWebOptions(undefined, [], 3100).sources.host, '固定本机');
  for (const key of ['tokenEnv', 'tlsCert', 'tlsKey', 'publicOrigin']) assert.throws(() => validateWebConfig({ [key]: 'unused' }), /Unknown/);
});

test('All original example fields have visual descriptors and accept original value types', async () => {
  const examplePath = project === 'database' ? 'config/databases.example.json' : 'config.example.json';
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  validateFormTypes(example, configSchema(project));
  const check = (value, raw, pointer = '', parent) => {
    const field = resolveField(raw, value, parent);
    if (Array.isArray(value)) value.forEach((child, index) => check(child, field.item, `${pointer}.${index}`));
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (!pointer && key === 'web') continue;
      const next = field.properties?.[key] ?? field.item;
      assert.ok(next, `Missing visual descriptor ${pointer}.${key}`);
      check(child, next, `${pointer}.${key}`, value);
    }
  };
  check(example, configSchema(project));
});

test('Original validators accept Web and reject unsafe downstream URLs or invalid settings', async () => {
  const validate = project === 'gateway' ? (await import('../dist/config.js')).validateGatewayConfig
    : project === 'database' ? (await import('../dist/config/configValidation.js')).validateDatabaseConfig : undefined;
  if (!validate) return;
  assert.doesNotThrow(() => validate({ ...baseConfig(), web: { enabled: false, port: 3100 } }));
  assert.throws(() => validate({ ...baseConfig(), web: { enabled: 'false' } }));
  if (project === 'gateway') {
    const service = { serviceId: 'demo', name: 'demo', enable: false, transport: { type: 'stdio', command: 'node' } };
    for (const webUrl of ['javascript:alert(1)', 'file:///tmp', 'http://user:password@localhost', 'invalid']) assert.throws(() => validate({ services: [{ ...service, webUrl }] }));
    for (const webUrl of ['', 'https://localhost:3101']) assert.doesNotThrow(() => validate({ services: [{ ...service, webUrl }] }));
  }
});

const waitFor = (check, child, milliseconds = 15000) => new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (check()) { clearInterval(timer); clearTimeout(timeout); resolve(); }
    else if (child.exitCode !== null) { clearInterval(timer); clearTimeout(timeout); reject(new Error(`Child exited ${child.exitCode}`)); }
  }, 20);
  const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('Timed out waiting for child')); }, milliseconds);
});

test('Real CLI serves Web beside stdio, saves actual config and closes on stdin EOF', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), `mcp-${project}-web-cli-`));
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(baseConfig()));
  const webPort = await port();
  const child = spawn(process.execPath, ['dist/index.js', '--config', configPath, '--web', '--web-port', String(webPort)], {
    cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { child.kill(); await rm(directory, { recursive: true, force: true }); });
  await waitFor(() => stderr.includes('Configuration Web:'), child);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'web-test', version: '1' } } }) + '\n');
  await waitFor(() => stdout.includes('"id":1'), child);
  for (const line of stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  const url = `http://127.0.0.1:${webPort}`;
  const headers = { Origin: url, 'Content-Type': 'application/json' };
  const current = await (await fetch(url + '/api/config', { headers })).json();
  const config = { ...current.config, ...(project === 'gateway' ? { logging: { enable: false } } : { maxSessions: 64 }) };
  const saved = await (await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ config, revision: current.revision }) })).json();
  assert.equal(saved.loaded, true, JSON.stringify(saved));
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('EOF did not stop process')), 5000); timer.unref(); })]);
  await assert.rejects(fetch(url + '/api/config', { headers }));
});

test('Gateway keeps MCP HTTP and configuration Web on independent ports', { skip: project !== 'gateway', timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcp-gateway-web-http-'));
  const configPath = path.join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(baseConfig()));
  const webPort = await port(), mcpPort = await port();
  const child = spawn(process.execPath, ['dist/index.js', '--config', configPath, '--http', '--port', String(mcpPort), '--web', '--web-port', String(webPort)], {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => { child.kill(); await rm(directory, { recursive: true, force: true }); });
  await waitFor(() => stderr.includes('Configuration Web:'), child);
  assert.equal((await fetch(`http://127.0.0.1:${webPort}/`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/`)).status, 404);
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  });
  assert.equal(response.status, 200);
});

test('Real CLI defaults to disabled and --no-web overrides enabled file without rewriting it', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), `mcp-${project}-web-disabled-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const enabled of [false, true]) {
    const listenPort = await port();
    const configPath = path.join(directory, `${enabled}.json`);
    const config = { ...baseConfig(), ...(enabled ? { web: { enabled, port: listenPort } } : {}) };
    const original = JSON.stringify(config);
    await writeFile(configPath, original);
    const child = spawn(process.execPath, ['dist/index.js', '--config', configPath, ...(enabled ? ['--no-web'] : ['--web-port', String(listenPort)])], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let stdout = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.resume();
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
    await waitFor(() => stdout.includes('"id":7'), child);
    await assert.rejects(fetch(`http://127.0.0.1:${listenPort}/`));
    assert.equal(await readFile(configPath, 'utf8'), original);
    const closed = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    await closed;
  }
});
