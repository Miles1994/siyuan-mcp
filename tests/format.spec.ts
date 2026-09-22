import { describe, expect, it } from 'vitest'
import { formatAck, formatBlocks, plainText, truncateLine } from '../src/format.js'

describe('plainText', () => {
  it('strips search highlight markers', () => {
    expect(plainText('<mark>示例</mark>文档')).toBe('示例文档')
  })

  it('strips block reference and inline markup, keeping text', () => {
    expect(plainText('see <span data-type="block-ref" data-id="x">ref text</span> here')).toBe(
      'see ref text here',
    )
    expect(plainText('a <br>b')).toBe('a b')
  })

  it('decodes HTML entities', () => {
    expect(plainText('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f')).toBe('a & b <c> "d" \'e\' f')
  })

  it('collapses whitespace and handles non-strings', () => {
    expect(plainText('  a \n\t b  ')).toBe('a b')
    expect(plainText(undefined)).toBe('')
    expect(plainText(42)).toBe('')
  })

  it('decodes entities without re-interpreting the decoded text as markup', () => {
    expect(plainText('&lt;script&gt;')).toBe('<script>')
  })
})

describe('formatBlocks', () => {
  it('returns the empty message when there is nothing to show', () => {
    expect(formatBlocks([], 'No documents found.')).toBe('No documents found.')
  })

  it('renders one compact entry per block with id, path and text', () => {
    const out = formatBlocks(
      [
        {
          id: '20260101000001-hijklmn',
          type: 'd',
          hpath: '/示例文档',
          box: 'nb',
          content: '示例文档',
          updated: '20260922142104',
        },
      ],
      'none',
    )
    expect(out).toContain('[doc] 20260101000001-hijklmn')
    expect(out).toContain('/示例文档')
    expect(out).toContain('示例文档')
  })

  it('omits a root-level hpath and labels non-document types', () => {
    const out = formatBlocks(
      [{ id: 'x', type: 'p', hpath: '/', box: 'nb', content: 'hi', updated: '1' }],
      'none',
    )
    expect(out).toContain('[p] x')
    expect(out).not.toContain('/')
  })

  it('marks empty content and truncates long content', () => {
    const long = 'x'.repeat(500)
    const out = formatBlocks([{ id: 'a', type: 'p', hpath: '/d', box: 'b', content: '  ', updated: '1' }], 'none')
    expect(out).toContain('(empty)')
    expect(formatBlocks([{ id: 'a', type: 'p', hpath: '/d', box: 'b', content: long, updated: '1' }], 'none')).toContain('…')
  })
})

describe('truncateLine', () => {
  it('leaves short text and marks truncated text', () => {
    expect(truncateLine('abc', 5)).toBe('abc')
    expect(truncateLine('abcdef', 5)).toBe('abcde…')
  })
})

describe('formatAck', () => {
  it('appends detail only when present', () => {
    expect(formatAck('Deleted')).toBe('Deleted')
    expect(formatAck('Deleted', 'x')).toBe('Deleted: x')
  })
})
