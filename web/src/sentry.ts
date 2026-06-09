import * as Sentry from '@sentry/browser'
import type {ErrorEvent, EventHint} from '@sentry/browser'

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

const dsn = import.meta.env.VITE_SENTRY_DSN

function redactHeaders(headers: Record<string, string> | undefined) {
  if (!headers) {
    return headers
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const lowerKey = key.toLowerCase()
      if (lowerKey.includes('authorization') || lowerKey.includes('cookie')) {
        return [key, '[Filtered]']
      }
      return [key, value]
    })
  )
}

function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent {
  if (event.request) {
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

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: import.meta.env.PROD ? 0.01 : 0,
    beforeSend,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0
  })
}

export const setSentryContext = (entry: string): void => {
  if (dsn) {
    Sentry.setTag('entry', entry)
  }
}
