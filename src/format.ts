/**
 * Shared helpers for turning SiYuan responses into compact, model-friendly
 * text. Kept separate from the tool definitions so the formatting rules can be
 * unit tested without spinning up an MCP server.
 */

/** A row from the `blocks` table, narrowed to the fields tools surface. */
export interface BlockSummary {
  id: string
  type: string
  hpath: string
  box: string
  content: string
  updated: string
}

/** Extract the plain text of a block, stripping SiYuan/HTML markup. */
export function plainText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return decodeEntities(
    value
      // Highlight markers emitted by the search API.
      .replaceAll('<mark>', '')
      .replaceAll('</mark>', '')
      // Block reference / inline-math spans keep only their text.
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** Render a list of blocks as compact lines. */
export function formatBlocks(blocks: BlockSummary[], emptyMessage: string): string {
  if (blocks.length === 0) return emptyMessage
  return blocks
    .map((block) => {
      const label = block.type === 'd' ? 'doc' : block.type || 'block'
      const path = block.hpath && block.hpath !== '/' ? `  ${block.hpath}` : ''
      const text = truncateLine(plainText(block.content), 200)
      return `- [${label}] ${block.id}${path}\n  ${text || '(empty)'}`
    })
    .join('\n')
}

/** Render a `{ code, msg, data }`-style acknowledgement. */
export function formatAck(action: string, detail?: string): string {
  return detail ? `${action}: ${detail}` : action
}

export function truncateLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
}
