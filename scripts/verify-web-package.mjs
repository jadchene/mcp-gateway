import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// 验证发布清单包含独立运行配置页面所需的全部构建文件。
const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(os.tmpdir(), 'mcp-web-pack-cache')], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const parsed = JSON.parse(result.stdout);
const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = report.files.map(file => file.path);
for (const file of ['dist/index.js', 'dist/web-config/server.js', 'dist/web-config/options.js', 'dist/web-config/schema.js', 'dist/web-ui/index.html']) assert.ok(files.includes(file), `Missing ${file}`);
assert.ok(files.some(file => /^dist\/web-ui\/assets\/.*\.js$/.test(file)), 'Missing JavaScript assets');
assert.ok(files.some(file => /^dist\/web-ui\/assets\/.*\.css$/.test(file)), 'Missing CSS assets');
assert.ok(!files.some(file => file.includes('preview-token') || file.startsWith('node_modules/')), 'Unexpected local files');
console.log(`Verified embedded Web resources in ${report.name}: ${files.length} files`);
