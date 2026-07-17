import './pwa-update.css'
import {
  activateWaitingServiceWorker,
  checkForServiceWorkerUpdate,
  installUpdateCheckTriggers,
  shouldRunUpdateCheck
} from './pwa-update-lifecycle'

type UpdateUiState = 'hidden' | 'ready' | 'deferred' | 'updating'

const installPwaUpdate = (): void => {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return

  let registration: ServiceWorkerRegistration | undefined
  let checking = false
  let lastCheckAt = 0
  let state: UpdateUiState = 'hidden'

  const prompt = document.createElement('div')
  prompt.id = 'pwa-update'

  const render = (): void => {
    if (state === 'hidden') {
      prompt.remove()
      return
    }
    if (!prompt.isConnected) document.body.appendChild(prompt)

    if (state === 'deferred') {
      prompt.className = 'pwa-update-deferred'
      prompt.removeAttribute('role')
      prompt.removeAttribute('aria-live')
      prompt.innerHTML = '<button type="button" class="pwa-update-chip">Update ready</button>'
      prompt.querySelector('button')?.addEventListener('click', () => {
        state = 'ready'
        render()
      })
      return
    }

    prompt.className = 'pwa-update-prompt'
    prompt.setAttribute('role', 'status')
    prompt.setAttribute('aria-live', 'polite')
    prompt.innerHTML = `
      <p>${state === 'updating' ? 'Applying update…' : 'Update ready. Reload when you reach a safe point.'}</p>
      <div class="pwa-update-actions">
        <button type="button" class="pwa-update-primary" ${state === 'updating' ? 'disabled' : ''}>
          ${state === 'updating' ? 'Updating…' : 'Reload now'}
        </button>
        ${state === 'updating' ? '' : '<button type="button" class="pwa-update-later">Later</button>'}
      </div>`
    prompt.querySelector('.pwa-update-primary')?.addEventListener('click', () => void activateUpdate())
    prompt.querySelector('.pwa-update-later')?.addEventListener('click', () => {
      state = 'deferred'
      render()
    })
  }

  const showUpdate = (): void => {
    if (state !== 'deferred' && state !== 'updating') state = 'ready'
    render()
  }

  const checkForUpdate = async (force = false): Promise<void> => {
    if (
      checking ||
      !registration ||
      !navigator.onLine ||
      document.visibilityState !== 'visible' ||
      (!force && !shouldRunUpdateCheck(Date.now(), lastCheckAt))
    ) {
      return
    }
    lastCheckAt = Date.now()
    checking = true
    const result = await checkForServiceWorkerUpdate({registration, swUrl: '/sw.js'})
    checking = false
    if (result === 'waiting') showUpdate()
  }

  const activateUpdate = async (): Promise<void> => {
    if (!registration) return
    state = 'updating'
    render()
    const activated = await activateWaitingServiceWorker({registration})
    if (activated) return
    await checkForUpdate(true)
    state = 'ready'
    render()
  }

  const register = async (): Promise<void> => {
    try {
      registration = await navigator.serviceWorker.register('/sw.js')
      if (registration.waiting) showUpdate()
      registration.addEventListener('updatefound', () => {
        const worker = registration?.installing
        if (!worker) return
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate()
        })
      })
      installUpdateCheckTriggers({check: () => void checkForUpdate()})
      await checkForUpdate(true)
    } catch {
      // Offline support is a progressive enhancement.
    }
  }

  if (document.readyState === 'complete') void register()
  else window.addEventListener('load', () => void register(), {once: true})
}

installPwaUpdate()
