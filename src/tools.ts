/**
 * The MCP tool surface.
 *
 * Tools are grouped by the SiYuan concept they act on and every tool returns
 * compact text so a model can read results without parsing JSON. Writes are
 * always addressed by an explicit ID that the model obtained from a read tool,
 * which keeps destructive operations deliberate rather than guessed.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { SiYuanClient, type Block, type BlockRow } from './siyuan.js'
import { formatBlocks, plainText, truncateLine } from './format.js'
import { assertReadOnlySql } from './sql-guard.js'

/** Present a value as MCP text content. */
function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] }
}

/** Present a failure as MCP text with `isError`, so the model can self-correct. */
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
}

/** Fields selected when summarising blocks, to keep SQL results readable. */
const SUMMARY_COLUMNS = 'id, type, hpath, box, content, updated'

/** Page size the kernel applies to unbounded queries. */
const SQL_ROW_CAP = 64

/** Run a tool body, converting thrown errors into MCP error results. */
async function run(body: () => Promise<string>) {
  try {
    return text(await body())
  } catch (error) {
    return failure(error)
  }
}

export interface ToolDependencies {
  client: SiYuanClient
}

/**
 * Register every tool on `server`.
 *
 * Split from server construction so tests can register the same surface
 * against an in-memory client.
 */
