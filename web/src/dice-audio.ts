// Procedural dice audio synthesised from the physics engine's contacts — no
// audio assets. The Rust engine reports each collision's kind (die / floor /
// wall), its impact speed, the tray-space contact point, and which die it was;
// plus a continuous per-frame "rolling energy" (sliding/spinning contact).
//
// Each discrete contact is rendered as a short, dull "thud" — a burst of
// low-passed noise with a fast decay. It is broadband (no tuned partials), so
// it reads as a thump rather than a pitched wooden block. Each thud is panned
// to the real contact point and bussed through one shared "box" reverb. On top
// of that a single continuous "scrape" voice swells while the dice tumble and
// fades as they settle, so a roll resolves naturally instead of cutting out.
//
// Each die carries a small fixed "size" offset so a handful reads as several
// distinct objects; the constants in MATERIALS are tuned by ear.

/** One collision reported by the engine (see `DiceRoller.take_impacts`). */
export type DiceContact = {
  /** 0 = die-on-die, 1 = die-on-floor, 2 = die-on-wall. */
  kind: number
  /** Approach speed along the contact normal. */
  vel: number
  /** Tray-space contact point (tray half-extent `TRAY_HALF`). */
  x: number
  z: number
  /** Index of the die, for a consistent per-die pitch. */
  die: number
}

/** Parse the engine's flat `take_impacts()` payload (stride 5) into contacts. */
export const parseDiceContacts = (raw: Float32Array): DiceContact[] => {
  const contacts: DiceContact[] = []
  for (let i = 0; i + 4 < raw.length; i += 5) {
    contacts.push({kind: raw[i], vel: raw[i + 1], x: raw[i + 2], z: raw[i + 3], die: raw[i + 4]})
  }
  return contacts
}

type Material = {
  /** Exponential decay of the thud (seconds) — short, so it's a thump not a tone. */
  decay: number
  /** One-pole lowpass coefficient baked into the noise (lower = duller body). */
  tone: number
  /** Per-voice lowpass cutoff at the softest / hardest impact (Hz). */
  lpMin: number
  lpMax: number
  /** Output level and reverb send for this surface. */
  base: number
  reverb: number
}

const TRAY_HALF = 1.7
const VARIANTS = 8
const MAX_VOICES = 16
// The engine reports impacts above ~2.2; map [2.2 .. ~18] onto [0 .. 1].
const IMPACT_FLOOR = 2.2
const IMPACT_SPAN = 16
// Rolling/scrape layer: energy (summed tangential speed) → gain.
const ROLL_GAIN_SCALE = 0.006
const ROLL_MAX_GAIN = 0.085

// Indexed by contact kind: 0 die-on-die, 1 die-on-floor, 2 die-on-wall.
const MATERIALS: Material[] = [
  {
    // die-on-die: the tightest, slightly highest thud.
    decay: 0.028,
    tone: 0.16,
    lpMin: 700,
    lpMax: 1800,
    base: 0.5,
    reverb: 0.1
  },
  {
    // die-on-floor: the lowest, fullest, dullest thud.
    decay: 0.05,
    tone: 0.085,
    lpMin: 380,
    lpMax: 1100,
    base: 0.7,
    reverb: 0.16
  },
  {
    // die-on-wall: a short, dull knock between the two.
    decay: 0.038,
    tone: 0.12,
    lpMin: 520,
    lpMax: 1400,
    base: 0.55,
    reverb: 0.13
  }
]

/** Small seeded PRNG so baked variants are deterministic across reloads. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A consistent per-die pitch multiplier so a handful reads as distinct dice. */
const diePitch = (die: number): number => 2 ** (((((die | 0) % 6) - 2.5) / 6) * 0.5)

/** Render one normalised "thud" for a material: a burst of low-passed noise
 *  with an exponential decay. Broadband (no tuned partials), so it reads as a
 *  dull thump rather than a pitched wooden block. */
