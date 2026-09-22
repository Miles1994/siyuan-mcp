/**
 * Client for the SiYuan kernel HTTP API.
 *
 * Every SiYuan endpoint is `POST <baseUrl>/api/...` with a JSON body and a
 * `{ code, msg, data }` envelope where a non-zero `code` signals failure.
 * This module owns that envelope, the auth header and error mapping so that
 * the tool layer only ever deals with plain typed data or a thrown Error whose
 * message is safe to show a model.
 */

/** Default kernel address used by a locally installed SiYuan. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:6806'

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Shape of every SiYuan kernel response. */
export interface SiYuanEnvelope<T> {
  code: number
  msg: string
  data: T
  /** Row cap the kernel applied, present on list/SQL responses. */
  limit?: number
  /** Whether the kernel dropped rows to respect `limit`. */
  truncated?: boolean
}

/** The kernel answered but reported a business error (`code !== 0`). */
export class SiYuanApiError extends Error {
  readonly endpoint: string
  readonly code: number

  constructor(endpoint: string, code: number, msg: string) {
    super(`SiYuan API ${endpoint} failed (code ${code})${msg ? `: ${msg}` : ''}`)
    this.name = 'SiYuanApiError'
    this.endpoint = endpoint
    this.code = code
  }
}

/** The kernel could not be reached at all. */
export class SiYuanConnectionError extends Error {
  readonly baseUrl: string

  constructor(baseUrl: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `Cannot reach the SiYuan kernel at ${baseUrl} (${detail}). ` +
        'Make sure SiYuan is running and that the address matches ' +
        '设置 → 关于 → 伺服地址 (Settings → About → server address).',
    )
    this.name = 'SiYuanConnectionError'
    this.baseUrl = baseUrl
    this.cause = cause
  }
}

/** A notebook as returned by `/api/notebook/lsNotebooks`. */
export interface Notebook {
  id: string
  name: string
  icon?: string
  sort?: number
  closed?: boolean
  encrypted?: boolean
  [key: string]: unknown
}

/** A row from the SiYuan SQLite `blocks` table. */
export interface BlockRow {
  id: string
  parent_id?: string
  root_id?: string
  box?: string
  path?: string
  hpath?: string
  name?: string
  alias?: string
  memo?: string
  tag?: string
  content?: string
  fcontent?: string
  markdown?: string
  type?: string
  subtype?: string
  ial?: string
  sort?: number
  created?: string
  updated?: string
  [key: string]: unknown
}

/** A block as returned by block endpoints (`getChildBlocks`, `insertBlock`, …). */
export interface Block {
  id: string
  type?: string
  subtype?: string
  content?: string
  markdown?: string
  [key: string]: unknown
}

export interface SiYuanClientOptions {
  baseUrl?: string
  token?: string
  timeoutMs?: number
  /** Injectable fetch, used by tests. */
  fetch?: typeof globalThis.fetch
}

/** SiYuan block/document IDs look like `20260101000001-hijklmn`. */
const BLOCK_ID_PATTERN = /^\d{14}-[0-9a-z]{7}$/

/** True when `ref` is shaped like a SiYuan block ID rather than a path. */
export function isBlockId(ref: string): boolean {
  return BLOCK_ID_PATTERN.test(ref.trim())
}

export class SiYuanClient {
  readonly baseUrl: string
  readonly token?: string
  readonly timeoutMs: number
  #fetch: typeof globalThis.fetch

  constructor(options: SiYuanClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.token = options.token?.trim() || undefined
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  /** POST to a kernel endpoint and return the full envelope. */
  async request<T = unknown>(
    endpoint: string,
    payload: Record<string, unknown> = {},
  ): Promise<SiYuanEnvelope<T>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers.Authorization = `Token ${this.token}`

    let response: Response
    try {
      response = await this.#fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new SiYuanConnectionError(this.baseUrl, cause)
    }

    if (!response.ok) {
      throw new Error(
        `SiYuan API ${endpoint} returned HTTP ${response.status} ${response.statusText}`,
      )
    }

    const text = await response.text()
    let envelope: SiYuanEnvelope<T>
    try {
      envelope = JSON.parse(text) as SiYuanEnvelope<T>
    } catch {
      throw new Error(
        `SiYuan API ${endpoint} returned a non-JSON response: ${truncate(text, 200)}`,
      )
    }

    if (typeof envelope?.code !== 'number') {
      throw new Error(`SiYuan API ${endpoint} returned an unexpected payload: ${truncate(text, 200)}`)
    }
    if (envelope.code !== 0) {
      throw new SiYuanApiError(endpoint, envelope.code, envelope.msg ?? '')
    }
    return envelope
  }

  /** POST to a kernel endpoint and return only the `data` field. */
  async call<T = unknown>(endpoint: string, payload: Record<string, unknown> = {}): Promise<T> {
    return (await this.request<T>(endpoint, payload)).data
  }

  /** Every notebook known to the kernel, including closed ones. */
  async listNotebooks(): Promise<Notebook[]> {
    const data = await this.call<{ notebooks?: Notebook[] }>('/api/notebook/lsNotebooks')
    return data?.notebooks ?? []
  }