export function registerTools(server: McpServer, deps: ToolDependencies): void {
  const { client } = deps

  // ---------------------------------------------------------------- discovery

  server.registerTool(
    'list_notebooks',
    {
      title: 'List notebooks',
      description:
        'List every notebook (思源笔记本) in the workspace with its ID, name and open state. ' +
        'Call this first when you need a notebook ID for other tools.',
      inputSchema: {},
    },
    () =>
      run(async () => {
        const notebooks = await client.listNotebooks()
        if (notebooks.length === 0) return 'No notebooks found in this workspace.'
        return notebooks
          .map((notebook) => {
            const state = notebook.closed ? 'closed' : 'open'
            const lock = notebook.encrypted ? ', encrypted' : ''
            return `- ${notebook.name} (id: ${notebook.id}) [${state}${lock}]`
          })
          .join('\n')
      }),
  )

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Full-text search across the workspace and return matching blocks with their IDs and ' +
        'document paths. Use this to locate content before reading or editing it. ' +
        'Supports SiYuan search syntax, e.g. `foo bar` (AND), `"exact phrase"`, `foo OR bar`, `-exclude`, `*` wildcard.',
      inputSchema: {
        query: z.string().min(1).describe('Search keywords.'),
        page: z.number().int().min(1).optional().describe('Page number, 1-based. Defaults to 1.'),
        pageSize: z.number().int().min(1).max(50).optional().describe('Results per page, 1-50. Defaults to 10.'),
      },
    },
    ({ query, page, pageSize }) =>
      run(async () => {
        const size = pageSize ?? 10
        const current = page ?? 1
        const data = await client.call<{
          blocks?: SiYuanSearchBlock[]
          matchedBlockCount?: number
          pageCount?: number
        }>('/api/search/fullTextSearchBlock', { query, page: current, pageSize: size })

        const blocks = data?.blocks ?? []
        if (blocks.length === 0) return `No results for "${query}".`

        const total = data?.matchedBlockCount ?? blocks.length
        const pages = data?.pageCount ?? 1
        const lines = blocks.map((block) => {
          const label = block.type === 'NodeDocument' ? 'doc' : block.type || 'block'
          const path = block.hPath && block.hPath !== '/' ? `  ${block.hPath}` : ''
          return `- [${label}] ${block.id}${path}\n  ${truncateLine(plainText(block.content), 200) || '(empty)'}`
        })
        return `${total} match(es), page ${current}/${pages}:\n${lines.join('\n')}`
      }),
  )

  server.registerTool(
    'list_documents',
    {
      title: 'List documents',
      description:
        'List documents in the workspace or in one notebook, most recently updated first. ' +
        'Useful for browsing what exists before searching.',
      inputSchema: {
        notebook: z
          .string()
          .optional()
          .describe('Notebook ID or exact notebook name. Omit to list across all notebooks.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum documents to return. Defaults to 50.'),
      },
    },
    ({ notebook, limit }) =>
      run(async () => {
        const max = limit ?? 50
        const where = ["type = 'd'"]
        const params: unknown[] = []
        if (notebook) {
          const resolved = await client.resolveNotebook(notebook)
          where.push('box = ?')
          params.push(resolved.id)
        }
        const rows = await client.sql<BlockRow>(
          `SELECT ${SUMMARY_COLUMNS} FROM blocks WHERE ${where.join(' AND ')} ORDER BY updated DESC LIMIT ${max}`,
          params,
        )
        return formatBlocks(rows as never[], 'No documents found.')
      }),
  )

  server.registerTool(
    'get_document',
    {
      title: 'Get document content',
      description:
        'Read a document as Markdown. Accepts a document ID or a human-readable path such as ' +
        '`/Notes/My doc`. This is the primary way to read note content.',
      inputSchema: {
        doc: z.string().min(1).describe('Document ID, or a path like `/Notes/My doc`.'),
      },
    },
    ({ doc }) =>
      run(async () => {
        const id = await client.resolveDocId(doc)
        const data = await client.call<{ hPath?: string; content?: string }>('/api/export/exportMdContent', {
          id,
        })
        const content = data?.content ?? ''
        if (!content.trim()) return `Document ${id} (${data?.hPath ?? 'unknown path'}) is empty.`
        return `# ${data?.hPath ?? id}\n\n${content}`
      }),
  )

  // ------------------------------------------------------------------ blocks

  server.registerTool(
    'get_block',
    {
      title: 'Get block',
      description:
        'Read one block by ID. `kramdown` returns the source including block attributes (IDs, ' +
        'made useful for locating nested blocks to edit); `children` lists direct child blocks.',
      inputSchema: {
        id: z.string().min(1).describe('Block ID.'),
        format: z
          .enum(['kramdown', 'children'])
          .optional()
          .describe('`kramdown` (default) returns source; `children` returns direct child blocks.'),
      },
    },
    ({ id, format }) =>
      run(async () => {
        if (format === 'children') {
          const blocks = await client.call<Block[]>('/api/block/getChildBlocks', { id })
          if (!blocks || blocks.length === 0) return `Block ${id} has no child blocks.`
          return blocks
            .map((block) => {
              const markdown = block.markdown ?? plainText(block.content)
              return `- ${block.id} [${block.type ?? 'block'}${block.subType ? `/${block.subType}` : ''}]\n  ${truncateLine(markdown.replace(/\n/g, ' '), 200)}`
            })
            .join('\n')
        }
        const data = await client.call<{ kramdown?: string }>('/api/block/getBlockKramdown', { id })
        return data?.kramdown ?? `Block ${id} returned no content.`
      }),
  )

  server.registerTool(
    'insert_block',
    {
      title: 'Insert block',
      description:
        'Append Markdown as new blocks. With `parent_id` the content is appended inside that ' +
        'block (use a document ID to append to a document); with `previous_id` it is inserted ' +
        'directly after that block. Provide exactly one of them.',
      inputSchema: {
        data: z.string().min(1).describe('Markdown content to insert.'),
        parent_id: z.string().optional().describe('Parent block/document ID to append into.'),
        previous_id: z.string().optional().describe('Insert immediately after this block ID.'),
      },
    },
    ({ data, parent_id, previous_id }) =>
      run(async () => {
        const useParent = Boolean(parent_id) && !previous_id
        const usePrevious = Boolean(previous_id) && !parent_id
        if (!useParent && !usePrevious) {
          throw new Error('Provide exactly one of `parent_id` (append into) or `previous_id` (insert after).')
        }
        const endpoint = useParent ? '/api/block/appendBlock' : '/api/block/insertBlock'
        const payload = useParent
          ? { dataType: 'markdown', data, parentID: parent_id }
          : { dataType: 'markdown', data, previousID: previous_id }
        const result = await client.call<Block[] | { id?: string }>(endpoint, payload)
        const created = Array.isArray(result) ? result : []
        const ids = created.map((block) => block.id).filter(Boolean)
        if (ids.length > 0) return `Inserted ${ids.length} block(s): ${ids.join(', ')}`
        const single = (result as { id?: string })?.id
        return single ? `Inserted block ${single}` : 'Inserted.'
      }),
  )

  server.registerTool(
    'update_block',
    {
      title: 'Update block',
      description:
        'Replace the content of an existing block with new Markdown. The block type may change ' +
        '(e.g. a paragraph into a heading) unless `lock_type` is true. Get the ID from ' +
        '`get_block` or `search_notes` first.',
      inputSchema: {
        id: z.string().min(1).describe('Block ID to replace.'),
        data: z.string().describe('New Markdown content for the block.'),
        lock_type: z
          .boolean()
          .optional()
          .describe('When true, refuse the update if the parsed block type differs from the original.'),
      },
    },
    ({ id, data, lock_type }) =>
      run(async () => {
        await client.call('/api/block/updateBlock', {
          dataType: 'markdown',
          data,
          id,
          lockType: lock_type ?? false,
        })
        return `Updated block ${id}.`
      }),
  )

  server.registerTool(
    'delete_block',
    {
      title: 'Delete block',
      description:
        'Delete a block (and its children) by ID. Deleting a document block removes the whole ' +
        'document. Use `get_document` or `search_notes` first to confirm the target.',
      inputSchema: {
        id: z.string().min(1).describe('Block ID to delete.'),
      },
    },
    ({ id }) =>
      run(async () => {
        await client.call('/api/block/deleteBlock', { id })
        return `Deleted block ${id}.`
      }),
  )

  // --------------------------------------------------------------- documents

  server.registerTool(
    'create_document',
    {
      title: 'Create document',
      description:
        'Create a document from Markdown. `path` is the human-readable path, e.g. `/Notes/Idea`; ' +
        'missing parent documents are created automatically. An existing path is not overwritten — ' +
        'a new document is created alongside it.',
      inputSchema: {
        notebook: z.string().min(1).describe('Notebook ID or exact notebook name.'),
        path: z.string().min(1).describe('Document path starting with `/`, e.g. `/Notes/Idea`.'),
        markdown: z.string().optional().describe('Initial Markdown content.'),
      },
    },
    ({ notebook, path, markdown }) =>
      run(async () => {
        const resolved = await client.resolveNotebook(notebook)
        const normalised = path.startsWith('/') ? path : `/${path}`
        const id = await client.call<string>('/api/filetree/createDocWithMd', {
          notebook: resolved.id,
          path: normalised,
          markdown: markdown ?? '',
        })
        return `Created document ${id} at ${normalised} in notebook "${resolved.name}".`
      }),
  )

  server.registerTool(
    'rename_document',
    {
      title: 'Rename document',
      description: 'Change the title of a document. Accepts a document ID or a path.',
      inputSchema: {
        doc: z.string().min(1).describe('Document ID or path.'),
        title: z.string().min(1).describe('New title.'),
      },
    },
    ({ doc, title }) =>
      run(async () => {
        const id = await client.resolveDocId(doc)
        await client.call('/api/filetree/renameDocByID', { id, title })
        return `Renamed document ${id} to "${title}".`
      }),
  )

  server.registerTool(
    'remove_document',
    {
      title: 'Remove document',
      description:
        'Delete a document. Accepts a document ID or a path. The document is moved to the ' +
        'workspace trash (数据历史) and can be recovered from SiYuan.',
      inputSchema: {
        doc: z.string().min(1).describe('Document ID or path.'),
      },
    },
    ({ doc }) =>
      run(async () => {
        const id = await client.resolveDocId(doc)
        await client.call('/api/filetree/removeDocByID', { id })
        return `Removed document ${id} (recoverable from 数据历史).`
      }),
  )

  server.registerTool(
    'move_document',
    {
      title: 'Move document',
      description:
        'Move a document under a different parent document, or into a different notebook. ' +
        '`to` may be a parent document ID/path, or a notebook ID/name to move it to that ' +
        "notebook's root.",
      inputSchema: {
        doc: z.string().min(1).describe('Document ID or path to move.'),
        to: z.string().min(1).describe('Destination parent document ID/path, or notebook ID/name.'),
      },
    },
    ({ doc, to }) =>
      run(async () => {
        const fromId = await client.resolveDocId(doc)
        let toId: string
        try {
          toId = await client.resolveDocId(to)
        } catch {
          // Not a document — fall back to treating it as a notebook.
          toId = (await client.resolveNotebook(to)).id
        }
        if (toId === fromId) throw new Error('The destination and the source document are the same.')
        await client.call('/api/filetree/moveDocsByID', { fromIDs: [fromId], toID: toId })
        return `Moved document ${fromId} to ${toId}.`
      }),
  )

  // -------------------------------------------------------------------- raw

  server.registerTool(
    'sql_query',
    {
      title: 'Run SQL query',
      description:
        'Run a read-only SQL query against the SiYuan index to answer questions the other tools ' +
        'cannot, e.g. counting blocks or filtering by tag/attribute. Main table: `blocks` ' +
        `(id, parent_id, root_id, box, path, hpath, type, subtype, content, tag, ial, created, updated). ` +
        `Only SELECT/WITH/EXPLAIN are allowed; results are capped at ${SQL_ROW_CAP} rows by the kernel.`,
      inputSchema: {
        stmt: z.string().min(1).describe('A single read-only SQL statement.'),
      },
    },
    ({ stmt }) =>
      run(async () => {
        const safe = assertReadOnlySql(stmt)
        const rows = await client.sql<Record<string, unknown>>(safe)
        if (rows.length === 0) return 'Query returned no rows.'
        return `${rows.length} row(s):\n${JSON.stringify(rows, null, 2)}`
      }),
  )
}

/** A block as returned by `/api/search/fullTextSearchBlock`. */
interface SiYuanSearchBlock {
  id: string
  type?: string
  hPath?: string
  content?: string
}
