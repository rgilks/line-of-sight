// Phone controller for companion play: a heads-up gamepad for ONE character. It
// renders the per-character, LOS-gated controller projection streamed from a
// SoloRoom (the character HUD, the nearest visible foes, in-reach items, and
// adjacent doors) and posts authority-checked commands back. It deliberately
// renders NO map — the shared board screen carries the spatial picture, and the
// phone is operated heads-up by feel. Movement (a d-pad / move-to-target) lands
// in a later phase; this drives targeting, items, doors, stance, and turns.
//
// URL: /controller?table=<roomId>&actor=<characterId>[&seed=<n>]
import {installErrorReporting} from './error-reporting'
import type {ControllerView, FoeRow} from './solo/projection'
import './controller.css'

installErrorReporting('controller')

const params = new URLSearchParams(location.search)
const room = params.get('table') ?? 'demo'
const actor = params.get('actor') ?? ''
const seedParam = params.get('seed')

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app root.')
const root = app

let view: ControllerView | null = null
let selectedFoe: string | null = null
let note = 'Connecting…'

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

const send = async (command: Record<string, unknown>): Promise<void> => {
  try {
    const res = await fetch(`/api/solo/${encodeURIComponent(room)}/commands`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({...command, byActor: actor})
    })
    const body = (await res.json().catch(() => ({}))) as {accepted?: boolean; error?: string}
    note = body.accepted ? '' : (body.error ?? (res.ok ? 'Not your turn.' : 'Command failed.'))
  } catch {
    note = 'Network error.'
  }
  render()
}

// Atomic reducer actions ride in `action`; the d-pad uses send({step}).
const post = (action: Record<string, unknown>): void => void send({action})

const nextStance = (s: string): 'standing' | 'crouched' | 'prone' =>
  s === 'standing' ? 'crouched' : s === 'crouched' ? 'prone' : 'standing'

const foeRow = (foe: FoeRow): string =>
  `<button class="ctrl-foe${selectedFoe === foe.id ? ' is-selected' : ''}${foe.inRange ? '' : ' is-far'}" data-foe="${escapeHtml(foe.id)}">
     <span class="ctrl-foe-name">${escapeHtml(foe.label)}</span>
     <span class="ctrl-foe-meta">${escapeHtml(foe.band)}${foe.inRange ? ` · ${Math.round(foe.hitChance * 100)}%` : ' · out of range'}</span>
   </button>`

// The 8-way step d-pad as a 3x3 grid; the centre shows the move budget. A
// direction greys out when the projection says that step is illegal right now.
const DPAD: ReadonlyArray<readonly [string, number, number, string]> = [
  ['nw', -1, -1, '↖'],
  ['n', 0, -1, '↑'],
  ['ne', 1, -1, '↗'],
  ['w', -1, 0, '←'],
  ['', 0, 0, ''],
  ['e', 1, 0, '→'],
  ['sw', -1, 1, '↙'],
  ['s', 0, 1, '↓'],
  ['se', 1, 1, '↘']
]

const dpadHtml = (dirs: Record<string, boolean>, squares: number): string =>
  `<div class="ctrl-dpad">${DPAD.map(([k, dx, dy, label]) =>
    k === ''
      ? `<div class="ctrl-dpad-mid">${squares}<small>sq</small></div>`
      : `<button class="ctrl-dir" data-step="${dx},${dy}"${dirs[k] ? '' : ' disabled'}>${label}</button>`
  ).join('')}</div>`