const bakeHit = (ac: BaseAudioContext, spec: Material, seed: number): AudioBuffer => {
  const sr = ac.sampleRate
  const dur = Math.min(0.25, spec.decay * 6 + 0.008)
  const n = Math.max(1, Math.ceil(sr * dur))
  const buffer = ac.createBuffer(1, n, sr)
  const data = buffer.getChannelData(0)
  const rnd = mulberry32(seed)
  // Wander the decay a touch per bake so the variants are not audible clones.
  const decay = spec.decay * (0.9 + rnd() * 0.2)
  let lp = 0
  let peak = 1e-6
  for (let i = 0; i < n; i += 1) {
    const t = i / sr
    // One-pole lowpass on white noise gives a dull body; the exp envelope makes
    // it a short thump.
    lp += spec.tone * (rnd() * 2 - 1 - lp)
    const s = lp * Math.exp(-t / decay)
    data[i] = s
    const a = Math.abs(s)
    if (a > peak) peak = a
  }
  // Normalise, with a soft ~1ms attack and short release to avoid edge clicks.
  const norm = 0.92 / peak
  const attack = Math.max(1, Math.floor(sr * 0.001))
  const release = Math.max(1, Math.floor(sr * 0.004))
  for (let i = 0; i < n; i += 1) {
    let g = norm
    if (i < attack) g *= i / attack
    if (i > n - release) g *= (n - i) / release
    data[i] *= g
  }
  return buffer
}

/** Render a tight "box" impulse response for a small dice tray: a cluster of
 *  very early reflections (sub-2ms, i.e. a ~20-40cm box) over a short, lowpassed
 *  diffuse tail. Kept brief so it reads as a tray, not a room. */
const bakeBoxIR = (ac: BaseAudioContext): AudioBuffer => {
  const sr = ac.sampleRate
  const n = Math.max(1, Math.ceil(sr * 0.04))
  const buffer = ac.createBuffer(2, n, sr)
  const rnd = mulberry32(0x9e3779b9)
  const taps = [
    {t: 0.0004, g: 0.6},
    {t: 0.0008, g: 0.5},
    {t: 0.0014, g: 0.4},
    {t: 0.0022, g: 0.28}
  ]
  for (let ch = 0; ch < 2; ch += 1) {
    const d = buffer.getChannelData(ch)
    for (const tap of taps) {
      const idx = Math.floor((tap.t + (rnd() - 0.5) * 0.0004) * sr)
      if (idx >= 0 && idx < n) d[idx] += tap.g * (ch === 0 ? 1 : 0.85) * (rnd() > 0.5 ? 1 : -1)
    }
    let lp = 0
    for (let i = 0; i < n; i += 1) {
      const t = i / sr
      const white = (rnd() * 2 - 1) * Math.exp(-t / 0.008)
      lp += 0.4 * (white - lp)
      d[i] += lp * 0.45
    }
  }
  return buffer
}

/** A seamless looping noise bed (gently lowpassed) for the continuous scrape. */
const bakeLoopNoise = (ac: BaseAudioContext): AudioBuffer => {
  const sr = ac.sampleRate
  const n = Math.max(2, Math.ceil(sr * 1.5))
  const xf = Math.min(n >> 1, Math.floor(sr * 0.05))
  const tmp = new Float32Array(n + xf)
  const rnd = mulberry32(0x51ed2701)
  let lp = 0
  for (let i = 0; i < n + xf; i += 1) {
    const white = rnd() * 2 - 1
    lp += 0.5 * (white - lp)
    tmp[i] = lp
  }
  const buffer = ac.createBuffer(1, n, sr)
  const d = buffer.getChannelData(0)
  for (let i = 0; i < n; i += 1) d[i] = tmp[i]
  // Cross-fade the wrap so the loop seam is inaudible.
  for (let i = 0; i < xf; i += 1) {
    const t = i / xf
    d[i] = tmp[i] * t + tmp[n + i] * (1 - t)
  }
  return buffer
}

type AudioGraph = {
  ac: AudioContext
  bus: GainNode
  convolver: ConvolverNode
  hits: AudioBuffer[][]
  roll: {gain: GainNode; filter: BiquadFilterNode}
}

let graph: AudioGraph | null = null
let voiceCount = 0
let injectedContext: AudioContext | null = null

/** Render the dice through a caller-supplied AudioContext instead of creating
 * a private one. Concurrent contexts on one output device (e.g. a BlackHole
 * loopback during recording) glitch each other, so the app injects its shared
 * game context before the first roll. No-op after the graph exists. */
export const setDiceAudioContext = (context: AudioContext): void => {
  injectedContext = context
}

