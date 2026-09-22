/**
 * End-to-end smoke test against a running SiYuan kernel.
 *
 * Spawns the built CLI as a real child process, speaks MCP over stdio, and
 * exercises the read tools plus a full create → read → update → delete
 * document round trip. Skipped automatically when no kernel is reachable, so
 * it stays safe in CI.
 *
 * Run with: npx vitest run tests/e2e.spec.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(here, '..', 'lib', 'cli.js')
const BASE_URL = process.env.SIYUAN_API_URL ?? 'http://127.0.0.1:6806'

async function kernelReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/system/version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { code?: number }
    return body.code === 0
  } catch {
    return false
  }
}

const reachable = await kernelReachable()

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.map((part) => part.text ?? '').join('\n')
}

/**
 * Poll until `probe` sees the expected value.
 *
 * SiYuan's SQL index and full-text index are updated asynchronously after a
 * write (measured ~2s on 3.8.4), so index-backed reads are eventually
 * consistent. Polling here keeps the test honest about that property instead
 * of asserting on something the kernel does not promise.
 */
async function waitFor(probe: () => Promise<string>, expected: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    last = await probe()
    if (last.includes(expected)) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)}. Last value:\n${last}`)
}

describe.skipIf(!reachable)('end-to-end against a live SiYuan kernel', () => {
  let client: Client
  let transport: StdioClientTransport
  let notebookId: string
  const createdDocs: string[] = []
  const testPath = `/siyuan-mcp-e2e-${Date.now()}`

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI],
      env: { ...process.env, SIYUAN_API_URL: BASE_URL } as Record<string, string>,
      stderr: 'pipe',
    })
    client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(transport)

    const notebooks = textOf(await client.callTool({ name: 'list_notebooks', arguments: {} }))
    const match = /\(id: ([^)]+)\)/.exec(notebooks)
    expect(match, `no notebook found in: ${notebooks}`).toBeTruthy()
    notebookId = match![1]!
  }, 30_000)

  afterAll(async () => {
    // Clean up anything the test created.
    for (const doc of createdDocs) {
      try {
        await client.callTool({ name: 'remove_document', arguments: { doc } })
      } catch {
        // Best effort.
      }
    }
    await client?.close()
  }, 30_000)

  it('lists the expected tools over a real stdio handshake', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).toContain('search_notes')
    expect(names).toContain('create_document')
    expect(names).toHaveLength(13)
  })

  it('runs a read-only SQL query against the real index', async () => {
    const out = textOf(
      await client.callTool({
        name: 'sql_query',
        arguments: { stmt: 'SELECT COUNT(*) AS c FROM blocks' },
      }),
    )
    expect(out).toMatch(/row\(s\)/)
    expect(out).toMatch(/"c":\s*\d+/)
  })

  it('refuses a write through sql_query, leaving the index intact', async () => {
    const before = textOf(
      await client.callTool({ name: 'sql_query', arguments: { stmt: 'SELECT COUNT(*) AS c FROM blocks' } }),
    )
    const refused = await client.callTool({
      name: 'sql_query',
      arguments: { stmt: 'DELETE FROM blocks' },
    })
    expect(refused.isError).toBe(true)
    const after = textOf(
      await client.callTool({ name: 'sql_query', arguments: { stmt: 'SELECT COUNT(*) AS c FROM blocks' } }),
    )
    expect(after).toBe(before)
  })

  it('completes a create → read → search → update → delete round trip', async () => {
    // Create.
    const created = textOf(
      await client.callTool({
        name: 'create_document',
        arguments: {
          notebook: notebookId,
          path: testPath,
          markdown: '# E2E heading\n\noriginal body text\n',
        },
      }),
    )
    const docId = /document (\d{14}-[0-9a-z]{7})/.exec(created)?.[1]
    expect(docId, `could not parse doc id from: ${created}`).toBeTruthy()
    createdDocs.push(docId!)

    // Read it back by path. Resolution goes through the document tree API,
    // which (unlike the SQL index) sees a new document immediately.
    const read = textOf(await client.callTool({ name: 'get_document', arguments: { doc: testPath } }))
    expect(read).toContain('original body text')

    // Find it through full-text search. The FTS index is updated
    // asynchronously, so allow it a moment to catch up.
    await waitFor(
      () => client.callTool({ name: 'search_notes', arguments: { query: 'original body text' } }).then(textOf),
      docId!,
    )

    // Append a block and confirm it lands (kramdown reads are immediate).
    const inserted = await client.callTool({
      name: 'insert_block',
      arguments: { parent_id: docId!, data: 'appended via e2e' },
    })
    expect(inserted.isError, textOf(inserted)).toBeFalsy()

    await waitFor(
      () => client.callTool({ name: 'get_document', arguments: { doc: docId! } }).then(textOf),
      'appended via e2e',
    )

    // Rename, then verify the new title is visible once the index catches up.
    await client.callTool({ name: 'rename_document', arguments: { doc: docId!, title: 'siyuan-mcp e2e renamed' } })
    await waitFor(
      () =>
        client
          .callTool({ name: 'list_documents', arguments: { notebook: notebookId, limit: 100 } })
          .then(textOf),
      'siyuan-mcp e2e renamed',
    )

    // Delete and confirm it is gone.
    await client.callTool({ name: 'remove_document', arguments: { doc: docId! } })
    await waitFor(
      () =>
        client
          .callTool({ name: 'sql_query', arguments: { stmt: `SELECT id FROM blocks WHERE id = '${docId}'` } })
          .then(textOf),
      'no rows',
    )
  }, 120_000)

  it('reports a helpful error for an unknown document', async () => {
    const result = await client.callTool({
      name: 'get_document',
      arguments: { doc: '/definitely/not/a/real/doc-xyz' },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/No document found/)
  })
})
