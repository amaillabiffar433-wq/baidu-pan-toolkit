/**
 * baidu-pan-toolkit · 核心库
 * 百度网盘 xpan / pcs REST API 的极简封装：零 npm 依赖。
 *
 * 设计要点（都是踩坑换来的，别改）：
 *  - HTTP 优先走 curl.exe：百度会在 Content-Encoding: gzip 的响应里塞明文 HTML，
 *    Node 的 fetch/undici 会抛 `TypeError: terminated` + `incorrect header check`。
 *  - 没有 curl 时回退到 fetch，只是对部分接口可能不稳定。
 *  - 下载直链 dlink 必须再拼一次 access_token，否则 d.pcs.baidu.com 回 403 / 31045。
 *  - 分片上传走 /rest/2.0/pcs/superfile2 + multipart 字段名 file；官方分片大小 4MB。
 *  - 分片成功响应可能不带 errno（只有 md5/request_id），判断成功要放宽。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export const API = 'https://pan.baidu.com/rest/2.0/xpan';
export const UPLOAD_HOST = 'https://d.pcs.baidu.com';
export const UA = 'pan.baidu.com';
export const CHUNK = 4 * 1024 * 1024; // 官方分片固定 4MB，别调大
export const DEFAULT_CONFIG_FILE = path.join(os.homedir(), '.baidu-pan', 'config.json');

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ token */

export function resolveConfigFile(explicit) {
  return explicit || process.env.BAIDU_PAN_CONFIG || DEFAULT_CONFIG_FILE;
}

/**
 * 解析 access_token，优先级：
 *   1. 显式传入
 *   2. 环境变量 BAIDU_PAN_TOKEN / BAIDU_NETDISK_ACCESS_TOKEN
 *   3. 环境变量 BAIDU_TOKEN_FILE 指向的文件
 *   4. ~/.baidu-pan/config.json 里的 access_token
 */
export function loadToken(explicit) {
  if (explicit) return explicit.trim();
  for (const k of ['BAIDU_PAN_TOKEN', 'BAIDU_NETDISK_ACCESS_TOKEN']) {
    if (process.env[k]) return process.env[k].trim();
  }
  if (process.env.BAIDU_TOKEN_FILE) {
    return fs.readFileSync(process.env.BAIDU_TOKEN_FILE, 'utf8').trim();
  }
  const cfg = resolveConfigFile();
  if (fs.existsSync(cfg)) {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    if (j.access_token) return String(j.access_token).trim();
  }
  throw new Error(
    '找不到 access_token。请先 `baidu-pan login`，或设置环境变量 BAIDU_PAN_TOKEN，' +
      '或在 ' + cfg + ' 里写入 {"access_token":"..."}',
  );
}

export function saveToken(token, extra = {}) {
  const cfg = resolveConfigFile();
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  let old = {};
  if (fs.existsSync(cfg)) {
    try { old = JSON.parse(fs.readFileSync(cfg, 'utf8')); } catch { old = {}; }
  }
  const body = { ...old, ...extra, access_token: String(token).trim(), saved_at: new Date().toISOString() };
  fs.writeFileSync(cfg, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}

/* -------------------------------------------------------------------- http */

function hasCurl() {
  const bin = process.env.CURL_BIN || (process.platform === 'win32' ? 'curl.exe' : 'curl');
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return r.status === 0 ? bin : null;
}
let CURL_BIN; // 懒探测，只探一次

export function httpText(url, { method = 'GET', form, binary } = {}) {
  if (CURL_BIN === undefined) CURL_BIN = hasCurl();
  const args = ['-sS', '--connect-timeout', '20', '--retry', '2', '-A', UA, '--max-time', '600'];
  if (method === 'POST') {
    args.push('-X', 'POST', '-H', 'Content-Type: application/x-www-form-urlencoded');
    if (form) args.push('--data-binary', form); else args.push('-d', '');
  }
  args.push(url);
  if (CURL_BIN) {
    const out = execFileSync(CURL_BIN, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, ...(binary ? { input: binary } : {}) });
    return out;
  }
  // 回退：Node 原生 fetch（无 curl 的环境；部分接口可能因 gzip 头不匹配而失败）
  return fetchSync(url, { method, form });
}

