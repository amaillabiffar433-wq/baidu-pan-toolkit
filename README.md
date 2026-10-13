# baidu-pan-toolkit

**百度网盘的命令行工具 + MCP 服务：上传、下载、列目录、搜索、整理、分享。**

零 npm 依赖 —— 只用 Node 内置模块和系统自带的 `curl`。Windows / macOS / Linux 都能跑。

> 为什么会有这个东西：官方 MCP 只给了 `file_upload_by_url`（要你的文件先有公网地址）、没有本地文件上传、没有下载。这个项目补上了这两块，并且把常用操作做成了能脚本化的 CLI。

---

## 它给你什么

| 能力 | CLI | MCP 工具 | 说明 |
| --- | --- | --- | --- |
| 上传本机文件 | `upload` | `upload_local` | 自动 4MB 分片，大文件可传；命中秒传直接完成 |
| 下载到本机 | `download` | `download_local` | 自动处理必须追加 `access_token` 的直链 |
| 列目录 | `ls` / `ls -R` | `list_dir` / `list_all` | 递归盘点整棵目录树 |
| 文件详情 | `meta` | `file_meta` | 大小、md5、修改时间、下载直链 |
| 文件名搜索 | `search` | `search_files` | |
| 移动 / 复制 / 重命名 | `mv` `cp` `rename` | `move_files` `copy_files` `rename_file` | |
| 删除 | `rm --yes` | `remove_files`（需 `--allow-delete`） | 默认关闭，删除进回收站 |
| 分享链接 | `share` | `share_link` | 可设有效期和 4 位提取码 |
| 账号 / 容量 | `whoami` `quota` | `user_info` `get_quota` | |

共 14 个 MCP 工具。

## 环境要求

- Node.js **18 或更高**（只用到标准库；本项目没有任何第三方依赖）
- `curl`：Windows 10/11 自带，macOS / Linux 一般自带。走 `CURL_BIN` 可以指定路径。
- 一个百度网盘 **access_token**（见下面「授权」）

```bash
git clone https://github.com/amaillabiffar433-wq/baidu-pan-toolkit.git
cd baidu-pan-toolkit
node bin/baidu-pan.mjs --help          # 直接跑，无需 npm install
```

想装成全局命令：

```bash
npm i -g .            # 之后可以直接敲 baidu-pan / baidu-pan-mcp
```

## 授权

百度开放平台的 token 有两种拿法。

### 方式一：个人快速体验（30 天）

> 开放平台的正式使用目前只对企业开发者开放，个人开发者用的是官方提供的限时体验密钥，
> 密钥会不定期更换，**每 30 天要重新授权一次**。

1. 浏览器打开（登录你的百度账号）：

   ```
   https://openapi.baidu.com/oauth/2.0/authorize?response_type=token&client_id=QHOuRXiepJBMjtk0esLhrPoNlQyYd0mF&redirect_uri=oob&scope=basic,netdisk
   ```

2. 点「授权」。页面跳到一个错误页但 URL 会变成 `.../login_success#expires_in=2592000&access_token=123.xxxx`。
   **`access_token=` 后面那一长串就是 token**（在地址栏 `#` 之后，页面正文里看不到）。
3. 存下来：

   ```bash
   baidu-pan login --token 123.xxxx
   ```

   token 写到 `~/.baidu-pan/config.json`（权限 600）。也可以用环境变量 `BAIDU_PAN_TOKEN` 覆盖。

### 方式二：企业/正式应用

