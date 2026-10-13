/**
 * 自检：不碰网盘的那部分先跑一遍，确认入口、参数解析、MCP 协议握手都正常。
 * 用法： node test/selftest.mjs
 * 有 token 时会额外跑一次只读的 whoami（不写任何数据）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'bin', 'baidu-pan.mjs');
const MCP = path.join(root, 'src', 'mcp.mjs');
let pass = 0; let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
};
const run = (bin, args, input) => new Promise((resolve) => {
  const p = spawn(process.execPath, [bin, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  if (input) p.stdin.write(input);
  p.stdin.end();
  p.on('exit', (code) => resolve({ code, out, err }));
});

console.log('CLI');
const help = await run(CLI, ['--help']);
check('--help 有输出', help.out.includes('baidu-pan'));
check('--help 列出 upload', help.out.includes('upload'));
check('--version', (await run(CLI, ['--version'])).out.trim().length > 0);
const bad = await run(CLI, ['nosuchcmd']);
check('未知命令报错退出码非 0', bad.code !== 0);
const rmNoYes = await run(CLI, ['rm', '/x/y']);
check('rm 不带 --yes 时拒绝执行', rmNoYes.code === 3, 'exit=' + rmNoYes.code);

console.log('MCP 协议');
const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n';
const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n';
const r = await run(MCP, [], init + list);
const lines = r.out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const initRes = lines.find((m) => m.id === 1);
const listRes = lines.find((m) => m.id === 2);
check('initialize 返回 serverInfo', initRes?.result?.serverInfo?.name === 'baidu-pan', JSON.stringify(initRes).slice(0, 120));
check('tools/list 有 14 个工具', listRes?.result?.tools?.length === 14, 'count=' + (listRes?.result?.tools?.length));
check('工具含 upload_local', !!listRes?.result?.tools?.some((t) => t.name === 'upload_local'));
check('删除默认不开', !!(listRes?.result?.tools?.some((t) => t.name === 'remove_files')));

console.log('只读接口（需要 token，没有就跳过）');
try {
  const { loadToken, userInfo, quota } = await import(new URL('../src/core.mjs', import.meta.url).href);
  loadToken();
  const u = await userInfo();
  check('whoami 返回账号', u.errno === 0, JSON.stringify(u).slice(0, 120));
  const q = await quota();
  check('quota 返回容量', q.total > 0, 'total=' + q.total);
} catch (e) {
  console.log('  - 跳过：' + e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