// 用子进程同步等待 fetch，避免把整个库改成 async
let FETCH_HELPER;
function fetchSync(url, opts = {}) {
  if (!FETCH_HELPER) {
    FETCH_HELPER = path.join(os.tmpdir(), 'baidu-pan-fetch-helper.mjs');
    fs.writeFileSync(FETCH_HELPER, [
      "const url = process.argv[2];",
      "const method = process.argv[3] || 'GET';",
      "const form = process.argv[4] || undefined;",
      "const res = await fetch(url, { method, headers: { 'User-Agent': 'pan.baidu.com' }, body: method === 'POST' ? (form || '') : undefined });",
      "process.stdout.write(Buffer.from(await res.arrayBuffer()));",
    ].join('\n'));
  }
  const r = spawnSync(process.execPath, [FETCH_HELPER, url, opts.method || 'GET', opts.form || ''], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('fetch 回退失败: ' + (r.stderr ? r.stderr.toString().slice(0, 300) : ''));
  return r.stdout;
}

export function httpJson(url, opts) {
  const raw = httpText(url, opts).toString('utf8');
  try { return JSON.parse(raw); }
  catch { throw new Error('响应不是 JSON: ' + raw.slice(0, 300)); }
}

export const get = (url) => httpJson(url);
export const post = (url) => httpJson(url, { method: 'POST' });
export function postForm(base, params) {
  const q = new URLSearchParams(params).toString();
  return httpJson(base + '?' + q, { method: 'POST' });
}

/* ------------------------------------------------------------------ errors */

export const ERRS = {
  '0': '成功', '-6': 'token 无效', '-7': 'token 过期', '-8': '条目已存在', '-9': '文件不存在',
  '2': '参数错误', '111': 'token 无效', '112': 'token 过期', '31034': '设备未授权',
  '31023': '参数错误', '31045': '未授权（请求里没带 access_token）', '31061': '文件已存在',
  '31064': '未授权或文件不可用', '31066': '文件不存在或无权限', '31200': '空间不足',
  '31326': '文件校验失败', '31345': '上传参数错误', '31355': '分片上传失败', '31500': '创建文件失败', '1003': '上传失败',
};
export function explain(j) {
  const c = j.errno !== undefined ? j.errno : j.error_code;
  const label = ERRS[String(c)];
  return `errno=${c}${label ? ' ' + label : ''} ${j.errmsg || j.error_msg || ''} request_id=${j.request_id || ''}`.trim();
}
export function assertOk(j, what) {
  const c = j.errno !== undefined ? j.errno : j.error_code;
  if (c !== undefined && c !== 0) throw new Error(`${what}失败: ${explain(j)}`);
  return j;
}

/* -------------------------------------------------------------------- 账号 */

export async function userInfo(token = loadToken()) {
  return get(`${API}/nas?method=uinfo&access_token=${token}`);
}
export async function quota(token = loadToken()) {
  return get(`https://pan.baidu.com/api/quota?access_token=${token}&checkfree=1&checkexpire=1`);
}

/* -------------------------------------------------------------------- 列表 */

/**
 * 列目录。优先用 `xpan/file?method=list`（稳定、支持 start 翻页），
 * 失败时回退到 `xpan/multimedia?method=listall`（部分账号上会对 / 返回 20021）。
 */
export async function listDir(dir = '/', { limit = 1000, token = loadToken() } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
  const items = [];
  let start = 0;
  let usedFallback = false;
  for (;;) {
    let j = get(`${API}/file?method=list&access_token=${token}&dir=${enc(dir)}&order=name&start=${start}&limit=${pageSize}`);
    if (j.errno && j.errno !== 0) {
      usedFallback = true;
      j = get(`${API}/multimedia?method=listall&access_token=${token}&path=${enc(dir)}&recursion=0&limit=${pageSize}&order=name`);
    }
    assertOk(j, '列目录');
    const batch = j.list || [];
    for (const x of batch) {
      items.push({
        name: x.server_filename, isdir: !!x.isdir, size: x.size, fs_id: x.fs_id,
        mtime: x.server_mtime, md5: x.md5 || undefined,
      });
    }
    if (usedFallback || batch.length < pageSize || items.length >= limit) break;
    start += pageSize;
  }
  return { dir, count: items.length, items };
}

/** 递归列出目录下所有条目（多用于清理、统计）：逐层列目录，不依赖 recursion 参数 */
export async function listAll(dir = '/', { token = loadToken(), max = 20000 } = {}) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const { items } = await listDir(cur, { token, limit: 1000 });
    for (const x of items) {
      const full = (cur.replace(/\/+$/, '') || '') + '/' + x.name;
      out.push({ name: x.name, path: full, isdir: x.isdir, size: x.size, fs_id: x.fs_id, mtime: x.mtime });
      if (x.isdir) stack.push(full);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export async function fsidOf(remotePath, token = loadToken()) {
  const parent = path.posix.dirname(remotePath.replace(/\/+$/, '')) || '/';
  const name = path.posix.basename(remotePath.replace(/\/+$/, ''));
  const { items } = await listDir(parent, { token, limit: 1000 });
  const hit = items.find((x) => x.name === name);
  if (!hit) throw new Error('网盘上找不到: ' + remotePath);
  return hit.fs_id;
}

export async function meta(remotePath, { token = loadToken(), dlink = true } = {}) {
  const fsid = await fsidOf(remotePath, token);
  const j = get(`${API}/multimedia?method=filemetas&access_token=${token}&fsids=${enc('[' + fsid + ']')}&dlink=${dlink ? 1 : 0}&thumb=0&extra=0`);
  assertOk(j, '查询文件');
  return (j.list || [])[0] || null;
}

/* --------------------------------------------------------------- 搜索/移动 */

export async function search(keyword, { dir = '/', recursion = 1, token = loadToken() } = {}) {
  const j = get(`${API}/file?method=search&access_token=${token}&key=${enc(keyword)}&dir=${enc(dir)}&recursion=${recursion}&page=1&num=100&web=1`);
  assertOk(j, '搜索');
  return { count: (j.list || []).length, items: j.list || [] };
}
export async function fileManagerOp(op, filelist, token = loadToken()) {
  const j = postForm(`${API}/file`, { method: op, access_token: token, async: '0', filelist: JSON.stringify(filelist) });
  assertOk(j, op);
  return j;
}
export const moveFiles = (paths, dest, token) =>
  fileManagerOp('move', paths.map((p) => ({ path: p, dest, newname: path.posix.basename(p) })), token);
export const copyFiles = (paths, dest, token) =>
  fileManagerOp('copy', paths.map((p) => ({ path: p, dest, newname: path.posix.basename(p) })), token);
export const renameFile = (p, newname, token) =>
  fileManagerOp('rename', [{ path: p, newname }], token);
export const removeFiles = (paths, token) =>
  fileManagerOp('delete', paths.map((p) => ({ path: p })), token);

/* ------------------------------------------------------------------ 上传 */

export function md5Blocks(absFile, chunk = CHUNK) {
  const size = fs.statSync(absFile).size;
  const parts = Math.max(1, Math.ceil(size / chunk));
  const blockList = [];
  const whole = crypto.createHash('md5');
  const fd = fs.openSync(absFile, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const len = Math.min(chunk, size - i * chunk);
      const b = Buffer.allocUnsafe(len);
      fs.readSync(fd, b, 0, len, i * chunk);
      blockList.push(crypto.createHash('md5').update(b).digest('hex'));
      whole.update(b);
    }
  } finally { fs.closeSync(fd); }
  return { size, parts, blockList, md5: whole.digest('hex') };
}

/** 上传本机文件到网盘，自动分片；命中秒传时 parts=0 */
export async function uploadLocal(localPath, { remoteDir = '/', remoteName, token = loadToken(), onProgress = () => {}, chunk = CHUNK } = {}) {
  const abs = path.resolve(localPath);
  if (!fs.existsSync(abs)) throw new Error('本地文件不存在: ' + abs);
  if (!fs.statSync(abs).isFile()) throw new Error('不是普通文件: ' + abs);
  const name = remoteName || path.basename(abs);
  const target = (remoteDir && remoteDir !== '/' ? remoteDir.replace(/\/+$/, '') : '') + '/' + name;
  const { size, parts, blockList, md5 } = md5Blocks(abs, chunk);

  onProgress('计算 md5 完成（' + parts + ' 片）');
  const pre = postForm(`${API}/file`, {
    method: 'precreate', access_token: token, path: target, size: String(size),
    isdir: '0', autoinit: '1', rtype: '3', block_list: JSON.stringify(blockList),
  });
  assertOk(pre, '预上传');
  if (pre.rapid_upload) { onProgress('秒传命中'); return { path: target, size, md5, parts: 0, rapid: true, fs_id: pre.fs_id }; }

  let fd = fs.openSync(abs, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const len = Math.min(chunk, size - i * chunk);
      const b = Buffer.allocUnsafe(len);
      fs.readSync(fd, b, 0, len, i * chunk);
      onProgress(`上传分片 ${i + 1}/${parts}（${(len / 1048576).toFixed(1)}MB）`);
      const url = `${UPLOAD_HOST}/rest/2.0/pcs/superfile2?method=upload&access_token=${token}&type=tmpfile` +
        `&path=${enc(target)}&uploadid=${enc(pre.uploadid)}&partseq=${i}`;
      const bin = process.env.CURL_BIN || (process.platform === 'win32' ? 'curl.exe' : 'curl');
      const out = execFileSync(bin, ['-sS', '--connect-timeout', '20', '--max-time', '600', '--retry', '2', '-A', UA, '-X', 'POST', '-F', 'file=@-', url],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: b });
      let j; try { j = JSON.parse(out); } catch { throw new Error(`分片 ${i} 响应异常: ` + out.slice(0, 300)); }
      assertOk(j, `分片 ${i}`);
    }
  } finally { fs.closeSync(fd); }

  onProgress('合并文件…');
  const crt = postForm(`${API}/file`, {
    method: 'create', access_token: token, path: target, size: String(size),
    isdir: '0', rtype: '3', uploadid: pre.uploadid, block_list: JSON.stringify(blockList),
  });
  assertOk(crt, '创建文件');
  return { path: crt.path || target, size, md5: crt.md5 || md5, fs_id: crt.fs_id, parts };
}

