/**
 * Server construction and the public embedding API.
 *
 * @module siyuan-mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SiYuanClient, type SiYuanClientOptions } from './siyuan.js'
import { registerTools } from './tools.js'
import { loadConfig, toClientOptions, type SiYuanConfig } from './config.js'

export { SiYuanClient, SiYuanApiError, SiYuanConnectionError, isBlockId } from './siyuan.js'
export type { Block, BlockRow, Notebook, SiYuanClientOptions } from './siyuan.js'
export { loadConfig } from './config.js'
export type { SiYuanConfig } from './config.js'
export { registerTools } from './tools.js'
export { assertReadOnlySql, UnsafeSqlError } from './sql-guard.js'

/** Name the server reports during MCP initialisation. */
export const SERVER_NAME = 'siyuan'

/** Version reported during MCP initialisation. */
export const SERVER_VERSION = '0.1.0'

export interface CreateServerOptions {
  /** A pre-built client. When omitted, one is derived from `config`/`env`. */
  client?: SiYuanClient
  /** Configuration; defaults to {@link loadConfig} over `process.env`. */
  config?: SiYuanConfig
  /** Environment used when neither `client` nor `config` is given. */
  env?: NodeJS.ProcessEnv
  /** Extra client options merged over the resolved configuration. */
  clientOptions?: SiYuanClientOptions
}

/**
 * Build an MCP server exposing the SiYuan tools.
 *
 * The returned server is not connected; call `server.connect(transport)` (see
 * {@link runStdio}) or pass it to a test transport.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

  const client =
    options.client ??
    new SiYuanClient({
      ...toClientOptions(options.config ?? loadConfig(options.env)),
      ...options.clientOptions,
    })

  registerTools(server, { client })
  return server
}

/**
 * Connect a server to stdio and serve until the transport closes.
 *
 * stdout carries the MCP protocol, so nothing may be logged there; diagnostics
 * belong on stderr.
 */
export async function runStdio(options: CreateServerOptions = {}): Promise<void> {
  const server = createServer(options)
  await server.connect(new StdioServerTransport())
}
