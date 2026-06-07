// Combat feedback for the solo game: a weapon-specific sound, a projectile
// (bullet tracer / acid glob) or melee slash, and an impact burst — blood/ichor
// on a hit, a spark on a miss — at the point of contact. Pure presentation: the
// DOM shell calls spawnAttackFx() after an attack resolves, so the game reducer
// stays effect-free.
//
// Sounds are synthesised with the Web Audio API (no audio assets to ship). The
// visuals are drawn on the board canvas in board-pixel space (the same space as
// entities), layered on top of the tokens each frame; the render loop polls
// effectsActive() to keep animating while any are live.
import type {Point} from '../../../core/los'
import type {Weapon} from './gear'

// ---- timing + math primitives --------------------------------------------
const nowMs = (): number => performance.now()
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const easeOut = (t: number): number => 1 - (1 - t) ** 3

type Effect = {start: number; end: number; draw: (ctx: CanvasRenderingContext2D, t: number) => void}
const effects: Effect[] = []

// Global time scale (1 = real time). Bumped up only by the dev preview hook to
// slow effects down for inspection; production always runs at 1.
let timeScale = 1
export const setFxTimeScale = (s: number): void => {
  timeScale = Math.max(0.1, s)
}
/** Scale a duration / scheduled offset by the current time scale. */
const D = (ms: number): number => ms * timeScale

const add = (start: number, dur: number, draw: Effect['draw']): void => {
  effects.push({start, end: start + dur, draw})
}

/** Any effect still running or scheduled — the render loop polls this to keep rAF alive. */
export const effectsActive = (t: number = nowMs()): boolean => effects.some((e) => e.end > t)

/** Draw + reap active effects. Call at the end of the board draw, in board space. */
export const drawEffects = (ctx: CanvasRenderingContext2D, t: number = nowMs()): void => {
  for (let i = effects.length - 1; i >= 0; i -= 1) if (t > effects[i].end) effects.splice(i, 1)
  for (const e of effects) {
    if (t < e.start) continue
    ctx.save()
    e.draw(ctx, t)
    ctx.restore()
  }
}

/** Drop any in-flight effects (e.g. on a new game). */
export const clearEffects = (): void => {
  effects.length = 0
}

// ---- colours --------------------------------------------------------------
const TRACER = '#ffe9a8'
const TRACER_HEAD = '#fff6d8'
const MUZZLE = '#ffd27a'
const SPARK = '#c9d2c0'
const ACID = '#9bf23a'
const ACID_HOT = '#e8ffb0'
// Humans bleed red; the alien horde splatters violet ichor — both read clearly
// as gore and neither clashes with the board's phosphor-green.
const gore = (faction: 'pc' | 'monster'): string => (faction === 'pc' ? '#e7382b' : '#c558ff')

// ---- visual primitives ----------------------------------------------------
const spawnBurst = (
  at: Point,
  color: string,
  opts: {count?: number; reach: number; dur?: number; t?: number}
): void => {
  const t0 = opts.t ?? nowMs()
  const count = opts.count ?? 12
  const dur = D(opts.dur ?? 360)
  const parts = Array.from({length: count}, () => ({
    ang: Math.random() * Math.PI * 2,
    reach: opts.reach * (0.5 + Math.random() * 0.8),
    w: 1.4 + Math.random() * 2.2
  }))
  add(t0, dur, (ctx, t) => {
    const p = clamp((t - t0) / dur, 0, 1)
    const e = easeOut(p)
    const alpha = 1 - p
    ctx.lineCap = 'round'
    // hot flash core
    ctx.globalAlpha = alpha * 0.7
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(at.x, at.y, opts.reach * 0.28 * (1 - e) + 1.5, 0, Math.PI * 2)
    ctx.fill()
    // flung particles
    for (const part of parts) {
      const r = opts.reach * 0.12 + part.reach * e
      ctx.globalAlpha = alpha
      ctx.strokeStyle = color
      ctx.lineWidth = part.w * (1 - p * 0.5)
      ctx.beginPath()
      ctx.moveTo(at.x + Math.cos(part.ang) * opts.reach * 0.1, at.y + Math.sin(part.ang) * opts.reach * 0.1)
      ctx.lineTo(at.x + Math.cos(part.ang) * r, at.y + Math.sin(part.ang) * r)
      ctx.stroke()
    }
  })
}

