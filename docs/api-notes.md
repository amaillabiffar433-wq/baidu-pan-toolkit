# 接口笔记

这些是开发时逐条验证出来的行为，写下来免得后来的人（包括我自己）再踩一遍。
验证时间：2026 年 10 月，百度网盘开放平台个人体验密钥。

## 端点清单

| 用途 | 方法与端点 | 备注 |
| --- | --- | --- |
| 账号信息 | `GET /rest/2.0/xpan/nas?method=uinfo` | 返回 `baidu_name` / `uk` / `vip_type` |
| 容量 | `GET /api/quota?checkfree=1&checkexpire=1` | `total` / `used` / `free`，单位字节 |
| 列目录 | `GET /rest/2.0/xpan/multimedia?method=listall&path=&recursion=0&limit=&order=name` | 带 `cursor` / `has_more` |
| 文件详情 | `GET /rest/2.0/xpan/multimedia?method=filemetas&fsids=[id]&dlink=1` | `dlink` 需再追加 token |
| 搜索 | `GET /rest/2.0/xpan/file?method=search&key=&dir=&recursion=1` | |
| 新建目录/文件 | `POST /rest/2.0/xpan/file?method=create` | 参数要放**表单体** |
| 预上传 | `POST /rest/2.0/xpan/file?method=precreate` | 见下方必填参数 |
| 分片上传 | `POST /rest/2.0/pcs/superfile2?method=upload&type=tmpfile` | multipart，字段名 `file` |
| 合并 | `POST /rest/2.0/xpan/file?method=create`（带 uploadid + block_list） | |
| 文件管理 | `POST /rest/2.0/xpan/file?method=move\|copy\|rename\|delete` | `filelist` 传 JSON |
| 分享 | `GET /rest/2.0/xpan/share?method=set&period=&channel=0&fsid_list=[id]` | |

所有请求都建议带 `User-Agent: pan.baidu.com`。

## 实测坑位

### 1. HTTP 客户端

- Node `fetch`（undici）打 `pan.baidu.com` 会炸：
  `TypeError: terminated`，`cause: Error: incorrect header check`。
  根因是响应头写 `Content-Encoding: gzip`，正文却是明文。
- 有些端点（如 `xpan/file?method=listall`）会 302 到 `403.html`，
  拿到的是 HTML 而不是 JSON，错误信息是 `{"error_code":31064,"error_msg":"file is not authorized"}`。
- 结论：统一用 `curl -sS -A pan.baidu.com` 收字节流，需要 JSON 时自己 parse。

### 2. 下载直链

```bash
# filemetas 返回的 dlink 直接请求 → 403
curl -sS "https://d.pcs.baidu.com/file/xxxx?fid=..." 
# {"error_code":31045,"error_msg":"user not exists"}

# 追加 access_token → 200
curl -L -A pan.baidu.com "https://d.pcs.baidu.com/file/xxxx?fid=...&access_token=<TOKEN>"
```

下载请求建议带 `-e https://pan.baidu.com/`（Referer）与 `-L`。

### 3. 分片上传参数矩阵

| 组合 | 结果 |
| --- | --- |
| 缺 `autoinit=1` | 不返回 `uploadid` |
| 缺 `block_list` | `errno=2` 参数错误 |
| `block_list` 非 JSON 数组 | `errno=2` |
| 分片大小 > 4MB | 失败；4MB 稳定 |
| 分片响应无 `errno` | **成功**（只有 `md5` / `request_id`），别当失败 |
| `pcs/file?method=upload`（旧端点） | 一律 `31064 file is not authorized`，别用 |

`precreate` 完整参数：

```
method=precreate
access_token=<TOKEN>
path=/目标/文件.zip
size=<字节>
isdir=0
rtype=3
autoinit=1
block_list=["分片1的md5","分片2的md5",...]
```

命中秒传时响应里有 `rapid_upload: 1`，不用再传分片。

### 4. 官方 MCP 的短板

官方 `mcp-pan.baidu.com`（SSE，`/sse?access_token=...`，16 个工具）没有：

- 本地文件上传 → `file_upload_by_url` 只认公网 URL，`http://127.0.0.1:...` 返回
  `errno=1003 上传文件失败`
- 下载、删除

`file_upload_by_content` 实测会**忽略传入的 path**，文件落在 `/来自：mcp_server/hello.txt`。

### 5. 删除 `/apps/...`

`file?method=delete` 对应用目录（`/apps/<appname>/...`）稳定返回 `31023 参数错误`；
对普通目录正常。需要清理应用目录时用网盘客户端或网页端。

### 6. errno 速查

```
0       成功
-6 / 111   token 无效
-7 / 112   token 过期
-8 / 31061 条目已存在
-9 / 31066 文件不存在
2 / 31023  参数错误
31045    请求里没带 access_token
31064    未授权 / 文件不可用
31200    空间不足
31326    文件校验失败
31345    上传参数错误
31355    分片上传失败
1003     上传失败（服务端取不到文件）
```

## 时间戳口径

`listall` 返回的 `server_mtime` / `local_mtime` 是 **Unix 秒**；
分片上传成功响应里的 `mtime` 是毫秒。别混。
