import type {CloudflareOptions, ErrorEvent, EventHint} from '@sentry/cloudflare'

type RuntimeCloudflareOptions = CloudflareOptions & Record<string, unknown>

export type SentryEnv = {
  CF_VERSION_METADATA?: {
    id?: string
  }
  SENTRY_DSN?: string
  SENTRY_ENVIRONMENT?: string
  SENTRY_RELEASE?: string
}

const SENSITIVE_EXTRA_KEYS = [
  'apiKey',
  'authorization',
  'character',
  'cookie',
  'gameState',
  'map',
  'moves',
  'prompt',
  'requestBody',
  'response',
  'room',
  'text',
  'tokens'
]
const SENSITIVE_QUERY_KEYS = ['authToken', 'gmKey']

function redactHeaders(headers: Record<string, string> | undefined) {
  if (!headers) {
    return headers
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const lowerKey = key.toLowerCase()
      if (lowerKey.includes('authorization') || lowerKey.includes('cookie') || lowerKey.startsWith('x-los-')) {
        return [key, '[Filtered]']
      }
      return [key, value]
    })
  )
}

function redactUrl(value: string | undefined) {
  if (!value) return value
  try {
    const url = new URL(value)
    for (const key of SENSITIVE_QUERY_KEYS) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '[Filtered]')
    }
    return url.toString()
  } catch {
    return value
  }
}

function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
    event.request.url = redactUrl(event.request.url)
    const headers = redactHeaders(event.request.headers)
    if (headers) {
      event.request.headers = headers
    } else {
      delete event.request.headers
    }
    delete event.request.cookies
    delete event.request.data
  }

  if (event.extra) {
    for (const key of SENSITIVE_EXTRA_KEYS) {
      if (key in event.extra) {
        event.extra[key] = '[Filtered]'
      }
    }
  }

  return event
}

export const sentryOptions = (env: SentryEnv): RuntimeCloudflareOptions | undefined => {
  if (!env.SENTRY_DSN) {
    return undefined
  }

  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    release: env.SENTRY_RELEASE ?? env.CF_VERSION_METADATA?.id,
    sendDefaultPii: false,
    tracesSampleRate: env.SENTRY_ENVIRONMENT === 'production' ? 0.01 : 0,
    enableRpcTracePropagation: true,
    beforeSend
  }
}