const spawnFlash = (at: Point, toward: Point, gridScale: number, t0: number): void => {
  const dur = D(90)
  const ang = Math.atan2(toward.y - at.y, toward.x - at.x)
  const len = gridScale * 0.55
  add(t0, dur, (ctx, t) => {
    const p = clamp((t - t0) / dur, 0, 1)
    const a = 1 - p
    ctx.translate(at.x, at.y)
    ctx.rotate(ang)
    ctx.globalAlpha = a
    ctx.fillStyle = MUZZLE
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(len * (1 - p * 0.4), -gridScale * 0.13)
    ctx.lineTo(len * (1.25 - p * 0.4), 0)
    ctx.lineTo(len * (1 - p * 0.4), gridScale * 0.13)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = a * 0.9
    ctx.beginPath()
    ctx.arc(0, 0, gridScale * 0.17, 0, Math.PI * 2)
    ctx.fill()
  })
}

const spawnTracer = (from: Point, to: Point, t0: number, travel: number): void => {
  add(t0, travel + D(90), (ctx, t) => {
    const p = clamp((t - t0) / travel, 0, 1)
    ctx.lineCap = 'round'
    if (p < 1) {
      const hx = lerp(from.x, to.x, p)
      const hy = lerp(from.y, to.y, p)
      // faint trail from the muzzle to the round
      ctx.globalAlpha = 0.22
      ctx.strokeStyle = TRACER
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      // bright streak at the head, with a soft glow underlay
      const tailE = clamp(p - 0.22, 0, 1)
      const tx = lerp(from.x, to.x, tailE)
      const ty = lerp(from.y, to.y, tailE)
      ctx.lineCap = 'round'
      ctx.globalAlpha = 0.28
      ctx.strokeStyle = TRACER
      ctx.lineWidth = 8
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      ctx.globalAlpha = 0.98
      ctx.strokeStyle = TRACER_HEAD
      ctx.lineWidth = 3.5
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      // glowing head
      ctx.globalAlpha = 0.3
      ctx.fillStyle = TRACER
      ctx.beginPath()
      ctx.arc(hx, hy, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 0.95
      ctx.fillStyle = TRACER_HEAD
      ctx.beginPath()
      ctx.arc(hx, hy, 3.2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      // brief full-line afterimage fading once the round lands
      const fade = clamp((t - (t0 + travel)) / D(90), 0, 1)
      ctx.globalAlpha = (1 - fade) * 0.3
      ctx.strokeStyle = TRACER
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }
  })
}

const missPoint = (from: Point, to: Point, gridScale: number): Point => {
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const perp = ang + Math.PI / 2
  const side = Math.random() < 0.5 ? -1 : 1
  return {
    x: to.x + Math.cos(ang) * gridScale * 0.25 + Math.cos(perp) * side * gridScale * 0.4,
    y: to.y + Math.sin(ang) * gridScale * 0.25 + Math.sin(perp) * side * gridScale * 0.4
  }
}

const spawnBullets = (o: {
  from: Point
  to: Point
  rounds: number
  spread: number
  stagger: number
  gridScale: number
  hit: boolean
  bloodColor: string
}): number => {
  const t0 = nowMs()
  const dist = Math.hypot(o.to.x - o.from.x, o.to.y - o.from.y)
  const travel = D(clamp(dist / 7, 60, 190))
  const stagger = D(o.stagger)
  const ang = Math.atan2(o.to.y - o.from.y, o.to.x - o.from.x) + Math.PI / 2
  for (let i = 0; i < o.rounds; i += 1) {
    const st = t0 + i * stagger
    const off = (o.rounds === 1 ? 0 : i / (o.rounds - 1) - 0.5) * o.spread * o.gridScale
    const tgt = {x: o.to.x + Math.cos(ang) * off, y: o.to.y + Math.sin(ang) * off}
    spawnFlash(o.from, tgt, o.gridScale, st)
    spawnTracer(o.from, tgt, st, travel)
  }
  const arrive = t0 + (o.rounds - 1) * stagger + travel
  if (o.hit) {
    spawnBurst(o.to, o.bloodColor, {reach: o.gridScale * (o.rounds >= 5 ? 0.95 : 0.7), count: o.rounds >= 5 ? 16 : 12, dur: 380, t: arrive})
  } else {
    spawnBurst(missPoint(o.from, o.to, o.gridScale), SPARK, {reach: o.gridScale * 0.4, count: 7, dur: 240, t: arrive})
  }
  return arrive
}

const spawnMeleeFx = (o: {from: Point; to: Point; gridScale: number; hit: boolean; bloodColor: string}): number => {
  const t0 = nowMs()
  const dur = D(240)
  const ang = Math.atan2(o.to.y - o.from.y, o.to.x - o.from.x)
  const at = {x: lerp(o.from.x, o.to.x, 0.72), y: lerp(o.from.y, o.to.y, 0.72)}
  const r = o.gridScale * 0.55
  add(t0, dur, (ctx, t) => {
    const p = clamp((t - t0) / dur, 0, 1)
    const a = 1 - p
    const sweep = lerp(-0.9, 0.9, easeOut(p))
    ctx.translate(at.x, at.y)
    ctx.rotate(ang)
    ctx.lineCap = 'round'
    ctx.globalAlpha = a
    ctx.strokeStyle = '#eaf2ff'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(0, 0, r, sweep - 0.5, sweep + 0.5)
    ctx.stroke()
    ctx.globalAlpha = a * 0.5
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.8, sweep - 0.7, sweep + 0.3)
    ctx.stroke()
  })
  const impact = t0 + D(110)
  if (o.hit) spawnBurst(o.to, o.bloodColor, {reach: o.gridScale * 0.7, count: 12, dur: 360, t: impact})
  else spawnBurst(missPoint(o.from, o.to, o.gridScale), SPARK, {reach: o.gridScale * 0.35, count: 6, dur: 220, t: t0 + D(120)})
  return impact
}

const spawnAcidFx = (o: {from: Point; to: Point; gridScale: number; hit: boolean}): number => {
  const t0 = nowMs()
  const dist = Math.hypot(o.to.x - o.from.x, o.to.y - o.from.y)
  const travel = D(clamp(dist / 4.5, 120, 320))
  const arc = clamp(dist * 0.18, 8, o.gridScale * 1.4)
  add(t0, travel + D(40), (ctx, t) => {
    const p = clamp((t - t0) / travel, 0, 1)
    if (p >= 1) return
    for (let k = 4; k >= 0; k -= 1) {
      const pk = clamp(p - k * 0.06, 0, 1)
      const xk = lerp(o.from.x, o.to.x, pk)
      const yk = lerp(o.from.y, o.to.y, pk) - Math.sin(pk * Math.PI) * arc
      ctx.globalAlpha = (1 - k / 5) * 0.6
      ctx.fillStyle = k === 0 ? ACID_HOT : ACID
      ctx.beginPath()
      ctx.arc(xk, yk, o.gridScale * (k === 0 ? 0.15 : 0.12 * (1 - k / 6)), 0, Math.PI * 2)
      ctx.fill()
    }
  })
  spawnBurst(o.to, ACID, {reach: o.gridScale * 0.7, count: o.hit ? 14 : 8, dur: o.hit ? 420 : 260, t: t0 + travel})
  if (o.hit) spawnBurst(o.to, '#e7382b', {reach: o.gridScale * 0.45, count: 6, dur: 360, t: t0 + travel + D(40)})
  return t0 + travel
}

// An expanding ring — a flourish for high-Effect hits.
const spawnRing = (at: Point, color: string, reach: number, startMs: number, dur: number): void => {
  add(startMs, dur, (ctx, t) => {
    const p = clamp((t - startMs) / dur, 0, 1)
    ctx.globalAlpha = (1 - p) * 0.85
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, 4 * (1 - p))
    ctx.beginPath()
    ctx.arc(at.x, at.y, reach * easeOut(p), 0, Math.PI * 2)
    ctx.stroke()
  })
}