在 [百度网盘开放平台](https://pan.baidu.com/union) 创建应用拿到 `AppKey` / `SecretKey`，走标准 OAuth：

```bash
# 1) 浏览器授权，拿到 code
#    https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=<AppKey>&redirect_uri=oob&scope=basic,netdisk
# 2) 用 code 换 token
curl -sS "https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code=<code>&client_id=<AppKey>&client_secret=<SecretKey>&redirect_uri=oob"
# 3) 保存
baidu-pan login --token <返回的 access_token>
```

### 排查

```bash
baidu-pan token      # 看当前 token 从哪来、长度、前 6 位
baidu-pan whoami     # token 有效时会返回昵称
```

报 `errno=-6 / 111`（token 无效）或 `-7 / 112`（token 过期）→ 重新授权。

## CLI 用法

```
baidu-pan <命令> [参数]

账号
  login [--token <token>]           保存 token
  whoami                            账号信息
  quota                             容量使用

浏览
  ls [<远端目录>]                   列目录（默认 /）
  ls -R [<远端目录>]                递归列出全部条目
  meta <远端路径>                   大小 / md5 / 直链
  search <关键词> [--in <目录>]
  mkdir <远端目录>

传输
  upload <本地文件> [--to <远端目录>] [--as <远端文件名>]
  download <远端路径> [--to <本地目录或文件>]

整理
  mv <远端路径...> --to <远端目录>
  cp <远端路径...> --to <远端目录>
  rename <远端路径> --to <新文件名>
  share <远端路径> [--period 7] [--pwd 1234]
  rm <远端路径...> --yes

全局
  --json     机器可读输出（脚本用）
  --quiet    不打印进度
  -v / -h    版本 / 帮助
```

例子：

```bash
baidu-pan ls /                       # 看根目录
baidu-pan ls -R /apps | head -50     # 递归盘点
baidu-pan upload ./论文.pdf --to /科研论文
baidu-pan upload ./大文件.iso --to /备份 --as 2026备份.iso
baidu-pan download /科研论文/论文.pdf --to ./下载
baidu-pan share /科研论文/论文.pdf --period 7 --pwd 1234
baidu-pan search 综述 --json | jq '.items[].path'
baidu-pan quota
```

任何命令加 `--json` 都输出 JSON，方便接 `jq` 或别的脚本。

## MCP 用法

启动服务（stdio）：

```bash
node src/mcp.mjs                 # 只读 + 上传/下载
node src/mcp.mjs --allow-delete  # 额外开放删除工具
```

### Claude Desktop / Cursor

`claude_desktop_config.json`（或对应客户端的 `mcpServers`）：

```json
{
  "mcpServers": {
    "baidu-pan": {
      "command": "node",
      "args": ["D:/path/to/baidu-pan-toolkit/src/mcp.mjs"],
      "env": { "BAIDU_PAN_TOKEN": "123.xxxx" }
    }
  }
}
```

### DeepSeek Harness

在 profile 的 `cordis.patch.yml` 里加一条（需要 `@deepseek-ai/dsh-mcp-client`；改完要重启 DSH）：

```yaml
- id: mcp-baidu-pan
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: baidu-pan
    transport: stdio
    command: node
    args:
      - D:/path/to/baidu-pan-toolkit/src/mcp.mjs
    toolCallTimeoutMs: 600000
    failOnStartupError: false
```

工具会以 `mcp__baidu-pan__upload_local` 这样的名字出现。

> 注意：`cordis.patch.yml` 里的条目只能**覆盖已存在的 id**，新 id 需要用插件包的方式挂进去，具体见 DSH 文档。

### 作为库用

```js
import { uploadLocal, downloadLocal, listDir, shareLink } from 'baidu-pan-toolkit';

await uploadLocal('D:/a/b.pdf', { remoteDir: '/论文', onProgress: console.error });
const { items } = await listDir('/论文');
await downloadLocal('/论文/b.pdf', { localPath: './b.pdf' });
```

## 踩过的坑（想自己改代码的话先看这里）

1. **别用 Node 的 fetch / axios 打这些接口。**
   百度会返回 `Content-Encoding: gzip` 但正文其实是明文 HTML，undici 直接抛
   `TypeError: terminated` + `Error: incorrect header check`；有些接口还会把 302 中间页
   `{"error_code":31064}` 当作正文给你。本项目统一走 `curl.exe` 收字节流。

2. **下载直链必须再拼一次 `access_token`。**
   `filemetas?dlink=1` 拿到的直链直接请求会 403 `{"error_code":31045,"error_msg":"user not exists"}`，
   必须 `dlink + "&access_token=" + token`。

3. **分片上传的正确组合。**
   端点 `POST https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&type=tmpfile&path=..&uploadid=..&partseq=N`，
   用 multipart 表单、字段名 `file`；分片大小 **4MB**（官方固定值，调大直接失败）。
   成功后响应可能只有 `md5` / `request_id` 而没有 `errno`，判断成功要放宽。

4. **precreate 必须带全参数。**
   `path` + `size` + `isdir=0` + `rtype=3` + `autoinit=1` + `block_list=[分片md5...]`；
   少 `autoinit` 不返回 `uploadid`，少 `block_list` 报 errno=2。
   `create` 也要走 POST 表单体（塞 query 会 errno=2）。

5. **`file_upload_by_url` 只认公网地址。**
   官方 MCP 的这个工具传 `http://127.0.0.1:...` 会得到 `errno=1003`，服务端取不到你的内网。

6. **删除接口对 `/apps/...` 目录不友好。**
   实测 `file?method=delete` 删应用目录下的文件稳定返回 `31023 参数错误`，
   普通目录（`/我的资源/...`）正常。CLI 的 `rm` 因此走的是同一接口，删应用目录可能失败。

常见 errno：`-6/111` token 无效、`-7/112` token 过期、`-8/31061` 已存在、`-9/31066` 文件不存在、
`31045` 请求里没带 token、`31200` 空间不足、`31326` 文件校验失败。

## 安全

- token 等于你网盘的读写权限，**不要提交到仓库、不要贴到公开聊天**。
  本项目把 token 存在 `~/.baidu-pan/config.json`（600 权限），也支持走环境变量。
- `.gitignore` 已经排除 `config.json`、`.env`、`*.token`。
- CLI 的 `rm` 必须显式 `--yes`；MCP 的删除工具默认不加载，要 `--allow-delete`。
- 所有操作都在你自己的账号下执行，走的是百度官方开放平台接口。

## 免责

非官方项目，与百度无关。用的是百度网盘开放平台的公开接口，接口行为可能随时调整；
账号被封禁、数据丢失等风险请自负，重要数据请保持本地备份。个人限时体验密钥由百度提供与更换，与本项目无关。

## English quickstart

```bash
git clone https://github.com/amaillabiffar433-wq/baidu-pan-toolkit.git && cd baidu-pan-toolkit
baidu-pan login --token <your baidu access_token>
baidu-pan upload ./report.pdf --to /papers
baidu-pan download /papers/report.pdf --to ./downloads
node src/mcp.mjs      # stdio MCP server, 14 tools
```

Zero dependencies: Node 18+ built-ins plus the system `curl`. MIT licensed.

## License

MIT © Exmling
