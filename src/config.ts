/**
 * Configuration resolved from the environment, shared by the CLI entry point
 * and by programmatic embedders.
 */
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, type SiYuanClientOptions } from './siyuan.js'

export interface SiYuanConfig {
  baseUrl: string
  token?: string
  timeoutMs: number
}

/**
 * Read configuration from the environment.
 *
 * Recognised variables:
 * - `SIYUAN_API_URL` (alias `SIYUAN_BASE_URL`) — kernel address.
 * - `SIYUAN_TOKEN` — API token; only needed when the kernel has auth enabled.
 * - `SIYUAN_TIMEOUT_MS` — per-request timeout in milliseconds.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SiYuanConfig {
  const baseUrl = env.SIYUAN_API_URL?.trim() || env.SIYUAN_BASE_URL?.trim() || DEFAULT_BASE_URL
  const token = env.SIYUAN_TOKEN?.trim() || undefined
  return { baseUrl, token, timeoutMs: parseTimeout(env.SIYUAN_TIMEOUT_MS) }
}

/** Convert a config object into client options. */
export function toClientOptions(config: SiYuanConfig): SiYuanClientOptions {
  return { baseUrl: config.baseUrl, token: config.token, timeoutMs: config.timeoutMs }
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}