// Floating combat-text callout at the point of impact. Misses read "MISS"; hits
// escalate with the Cepheus Effect: a plain damage number, then HIT, SOLID HIT,
// CRITICAL, and KILL — bigger, brighter, longer-lived, with ring flourishes.
const spawnCombatText = (
  at: Point,
  info: {hit: boolean; effect: number; damage: number; killed: boolean},
  startMs: number,
  gridScale: number
): void => {
  let text: string
  let color: string
  let size: number
  let epic: number // 0..1 drama
  if (!info.hit) {
    text = 'MISS'
    color = '#aeb6ab'
    size = gridScale * 0.5
    epic = 0
  } else if (info.killed) {
    text = `KILL −${info.damage}`
    color = '#ff5247'
    size = gridScale * 0.82
    epic = 1
  } else if (info.effect >= 6) {
    text = `CRITICAL −${info.damage}`
    color = '#ffd35e'
    size = gridScale * 0.8
    epic = 1
  } else if (info.effect >= 4) {
    text = `SOLID HIT −${info.damage}`
    color = '#ffae42'
    size = gridScale * 0.62
    epic = 0.6
  } else if (info.effect >= 2) {
    text = `HIT −${info.damage}`
    color = '#ffd76a'
    size = gridScale * 0.56
    epic = 0.3
  } else {
    text = `−${info.damage}`
    color = '#ece5d2'
    size = gridScale * 0.52
    epic = 0.12
  }

  const dur = D(850 + epic * 550)
  const baseY = at.y - gridScale * 0.55
  add(startMs, dur, (ctx, t) => {
    const p = clamp((t - startMs) / dur, 0, 1)
    const rise = gridScale * (0.5 + epic * 0.7) * easeOut(p)
    const popDur = dur * 0.22
    const pp = clamp((t - startMs) / popDur, 0, 1)
    const overshoot = epic > 0.5 ? Math.sin(pp * Math.PI) * 0.2 : 0
    const scale = 0.5 + 0.5 * easeOut(pp) + overshoot
    ctx.globalAlpha = clamp(p < 0.62 ? 1 : 1 - (p - 0.62) / 0.38, 0, 1)
    ctx.translate(at.x, baseY - rise)
    ctx.scale(scale, scale)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `800 ${size}px "Orbitron", "JetBrains Mono", ui-sans-serif, sans-serif`
    ctx.lineWidth = Math.max(2, size * 0.14)
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'
    ctx.strokeText(text, 0, 0)
    ctx.fillStyle = color
    ctx.fillText(text, 0, 0)
  })

  if (epic >= 0.6) spawnRing(at, info.killed ? '#ff5247' : '#ffd35e', gridScale * 1.1, startMs, D(420))
  if (epic >= 1) spawnRing(at, '#fff0b0', gridScale * 1.7, startMs + D(60), D(540))
}

