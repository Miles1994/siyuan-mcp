import { describe, expect, it } from 'vitest'
import {
  SiYuanApiError,
  SiYuanClient,
  SiYuanConnectionError,
  bindParams,
  isBlockId,
  sqlLiteral,
} from '../src/siyuan.js'

/** Build a client whose fetch is stubbed by `handler`. */
function clientWith(
  handler: (endpoint: string, body: Record<string, unknown>) => unknown,
  options = {},
) {
  const calls: Array<{ endpoint: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const client = new SiYuanClient({
    baseUrl: 'http://127.0.0.1:6806',
    ...options,
    fetch: (async (url: string | URL, init: RequestInit) => {
      const endpoint = String(url).replace('http://127.0.0.1:6806', '')
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      calls.push({ endpoint, body, headers: init.headers as Record<string, string> })
      const result = handler(endpoint, body)
      if (result instanceof Error) throw result
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof globalThis.fetch,
  })
  return { client, calls }
}

const ok = (data: unknown) => ({ code: 0, msg: '', data })

describe('isBlockId', () => {
  it('accepts kernel-shaped IDs', () => {
    expect(isBlockId('20260101000001-hijklmn')).toBe(true)
    expect(isBlockId('  20210817205410-2kvfpfn ')).toBe(true)
  })

  it('rejects paths and free text', () => {
    expect(isBlockId('/Notes/My doc')).toBe(false)
    expect(isBlockId('My doc')).toBe(false)
    expect(isBlockId('20260101000001')).toBe(false)
  })
})

describe('sqlLiteral / bindParams', () => {
  it('escapes single quotes by doubling them', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
    expect(sqlLiteral("'; DROP TABLE blocks; --")).toBe("'''; DROP TABLE blocks; --'")
  })

  it('renders non-string literals', () => {
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral(true)).toBe('1')
    expect(sqlLiteral(null)).toBe('NULL')
  })

  it('substitutes placeholders positionally', () => {
    expect(bindParams('SELECT 1 WHERE a = ? AND b = ?', ["x'y", 2])).toBe(
      "SELECT 1 WHERE a = 'x''y' AND b = 2",
    )
  })

  it('leaves statements without placeholders untouched', () => {
    const stmt = "SELECT * FROM blocks WHERE type = 'd'"
    expect(bindParams(stmt, [])).toBe(stmt)
  })

  it('rejects a placeholder/parameter count mismatch', () => {
    expect(() => bindParams('SELECT ?, ?', [1])).toThrow(/Not enough parameters/)
    expect(() => bindParams('SELECT ?', [1, 2])).toThrow(/Unused SQL parameters/)
  })
})

describe('SiYuanClient.request', () => {
  it('posts JSON to the endpoint and unwraps data', async () => {
    const { client, calls } = clientWith(() => ok({ notebooks: [] }))
    await client.call('/api/notebook/lsNotebooks')
    expect(calls[0]!.endpoint).toBe('/api/notebook/lsNotebooks')
    expect(calls[0]!.headers['Content-Type']).toBe('application/json')
  })

  it('sends the token header only when configured', async () => {
    const without = clientWith(() => ok(null))
    await without.client.call('/api/system/version')
    expect(without.calls[0]!.headers.Authorization).toBeUndefined()

    const withToken = clientWith(() => ok(null), { token: 'secret' })
    await withToken.client.call('/api/system/version')
    expect(withToken.calls[0]!.headers.Authorization).toBe('Token secret')
  })

  it('maps a non-zero code to SiYuanApiError carrying the kernel message', async () => {
    const { client } = clientWith(() => ({ code: 1, msg: 'no such table: nowhere', data: null }))
    await expect(client.call('/api/query/sql')).rejects.toThrowError(SiYuanApiError)
    await expect(client.call('/api/query/sql')).rejects.toThrow(/no such table: nowhere/)
  })

  it('maps a transport failure to SiYuanConnectionError with remediation advice', async () => {
    const { client } = clientWith(() => new Error('ECONNREFUSED'))
    await expect(client.call('/api/system/version')).rejects.toThrowError(SiYuanConnectionError)
    await expect(client.call('/api/system/version')).rejects.toThrow(/Make sure SiYuan is running/)
  })

  it('rejects a non-JSON body', async () => {
    const client = new SiYuanClient({
      fetch: (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof globalThis.fetch,
    })
    await expect(client.call('/api/system/version')).rejects.toThrow(/non-JSON/)
  })

  it('rejects a non-200 response', async () => {
    const client = new SiYuanClient({
      fetch: (async () => new Response('denied', { status: 403, statusText: 'Forbidden' })) as unknown as typeof globalThis.fetch,
    })
    await expect(client.call('/api/system/version')).rejects.toThrow(/HTTP 403/)
  })
})

describe('SiYuanClient.resolveNotebook', () => {
  const notebooks = ok({
    notebooks: [
      { id: '20260101000000-abcdefg', name: '示例笔记本' },
      { id: '20260101000000-aaaaaaa', name: 'Notes' },
      { id: '20260101000000-bbbbbbb', name: 'notes' },
    ],
  })

  it('resolves by exact ID', async () => {
    const { client } = clientWith(() => notebooks)
    expect((await client.resolveNotebook('20260101000000-abcdefg')).name).toBe('示例笔记本')
  })

  it('resolves by exact name', async () => {
    const { client } = clientWith(() => notebooks)
    expect((await client.resolveNotebook('示例笔记本')).id).toBe('20260101000000-abcdefg')
  })

  it('falls back to a case-insensitive match when unambiguous', async () => {
    const { client } = clientWith(() =>
      ok({ notebooks: [{ id: '20260101000000-aaaaaaa', name: 'Notes' }] }),
    )
    expect((await client.resolveNotebook('notes')).id).toBe('20260101000000-aaaaaaa')
  })

  it('reports ambiguity rather than guessing', async () => {
    const { client } = clientWith(() => notebooks)
    await expect(client.resolveNotebook('Notes')).resolves.toBeDefined()
    // "notes" matches two notebooks case-insensitively.
    await expect(client.resolveNotebook('NOTES')).rejects.toThrow(/ambiguous/)
  })

  it('lists known notebooks when nothing matches', async () => {
    const { client } = clientWith(() => notebooks)
    await expect(client.resolveNotebook('missing')).rejects.toThrow(/Known notebooks: .*示例笔记本/)
  })
})

describe('SiYuanClient.resolveDocId', () => {
  it('passes block IDs through without querying', async () => {
    const { client, calls } = clientWith(() => ok([]))
    expect(await client.resolveDocId('20260101000001-hijklmn')).toBe('20260101000001-hijklmn')
    expect(calls).toHaveLength(0)
  })

  it('resolves an hpath through the document tree API first', async () => {
    const { client, calls } = clientWith((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') {
        return ok({ notebooks: [{ id: 'nb1', name: 'N' }] })
      }
      if (endpoint === '/api/filetree/getIDsByHPath') return ok(['20260101000001-hijklmn'])
      throw new Error(`unexpected ${endpoint}`)
    })
    expect(await client.resolveDocId('/示例文档')).toBe('20260101000001-hijklmn')
    // The tree API answered, so the lagging SQL index was never consulted.
    expect(calls.map((call) => call.endpoint)).toEqual([
      '/api/notebook/lsNotebooks',
      '/api/filetree/getIDsByHPath',
    ])
    expect(calls[1]!.body).toEqual({ path: '/示例文档', notebook: 'nb1' })
  })

  it('falls back to SQL when the tree API finds nothing', async () => {
    const { client, calls } = clientWith((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') return ok({ notebooks: [{ id: 'nb1', name: 'N' }] })
      if (endpoint === '/api/filetree/getIDsByHPath') return ok([])
      if (endpoint === '/api/query/sql') return ok([{ id: '20260101000001-hijklmn', hpath: '/示例文档' }])
      throw new Error(`unexpected ${endpoint}`)
    })
    expect(await client.resolveDocId('/示例文档')).toBe('20260101000001-hijklmn')
    const sqlCall = calls.find((call) => call.endpoint === '/api/query/sql')
    expect(String(sqlCall!.body.stmt)).toContain("hpath = '/示例文档'")
  })

  it('adds a leading slash to a bare path', async () => {
    const { client, calls } = clientWith((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') return ok({ notebooks: [{ id: 'nb1', name: 'N' }] })
      if (endpoint === '/api/filetree/getIDsByHPath') return ok([])
      return ok([{ id: '20260101000001-hijklmn', hpath: '/Notes' }])
    })
    await client.resolveDocId('Notes')
    const treeCall = calls.find((call) => call.endpoint === '/api/filetree/getIDsByHPath')
    expect(treeCall!.body.path).toBe('/Notes')
  })

  it('survives a notebook that cannot answer the path lookup', async () => {
    const { client } = clientWith((endpoint, body) => {
      if (endpoint === '/api/notebook/lsNotebooks') {
        return ok({ notebooks: [{ id: 'closed', name: 'Closed' }, { id: 'open', name: 'Open' }] })
      }
      if (endpoint === '/api/filetree/getIDsByHPath') {
        if (body.notebook === 'closed') return { code: 1, msg: 'notebook is closed', data: null }
        return ok(['20260101000001-hijklmn'])
      }
      throw new Error(`unexpected ${endpoint}`)
    })
    expect(await client.resolveDocId('/Doc')).toBe('20260101000001-hijklmn')
  })

  it('errors with guidance when nothing matches', async () => {
    const { client } = clientWith((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') return ok({ notebooks: [{ id: 'nb1', name: 'N' }] })
      if (endpoint === '/api/filetree/getIDsByHPath') return ok([])
      return ok([])
    })
    await expect(client.resolveDocId('/nope')).rejects.toThrow(/No document found/)
  })

  it('errors when a path matches several documents', async () => {
    const { client } = clientWith((endpoint) => {
      if (endpoint === '/api/notebook/lsNotebooks') return ok({ notebooks: [{ id: 'nb1', name: 'N' }] })
      if (endpoint === '/api/filetree/getIDsByHPath') {
        return ok(['20260101000001-hijklmn', '20260101000002-opqrstu'])
      }
      return ok([])
    })
    await expect(client.resolveDocId('/Dup')).rejects.toThrow(/matches multiple documents/)
  })
})
