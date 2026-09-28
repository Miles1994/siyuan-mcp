# siyuan-note-mcp

把 [思源笔记](https://b3log.org/siyuan/)（SiYuan）接入任何 MCP 客户端——Claude Desktop、Cursor、Cline、DeepSeek Harness 等。装上后，你的 agent 就能直接**搜索、读取和写入**思源里的笔记本、文档与内容块。

[![npm version](https://img.shields.io/npm/v/siyuan-note-mcp?color=cb3837&logo=npm&label=npm)](https://www.npmjs.com/package/siyuan-note-mcp) [![npm downloads](https://img.shields.io/npm/dm/siyuan-note-mcp?color=cb3837&label=downloads)](https://www.npmjs.com/package/siyuan-note-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 20%2B](https://img.shields.io/badge/Node-20%2B-339933.svg)](https://nodejs.org)

## 特性

- **13 个工具**覆盖日常读写：笔记本、文档、内容块、全文搜索、SQL 查询
- **零配置起步** — 默认连本机 `http://127.0.0.1:6806`，本地思源免 token
- **按 ID 或路径寻址** — 文档既可用 ID，也可用 `/笔记/我的文档` 这样的人类可读路径
- **只读 SQL 保护** — `sql_query` 只放行 `SELECT`/`WITH`/`EXPLAIN`
- **错误可自愈** — 内核报错原文回传给模型，附带修正建议

## 安装

需要 Node.js ≥ 20，且思源笔记正在运行。

免安装，用 `npx` 直接跑：

```bash
npx -y siyuan-note-mcp
```

或全局安装：

```bash
npm install -g siyuan-note-mcp
siyuan-note-mcp
```

> **注意**：npm 上已有的 `siyuan-mcp` 是**另一个项目**，本包名是 `siyuan-note-mcp`。

开发或想改代码时，从源码构建：

```bash
git clone https://github.com/Miles1994/siyuan-mcp.git
cd siyuan-mcp
npm install && npm run build
```

> 从源码运行**必须执行 `npm run build`**——仓库不包含 `lib/` 构建产物，不构建就没有可运行的文件。（npm 上发布的包里已经带好了 `lib/`。）

## 客户端配置

### 推荐：npx 免安装

```jsonc
{
  "mcpServers": {
    "siyuan": {
      "command": "npx",
      "args": ["-y", "siyuan-note-mcp"]
    }
  }
}
```

连接远程或开启鉴权的内核时，再加环境变量：

```jsonc
{
  "mcpServers": {
    "siyuan": {
      "command": "npx",
      "args": ["-y", "siyuan-note-mcp"],
      "env": {
        "SIYUAN_API_URL": "http://192.168.1.5:6806",
        "SIYUAN_TOKEN": "你的 API token"
      }
    }
  }
}
```

### 从源码运行

把 `args` 换成你 clone 下来的实际路径（Windows 下用正斜杠 `/`）：

```jsonc
{
  "mcpServers": {
    "siyuan": {
      "command": "node",
      "args": ["/path/to/siyuan-mcp/lib/cli.js"]
    }
  }
}
```

API token 在思源的 **设置 → 关于** 里查看。

> **Windows 上用 npx 报 spawn ENOENT**：部分客户端不解析 `npx.cmd` 包装。把 `command` 改为 `cmd`、`args` 改为 `["/c", "npx", "-y", "siyuan-note-mcp"]` 即可。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SIYUAN_API_URL` | `http://127.0.0.1:6806` | 思源内核地址，别名 `SIYUAN_BASE_URL` |
| `SIYUAN_TOKEN` | 无 | API token，仅在开启鉴权时需要 |
| `SIYUAN_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |

思源默认只监听 `127.0.0.1` 且不校验 token。把内核暴露到局域网时请**务必**在设置里开启鉴权并配置 `SIYUAN_TOKEN`。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `list_notebooks` | 列出所有笔记本及 ID、开关状态。需要笔记本 ID 时先调它 |
| `search_notes` | 全文搜索，返回块 ID 与文档路径。支持 `foo bar`(AND)、`"精确短语"`、`OR`、`-排除`、`*` 通配 |
| `list_documents` | 按最近更新列出文档，可按笔记本过滤 |
| `get_document` | 读取文档全文（Markdown）。接受文档 ID 或 `/路径/文档名` |
| `get_block` | 读取单个块：`kramdown` 源码，或 `children` 子块列表 |
| `create_document` | 用 Markdown 创建文档，父文档不存在会自动创建 |
| `insert_block` | 追加/插入内容块到指定父块或某个块之后 |
| `update_block` | 替换某个块的内容 |
| `delete_block` | 删除块（连同子块） |
| `rename_document` | 重命名文档 |
| `move_document` | 移动文档到别的父文档或笔记本 |
| `remove_document` | 删除文档（进回收站，可从「数据历史」恢复） |
| `sql_query` | 对思源索引执行**只读** SQL。主表 `blocks`：`id, parent_id, root_id, box, path, hpath, type, subtype, content, tag, ial, created, updated` |

## 设计说明

### 为什么 `sql_query` 只能读

思源的 `/api/query/sql` 虽然文档上叫查询接口，但内核实际**允许**通过它执行写入——实测 3.8.4：`DELETE FROM blocks WHERE 1=0` 正常返回 `code: 0`。

原样暴露的话，模型就能绕过所有块级写工具直接改索引。因此本项目在本地拦截写操作，且用词法分析而非关键字正则：注释和字符串字面量里的关键字会被忽略，所以 `WHERE content = 'please delete this'` 能过，`SELECT 1; DROP TABLE blocks` 会被拒。

### 索引延迟

思源的 SQL 索引和全文索引是**异步更新**的，实测写入后约 2 秒才可见；而文档路径解析走文档树接口（`getIDsByHPath`），**立即**可见。所以：

- 刚创建的文档，用**路径或 ID** 读取立刻可用
- `list_documents`、`search_notes`、`sql_query` 这类走索引的结果，可能要等一两秒

这是内核的最终一致性设计，不是 bug。测试中的对应处理见 `tests/e2e.spec.ts` 的 `waitFor`。

## DeepSeek Harness (DSH)

DSH 通过 [`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client) 挂载外部服务器，配置在 `~/.dsh/profiles/<profile>/cordis.patch.yml`。

装了 [`dsh-skill-mcp-panel`](https://www.npmjs.com/package/dsh-skill-mcp-panel) 的话，该文件中的 MCP 区块由它托管，**不要手改区块内内容**（会被覆盖），改用它的 CLI：

```bash
dsh-panel mcp add --name siyuan --stdio --command npx \
  --args -y --args siyuan-note-mcp --profile web

dsh-panel mcp test siyuan --profile web     # 验证连通性
dsh-panel mcp list --profile web            # 查看启用状态
```

> `--args` 每次只吃一个值，多个参数要重复写；`mcp` 子命令必须显式给 `--profile`。

否则手动插入这段（`cordis.patch.yml` 顶层是一个数组）：

```yaml
- insert:
    - id: mcp-siyuan
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: siyuan
        transport: stdio
        command: npx
        args:
          - "-y"
          - siyuan-note-mcp
        env:
          SIYUAN_API_URL: http://127.0.0.1:6806
        cwd: ""
```

工具会以 `mcp__siyuan__search_notes`、`mcp__siyuan__get_document` 这样的名字出现。

> `args` 里的路径**不要加引号**。stdio 直接传参数数组、不经过 shell，写成 `'"/path/to/cli.js"'` 会把引号当成文件名的一部分，spawn 时报 ENOENT。

## 开发

```bash
npm run build      # 构建到 lib/
npm test           # 单元测试
npm run typecheck  # 类型检查
```

端到端测试会直接连你本机的思源，**创建并删除**一个临时文档；检测不到内核时自动跳过：

```bash
npx vitest run tests/e2e.spec.ts
```

## 发布（维护者）

`package.json` 里的 `publishConfig` 已把发布目标钉在 `registry.npmjs.org`——本机 npm 源即使配成镜像站也不会发错地方。

**npm 现在强制要求发布者启用 2FA**，账号没 2FA 时 `npm publish` 会直接 403：

```
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

注意：`npm login` 拿到的登录 token **不能**发布，必须走下面两条之一。

**A. 交互发布** — 在 https://www.npmjs.com/settings/~/tfa 启用 Authenticator app（TOTP），然后每次发布带上当次的验证码：

```bash
npm publish --otp=<6 位验证码>
```

**B. 自动化发布** — 在 https://www.npmjs.com/settings/~/tokens 建 Granular Access Token，权限给 `Read and write`，并**勾选 Bypass 2FA**，用环境变量传入（不要写进 `.npmrc` 提交）：

```bash
# macOS / Linux
NPM_TOKEN=npm_xxx npm publish "--//registry.npmjs.org/:_authToken=$NPM_TOKEN"
```

```powershell
# Windows PowerShell
$env:NPM_TOKEN = 'npm_xxx'
npm publish "--//registry.npmjs.org/:_authToken=$env:NPM_TOKEN"
```

完整流程：

```bash
npm test && npm run typecheck   # 先过测试
npm version patch               # 或 minor / major
npm publish --otp=<验证码>       # prepare 钩子会自动构建 lib/
```

发布前建议先 `npm pack --dry-run` 确认打包内容（应只有 `lib/`、`README.md`、`LICENSE`、`package.json`，共 8 个文件）。

> 长期建议迁到 [trusted publishing (OIDC)](https://docs.npmjs.com/trusted-publishers)：npm 计划从 2027 年 1 月起收紧 Bypass-2FA token 的直接发布能力。
> npm 页面上的 README 取自发布时的 tarball，改完 README 要发新版本才会同步。

## 许可

MIT
