// Per-character projection for a phone controller: the view a single player sees.
// SECURITY-CRITICAL — every list is derived only from what THIS character can
// personally see (canSeePoint), never the squad's union and never the omniscient
// set. A foe the character cannot see is ABSENT from the list (not greyed), so a
// phone can never become an aimbot that sees through walls. The phone renders no
// map; the spatial picture is on the shared board screen.
import {predictAttack} from './combat'
import {weaponById} from './gear'
import {cellCenter, cellOf, isFloor} from './grid'
import {
  activeEntity,
  canSeePoint,
  containerLabel,
  entityById,
  isDead,
  isDown,
  movementCostMultiplier,
  type Faction,
  type GamePhase,
  type SoloState
} from './model'

// The 8 step directions for the controller d-pad, in compass order.
const DIRS: ReadonlyArray<readonly [string, number, number]> = [
  ['n', 0, -1],
  ['ne', 1, -1],
  ['e', 1, 0],
  ['se', 1, 1],
  ['s', 0, 1],
  ['sw', -1, 1],
  ['w', -1, 0],
  ['nw', -1, -1]
]

// P(2d6 >= k): the share of the 36 equally-likely outcomes whose sum is >= k.
const p2d6AtLeast = (k: number): number => {
  if (k <= 2) return 1
  if (k > 12) return 0
  const counts = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1] // sums 2..12
  let n = 0
  for (let sum = Math.max(2, Math.ceil(k)); sum <= 12; sum += 1) n += counts[sum - 2]
  return n / 36
}

const REACH_SQUARES = 1.6

export type FoeRow = {id: string; label: string; band: string; inRange: boolean; hitChance: number}
export type ReachRow = {id: string; label: string}
export type DoorRow = {id: string; open: boolean; locked: boolean; adjacent: boolean}

export type ControllerView = {
  active: {id: string; faction: Faction} | null
  round: number
  wave: number
  wavesTotal: number
  phase: GamePhase['t']
  me: {
    id: string
    label: string
    str: number
    dex: number
    end: number
    strMax: number
    dexMax: number
    endMax: number
    weapon: string
    loaded: number
    magazine: number | null
    stance: string
    aim: number
    myTurn: boolean
    actionUsed: boolean
    moveSquaresLeft: number
    down: boolean
    dead: boolean
  } | null
  foes: FoeRow[]
  items: ReachRow[]
  containers: ReachRow[]
  doors: DoorRow[]
  // 8-way step legality for the d-pad (compass key -> can step there now);
  // populated only on this character's turn so blocked arrows grey out before the
  // player taps blind.
  dirs: Record<string, boolean>
}

const groundLabel = (kind: string): string =>
  kind === 'ammo'
    ? 'ammo'
    : kind === 'medkit'
      ? 'medkit'
      : kind === 'keycard'
        ? 'access card'
        : kind === 'weapon'
          ? 'weapon'
          : kind === 'armor'
            ? 'armour'
            : kind