  /**
   * Accept either a notebook ID or its human-readable name.
   *
   * Tools advertise `notebook` as a string so a model can pass whatever it saw
   * from `list_notebooks`; this resolves the name form and reports ambiguity
   * instead of silently guessing.
   */
  async resolveNotebook(ref: string): Promise<Notebook> {
    const value = ref.trim()
    if (!value) throw new Error('`notebook` must not be empty.')

    const notebooks = await this.listNotebooks()

    const byId = notebooks.find((notebook) => notebook.id === value)
    if (byId) return byId

    const exact = notebooks.filter((notebook) => notebook.name === value)
    if (exact.length === 1) return exact[0]!
    if (exact.length > 1) throw ambiguousNotebook(value, exact)

    const insensitive = notebooks.filter(
      (notebook) => notebook.name.toLowerCase() === value.toLowerCase(),
    )
    if (insensitive.length === 1) return insensitive[0]!
    if (insensitive.length > 1) throw ambiguousNotebook(value, insensitive)

    throw new Error(
      `No notebook named "${value}". Known notebooks: ${formatNotebooks(notebooks)}. ` +
        'Call list_notebooks to see them.',
    )
  }

  /**
   * Accept either a document ID or a human-readable path (`hpath`).
   *
   * Paths resolve through `/api/filetree/getIDsByHPath`, which reads the
   * document tree directly. The SQL index is only consulted as a fallback,
   * because it lags roughly two seconds behind writes (measured on 3.8.4):
   * resolving a freshly created document through SQL would otherwise fail.
   */
  async resolveDocId(ref: string): Promise<string> {
    const value = ref.trim()
    if (!value) throw new Error('A document ID or path is required.')
    if (isBlockId(value)) return value

    const hpath = value.startsWith('/') ? value : `/${value}`

    const direct = await this.#lookupByHPath(hpath)
    if (direct.length === 1) return direct[0]!
    if (direct.length > 1) throw new Error(ambiguousDocMessage(value, direct.map((id) => ({ id, hpath }))))

    const rows = await this.sql<BlockRow>(
      "SELECT id, hpath, box FROM blocks WHERE type = 'd' AND (hpath = ? OR content = ?) LIMIT 25",
      [hpath, value],
    )

    const byPath = rows.filter((row) => row.hpath === hpath)
    const matches = byPath.length > 0 ? byPath : rows

    if (matches.length === 0) {
      throw new Error(
        `No document found for "${value}". Pass a document ID, or a document path such as "/Notes/My doc". ` +
          'Use search_notes or list_documents to find it.',
      )
    }
    if (matches.length > 1) throw new Error(ambiguousDocMessage(value, matches))
    return matches[0]!.id
  }

  /**
   * Resolve an `hpath` to document IDs via the document-tree API.
   *
   * `path` is matched within each notebook; an unknown notebook simply yields
   * no candidates rather than failing the whole lookup.
   */
  async #lookupByHPath(hpath: string): Promise<string[]> {
    const notebooks = await this.listNotebooks()
    const ids: string[] = []
    for (const notebook of notebooks) {
      try {
        const found = await this.call<string[] | null>('/api/filetree/getIDsByHPath', {
          path: hpath,
          notebook: notebook.id,
        })
        if (Array.isArray(found)) ids.push(...found)
      } catch {
        // A notebook that cannot answer (closed, encrypted, ...) is not fatal:
        // other notebooks may still hold the path.
      }
    }
    return ids
  }

  /**
   * Run a read-only SQL query against the workspace index.
   *
   * The kernel has no bound-parameter support for `/api/query/sql` (its `args`
   * field is ignored), so `?` placeholders are substituted with escaped
   * literals by {@link bindParams}. The kernel caps the row count and reports
   * it through `limit`/`truncated`.
   */
  async sql<T = BlockRow>(stmt: string, params: unknown[] = []): Promise<T[]> {
    const data = await this.call<T[]>('/api/query/sql', { stmt: bindParams(stmt, params) })
    return data ?? []
  }
}

/**
 * Quote a JavaScript value as a SQL literal.
 *
 * Strings are wrapped in single quotes with embedded quotes doubled, which is
 * the SQLite escape for a literal quote. This is the only safe way to
 * interpolate caller-supplied values because the kernel offers no parameter
 * binding.
 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot use non-finite number ${value} as a SQL literal.`)
    return String(value)
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  throw new Error(`Unsupported SQL literal type: ${typeof value}.`)
}

/**
 * Replace `?` placeholders in `stmt` with escaped literals, positionally.
 *
 * Only pass statements whose `?` characters are all intended as placeholders —
 * a `?` inside a string literal in `stmt` would be substituted too.
 */
export function bindParams(stmt: string, params: unknown[]): string {
  if (params.length === 0) return stmt
  let index = 0
  const bound = stmt.replace(/\?/g, () => {
    if (index >= params.length) throw new Error('Not enough parameters for the SQL placeholders.')
    return sqlLiteral(params[index++])
  })
  if (index !== params.length) {
    throw new Error(`Unused SQL parameters: expected ${index} placeholder(s), received ${params.length}.`)
  }
  return bound
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return DEFAULT_BASE_URL
  return trimmed.replace(/\/+$/, '')
}

function ambiguousNotebook(value: string, notebooks: Notebook[]): Error {
  const candidates = notebooks.map((notebook) => `${notebook.name} (id: ${notebook.id})`).join(', ')
  return new Error(`Notebook name "${value}" is ambiguous: ${candidates}. Pass the notebook ID instead.`)
}

function ambiguousDocMessage(
  value: string,
  matches: ReadonlyArray<{ id: string; hpath?: string }>,
): string {
  const candidates = matches.map((row) => `${row.hpath ?? '?'} (id: ${row.id})`).join(', ')
  return `"${value}" matches multiple documents: ${candidates}. Use an explicit document ID.`
}

function formatNotebooks(notebooks: Notebook[]): string {
  if (notebooks.length === 0) return '(none)'
  return notebooks.map((notebook) => `${notebook.name} (${notebook.id})`).join(', ')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
