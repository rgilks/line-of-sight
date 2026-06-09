// Tiny, framework-free runtime error reporter shared by all four browser entry
// points (solo.ts, play.ts, main.tsx). It registers global handlers for uncaught
// errors and unhandled promise rejections and logs them as a clearly-tagged
// console.error, so a runtime failure surfaces in the console instead of dying
// silently. `context` is a short page label (e.g. 'solo') that prefixes every
// line as `[los:<context>]`.
//
// This is the single seam for telemetry: to ship errors off-device later, POST
// the same `{context, message, stack}` payload to a beacon endpoint from inside
// `report()` — nothing else needs to change.
import {setSentryContext} from './sentry'

// Installed at most once for the page, regardless of how many times this runs.
let installed = false

const report = (context: string, message: string, detail: unknown): void => {
  // `detail` is the error/rejection reason: prefer its stack, fall back to the
  // value itself so a thrown non-Error (string, object) still shows up.
  const stack = detail instanceof Error ? detail.stack : detail
  console.error(`[los:${context}]`, message, stack)
}

export const installErrorReporting = (context: string): void => {
  if (installed) return
  installed = true
  setSentryContext(context)

  window.addEventListener('error', (event) => {
    report(context, event.message, event.error)
  })

  window.addEventListener('unhandledrejection', (event) => {
    report(context, 'unhandled promise rejection', event.reason)
  })
}