export const projectController = (state: SoloState, actorId: string): ControllerView => {
  const me = entityById(state, actorId)
  const active = activeEntity(state)
  const gridScale = state.grid.gridScale
  const reachPx = REACH_SQUARES * gridScale
  // Whether THIS character can personally see board point (x, y).
  const sees = (x: number, y: number): boolean => (me ? canSeePoint(state, me, x, y) : false)
  const near = (x: number, y: number): boolean => (me ? Math.hypot(me.x - x, me.y - y) <= reachPx : false)

  // Foes: only the monsters this character can personally see. Hidden foes are
  // absent — predictAttack runs only over the visible set, so no row, band, or
  // bearing ever leaks for a foe behind a wall.
  const foes: FoeRow[] = me
    ? state.entities
        .filter((e) => e.faction === 'monster' && !isDead(e) && sees(e.x, e.y))
        .map((foe) => {
          const pred = predictAttack(me, foe, gridScale, 0, 0)
          return {
            id: foe.id,
            label: foe.label,
            band: pred.band,
            inRange: !pred.outOfRange,
            hitChance: pred.outOfRange ? 0 : p2d6AtLeast(8 - pred.roll)
          }
        })
        .sort((a, b) => b.hitChance - a.hitChance)
    : []

  const items: ReachRow[] = me
    ? state.ground
        .filter((g) => sees(g.x, g.y) && near(g.x, g.y))
        .map((g) => ({id: g.id, label: groundLabel(g.stack.kind)}))
    : []

  const containers: ReachRow[] = me
    ? state.containers
        .filter((c) => !c.searched && sees(c.x, c.y) && near(c.x, c.y))
        .map((c) => ({id: c.id, label: containerLabel(c.kind)}))
    : []

  const doors: DoorRow[] = me
    ? state.map.occluders
        .filter((o) => o.type === 'door')
        .map((o) => ({o, mx: (o.x1 + o.x2) / 2, my: (o.y1 + o.y2) / 2}))
        // Visible doors, plus any the character is adjacent to — a closed door
        // blocks line of sight to itself, but you can always operate one you're
        // standing next to (and adjacency leaks nothing: you're touching it).
        .filter(({mx, my}) => sees(mx, my) || near(mx, my))
        .map(({o, mx, my}) => ({
          id: o.id,
          open: state.doorStates[o.id]?.open ?? false,
          locked: !!state.locks[o.id] && !state.locks[o.id].unlocked,
          adjacent: near(mx, my)
        }))
    : []

  const weapon = me ? weaponById(me.weaponId) : null

  // 8-way step legality for the d-pad — floor, unoccupied, in budget, and within
  // this character's own line of sight. Only meaningful on its turn.
  const dirs: Record<string, boolean> = {}
  if (me && active?.id === me.id) {
    const occupied = new Set<string>()
    for (const e of state.entities) {
      if (e === me || isDead(e)) continue
      const c = cellOf(state.grid, e.x, e.y)
      occupied.add(`${c.cx},${c.cy}`)
    }
    for (const p of state.props) {
      const c = cellOf(state.grid, p.x, p.y)
      occupied.add(`${c.cx},${c.cy}`)
    }
    const ac = cellOf(state.grid, me.x, me.y)
    const budget = state.moveRemainingPx
    const mult = movementCostMultiplier(me)
    for (const [k, dx, dy] of DIRS) {
      const center = cellCenter(state.grid, ac.cx + dx, ac.cy + dy)
      const cost = Math.hypot(center.x - me.x, center.y - me.y) * mult
      dirs[k] =
        isFloor(state.grid, ac.cx + dx, ac.cy + dy) &&
        !occupied.has(`${ac.cx + dx},${ac.cy + dy}`) &&
        cost <= budget + 0.5 &&
        canSeePoint(state, me, center.x, center.y)
    }
  }

  return {
    active: active ? {id: active.id, faction: active.faction} : null,
    round: state.round,
    wave: state.wave,
    wavesTotal: state.wavesTotal,
    phase: state.phase.t,
    me:
      me && weapon
        ? {
            id: me.id,
            label: me.label,
            str: me.stats.str,
            dex: me.stats.dex,
            end: me.stats.end,
            strMax: me.statsMax.str,
            dexMax: me.statsMax.dex,
            endMax: me.statsMax.end,
            weapon: weapon.name,
            loaded: me.loadedRounds,
            magazine: weapon.magazine ?? null,
            stance: me.stance,
            aim: me.aim,
            myTurn: active?.id === me.id,
            actionUsed: state.actionUsed,
            moveSquaresLeft: active?.id === me.id ? Math.round(state.moveRemainingPx / gridScale) : 0,
            down: isDown(me),
            dead: isDead(me)
          }
        : null,
    foes,
    items,
    containers,
    doors,
    dirs
  }
}
