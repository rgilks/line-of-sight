import {describe, expect, it, vi} from 'vitest'
import {
  activateWaitingServiceWorker,
  checkForServiceWorkerUpdate,
  installUpdateCheckTriggers,
  shouldRunUpdateCheck
} from './pwa-update-lifecycle'

class FakeWorker extends EventTarget {
  messages: unknown[] = []
  state: ServiceWorkerState = 'installed'

  postMessage(message: unknown) {
    this.messages.push(message)
  }
}

const registrationWith = (overrides: Partial<ServiceWorkerRegistration> = {}): ServiceWorkerRegistration =>
  ({
    installing: null,
    waiting: null,
    update: vi.fn(async function (this: ServiceWorkerRegistration) {
      return this
    }),
    ...overrides
  }) as unknown as ServiceWorkerRegistration

describe('PWA update lifecycle', () => {
  it('debounces clustered foreground update checks', () => {
    expect(shouldRunUpdateCheck(10_000, 0)).toBe(true)
    expect(shouldRunUpdateCheck(65_000, 10_000)).toBe(false)
    expect(shouldRunUpdateCheck(70_000, 10_000)).toBe(true)
  })

  it('checks the worker entry without cache before updating', async () => {
    const registration = registrationWith()
    const update = vi.spyOn(registration, 'update')
    const fetcher = vi.fn(
      async () =>
        new Response('worker', {
          headers: {'content-type': 'text/javascript'}
        })
    )

    await expect(
      checkForServiceWorkerUpdate({
        registration,
        swUrl: '/sw.js',
        fetcher: fetcher as typeof fetch
      })
    ).resolves.toBe('current')
    expect(fetcher).toHaveBeenCalledWith('/sw.js', {
      cache: 'no-store',
      headers: {
        cache: 'no-store',
        'cache-control': 'no-cache'
      }
    })
    expect(update).toHaveBeenCalledOnce()
  })

  it('surfaces an already-waiting worker without a network request', async () => {
    const waiting = new FakeWorker()
    const fetcher = vi.fn()
    const registration = registrationWith({waiting: waiting as unknown as ServiceWorker})

    await expect(
      checkForServiceWorkerUpdate({
        registration,
        swUrl: '/sw.js',
        fetcher: fetcher as typeof fetch
      })
    ).resolves.toBe('waiting')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not overlap an update while a worker is installing', async () => {
    const installing = new FakeWorker()
    installing.state = 'installing'
    const fetcher = vi.fn()
    const registration = registrationWith({installing: installing as unknown as ServiceWorker})

    await expect(
      checkForServiceWorkerUpdate({
        registration,
        swUrl: '/sw.js',
        fetcher: fetcher as typeof fetch
      })
    ).resolves.toBe('installing')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('leaves the app alone when the worker endpoint is unavailable', async () => {
    const registration = registrationWith()
    const update = vi.spyOn(registration, 'update')
    const fetcher = vi.fn(
      async () =>
        new Response('<!doctype html>', {
          headers: {'content-type': 'text/html'}
        })
    )

    await expect(
      checkForServiceWorkerUpdate({
        registration,
        swUrl: '/sw.js',
        fetcher: fetcher as typeof fetch
      })
    ).resolves.toBe('unavailable')
    expect(update).not.toHaveBeenCalled()
  })

  it('checks on resume, reconnect, focus, pageshow and a visible interval', () => {
    vi.useFakeTimers()
    const windowTarget = new EventTarget()
    const documentTarget = new EventTarget()
    const check = vi.fn()
    let visible = true
    const cleanup = installUpdateCheckTriggers({
      check,
      documentTarget,
      intervalMs: 1_000,
      isVisible: () => visible,
      setIntervalFn: setInterval as unknown as typeof window.setInterval,
      clearIntervalFn: clearInterval as unknown as typeof window.clearInterval,
      windowTarget
    })

    documentTarget.dispatchEvent(new Event('visibilitychange'))
    windowTarget.dispatchEvent(new Event('focus'))
    windowTarget.dispatchEvent(new Event('online'))
    windowTarget.dispatchEvent(new Event('pageshow'))
    vi.advanceTimersByTime(1_000)
    expect(check).toHaveBeenCalledTimes(5)

    visible = false
    documentTarget.dispatchEvent(new Event('visibilitychange'))
    windowTarget.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(1_000)
    expect(check).toHaveBeenCalledTimes(5)

    cleanup()
    visible = true
    windowTarget.dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(1_000)
    expect(check).toHaveBeenCalledTimes(5)
    vi.useRealTimers()
  })

  it('messages the exact waiting worker and reloads when it activates', async () => {
    const waiting = new FakeWorker()
    const reload = vi.fn()
    const registration = registrationWith({waiting: waiting as unknown as ServiceWorker})
    const activation = activateWaitingServiceWorker({registration, reload})

    expect(waiting.messages).toEqual([{type: 'SKIP_WAITING'}])
    waiting.state = 'activated'
    waiting.dispatchEvent(new Event('statechange'))

    await expect(activation).resolves.toBe(true)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('uses a bounded reload fallback when lifecycle delivery is missed', async () => {
    vi.useFakeTimers()
    const waiting = new FakeWorker()
    const reload = vi.fn()
    const registration = registrationWith({waiting: waiting as unknown as ServiceWorker})
    const activation = activateWaitingServiceWorker({
      registration,
      reload,
      fallbackMs: 2_000,
      setTimeoutFn: setTimeout as unknown as typeof window.setTimeout,
      clearTimeoutFn: clearTimeout as unknown as typeof window.clearTimeout
    })

    await vi.advanceTimersByTimeAsync(2_000)

    await expect(activation).resolves.toBe(true)
    expect(reload).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not reload when the waiting worker becomes redundant', async () => {
    const waiting = new FakeWorker()
    const reload = vi.fn()
    const registration = registrationWith({waiting: waiting as unknown as ServiceWorker})
    const activation = activateWaitingServiceWorker({registration, reload})

    waiting.state = 'redundant'
    waiting.dispatchEvent(new Event('statechange'))

    await expect(activation).resolves.toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
