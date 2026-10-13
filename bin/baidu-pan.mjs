#!/usr/bin/env node
/**
 * baidu-pan · 命令行入口
 * 零依赖，任何装了 Node 18+ 和 curl 的机器都能直接跑。
 */
import fs from 'node:fs';
import {
  loadToken, saveToken, userInfo, quota, listDir, listAll, meta, search,
  uploadLocal, downloadLocal, makeDir, shareLink,
  moveFiles, copyFiles, renameFile, removeFiles, resolveConfigFile,
} from '../src/core.mjs';

const VERSION = '1.0.0';
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (name) => { const i = rest.indexOf(name); return i > -1 ? rest[i + 1] : undefined; };
const has = (name) => rest.includes(name);
const positional = rest.filter((a, i) => !a.startsWith('-') && !(i > 0 && rest[i - 1].startsWith('--') && rest[i - 1] !== '--'));
const json = has('--json');
const quiet = has('--quiet');

const out = (v) => {
  if (json) console.log(JSON.stringify(v, null, 2));
  return v;
};
const human = (v) => { if (!json && !quiet) console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const die = (e) => { console.error('✗ ' + (e && e.message ? e.message : e)); process.exit(1); };
const fmtSize = (n) => {
  if (n === undefined || n === null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let x = Number(n);
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return x.toFixed(x >= 100 || i === 0 ? 0 : 1) + u[i];
};
const fmtTime = (s) => (s ? new Date(s * 1000).toLocaleString('zh-CN', { hour12: false }) : '-');

const HELP = `baidu-pan ${VERSION} · 百度网盘命令行（上传/下载/整理），零依赖

用法  baidu-pan <命令> [参数]

账号
  login [--token <token>]     保存 access_token（不给 --token 时读 stdin / 环境变量）
  whoami                      查看账号信息
  quota                       查看容量使用

浏览
  ls [<远端目录>]             列目录（默认 /）
  ls -R [<远端目录>]          递归列出全部条目
  meta <远端路径>             文件详情（大小/md5/直链）
  search <关键词>             文件名搜索

传输
  upload <本地文件> [--to <远端目录>] [--as <远端文件名>]
  download <远端路径> [--to <本地目录或文件>]
  mkdir <远端目录>

整理
  mv <远端路径...> --to <远端目录>
  cp <远端路径...> --to <远端目录>
  rename <远端路径> --to <新文件名>
  share <远端路径> [--period 7] [--pwd 1234]
  rm <远端路径...> [--yes]

其它
  token                       打印当前 token 来源（不回显明文）
  --json                      以 JSON 输出（适合脚本）
  --quiet                     不打印进度
  -v, --version               版本
  -h, --help                  帮助

环境变量
  BAIDU_PAN_TOKEN             access_token（优先级高于配置文件）
  BAIDU_PAN_CONFIG            配置文件路径，默认 ~/.baidu-pan/config.json
  BAIDU_TOKEN_FILE            从文件读 token（兼容旧用法）
  CURL_BIN                    curl 可执行文件路径

例
  baidu-pan login --token 123.xxxx
  baidu-pan upload ./report.pdf --to /论文
  baidu-pan download /论文/report.pdf --to ./下载
  baidu-pan ls /比赛中心 --json
`;

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(HELP); return; }
  if (cmd === '-v' || cmd === '--version') { console.log(VERSION); return; }

  switch (cmd) {
    case 'login': return cmdLogin();
    case 'token': return cmdToken();
    case 'whoami': case 'info': return human(out(await userInfo()));
    case 'quota': case 'df': return cmdQuota();
    case 'ls': case 'list': return cmdLs();
    case 'meta': case 'stat': return cmdMeta();
    case 'search': case 'find': return cmdSearch();
    case 'upload': case 'up': case 'put': return cmdUpload();
    case 'download': case 'dl': case 'get': return cmdDownload();
    case 'mkdir': case 'md': return human(out(await makeDir(requireArg('远端目录'))));
    case 'mv': case 'move': return cmdManager('move');
    case 'cp': case 'copy': return cmdManager('copy');
    case 'rename': case 'ren': return human(out(await renameFile(requireArg('远端路径'), requireFlag('--to', '新文件名'))));
    case 'share': return cmdShare();
    case 'rm': case 'remove': case 'delete': return cmdRemove();
    default: throw new Error(`未知命令: ${cmd}（baidu-pan --help 看用法）`);
  }
}

function requireArg(what) {
  const a = positional[0];
  if (!a) throw new Error(`缺少参数：${what}`);
  return a;
}
function requireFlag(name, what) {
  const v = flag(name);
  if (!v) throw new Error(`缺少参数：${name} <${what}>`);
  return v;
}

async function cmdLogin() {
  let token = flag('--token');
  if (!token && process.env.BAIDU_PAN_TOKEN) token = process.env.BAIDU_PAN_TOKEN;
  if (!token && !process.stdin.isTTY) token = fs.readFileSync(0, 'utf8').trim();
  if (!token) {
    console.log(`没有拿到 token。两种方式任选：

1) 浏览器授权（个人体验密钥，30 天有效）：
   打开下面这个链接，登录并点“授权”，页面会跳到 login_success#...
   URL 的 # 后面就藏着 access_token，复制下来再执行：
     baidu-pan login --token <粘在这里>

   https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&client_id=QHOuRXiepJBMjtk0esLhrPoNlQyYd0mF&redirect_uri=oob&scope=basic,netdisk

2) 企业开发者：在 https://pan.baidu.com/union 申请应用，用自己的 AppKey 走 OAuth。
`);
    return;
  }
  const cfg = saveToken(token);
  try {
    const u = await userInfo(token);
    human(`✓ token 已保存到 ${cfg}\n  账号：${u.baidu_name || '(未命名)'}  VIP：${u.vip_type ?? '-'}  uk：${u.uk ?? '-'}`);
  } catch (e) {
    human(`token 已保存到 ${cfg}，但校验失败：${e.message}`);
    process.exitCode = 2;
  }
}

