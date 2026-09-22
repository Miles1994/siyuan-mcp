#!/usr/bin/env node
/**
 * Executable entry point: serves the SiYuan MCP tools over stdio.
 *
 * All logging goes to stderr because stdout is the MCP channel.
 */
import { runStdio } from './index.js'
import { loadConfig } from './config.js'

async function main(): Promise<void> {
  const config = loadConfig()
  // A friendly startup line helps humans debugging an MCP client config.
  process.stderr.write(
    `siyuan-mcp: connecting to ${config.baseUrl}` +
      `${config.token ? ' (token auth enabled)' : ' (no token)'}\n`,
  )
  await runStdio({ config })
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`siyuan-mcp: fatal: ${message}\n`)
  process.exit(1)
})