// ---- audio (procedural; no assets) ---------------------------------------
let actx: AudioContext | null = null
let master: GainNode | null = null

const audio = (): {ac: AudioContext; out: GainNode} | null => {
  try {
    if (!actx) {
      const AC = window.AudioContext ?? (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext
      if (!AC) return null
      actx = new AC()
      master = actx.createGain()
      master.gain.value = 0.5
      master.connect(actx.destination)
    }
    if (actx.state === 'suspended') void actx.resume()
    return master ? {ac: actx, out: master} : null
  } catch {
    return null
  }
}

/** Create + unlock the audio context. Call from a user gesture (browsers require
 * one before audio can play); safe to call repeatedly. */
export const primeAudio = (): void => {
  audio()
}

const noiseBuf = (ac: AudioContext, dur: number): AudioBuffer => {
  const n = Math.max(1, Math.floor(ac.sampleRate * dur))
  const b = ac.createBuffer(1, n, ac.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < n; i += 1) d[i] = Math.random() * 2 - 1
  return b
}

// Quick attack / exponential decay envelope (exp ramps must stay > 0).
const env = (param: AudioParam, t0: number, peak: number, attack: number, decay: number): void => {
  param.setValueAtTime(0.0001, t0)
  param.exponentialRampToValueAtTime(peak, t0 + attack)
  param.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
}

const playGun = (
  out: GainNode,
  ac: AudioContext,
  when: number,
  o: {dur: number; cut: number; thump: number; vol: number}
): void => {
  // The crack: a filtered noise burst.
  const src = ac.createBufferSource()
  src.buffer = noiseBuf(ac, o.dur)
  const lp = ac.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = o.cut
  const g = ac.createGain()
  env(g.gain, when, o.vol, 0.002, o.dur)
  src.connect(lp).connect(g).connect(out)
  src.start(when)
  src.stop(when + o.dur + 0.05)
  // The body: a short low thump that drops in pitch.
  const osc = ac.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(o.thump, when)
  osc.frequency.exponentialRampToValueAtTime(o.thump * 0.5, when + 0.12)
  const og = ac.createGain()
  env(og.gain, when, o.vol * 0.8, 0.002, 0.14)
  osc.connect(og).connect(out)
  osc.start(when)
  osc.stop(when + 0.22)
}

const playSwish = (out: GainNode, ac: AudioContext): void => {
  const t0 = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noiseBuf(ac, 0.22)
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 0.8
  bp.frequency.setValueAtTime(1800, t0)
  bp.frequency.exponentialRampToValueAtTime(420, t0 + 0.2)
  const g = ac.createGain()
  env(g.gain, t0, 0.32, 0.01, 0.2)
  src.connect(bp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.25)
}

const playAcid = (out: GainNode, ac: AudioContext): void => {
  const t0 = ac.currentTime
  const src = ac.createBufferSource()
  src.buffer = noiseBuf(ac, 0.34)
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 2
  bp.frequency.setValueAtTime(600, t0)
  bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.18)
  bp.frequency.exponentialRampToValueAtTime(800, t0 + 0.33)
  const g = ac.createGain()
  env(g.gain, t0, 0.3, 0.02, 0.3)
  src.connect(bp).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + 0.36)
}

