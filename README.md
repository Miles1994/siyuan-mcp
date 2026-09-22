# siyuan-note-mcp

把 [思源笔记](https://b3log.org/siyuan/)（SiYuan）接入任何 MCP 客户端——DeepSeek Harness、Claude Desktop、Cursor、Cline 等。装上后，你的 agent 就能直接**搜索、读取和写入**思源里的笔记本、文档与内容块。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node: 20%2B](https://img.shields.io/badge/Node-20%2B-339933.svg)](https://nodejs.org)

> **注意**：本项目尚未发布到 npm。下面的 `npx` 命令在发布后才可用；现在请用「[从源码安装](#从源码安装)」。
> 另外 npm 上已有一个同名的第三方包 `siyuan-mcp`（同名但不同代码），本项目的包名是 `siyuan-note-mcp`。

## 特性

- **13 个工具**覆盖日常读写：笔记本、文档、内容块、全文搜索、SQL 查询。
- **零配置起步** — 本地思源默认地址 `http://127.0.0.1:6806`，开箱即用。
- **按 ID 或路径寻址** — 文档既可用 ID，也可用 `/笔记/我的文档` 这样的人类可读路径。
- **只读 SQL 保护** — `sql_query` 只放行 `SELECT`/`WITH`/`EXPLAIN`，写操作被本地拦截。
- **错误可自愈** — 内核报错原文回传给模型，附带修正建议。

## 快速开始

前提：Node.js ≥ 20，且思源笔记正在运行。

### 从源码安装（当前可用）

```bash
git clone https://github.com/Miles1994/siyuan-mcp.git && cd siyuan-mcp
npm install
npm run build
```

然后把下面的配置加进你的 MCP 客户端（把路径换成你的实际路径）：

```jsonc
{
  "mcpServers": {
    "siyuan": {
      "command": "node",
      "args": ["D:/Project/MCP/siyuan-mcp/lib/cli.js"]
    }
  }
}
```

### 通过 npm（发布后可用）

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

### 连接远程或带鉴权的内核

本地思源默认不需要 token。如果思源跑在别的机器/端口上，或内核开启了鉴权，加环境变量：

```jsonc
{
  "mcpServers": {
    "siyuan": {
      "command": "node",
      "args": ["D:/Project/MCP/siyuan-mcp/lib/cli.js"],
      "env": {
        "SIYUAN_API_URL": "http://192.168.1.5:6806",
        "SIYUAN_TOKEN": "你的 API token"
      }
    }
  }
}
```

API token 在思源的 **设置 → 关于** 里查看。

### DeepSeek Harness (DSH)

DSH 通过 [`@deepseek-ai/dsh-mcp-client`](https://www.npmjs.com/package/@deepseek-ai/dsh-mcp-client) 挂载外部服务器，配置写在 profile 的 `~/.dsh/profiles/<profile>/cordis.patch.yml`。

**如果你装了 [`dsh-skill-mcp-panel`](https://www.npmjs.com/package/dsh-skill-mcp-panel)**，该文件中的 MCP 区块由它托管，**不要手改区块内内容**（会被覆盖）。用它的 CLI：

```bash
dsh-panel mcp add --name siyuan --stdio --command node \
  --args "D:/Project/MCP/siyuan-mcp/lib/cli.js" \
  --env "SIYUAN_API_URL=http://127.0.0.1:6806" \
  --profile web

dsh-panel mcp test siyuan --profile web     # 验证连通性
dsh-panel mcp list --profile web            # 查看启用状态
```

**否则**手动把下面这段插进 `cordis.patch.yml`（顶层是一个数组）：

```yaml
- insert:
    - id: mcp-siyuan
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: siyuan        # 工具会以 mcp__siyuan__<tool> 暴露
        transport: stdio
        command: node
        args:
          - D:/Project/MCP/siyuan-mcp/lib/cli.js   # 不要加引号，args 按字面传递
        env:
          SIYUAN_API_URL: http://127.0.0.1:6806
          # SIYUAN_TOKEN: 你的 API token
        cwd: ""
```

改完重启 DSH 生效。工具会以 `mcp__siyuan__search_notes`、`mcp__siyuan__get_document` 这样的名字出现。

> 注意 `args` 里的路径**不要加引号**。stdio 传输直接传数组、不经过 shell，写成 `'"D:/..."'` 会把引号当成文件名的一部分，spawn 时报 ENOENT。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SIYUAN_API_URL` | `http://127.0.0.1:6806` | 思源内核地址。别名：`SIYUAN_BASE_URL` |
| `SIYUAN_TOKEN` | 无 | API token，仅在开启鉴权时需要 |
| `SIYUAN_TIMEOUT_MS` | `30000` | 单次请求超时（毫秒） |

## 工具一览

### 发现

| 工具 | 作用 |
| --- | --- |
| `list_notebooks` | 列出所有笔记本及 ID、开关状态。需要笔记本 ID 时先调它 |
| `search_notes` | 全文搜索，返回块 ID 与文档路径。支持 `foo bar`(AND)、`"精确短语"`、`OR`、`-排除`、`*` 通配 |
| `list_documents` | 按最近更新列出文档，可按笔记本过滤 |
| `get_document` | 读取文档全文（Markdown）。接受文档 ID 或 `/路径/文档名` |
| `get_block` | 读取单个块：`kramdown` 源码，或 `children` 子块列表 |

### 写入

| 工具 | 作用 |
| --- | --- |
| `create_document` | 用 Markdown 创建文档，父文档不存在会自动创建 |
| `insert_block` | 追加/插入内容块到指定父块或某个块之后 |
| `update_block` | 替换某个块的内容 |
| `delete_block` | 删除块（连同子块） |
| `rename_document` | 重命名文档 |
| `move_document` | 移动文档到别的父文档或笔记本 |
| `remove_document` | 删除文档（进回收站，可从「数据历史」恢复） |

### 高级

| 工具 | 作用 |
| --- | --- |
| `sql_query` | 对思源索引执行**只读** SQL。主表 `blocks`：`id, parent_id, root_id, box, path, hpath, type, subtype, content, tag, ial, created, updated` |

## 设计说明

### 为什么 `sql_query` 只能读

思源的 `/api/query/sql` 虽然文档上叫查询接口，但内核实际**允许**通过它执行写入。实测 3.8.4：`DELETE FROM blocks WHERE 1=0` 会正常返回 `code: 0`。

如果原样暴露，模型就能绕过所有块级写工具直接改索引。因此本项目在本地用词法分析（而不是简单的关键字正则）拦截写操作：注释和字符串字面量里的关键字会被忽略，所以 `WHERE content = 'please delete this'` 能过，而 `SELECT 1; DROP TABLE blocks` 会被拒。

### 关于索引延迟

思源的 SQL 索引和全文索引是**异步更新**的，实测写入后约 2 秒才可见。而文档路径解析走的是文档树接口（`getIDsByHPath`），**立即**可见。所以：

- 刚创建的文档，用**路径或 ID** 读取立刻可用；
- 但 `list_documents`、`search_notes`、`sql_query` 这类走索引的结果，可能要等一两秒。

这不是 bug，是内核的最终一致性设计。测试里对应的处理见 `tests/e2e.spec.ts` 的 `waitFor`。

### 为什么不需要 token

思源默认只监听 `127.0.0.1` 且不校验 token。把内核暴露到局域网时请**务必**在设置里开启鉴权并配置 `SIYUAN_TOKEN`。

## 开发

```bash
npm install
npm run build      # 构建到 lib/
npm test           # 单元测试
npm run typecheck  # 类型检查
```

端到端测试会直接连你本机的思源，**创建并删除**一个临时文档；检测不到内核时自动跳过：

```bash
npx vitest run tests/e2e.spec.ts
```

## 许可

MIT