function cmdToken() {
  const src = process.env.BAIDU_PAN_TOKEN ? '环境变量 BAIDU_PAN_TOKEN'
    : process.env.BAIDU_TOKEN_FILE ? '文件 ' + process.env.BAIDU_TOKEN_FILE
      : resolveConfigFile();
  const t = loadToken();
  human(`来源：${src}\n长度：${t.length}\n前缀：${t.slice(0, 6)}…（不完整回显）`);
}

async function cmdQuota() {
  const q = await quota();
  human(`总容量：${fmtSize(q.total)}   已用：${fmtSize(q.used)}   剩余：${fmtSize(q.free)}`);
  out(q);
}

async function cmdLs() {
  const dir = positional[0] || '/';
  if (has('-R') || has('--recursive')) {
    const items = await listAll(dir);
    if (json) return out(items);
    const dirs = items.filter((x) => x.isdir);
    console.log(`${dir}  共 ${items.length} 项（目录 ${dirs.length} / 文件 ${items.length - dirs.length}）`);
    for (const x of items) console.log(`${x.isdir ? '📁' : '  '} ${fmtSize(x.size).padStart(8)}  ${x.path}`);
    return;
  }
  const r = await listDir(dir, { limit: Number(flag('--limit') || 1000) });
  if (json) return out(r);
  console.log(`${r.dir}  共 ${r.count} 项`);
  const sorted = [...r.items].sort((a, b) => (b.isdir - a.isdir) || a.name.localeCompare(b.name, 'zh'));
  for (const x of sorted) {
    console.log(`${x.isdir ? '📁' : '  '} ${(x.isdir ? '-' : fmtSize(x.size)).padStart(8)}  ${x.name}`);
  }
}

async function cmdMeta() {
  const p = requireArg('远端路径');
  const m = await meta(p);
  if (json) return out(m);
  if (!m) return console.log('未找到');
  console.log(`路径：${p}\n大小：${fmtSize(m.size)}\n修改：${fmtTime(m.server_mtime)}\nmd5 ：${m.md5 || '-'}\n类型：${m.isdir ? '目录' : '文件'}\n直链：${m.dlink || '-'}`);
}

async function cmdSearch() {
  const kw = requireArg('关键词');
  const r = await search(kw, { dir: flag('--in') || '/' });
  if (json) return out(r);
  console.log(`命中 ${r.count} 项`);
  for (const x of r.items) console.log(`${x.isdir ? '📁' : '  '} ${fmtSize(x.size).padStart(8)}  ${x.path}`);
}

async function cmdUpload() {
  const local = requireArg('本地文件');
  const r = await uploadLocal(local, {
    remoteDir: flag('--to') || '/',
    remoteName: flag('--as'),
    onProgress: (m) => { if (!quiet) console.error('  ' + m); },
  });
  human(`✓ ${r.rapid ? '秒传' : '上传完成'}  ${r.path}  ${fmtSize(r.size)}${r.rapid ? '' : `  分片 ${r.parts}`}`);
  out(r);
}

async function cmdDownload() {
  const remote = requireArg('远端路径');
  const r = await downloadLocal(remote, {
    localPath: flag('--to'),
    onProgress: (m) => { if (!quiet) console.error('  ' + m); },
  });
  human(`✓ 已下载到 ${r.path}  ${fmtSize(r.bytes)}${r.ok ? '' : '（大小与网盘记录不一致，请检查）'}`);
  out(r);
}

async function cmdManager(op) {
  const paths = positional;
  if (!paths.length) throw new Error('缺少参数：远端路径');
  const dest = requireFlag('--to', '目标目录');
  const r = op === 'move' ? await moveFiles(paths, dest) : await copyFiles(paths, dest);
  human(`✓ ${op === 'move' ? '移动' : '复制'} ${paths.length} 项 → ${dest}`);
  out(r);
}

async function cmdShare() {
  const p = requireArg('远端路径');
  const r = await shareLink(p, { period: Number(flag('--period') || 7), pwd: flag('--pwd') });
  human(`✓ 链接：${r.link}${r.pwd ? '  提取码：' + r.pwd : ''}  有效期：${r.period} 天`);
  out(r);
}

async function cmdRemove() {
  const paths = positional;
  if (!paths.length) throw new Error('缺少参数：远端路径');
  if (!has('--yes') && !has('-y')) {
    console.error(`将要从网盘删除 ${paths.length} 项：\n  ${paths.join('\n  ')}\n确认请加 --yes 重跑（删除进回收站，可在网盘「回收站」恢复）。`);
    process.exitCode = 3;
    return;
  }
  const r = await removeFiles(paths);
  human(`✓ 已删除 ${paths.length} 项`);
  out(r);
}

main().catch(die);
