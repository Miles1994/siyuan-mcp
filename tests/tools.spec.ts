import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/index.js'
import { SiYuanClient } from '../src/siyuan.js'

/**
 * Drive the real MCP server over an in-memory transport, with a stubbed
 * kernel. This is what verifies the tool surface end to end — registration,
 * schemas, argument passing, formatting and error mapping — without needing a
 * running SiYuan.
 */
async function connect(handler: (endpoint: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = []
  const client = new SiYuanClient({
    fetch: (async (url: string | URL, init: RequestInit) => {
      const endpoint = String(url).replace('http://127.0.0.1:6806', '')
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ endpoint, body })
      const payload = handler(endpoint, body)
      return new Response(JSON.stringify({ code: 0, msg: '', data: payload }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch,
  })

  const server = createServer({ client })
  const mcp = new Client({ name: 'test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)])
  return { mcp, calls }
}

/** Read the text of a tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
  return content.map((part) => part.text ?? '').join('\n')
}

const DOC_ID = '20260101000001-hijklmn'

describe('tool surface', () => {
  it('advertises the core read/write tools', async () => {
    const { mcp } = await connect(() => null)
    const names = (await mcp.listTools()).tools.map((tool) => tool.name).sort()
    expect(names).toEqual([
      'create_document',
      'delete_block',
      'get_block',
      'get_document',
      'insert_block',
      'list_documents',
      'list_notebooks',
      'move_document',
      'remove_document',
      'rename_document',
      'search_notes',
      'sql_query',
      'update_block',
    ])
    await mcp.close()
  })

  it('every tool has a description and an object input schema', async () => {
    const { mcp } = await connect(() => null)
    for (const tool of (await mcp.listTools()).tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy()
      expect(tool.inputSchema.type, `${tool.name} schema`).toBe('object')
    }
    await mcp.close()
  })

  it('list_notebooks renders names, ids and state', async () => {
    const { mcp } = await connect(() => ({
      notebooks: [
        { id: '20260101000000-abcdefg', name: '示例笔记本' },
        { id: '20260101000000-aaaaaaa', name: 'Archive', closed: true, encrypted: true },
      ],
    }))
    const out = textOf(await mcp.callTool({ name: 'list_notebooks', arguments: {} }))
    expect(out).toContain('示例笔记本 (id: 20260101000000-abcdefg) [open]')
    expect(out).toContain('Archive (id: 20260101000000-aaaaaaa) [closed, encrypted]')
    await mcp.close()
  })

  it('search_notes reports totals and strips highlight markup', async () => {
    const { mcp, calls } = await connect(() => ({
      blocks: [
        { id: DOC_ID, type: 'NodeDocument', hPath: '/示例文档', content: '<mark>示例</mark>文档' },
      ],
      matchedBlockCount: 1,
      pageCount: 1,
    }))
    const out = textOf(await mcp.callTool({ name: 'search_notes', arguments: { query: '0922' } }))
    expect(out).toContain('1 match(es), page 1/1')
    expect(out).toContain('[doc] 20260101000001-hijklmn')
    expect(out).toContain('示例文档')
    expect(out).not.toContain('<mark>')
    expect(calls[0]!.body).toMatchObject({ query: '0922', page: 1, pageSize: 10 })
    await mcp.close()
  })

  it('search_notes applies paging arguments', async () => {
    const { mcp, calls } = await connect(() => ({ blocks: [], matchedBlockCount: 0, pageCount: 0 }))
    await mcp.callTool({ name: 'search_notes', arguments: { query: 'x', page: 3, pageSize: 25 } })
    expect(calls[0]!.body).toMatchObject({ page: 3, pageSize: 25 })
    await mcp.close()
  })

  it('get_document resolves a path then exports Markdown', async () => {
    const { mcp, calls } = await connect((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') return { notebooks: [{ id: 'nb1', name: 'N' }] }
      if (endpoint === '/api/filetree/getIDsByHPath') return [DOC_ID]
      if (endpoint === '/api/export/exportMdContent') return { hPath: '/示例文档', content: '# Hi\n\nbody' }
      throw new Error(`unexpected ${endpoint}`)
    })
    const out = textOf(await mcp.callTool({ name: 'get_document', arguments: { doc: '/示例文档' } }))
    expect(out).toContain('# /示例文档')
    expect(out).toContain('# Hi')
    expect(calls.at(-1)!.body).toEqual({ id: DOC_ID })
    await mcp.close()
  })

  it('create_document resolves the notebook by name and normalises the path', async () => {
    const { mcp, calls } = await connect((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') {
        return { notebooks: [{ id: '20260101000000-abcdefg', name: '示例笔记本' }] }
      }
      if (endpoint === '/api/filetree/createDocWithMd') return '20260101000002-newdoc0'
      throw new Error(`unexpected ${endpoint}`)
    })
    const out = textOf(
      await mcp.callTool({
        name: 'create_document',
        arguments: { notebook: '示例笔记本', path: 'Notes/Idea', markdown: '# x' },
      }),
    )
    expect(out).toContain('20260101000002-newdoc0')
    expect(out).toContain('/Notes/Idea')
    expect(calls.at(-1)!.body).toMatchObject({
      notebook: '20260101000000-abcdefg',
      path: '/Notes/Idea',
      markdown: '# x',
    })
    await mcp.close()
  })

  it('insert_block appends when parent_id is given', async () => {
    const { mcp, calls } = await connect(() => [{ id: '20260101000002-newblk0' }])
    const out = textOf(
      await mcp.callTool({ name: 'insert_block', arguments: { data: 'hello', parent_id: DOC_ID } }),
    )
    expect(out).toContain('Inserted')
    expect(calls[0]!.endpoint).toBe('/api/block/appendBlock')
    expect(calls[0]!.body).toMatchObject({ dataType: 'markdown', data: 'hello', parentID: DOC_ID })
    await mcp.close()
  })

  it('insert_block inserts after a sibling when previous_id is given', async () => {
    const { mcp, calls } = await connect(() => [{ id: '20260101000002-newblk0' }])
    await mcp.callTool({ name: 'insert_block', arguments: { data: 'hello', previous_id: DOC_ID } })
    expect(calls[0]!.endpoint).toBe('/api/block/insertBlock')
    expect(calls[0]!.body).toMatchObject({ previousID: DOC_ID })
    await mcp.close()
  })

  it('insert_block refuses ambiguous or missing anchors', async () => {
    const { mcp } = await connect(() => [])
    const neither = await mcp.callTool({ name: 'insert_block', arguments: { data: 'x' } })
    expect(neither.isError).toBe(true)
    expect(textOf(neither)).toMatch(/exactly one of/)

    const both = await mcp.callTool({
      name: 'insert_block',
      arguments: { data: 'x', parent_id: DOC_ID, previous_id: DOC_ID },
    })
    expect(both.isError).toBe(true)
    await mcp.close()
  })

  it('update_block passes markdown and the lock flag', async () => {
    const { mcp, calls } = await connect(() => null)
    const out = textOf(
      await mcp.callTool({
        name: 'update_block',
        arguments: { id: DOC_ID, data: 'new', lock_type: true },
      }),
    )
    expect(out).toBe(`Updated block ${DOC_ID}.`)
    expect(calls[0]!.body).toMatchObject({ dataType: 'markdown', data: 'new', id: DOC_ID, lockType: true })
    await mcp.close()
  })

  it('delete_block and remove_document report success', async () => {
    const { mcp } = await connect(() => null)
    expect(textOf(await mcp.callTool({ name: 'delete_block', arguments: { id: DOC_ID } }))).toContain(
      `Deleted block ${DOC_ID}`,
    )
    expect(textOf(await mcp.callTool({ name: 'remove_document', arguments: { doc: DOC_ID } }))).toContain(
      'recoverable from 数据历史',
    )
    await mcp.close()
  })

  it('rename_document and move_document reach the ID-based endpoints', async () => {
    const { mcp, calls } = await connect(() => null)
    await mcp.callTool({ name: 'rename_document', arguments: { doc: DOC_ID, title: 'New' } })
    expect(calls.at(-1)!.endpoint).toBe('/api/filetree/renameDocByID')
    expect(calls.at(-1)!.body).toEqual({ id: DOC_ID, title: 'New' })

    await mcp.callTool({
      name: 'move_document',
      arguments: { doc: DOC_ID, to: '20260101000000-abcdefg' },
    })
    expect(calls.at(-1)!.endpoint).toBe('/api/filetree/moveDocsByID')
    await mcp.close()
  })

  it('move_document falls back to a notebook destination', async () => {
    const { mcp, calls } = await connect((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') {
        return { notebooks: [{ id: '20260101000000-abcdefg', name: '示例笔记本' }] }
      }
      // Path lookups find nothing, so `to` is retried as a notebook name.
      if (endpoint === '/api/filetree/getIDsByHPath') return []
      if (endpoint === '/api/query/sql') return []
      return null
    })
    await mcp.callTool({
      name: 'move_document',
      arguments: { doc: DOC_ID, to: '示例笔记本' },
    })
    expect(calls.at(-1)!.endpoint).toBe('/api/filetree/moveDocsByID')
    expect(calls.at(-1)!.body).toEqual({ fromIDs: [DOC_ID], toID: '20260101000000-abcdefg' })
    await mcp.close()
  })

  it('get_block returns kramdown by default and children on request', async () => {
    const { mcp, calls } = await connect((endpoint) => {
      if (endpoint === '/api/block/getBlockKramdown') return { id: DOC_ID, kramdown: 'plain text' }
      if (endpoint === '/api/block/getChildBlocks') {
        return [{ id: 'child1', type: 'p', content: 'child body' }]
      }
      return null
    })
    expect(textOf(await mcp.callTool({ name: 'get_block', arguments: { id: DOC_ID } }))).toBe('plain text')

    const children = textOf(
      await mcp.callTool({ name: 'get_block', arguments: { id: DOC_ID, format: 'children' } }),
    )
    expect(children).toContain('child1')
    expect(children).toContain('child body')
    expect(calls.at(-1)!.endpoint).toBe('/api/block/getChildBlocks')
    await mcp.close()
  })

  it('sql_query runs read-only SQL and pretty-prints rows', async () => {
    const { mcp, calls } = await connect(() => [{ c: 10 }])
    const out = textOf(await mcp.callTool({ name: 'sql_query', arguments: { stmt: 'SELECT COUNT(*) AS c FROM blocks' } }))
    expect(out).toContain('1 row(s)')
    expect(out).toContain('"c": 10')
    expect(calls[0]!.body.stmt).toBe('SELECT COUNT(*) AS c FROM blocks')
    await mcp.close()
  })

  it('sql_query refuses writes before they reach the kernel', async () => {
    const { mcp, calls } = await connect(() => [])
    const result = await mcp.callTool({ name: 'sql_query', arguments: { stmt: 'DELETE FROM blocks' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/read-only/)
    expect(calls).toHaveLength(0)
    await mcp.close()
  })

  it('surfaces a kernel error message to the model', async () => {
    const client = new SiYuanClient({
      fetch: (async () =>
        new Response(JSON.stringify({ code: 1, msg: 'no such table: nowhere', data: null }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    })
    const server = createServer({ client })
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([mcp.connect(ct), server.connect(st)])

    const result = await mcp.callTool({ name: 'sql_query', arguments: { stmt: 'SELECT * FROM nowhere' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no such table: nowhere')
    await mcp.close()
  })

  it('rejects invalid arguments at the schema boundary', async () => {
    const { mcp, calls } = await connect(() => [])
    // The SDK reports schema violations as error results, not thrown promises.
    const missing = await mcp.callTool({ name: 'search_notes', arguments: {} })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toMatch(/query/)

    const tooLarge = await mcp.callTool({ name: 'search_notes', arguments: { query: 'x', pageSize: 999 } })
    expect(tooLarge.isError).toBe(true)

    // Nothing invalid reached the kernel.
    expect(calls).toHaveLength(0)
    await mcp.close()
  })
})