const ensureAudio = (): AudioGraph | null => {
  if (graph) {
    if (graph.ac.state === 'suspended') void graph.ac.resume()
    return graph
  }
  try {
    const Ctor =
      window.AudioContext ?? (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext
    if (!injectedContext && !Ctor) return null
    const ac = injectedContext ?? new Ctor()
    // Bus → air (a touch of high-shelf sparkle) → compressor → output. The
    // compressor glues a tumbling handful and keeps pile-ups from clipping.
    const bus = ac.createGain()
    bus.gain.value = 0.9
    const air = ac.createBiquadFilter()
    air.type = 'highshelf'
    air.frequency.value = 6000
    air.gain.value = 1.0
    const comp = ac.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 26
    comp.ratio.value = 3.2
    comp.attack.value = 0.003
    comp.release.value = 0.14
    bus.connect(air).connect(comp).connect(ac.destination)
    // One shared box reverb ties the isolated clicks into "inside a tray".
    const convolver = ac.createConvolver()
    convolver.buffer = bakeBoxIR(ac)
    const reverbReturn = ac.createGain()
    reverbReturn.gain.value = 0.4
    convolver.connect(reverbReturn).connect(bus)
    // Continuous scrape/roll voice: a looping bed gated by rolling energy.
    const rollNoise = ac.createBufferSource()
    rollNoise.buffer = bakeLoopNoise(ac)
    rollNoise.loop = true
    const rollFilter = ac.createBiquadFilter()
    rollFilter.type = 'bandpass'
    rollFilter.frequency.value = 340
    rollFilter.Q.value = 0.7
    const rollGain = ac.createGain()
    rollGain.gain.value = 0.0001
    rollNoise.connect(rollFilter).connect(rollGain).connect(bus)
    const rollSend = ac.createGain()
    rollSend.gain.value = 0.2
    rollGain.connect(rollSend).connect(convolver)
    rollNoise.start()
    const hits = MATERIALS.map((spec, k) =>
      Array.from({length: VARIANTS}, (_, v) => bakeHit(ac, spec, 1000 * (k + 1) + 7 * v + 1))
    )
    if (ac.state === 'suspended') void ac.resume()
    graph = {ac, bus, convolver, hits, roll: {gain: rollGain, filter: rollFilter}}
    return graph
  } catch {
    return null
  }
}

/** Play one dice collision. Safe to call before any user gesture (no-op until
 *  the AudioContext can start) and cheap to call many times per frame. */
export const playDiceContact = (contact: DiceContact): void => {
  const a = ensureAudio()
  if (!a || voiceCount >= MAX_VOICES) return
  const {ac, bus, convolver, hits} = a
  const kind = Math.min(2, Math.max(0, contact.kind | 0))
  const spec = MATERIALS[kind]
  const variants = hits[kind]
  const buffer = variants[(Math.random() * variants.length) | 0]
  const t = ac.currentTime
  const norm = Math.min(1, Math.max(0, (contact.vel - IMPACT_FLOOR) / IMPACT_SPAN))

  const src = ac.createBufferSource()
  src.buffer = buffer
  // Per-die pitch (distinct dice) × small per-hit jitter × a nudge for hard hits.
  src.playbackRate.value = diePitch(contact.die) * (0.985 + Math.random() * 0.03) * (1 + 0.04 * norm)

  const lp = ac.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.value = spec.lpMin + (spec.lpMax - spec.lpMin) * norm ** 0.7
  // A little resonance at the cutoff gives the thud some body without ringing.
  lp.Q.value = 1.1

  const vca = ac.createGain()
  vca.gain.value = spec.base * (0.22 + 0.78 * norm)

  const pan = ac.createStereoPanner()
  pan.pan.value = Math.max(-1, Math.min(1, contact.x / TRAY_HALF)) * 0.85

  src.connect(lp).connect(vca).connect(pan)
  pan.connect(bus)
  const send = ac.createGain()
  send.gain.value = spec.reverb
  pan.connect(send).connect(convolver)

  voiceCount += 1
  src.onended = () => {
    voiceCount -= 1
    try {
      src.disconnect()
      lp.disconnect()
      vca.disconnect()
      pan.disconnect()
      send.disconnect()
    } catch {
      // Nodes already torn down — nothing to clean up.
    }
  }
  src.start(t)
}

/** Drive the continuous scrape layer from the engine's per-frame rolling energy
 *  (summed tangential contact speed). Fast to swell, slower to fade. */
export const setDiceRolling = (energy: number): void => {
  const a = ensureAudio()
  if (!a) return
  const {ac, roll} = a
  const target = Math.min(ROLL_MAX_GAIN, Math.max(0, energy) * ROLL_GAIN_SCALE)
  roll.gain.gain.setTargetAtTime(target, ac.currentTime, target > 0.001 ? 0.03 : 0.08)
  roll.filter.frequency.setTargetAtTime(300 + Math.min(900, energy * 55), ac.currentTime, 0.05)
}

/** Fade the scrape layer out. No-op if no audio has started, so it never forces
 *  an AudioContext to exist before the first roll. */
export const stopDiceRolling = (): void => {
  if (!graph) return
  graph.roll.gain.gain.setTargetAtTime(0.0001, graph.ac.currentTime, 0.06)
}