export type SoundProfile = 'pistol' | 'rifle' | 'shotgun' | 'melee' | 'acid'

const playWeaponSound = (profile: SoundProfile): void => {
  const a = audio()
  if (!a) return
  const {ac, out} = a
  const t = ac.currentTime
  if (profile === 'pistol') playGun(out, ac, t, {dur: 0.12, cut: 2600, thump: 140, vol: 0.5})
  else if (profile === 'rifle') for (let i = 0; i < 3; i += 1) playGun(out, ac, t + i * 0.055, {dur: 0.09, cut: 3200, thump: 165, vol: 0.4})
  else if (profile === 'shotgun') playGun(out, ac, t, {dur: 0.26, cut: 1400, thump: 90, vol: 0.62})
  else if (profile === 'melee') playSwish(out, ac)
  else playAcid(out, ac)
}

// ---- weapon → sound/visual mapping ---------------------------------------
const soundProfile = (w: Weapon): SoundProfile => {
  if (w.id === 'shotgun') return 'shotgun'
  if (w.id === 'autorifle') return 'rifle'
  if (w.id === 'spit') return 'acid'
  if (w.category === 'melee') return 'melee'
  return 'pistol'
}

/**
 * Play the weapon's sound and spawn its projectile/strike + impact effect.
 * `from`/`to` are the attacker's and target's drawn positions (board pixels).
 */
export const spawnAttackFx = (o: {
  from: Point
  to: Point
  weapon: Weapon
  hit: boolean
  effect: number
  damage: number
  killed: boolean
  targetFaction: 'pc' | 'monster'
  gridScale: number
}): void => {
  playWeaponSound(soundProfile(o.weapon))
  const blood = gore(o.targetFaction)
  let arrive: number
  if (o.weapon.id === 'spit') {
    arrive = spawnAcidFx({from: o.from, to: o.to, gridScale: o.gridScale, hit: o.hit})
  } else if (o.weapon.category === 'melee') {
    arrive = spawnMeleeFx({from: o.from, to: o.to, gridScale: o.gridScale, hit: o.hit, bloodColor: blood})
  } else {
    const rounds = o.weapon.id === 'shotgun' ? 5 : o.weapon.id === 'autorifle' ? 3 : 1
    const spread = o.weapon.id === 'shotgun' ? 0.5 : o.weapon.id === 'autorifle' ? 0.12 : 0
    const stagger = o.weapon.id === 'autorifle' ? 55 : 0
    arrive = spawnBullets({from: o.from, to: o.to, rounds, spread, stagger, gridScale: o.gridScale, hit: o.hit, bloodColor: blood})
  }
  // The hit/miss + Effect callout lands with the projectile.
  spawnCombatText(o.to, {hit: o.hit, effect: o.effect, damage: o.damage, killed: o.killed}, arrive, o.gridScale)
}
