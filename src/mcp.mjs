#!/usr/bin/env node
/**
 * baidu-pan-mcp · MCP stdio 服务
 * 把 core.mjs 的能力暴露成 MCP 工具，任何支持 MCP 的客户端都能用
 * （Claude Desktop / Cursor / DeepSeek Harness / 自写 Agent ...）。
 *
 * 用法：node src/mcp.mjs
 *   --allow-delete   开放 remove_files 工具（默认关闭，防误删）
 */
import readline from 'node:readline';
import {
  loadToken, userInfo, quota, listDir, listAll, meta, search,
  uploadLocal, downloadLocal, makeDir, shareLink,
  moveFiles, copyFiles, renameFile, removeFiles,
} from './core.mjs';

const ALLOW_DELETE = process.env.BAIDU_ALLOW_DELETE === '1' || process.argv.includes('--allow-delete');
const log = (m) => process.stderr.write('[baidu-pan-mcp] ' + m + '\n');
const S = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, ...extra });

const TOOLS = [
  { name: 'user_info', description: '查询当前百度网盘账号信息（昵称、VIP 类型、uk）。', inputSchema: S({}) },
  { name: 'get_quota', description: '查询网盘容量：总容量、已用、剩余。', inputSchema: S({}) },
  { name: 'list_dir', description: '列出网盘目录内容。', inputSchema: S({ remote_dir: { type: 'string', description: '目录路径，默认 /' }, limit: { type: 'number', description: '最多条数，默认 1000' } }) },
  { name: 'list_all', description: '递归列出目录下所有条目（适合清点、迁移前盘点）。', inputSchema: S({ remote_dir: { type: 'string' }, max: { type: 'number', description: '最多条数，默认 20000' } }) },
  { name: 'file_meta', description: '按路径查文件详情：大小、md5、修改时间、下载直链。', inputSchema: S({ remote_path: { type: 'string' } }, ['remote_path']) },
  { name: 'search_files', description: '按文件名关键词搜索网盘文件。', inputSchema: S({ keyword: { type: 'string' }, dir: { type: 'string', description: '搜索起点，默认 /' } }, ['keyword']) },
  { name: 'upload_local', description: '把本机文件上传到百度网盘（自动 4MB 分片，支持大文件与秒传）。', inputSchema: S({ local_path: { type: 'string', description: '本机文件绝对路径' }, remote_dir: { type: 'string', description: '网盘目标目录，默认 /' }, remote_name: { type: 'string', description: '网盘文件名，默认同本地' } }, ['local_path']) },
  { name: 'download_local', description: '把网盘文件下载到本机。', inputSchema: S({ remote_path: { type: 'string' }, local_path: { type: 'string', description: '本机保存路径（可含目录），默认当前目录/同名' } }, ['remote_path']) },
  { name: 'make_dir', description: '在网盘新建目录。', inputSchema: S({ remote_dir: { type: 'string' } }, ['remote_dir']) },
  { name: 'move_files', description: '移动网盘文件/目录到目标目录。', inputSchema: S({ remote_paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } }, ['remote_paths', 'dest']) },
  { name: 'copy_files', description: '复制网盘文件。', inputSchema: S({ remote_paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } }, ['remote_paths', 'dest']) },
  { name: 'rename_file', description: '重命名网盘文件。', inputSchema: S({ remote_path: { type: 'string' }, new_name: { type: 'string' } }, ['remote_path', 'new_name']) },
  { name: 'share_link', description: '给网盘文件创建分享链接（可设有效期与提取码）。', inputSchema: S({ remote_path: { type: 'string' }, period: { type: 'number', description: '有效期天数，默认 7' }, pwd: { type: 'string', description: '可选 4 位提取码' } }, ['remote_path']) },
  { name: 'remove_files', description: '删除网盘文件（进回收站）。默认关闭，需要启动参数 --allow-delete。', inputSchema: S({ remote_paths: { type: 'array', items: { type: 'string' } } }, ['remote_paths']) },
];

const HANDLERS = {
  user_info: () => userInfo(),
  get_quota: () => quota(),
  list_dir: (a) => listDir(a.remote_dir || '/', { limit: a.limit || 1000 }),
  list_all: (a) => listAll(a.remote_dir || '/', { max: a.max || 20000 }),
  file_meta: (a) => meta(a.remote_path),
  search_files: (a) => search(a.keyword, { dir: a.dir || '/' }),
  upload_local: (a, n) => uploadLocal(a.local_path, { remoteDir: a.remote_dir || '/', remoteName: a.remote_name, onProgress: n }),
  download_local: (a, n) => downloadLocal(a.remote_path, { localPath: a.local_path, onProgress: n }),
  make_dir: (a) => makeDir(a.remote_dir),
  move_files: (a) => moveFiles(a.remote_paths, a.dest),
  copy_files: (a) => copyFiles(a.remote_paths, a.dest),
  rename_file: (a) => renameFile(a.remote_path, a.new_name),
  share_link: (a) => shareLink(a.remote_path, { period: a.period || 7, pwd: a.pwd }),
  remove_files: (a) => {
    if (!ALLOW_DELETE) throw new Error('删除未启用：启动 MCP 时加 --allow-delete（或 BAIDU_ALLOW_DELETE=1）');
    return removeFiles(a.remote_paths);
  },
};

/* ------------------------------------------------------------- stdio 循环 */
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const text = (id, t, isError) => ok(id, { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'baidu-pan', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = HANDLERS[params?.name];
    if (!fn) return text(id, '未知工具: ' + params?.name, true);
    try {
      const val = await fn(params.arguments || {}, log);
      return text(id, typeof val === 'string' ? val : JSON.stringify(val, null, 2));
    } catch (e) {
      return text(id, '失败: ' + e.message, true);
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
}

try { loadToken(); }
catch (e) {
  log('警告：' + e.message);
  log('提示：先跑 `baidu-pan login --token <token>`，或设置 BAIDU_PAN_TOKEN。');
}
log(`ready${ALLOW_DELETE ? ' (delete ON)' : ''}`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let m; try { m = JSON.parse(t); } catch { return; }
  handle(m).catch((e) => log('handler error: ' + e.message));
});