/* ------------------------------------------------------------------ 下载 */

export async function downloadLocal(remotePath, { localPath, token = loadToken(), onProgress = () => {} } = {}) {
  const info = await meta(remotePath, { token });
  if (!info) throw new Error('网盘上找不到: ' + remotePath);
  if (info.isdir) throw new Error('这是目录，不能直接下载: ' + remotePath);
  if (!info.dlink) throw new Error('该文件没有返回下载直链（可能受版权或权限限制）');
  const dest = localPath ? path.resolve(localPath) : path.join(process.cwd(), path.basename(remotePath));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  onProgress('下载中…');
  return await new Promise((resolve, reject) => {
    // dlink 必须再带一次 access_token，否则 403
    const url = info.dlink + (info.dlink.includes('?') ? '&' : '?') + 'access_token=' + token;
    const bin = process.env.CURL_BIN || (process.platform === 'win32' ? 'curl.exe' : 'curl');
    const p = spawn(bin, ['-sS', '--connect-timeout', '20', '-A', UA, '-e', 'https://pan.baidu.com/', '-L', '--fail', '--retry', '2', '-o', dest, url],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('exit', (code) => {
      if (code !== 0) {
        const hint = /403/.test(err) ? '403：该文件禁止直接下载（版权/违规限制）' : '';
        return reject(new Error(`下载失败 curl exit=${code} ${hint} ${err.slice(0, 200)}`.trim()));
      }
      const got = fs.statSync(dest).size;
      resolve({ path: dest, bytes: got, expected: info.size, ok: got === info.size });
    });
  });
}

/* -------------------------------------------------------------- 目录/分享 */

export async function makeDir(dir, token = loadToken()) {
  const clean = dir.replace(/\/+$/, '');
  const parent = path.posix.dirname(clean) || '/';
  const name = path.posix.basename(clean);
  try {
    const ls = await listDir(parent, { token });
    if (ls.items.some((x) => x.name === name && x.isdir)) return { path: dir, existed: true };
  } catch { /* 列目录失败就继续尝试创建 */ }
  const j = postForm(`${API}/file`, { method: 'create', access_token: token, path: dir, size: '0', isdir: '1', rtype: '3' });
  if (j.errno !== 0 && j.errno !== -8) throw new Error('建目录失败: ' + explain(j));
  return { path: dir, existed: j.errno === -8, fs_id: j.fs_id };
}

export async function shareLink(remotePath, { period = 7, pwd, token = loadToken() } = {}) {
  const fsid = await fsidOf(remotePath, token);
  const params = { method: 'set', access_token: token, period: String(period), channel: '0', fsid_list: JSON.stringify([fsid]) };
  if (pwd) params.pwd = String(pwd);
  const j = postForm(`${API}/share`, params);
  assertOk(j, '创建分享');
  return { link: j.link, pwd: j.pwd, period };
}
