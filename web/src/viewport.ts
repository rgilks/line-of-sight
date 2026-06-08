import type {Point} from '../../core/los'

// Shared canvas movement-tween + requestAnimationFrame core for the two game
// clients (solo.ts, play.ts). renderPos is each token's currently-drawn
// position; anim holds in-flight eases. The rAF loop is the sole owner of the
// per-frame work: it advances the eases, then calls the app's onFrame to draw /
// move the camera, then reschedules itself while anything is still moving.

export type Anim = {fromX: number; fromY: number; toX: number; toY: number; start: number}

// onFrame does the app's per-frame work (camera + draw) and returns whether the
// app wants the loop to keep ticking beyond what the tween itself needs — e.g.
// camera still gliding, effects/chat bubbles still fading.
export type TweenLoop = {
  // Each token's currently-drawn (possibly mid-ease) position.
  renderPos: Map<string, Point>
  // In-flight eases, keyed by token id. Exposed so callers can confirm/cancel.
  anim: Map<string, Anim>
  now: () => number
  // Resolves once token `id`'s in-flight glide finishes (or immediately if none).
  waitTween: (id: string) => Promise<void>
  startEase: (id: string, from: Point, to: Point) => void
  // Advance every in-flight ease to time `t`. Returns whether any remain unsettled.
  stepRenderPos: (t: number) => boolean
  // Schedule a frame if one isn't already pending (the loop drains itself).
  ensureRaf: () => void
  // Request a redraw. Same as ensureRaf — the rAF loop owns pixels.
  requestDraw: () => void
}

export const createTweenLoop = (opts: {
  easeMs: number
  onFrame: (t: number, moving: boolean) => boolean
}): TweenLoop => {
  const {easeMs, onFrame} = opts
  const renderPos = new Map<string, Point>()
  const anim = new Map<string, Anim>()
  const tweenWaiters = new Map<string, Array<() => void>>()
  let rafId = 0

  const now = (): number => performance.now()

  const waitTween = (id: string): Promise<void> =>
    new Promise((resolve) => {
      if (!anim.has(id)) {
        resolve()
        return
      }
      const waiters = tweenWaiters.get(id) ?? []
      waiters.push(resolve)
      tweenWaiters.set(id, waiters)
    })

  const startEase = (id: string, from: Point, to: Point): void => {
    anim.set(id, {fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, start: now()})
    ensureRaf()
  }

  const stepRenderPos = (t: number): boolean => {
    let moving = false
    for (const [id, a] of anim) {
      const progress = Math.min(1, (t - a.start) / easeMs)
      const eased = 1 - (1 - progress) ** 3 // ease-out cubic
      renderPos.set(id, {x: a.fromX + (a.toX - a.fromX) * eased, y: a.fromY + (a.toY - a.fromY) * eased})
      if (progress >= 1) {
        anim.delete(id)
        const waiters = tweenWaiters.get(id)
        if (waiters) {
          tweenWaiters.delete(id)
          for (const resolve of waiters) resolve()
        }
      } else {
        moving = true
      }
    }
    return moving
  }

  const ensureRaf = (): void => {
    if (rafId === 0) rafId = requestAnimationFrame(frame)
  }

  const requestDraw = (): void => {
    ensureRaf()
  }

  const frame = (t: number): void => {
    rafId = 0
    const moving = stepRenderPos(t)
    const keepGoing = onFrame(t, moving)
    if (moving || keepGoing) ensureRaf()
  }

  return {renderPos, anim, now, waitTween, startEase, stepRenderPos, ensureRaf, requestDraw}
}