const render = (): void => {
  if (!view) {
    root.innerHTML = `<div class="ctrl-boot">${escapeHtml(note)}</div>`
    return
  }
  const me = view.me
  const myTurn = !!me?.myTurn
  const turnLabel = !view.active
    ? '—'
    : myTurn
      ? 'YOUR TURN'
      : view.active.faction === 'monster'
        ? 'Enemy turn…'
        : 'Waiting…'
  const canAttack = myTurn && !!selectedFoe && view.foes.some((f) => f.id === selectedFoe && f.inRange)
  const adjacentDoors = view.doors.filter((d) => d.adjacent)
  root.innerHTML = `
    <header class="ctrl-hud">
      <div class="ctrl-turn${myTurn ? ' is-mine' : ''}">${escapeHtml(turnLabel)}</div>
      <div class="ctrl-wave">R${view.round} · W${view.wave}/${view.wavesTotal}</div>
    </header>
    ${
      me
        ? `<section class="ctrl-me">
      <strong class="ctrl-me-name">${escapeHtml(me.label)}</strong>
      <span class="ctrl-me-hp">END ${me.end}/${me.endMax} · STR ${me.str} · DEX ${me.dex}</span>
      <span class="ctrl-me-gear">${escapeHtml(me.weapon)}${me.magazine !== null ? ` ${me.loaded}/${me.magazine}` : ''} · ${escapeHtml(me.stance)}${me.aim ? ` · aim +${me.aim}` : ''}</span>
      <span class="ctrl-me-move">${myTurn ? `${me.moveSquaresLeft} sq left · ${me.actionUsed ? 'action spent' : 'action ready'}` : ''}</span>
    </section>`
        : ''
    }
    <section class="ctrl-list">
      <h2>Targets</h2>
      ${view.foes.length ? view.foes.map(foeRow).join('') : '<p class="ctrl-empty">No enemy in sight.</p>'}
    </section>
    ${
      view.items.length || view.containers.length
        ? `<section class="ctrl-list">
      <h2>In reach</h2>
      ${view.items.map((i) => `<button class="ctrl-act" data-pickup="${escapeHtml(i.id)}">Pick up ${escapeHtml(i.label)}</button>`).join('')}
      ${view.containers.map((c) => `<button class="ctrl-act" data-search="${escapeHtml(c.id)}">Search ${escapeHtml(c.label)}</button>`).join('')}
    </section>`
        : ''
    }
    ${
      adjacentDoors.length
        ? `<section class="ctrl-list">
      <h2>Doors</h2>
      ${adjacentDoors.map((d) => `<button class="ctrl-act" data-door="${escapeHtml(d.id)}">${d.locked ? 'Unlock' : d.open ? 'Close' : 'Open'} door${d.locked ? ' (locked)' : ''}</button>`).join('')}
    </section>`
        : ''
    }
    ${note ? `<p class="ctrl-note">${escapeHtml(note)}</p>` : ''}
    ${me && myTurn ? dpadHtml(view.dirs, me.moveSquaresLeft) : ''}
    <footer class="ctrl-actions">
      <button class="ctrl-btn ctrl-attack" data-do="attack"${canAttack ? '' : ' disabled'}>ATTACK</button>
      <button class="ctrl-btn" data-do="reload"${myTurn ? '' : ' disabled'}>Reload</button>
      <button class="ctrl-btn" data-do="aim"${myTurn ? '' : ' disabled'}>Aim</button>
      <button class="ctrl-btn" data-do="stance"${myTurn ? '' : ' disabled'}>Stance</button>
      <button class="ctrl-btn ctrl-end" data-do="end"${myTurn ? '' : ' disabled'}>END TURN</button>
    </footer>`
}

root.addEventListener('click', (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>(
    '[data-foe],[data-step],[data-pickup],[data-search],[data-door],[data-do]'
  )
  if (!el || !view) return
  if (el.dataset.foe) {
    selectedFoe = el.dataset.foe
    render()
    return
  }
  if (el.dataset.step) {
    const [dx, dy] = el.dataset.step.split(',').map(Number)
    void send({step: {dx, dy}})
    return
  }
  if (el.dataset.pickup) return void post({t: 'PickUp', groundItemId: el.dataset.pickup})
  if (el.dataset.search) return void post({t: 'Search', containerId: el.dataset.search})
  if (el.dataset.door) return void post({t: 'ToggleDoor', doorId: el.dataset.door})
  switch (el.dataset.do) {
    case 'attack':
      if (selectedFoe) void post({t: 'Attack', targetId: selectedFoe})
      break
    case 'reload':
      void post({t: 'Reload'})
      break
    case 'aim':
      void post({t: 'Aim'})
      break
    case 'stance':
      void post({t: 'SetStance', stance: nextStance(view.me?.stance ?? 'standing')})
      break
    case 'end':
      void post({t: 'EndTurn'})
      break
  }
})

const connect = (): void => {
  const url = `/api/solo/${encodeURIComponent(room)}/stream?actor=${encodeURIComponent(actor)}${
    seedParam ? `&seed=${encodeURIComponent(seedParam)}` : ''
  }`
  const source = new EventSource(url)
  source.onmessage = (event) => {
    const message = JSON.parse(event.data) as {view?: string; controller?: ControllerView}
    if (!message.controller) return
    view = message.controller
    if (selectedFoe && !view.foes.some((f) => f.id === selectedFoe)) selectedFoe = null
    note = ''
    render()
  }
  source.onerror = () => {
    note = 'Reconnecting…'
    render()
  }
}

if (!actor) {
  note = 'Open this from the board: it needs ?table=<room>&actor=<character>.'
  render()
} else {
  render()
  connect()
}
