import { describe, expect, it } from 'vitest'
import { loadConfig, toClientOptions } from '../src/config.js'
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from '../src/siyuan.js'

describe('loadConfig', () => {
  it('falls back to the local kernel defaults', () => {
    const config = loadConfig({})
    expect(config.baseUrl).toBe(DEFAULT_BASE_URL)
    expect(config.token).toBeUndefined()
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it('reads SIYUAN_API_URL and trims it', () => {
    expect(loadConfig({ SIYUAN_API_URL: '  http://192.168.1.5:6806  ' }).baseUrl).toBe(
      'http://192.168.1.5:6806',
    )
  })

  it('accepts SIYUAN_BASE_URL as an alias', () => {
    expect(loadConfig({ SIYUAN_BASE_URL: 'http://host:6806' }).baseUrl).toBe('http://host:6806')
  })

  it('prefers SIYUAN_API_URL over the alias', () => {
    const config = loadConfig({ SIYUAN_API_URL: 'http://a:6806', SIYUAN_BASE_URL: 'http://b:6806' })
    expect(config.baseUrl).toBe('http://a:6806')
  })

  it('treats a blank token as absent', () => {
    expect(loadConfig({ SIYUAN_TOKEN: '   ' }).token).toBeUndefined()
    expect(loadConfig({ SIYUAN_TOKEN: 'abc' }).token).toBe('abc')
  })

  it('ignores an invalid timeout', () => {
    expect(loadConfig({ SIYUAN_TIMEOUT_MS: 'nope' }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(loadConfig({ SIYUAN_TIMEOUT_MS: '-1' }).timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(loadConfig({ SIYUAN_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000)
  })
})

describe('toClientOptions', () => {
  it('maps config fields onto client options', () => {
    expect(toClientOptions({ baseUrl: 'http://h:6806', token: 't', timeoutMs: 1234 })).toEqual({
      baseUrl: 'http://h:6806',
      token: 't',
      timeoutMs: 1234,
    })
  })
})
