// The single-player game engine, event-sourced to match the multiplayer
// GameTable. `decide(state, action, rng)` validates a command and emits
// SoloEvents — facts carrying the *resolved outcomes* (the rolled dice, the final
// position, the damage dealt). `foldSolo(state, event)` applies an event
// deterministically with NO rng. So a game replays from its event log faithfully
// even across rule changes, and the SoloRoom persists/replays events exactly like
// the table does. `reduce` is kept as a thin (decide → fold) shim for the local
// /solo driver and the tests, so their behaviour is unchanged.
//
// The only impurity is the injectable `rng` for combat throws, and it lives only
// in `decide` (where outcomes are rolled into events); fold never touches it.
import {distanceToOccluder, doorReachForGrid, visibilityPolygon} from '../../../core/los'
import {orderByInitiative, pointInPolygon} from '../../../core/rules'
import {roll2D6, type Rng} from '../../../core/dice'
import {applyDamage, applyHeal, attackLog, HACK_TARGET, resolveAttack, resolveFirstAid, resolveHack} from './combat'
import {ARMORS, weaponById} from './gear'
import {cellCenter, cellOf, isFloor} from './grid'
import {
  activeEntity,
  AIM_MAX,
  canSeePoint,
  containerLabel,
  dexDm,
  entityById,
  hasKeycard,
  keyLabel,
  isActive,
  isDead,
  isDown,
  moveBudgetPx,
  movementCostMultiplier,
  SIGNIFICANT_ACTION_COST,
  stanceLabel,
  turnBudgetPx,
  withinReach,
  type Action,
  type AttackFx,
  type CombatStance,
  type Entity,
  type GroundItem,
  type ItemStack,
  type Seat,
  type SoloState
} from './model'
import {redistribute, type SeatAssignment} from './seats'

const LOG_KEEP = 60
const appendLines = (state: SoloState, lines: ReadonlyArray<string>): SoloState =>
  lines.length === 0 ? state : {...state, log: [...state.log, ...lines].slice(-LOG_KEEP)}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

// Cepheus action economy (see model.ts). A minor action costs one 6 m move's
// worth; a significant action costs two.
const minorCost = (state: SoloState, actor: Entity): number => moveBudgetPx(state.grid.gridScale, actor.moveMeters)
const significantCost = (state: SoloState, actor: Entity): number => SIGNIFICANT_ACTION_COST * minorCost(state, actor)
const enough = (state: SoloState, cost: number): boolean => state.moveRemainingPx + 0.5 >= cost

// Cells blocked for movement: living entities (except `exclude`) and crates.
const blockedCells = (state: SoloState, exclude: Entity): Set<string> => {
  const set = new Set<string>()
  for (const entity of state.entities) {
    if (entity === exclude || isDead(entity)) continue
    const cell = cellOf(state.grid, entity.x, entity.y)
    set.add(cellKey(cell.cx, cell.cy))
  }
  for (const prop of state.props) {
    const cell = cellOf(state.grid, prop.x, prop.y)
    set.add(cellKey(cell.cx, cell.cy))
  }
  return set
}

const canSee = (state: SoloState, from: Entity, x: number, y: number): boolean => {
  const polygon = visibilityPolygon(
    from.x,
    from.y,
    state.map.width,
    state.map.height,
    state.sightRadius,
    state.map.occluders,
    state.doorStates
  )
  return polygon.length >= 3 && pointInPolygon({x, y}, polygon)
}

// If every PC is dead or downed, the run is lost.
const checkLoss = (state: SoloState): SoloState => {
  const pcUp = state.entities.some((e) => e.faction === 'pc' && isActive(e))
  return pcUp ? state : {...state, phase: {t: 'lost'}}
}

const replace = (state: SoloState, id: string, change: (e: Entity) => Entity): Entity[] =>
  state.entities.map((e) => (e.id === id ? change(e) : e))

const mergeStack = (inventory: ItemStack[], stack: ItemStack): ItemStack[] => {
  const index = inventory.findIndex(
    (s) => s.kind === stack.kind && s.weaponId === stack.weaponId && s.keyId === stack.keyId
  )
  if (index >= 0) return inventory.map((s, i) => (i === index ? {...s, count: s.count + stack.count} : s))
  return [...inventory, {...stack}]
}

const lootLabel = (stack: ItemStack): string =>
  stack.kind === 'ammo'
    ? `${stack.count} rounds`
    : stack.kind === 'keycard'
      ? `a ${keyLabel(stack.keyId)} access card`
      : stack.kind === 'weapon'
        ? `a ${weaponById(stack.weaponId ?? '').name}`
        : stack.kind === 'armor'
          ? (ARMORS[stack.armorId ?? '']?.name ?? 'armour')
          : `${stack.count} medkit${stack.count > 1 ? 's' : ''}`

// The resolved equip outcome: which gear the actor ends with, the gear it drops
// to the floor (so nothing is lost), and the log line(s). Pure — fold just
// applies it. The dropped item's id derives from `state.ground.length`, so the
// caller passes a state whose ground already reflects any item being picked up.
type EquipOutcome = {
  equip: {weaponId?: string; armorId?: string | null; loadedRounds?: number}
  dropped: GroundItem | null
  lines: string[]
}
const equipGear = (state: SoloState, actor: Entity, stack: ItemStack): EquipOutcome => {
  const dropId = `g-old-${actor.id}-${state.ground.length}`
  if (stack.kind === 'weapon' && stack.weaponId) {
    const weapon = weaponById(stack.weaponId)
    const old = weaponById(actor.weaponId)
    const dropped =
      old.id === weapon.id
        ? null
        : {id: dropId, x: actor.x, y: actor.y, stack: {kind: 'weapon' as const, weaponId: old.id, count: 1}}
    return {
      equip: {weaponId: weapon.id, loadedRounds: weapon.magazine ?? 0},
      dropped,
      lines: [`${actor.label} takes up the ${weapon.name}${weapon.magazine ? ' (loaded)' : ''}.`]
    }
  }
  const armor = ARMORS[stack.armorId ?? '']
  const dropped = actor.armorId
    ? {id: dropId, x: actor.x, y: actor.y, stack: {kind: 'armor' as const, armorId: actor.armorId, count: 1}}
    : null
  return {
    equip: {armorId: stack.armorId ?? null},
    dropped,
    lines: [`${actor.label} dons ${armor?.name ?? 'armour'} (AR ${armor?.ar ?? 0}).`]
  }
}

// === Events: facts carrying resolved outcomes (the log of what happened). ===
type EquipFields = {weaponId?: string; armorId?: string | null; loadedRounds?: number}
export type SoloEvent =
  | {t: 'Moved'; actorId: string; x: number; y: number; cost: number}
  | {t: 'StanceSet'; actorId: string; stance: CombatStance; cost: number; line: string}
  | {t: 'Aimed'; actorId: string; aim: number; cost: number; line: string}
  | {
      t: 'DoorChanged'
      doorId: string | null
      open: boolean | null
      unlock: boolean
      spendAction: boolean
      cost: number
      line: string
    }
  | {
      t: 'Attacked'
      attackerId: string
      targetId: string
      hit: boolean
      damage: number
      spendAmmo: boolean
      fx: AttackFx
      cost: number
      lines: string[]
    }
  | {t: 'Reloaded'; actorId: string; stackIndex: number; take: number; cost: number; line: string}
  | {t: 'Healed'; actorId: string; targetId: string; medIndex: number; heal: number; cost: number; line: string}
  | {
      t: 'PickedUp'
      actorId: string
      groundItemId: string
      equip: EquipFields | null
      stack: ItemStack | null
      dropped: GroundItem | null
      cost: number
      lines: string[]
    }
  | {t: 'Dropped'; actorId: string; stackIndex: number; item: GroundItem; line: string}
  | {
      t: 'Searched'
      actorId: string
      containerId: string
      equip: EquipFields | null
      stack: ItemStack | null
      dropped: GroundItem | null
      cost: number
      lines: string[]
    }
  | {t: 'PropPushed'; propId: string; x: number; y: number; cost: number; line: string}
  | {t: 'TurnAdvanced'; turnPtr: number; round: number}
  | {t: 'WaveAdded'; entities: Entity[]; wave: number; round: number; turnPtr: number; line: string}
  | {t: 'Won'}
  // A player joins / leaves; `assignments` is the FULL post-redistribution piece
  // ownership (fold applies it wholesale — no recompute, so replay is exact).
  | {t: 'SeatClaimed'; seat: Seat; assignments: SeatAssignment[]}
  | {t: 'SeatReleased'; seatId: string; assignments: SeatAssignment[]}

// Apply a full ownership assignment to the PCs (null → unowned).
const applyOwners = (entities: Entity[], assignments: SeatAssignment[]): Entity[] => {
  const owners = new Map(assignments.map((a) => [a.pcId, a.owner]))
  return entities.map((e) => (owners.has(e.id) ? {...e, owner: owners.get(e.id) ?? undefined} : e))
}

const applyEquip = (state: SoloState, actorId: string, equip: EquipFields): Entity[] =>
  replace(state, actorId, (e) => ({
    ...e,
    ...(equip.weaponId !== undefined ? {weaponId: equip.weaponId, loadedRounds: equip.loadedRounds ?? 0} : {}),
    ...(equip.armorId !== undefined ? {armorId: equip.armorId} : {})
  }))

export const foldSolo = (state: SoloState, event: SoloEvent): SoloState => {
  switch (event.t) {
    case 'Moved':
      return {
        ...state,
        entities: replace(state, event.actorId, (e) => ({...e, x: event.x, y: event.y, aim: 0})),
        moveRemainingPx: state.moveRemainingPx - event.cost
      }
    case 'StanceSet':
      return appendLines(
        {
          ...state,
          entities: replace(state, event.actorId, (e) => ({...e, stance: event.stance})),
          moveRemainingPx: state.moveRemainingPx - event.cost
        },
        [event.line]
      )
    case 'Aimed':
      return appendLines(
        {
          ...state,
          entities: replace(state, event.actorId, (e) => ({...e, aim: event.aim})),
          actionUsed: true,
          moveRemainingPx: state.moveRemainingPx - event.cost
        },
        [event.line]
      )
    case 'DoorChanged': {
      let next: SoloState = {...state, moveRemainingPx: state.moveRemainingPx - event.cost}
      if (event.spendAction) next = {...next, actionUsed: true}
      if (event.doorId && event.unlock) {
        next = {...next, locks: {...next.locks, [event.doorId]: {...next.locks[event.doorId], unlocked: true}}}
      }
      if (event.doorId && event.open !== null) {
        next = {...next, doorStates: {...next.doorStates, [event.doorId]: {open: event.open}}}
      }
      return appendLines(next, [event.line])
    }
    case 'Attacked': {
      const entities = state.entities.map((e) => {
        let next = e
        if (e.id === event.attackerId) {
          next = {...next, aim: 0}
          if (event.spendAmmo) next = {...next, loadedRounds: next.loadedRounds - 1}
        }
        if (e.id === event.targetId && event.hit) next = applyDamage(next, event.damage)
        return next
      })
      return checkLoss(
        appendLines(
          {
            ...state,
            entities,
            actionUsed: true,
            moveRemainingPx: state.moveRemainingPx - event.cost,
            lastAttack: event.fx
          },
          event.lines
        )
      )
    }
    case 'Reloaded': {
      const actor = entityById(state, event.actorId)
      if (!actor) return state
      const inventory = actor.inventory
        .map((s, i) => (i === event.stackIndex ? {...s, count: s.count - event.take} : s))
        .filter((s) => s.count > 0)
      return appendLines(
        {
          ...state,
          entities: replace(state, event.actorId, (e) => ({
            ...e,
            loadedRounds: e.loadedRounds + event.take,
            inventory
          })),
          moveRemainingPx: state.moveRemainingPx - event.cost
        },
        [event.line]
      )
    }
    case 'Healed': {
      const actor = entityById(state, event.actorId)
      if (!actor) return state
      const spent = actor.inventory
        .map((s, i) => (i === event.medIndex ? {...s, count: s.count - 1} : s))
        .filter((s) => s.count > 0)
      const entities = state.entities.map((e) => {
        let next = e
        if (e.id === event.actorId) next = {...next, inventory: spent}
        if (e.id === event.targetId && event.heal > 0) next = applyHeal(next, event.heal)
        return next
      })
      return appendLines({...state, entities, actionUsed: true, moveRemainingPx: state.moveRemainingPx - event.cost}, [
        event.line
      ])
    }
    case 'PickedUp': {
      let ground = state.ground.filter((g) => g.id !== event.groundItemId)
      if (event.dropped) ground = [...ground, event.dropped]
      let entities = state.entities
      if (event.equip) entities = applyEquip(state, event.actorId, event.equip)
      else if (event.stack) {
        const stack = event.stack
        entities = replace(state, event.actorId, (e) => ({...e, inventory: mergeStack(e.inventory, stack)}))
      }
      return appendLines({...state, entities, ground, moveRemainingPx: state.moveRemainingPx - event.cost}, event.lines)
    }
    case 'Dropped':
      return appendLines(
        {
          ...state,
          entities: replace(state, event.actorId, (e) => ({
            ...e,
            inventory: e.inventory.filter((_, i) => i !== event.stackIndex)
          })),
          ground: [...state.ground, event.item]
        },
        [event.line]
      )
    case 'Searched': {
      const containers = state.containers.map((c) => (c.id === event.containerId ? {...c, searched: true} : c))
      let ground = state.ground
      if (event.dropped) ground = [...ground, event.dropped]
      let entities = state.entities
      if (event.equip) entities = applyEquip(state, event.actorId, event.equip)
      else if (event.stack) {
        const stack = event.stack
        entities = replace(state, event.actorId, (e) => ({...e, inventory: mergeStack(e.inventory, stack)}))
      }
      return appendLines(
        {...state, containers, entities, ground, moveRemainingPx: state.moveRemainingPx - event.cost},
        event.lines
      )
    }
    case 'PropPushed':
      return appendLines(
        {
          ...state,
          props: state.props.map((p) => (p.id === event.propId ? {...p, x: event.x, y: event.y} : p)),
          actionUsed: true,
          moveRemainingPx: state.moveRemainingPx - event.cost
        },
        [event.line]
      )
    case 'TurnAdvanced':
      return checkLoss({
        ...state,
        turnPtr: event.turnPtr,
        round: event.round,
        moveRemainingPx: turnBudgetPx(state.grid.gridScale, state.entities[event.turnPtr]?.moveMeters),
        actionUsed: false
      })
    case 'WaveAdded':
      return appendLines(
        {
          ...state,
          entities: event.entities,
          wave: event.wave,
          round: event.round,
          turnPtr: event.turnPtr,
          moveRemainingPx: turnBudgetPx(state.grid.gridScale, event.entities[event.turnPtr]?.moveMeters),
          actionUsed: false
        },
        [event.line]
      )
    case 'Won':
      return {...state, phase: {t: 'won'}}
    case 'SeatClaimed':
      return {...state, seats: [...state.seats, event.seat], entities: applyOwners(state.entities, event.assignments)}
    case 'SeatReleased':
      return {
        ...state,
        seats: state.seats.filter((s) => s.id !== event.seatId),
        entities: applyOwners(state.entities, event.assignments)
      }
  }
}

// === decide: validate a command, roll outcomes, emit events (or reject). ===
// `rejected` carries a feedback message (or null for a silent no-op); the shim
// turns a message into a log line, and the SoloRoom returns it to the phone.
export type DecideResult = {events: SoloEvent[]} | {rejected: string | null}
const ok = (event: SoloEvent): DecideResult => ({events: [event]})
const reject = (message: string | null = null): DecideResult => ({rejected: message})

const decideMove = (state: SoloState, to: {x: number; y: number}): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  const cell = cellOf(state.grid, to.x, to.y)
  if (!isFloor(state.grid, cell.cx, cell.cy)) return reject('That way is blocked.')
  const dest = cellCenter(state.grid, cell.cx, cell.cy)
  const distance = Math.hypot(dest.x - actor.x, dest.y - actor.y)
  const moveCost = distance * movementCostMultiplier(actor)
  if (distance < 0.5) return reject()
  if (moveCost > state.moveRemainingPx + 0.5) return reject('Out of movement this turn.')
  if (!canSee(state, actor, dest.x, dest.y)) return reject("Can't move where you can't see.")
  if (blockedCells(state, actor).has(cellKey(cell.cx, cell.cy))) return reject('Something is in the way.')
  return ok({t: 'Moved', actorId: actor.id, x: dest.x, y: dest.y, cost: moveCost})
}

const decideStance = (state: SoloState, stance: CombatStance): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  if (actor.stance === stance) return reject()
  const cost = minorCost(state, actor)
  if (!enough(state, cost)) return reject(`${actor.label} has no actions left this turn.`)
  return ok({
    t: 'StanceSet',
    actorId: actor.id,
    stance,
    cost,
    line: `${actor.label} goes ${stanceLabel(stance).toLowerCase()}.`
  })
}

const decideAim = (state: SoloState): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return reject()
  const cost = significantCost(state, actor)
  if (!enough(state, cost)) return reject(`${actor.label} has no action left this turn.`)
  const aim = Math.min(actor.aim + 1, AIM_MAX)
  return ok({t: 'Aimed', actorId: actor.id, aim, cost, line: `${actor.label} takes aim (+${aim}).`})
}

const decideDoor = (state: SoloState, doorId: string, rng: Rng): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  const door = state.map.occluders.find((o) => o.id === doorId && o.type === 'door')
  if (!door) return reject()
  if (distanceToOccluder({x: actor.x, y: actor.y}, door) > doorReachForGrid(state.grid.gridScale)) {
    return reject('Too far from that door.')
  }
  const currentlyOpen = state.doorStates[doorId]?.open ?? false
  const lock = state.locks[doorId]
  if (!currentlyOpen && lock && !lock.unlocked) {
    if (lock.kind === 'key') {
      if (!hasKeycard(actor, lock.keyId))
        return reject(`That door is locked — needs a ${keyLabel(lock.keyId)} keycard.`)
      const cost = minorCost(state, actor)
      if (!enough(state, cost)) return reject(`${actor.label} has no actions left this turn.`)
      return ok({
        t: 'DoorChanged',
        doorId,
        open: true,
        unlock: true,
        spendAction: false,
        cost,
        line: `${actor.label} badges the ${keyLabel(lock.keyId)} lock — access granted.`
      })
    }
    if (state.actionUsed) return reject()
    const cost = significantCost(state, actor)
    if (!enough(state, cost)) return reject(`${actor.label} has no action left this turn.`)
    const h = resolveHack(actor, rng)
    const sign = h.skill >= 0 ? `+${h.skill}` : `${h.skill}`
    const detail = `(2D6 ${h.dice[0]}+${h.dice[1]} ${sign} Electronics = ${h.roll} vs ${HACK_TARGET})`
    if (!h.success) {
      return ok({
        t: 'DoorChanged',
        doorId: null,
        open: null,
        unlock: false,
        spendAction: true,
        cost,
        line: `${actor.label} fails to hack the lock ${detail}.`
      })
    }
    return ok({
      t: 'DoorChanged',
      doorId,
      open: true,
      unlock: true,
      spendAction: true,
      cost,
      line: `${actor.label} hacks the lock — ACCESS GRANTED ${detail}.`
    })
  }
  const cost = minorCost(state, actor)
  if (!enough(state, cost)) return reject(`${actor.label} has no actions left this turn.`)
  const open = !currentlyOpen
  return ok({
    t: 'DoorChanged',
    doorId,
    open,
    unlock: false,
    spendAction: false,
    cost,
    line: open ? `${actor.label} opens a door.` : `${actor.label} closes a door.`
  })
}

const decideAttack = (state: SoloState, targetId: string, rng: Rng): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return reject()
  if (!enough(state, significantCost(state, actor))) return reject(`${actor.label} has no action left this turn.`)
  const target = entityById(state, targetId)
  if (!target || target.faction === actor.faction || isDead(target)) return reject()
  const weapon = weaponById(actor.weaponId)
  if (weapon.magazine !== undefined && actor.loadedRounds <= 0) return reject(`${actor.label} is out of ammo — reload!`)
  if (!canSeePoint(state, actor, target.x, target.y))
    return reject(`${actor.label} has no line of sight to ${target.label}.`)
  const result = resolveAttack(actor, target, rng, state.grid.gridScale)
  if (result.outOfRange) return reject(`${target.label} is out of range.`)
  const damaged = result.hit ? applyDamage(target, result.damage) : target
  const lines = attackLog(actor, target, result)
  if (isDead(damaged)) lines.push(`${target.label} is killed.`)
  else if (isDown(damaged)) lines.push(`${target.label} is down.`)
  const fx: AttackFx = {
    attackerId: actor.id,
    targetId,
    weaponId: weapon.id,
    hit: result.hit,
    effect: result.effect,
    damage: result.damage,
    killed: isDead(damaged)
  }
  return ok({
    t: 'Attacked',
    attackerId: actor.id,
    targetId,
    hit: result.hit,
    damage: result.damage,
    spendAmmo: weapon.magazine !== undefined,
    fx,
    cost: significantCost(state, actor),
    lines
  })
}

const decideReload = (state: SoloState): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  const weapon = weaponById(actor.weaponId)
  if (weapon.magazine === undefined) return reject()
  const need = weapon.magazine - actor.loadedRounds
  if (need <= 0) return reject(`${actor.label}'s weapon is already loaded.`)
  const stackIndex = actor.inventory.findIndex((s) => s.kind === 'ammo' && s.weaponId === actor.weaponId && s.count > 0)
  if (stackIndex < 0) return reject(`${actor.label} has no spare ammo.`)
  const cost = minorCost(state, actor)
  if (!enough(state, cost)) return reject(`${actor.label} has no actions left this turn.`)
  const take = Math.min(need, actor.inventory[stackIndex].count)
  return ok({
    t: 'Reloaded',
    actorId: actor.id,
    stackIndex,
    take,
    cost,
    line: `${actor.label} reloads (${take} rounds).`
  })
}

const decideMedkit = (state: SoloState, targetId: string, rng: Rng): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return reject()
  if (!enough(state, significantCost(state, actor))) return reject(`${actor.label} has no action left this turn.`)
  const medIndex = actor.inventory.findIndex((s) => s.kind === 'medkit' && s.count > 0)
  if (medIndex < 0) return reject(`${actor.label} has no medkit.`)
  const target = entityById(state, targetId)
  if (!target || target.faction !== 'pc' || isDead(target)) return reject()
  if (!withinReach(actor, target, state.grid.gridScale)) return reject('Move next to your patient.')
  const aid = resolveFirstAid(actor, rng)
  return ok({
    t: 'Healed',
    actorId: actor.id,
    targetId,
    medIndex,
    heal: aid.heal,
    cost: significantCost(state, actor),
    line: aid.heal > 0 ? `${actor.label} treats ${target.label} (+${aid.heal}).` : `${actor.label}'s first aid fails.`
  })
}

const decidePickUp = (state: SoloState, groundItemId: string): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  const item = state.ground.find((g) => g.id === groundItemId)
  if (!item) return reject()
  if (Math.hypot(actor.x - item.x, actor.y - item.y) > 1.6 * state.grid.gridScale)
    return reject('Too far to pick that up.')
  const cost = minorCost(state, actor)
  if (!enough(state, cost)) return reject(`${actor.label} has no actions left this turn.`)
  if (item.stack.kind === 'weapon' || item.stack.kind === 'armor') {
    const remaining = state.ground.filter((g) => g.id !== groundItemId)
    const eq = equipGear({...state, ground: remaining}, actor, item.stack)
    return ok({
      t: 'PickedUp',
      actorId: actor.id,
      groundItemId,
      equip: eq.equip,
      stack: null,
      dropped: eq.dropped,
      cost,
      lines: eq.lines
    })
  }
  return ok({
    t: 'PickedUp',
    actorId: actor.id,
    groundItemId,
    equip: null,
    stack: item.stack,
    dropped: null,
    cost,
    lines: [`${actor.label} picks up ${lootLabel(item.stack)}.`]
  })
}

const decideDrop = (state: SoloState, stackIndex: number): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  const stack = actor.inventory[stackIndex]
  if (!stack) return reject()
  const item = {id: `g-${actor.id}-${state.ground.length}-${stackIndex}`, x: actor.x, y: actor.y, stack}
  return ok({t: 'Dropped', actorId: actor.id, stackIndex, item, line: `${actor.label} drops an item.`})
}

const decideSearch = (state: SoloState, containerId: string): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return reject()
  const container = state.containers.find((c) => c.id === containerId)
  if (!container || container.searched) return reject()
  if (Math.hypot(actor.x - container.x, actor.y - container.y) > 1.6 * state.grid.gridScale)
    return reject('Too far to search that.')
  const cost = minorCost(state, actor)
  if (!enough(state, cost)) return reject(`${actor.label} has no actions left this turn.`)
  const lines = [`${actor.label} searches the ${containerLabel(container.kind)}.`]
  let equip: EquipFields | null = null
  let stack: ItemStack | null = null
  let dropped: GroundItem | null = null
  if (container.loot) {
    const loot = container.loot
    lines.push(`  ${actor.label} finds ${lootLabel(loot)}.`)
    if (loot.kind === 'weapon' || loot.kind === 'armor') {
      const eq = equipGear(state, actor, loot)
      equip = eq.equip
      dropped = eq.dropped
    } else {
      stack = loot
    }
  }
  if (container.clue) lines.push(`  ${container.clue}`)
  if (!container.loot && !container.clue) lines.push('  …nothing of use.')
  return ok({t: 'Searched', actorId: actor.id, containerId, equip, stack, dropped, cost, lines})
}

const decidePush = (state: SoloState, propId: string): DecideResult => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return reject()
  if (!enough(state, significantCost(state, actor))) return reject(`${actor.label} has no action left this turn.`)
  const prop = state.props.find((p) => p.id === propId)
  if (!prop) return reject()
  const ac = cellOf(state.grid, actor.x, actor.y)
  const pc = cellOf(state.grid, prop.x, prop.y)
  if (Math.abs(pc.cx - ac.cx) + Math.abs(pc.cy - ac.cy) !== 1)
    return reject('Stand right next to the crate to push it.')
  const dest = {cx: pc.cx + Math.sign(pc.cx - ac.cx), cy: pc.cy + Math.sign(pc.cy - ac.cy)}
  if (!isFloor(state.grid, dest.cx, dest.cy)) return reject("The crate won't budge — something behind it.")
  if (blockedCells(state, actor).has(cellKey(dest.cx, dest.cy))) return reject('Something is blocking the crate.')
  const at = cellCenter(state.grid, dest.cx, dest.cy)
  return ok({
    t: 'PropPushed',
    propId,
    x: at.x,
    y: at.y,
    cost: significantCost(state, actor),
    line: `${actor.label} shoves a crate.`
  })
}

const decideEndTurn = (state: SoloState): DecideResult => {
  const count = state.entities.length
  if (count === 0) return reject()
  let ptr = state.turnPtr
  let round = state.round
  for (let step = 0; step < count; step += 1) {
    ptr += 1
    if (ptr >= count) {
      ptr = 0
      round += 1
    }
    if (isActive(state.entities[ptr])) break
  }
  return ok({t: 'TurnAdvanced', turnPtr: ptr, round})
}

const decideAddWave = (state: SoloState, monsters: Entity[], rng: Rng): DecideResult => {
  const rolled = [...state.entities, ...monsters].map((entity) => {
    const [a, b] = roll2D6(rng)
    return {...entity, initiative: a + b + dexDm(entity)}
  })
  const ordered = orderByInitiative(rolled)
  const firstPc = Math.max(
    0,
    ordered.findIndex((entity) => entity.faction === 'pc' && isActive(entity))
  )
  return ok({
    t: 'WaveAdded',
    entities: ordered,
    wave: state.wave + 1,
    round: state.round + 1,
    turnPtr: firstPc,
    line: `Wave ${state.wave + 1} boards!`
  })
}

// Seat lifecycle: a player joins / leaves, which redistributes piece ownership
// across the present seats (see seats.ts). Ungated by turn — anyone may claim a
// free seat at any time (open join). The event carries the full new ownership map.
const decideClaimSeat = (state: SoloState, seatId: string, joinedAt: number): DecideResult => {
  if (state.seats.some((s) => s.id === seatId)) return reject() // already seated
  const seats: Seat[] = [...state.seats, {id: seatId, joinedAt}]
  const pcs = state.entities.filter((e) => e.faction === 'pc')
  return ok({
    t: 'SeatClaimed',
    seat: {id: seatId, joinedAt},
    assignments: redistribute(seats, pcs, activeEntity(state)?.id)
  })
}

const decideReleaseSeat = (state: SoloState, seatId: string): DecideResult => {
  if (!state.seats.some((s) => s.id === seatId)) return reject() // not seated
  const seats = state.seats.filter((s) => s.id !== seatId)
  const pcs = state.entities.filter((e) => e.faction === 'pc')
  return ok({t: 'SeatReleased', seatId, assignments: redistribute(seats, pcs, activeEntity(state)?.id)})
}

// In multi-actor "companion" play (see docs/COMPANION-PLAY.md) a command names the
// actor issuing it via `byActor`, and the seat (player) via `byPlayer`. A command is
// accepted only on the active character's turn (`byActor`) AND, when a seat is
// named, only if that seat OWNS the active character (`byPlayer`) — the authority
// gate that stops one phone from driving another's piece. Single-player, the monster
// AI, and the wave director pass neither and are ungated; seat claims are ungated by
// turn. Offline (`byPlayer` unset) the ownership clause is a no-op.
export const decide = (
  state: SoloState,
  action: Action,
  rng: Rng = Math.random,
  byActor?: string,
  byPlayer?: string
): DecideResult => {
  if (action.t === 'ClaimSeat') return decideClaimSeat(state, action.seatId, action.joinedAt)
  if (action.t === 'ReleaseSeat') return decideReleaseSeat(state, action.seatId)
  if (byActor !== undefined && activeEntity(state)?.id !== byActor) return reject()
  if (byPlayer !== undefined && entityById(state, byActor ?? '')?.owner !== byPlayer) return reject()
  switch (action.t) {
    case 'Move':
      return decideMove(state, action.to)
    case 'ToggleDoor':
      return decideDoor(state, action.doorId, rng)
    case 'Attack':
      return decideAttack(state, action.targetId, rng)
    case 'Reload':
      return decideReload(state)
    case 'UseMedkit':
      return decideMedkit(state, action.targetId, rng)
    case 'PickUp':
      return decidePickUp(state, action.groundItemId)
    case 'Drop':
      return decideDrop(state, action.stackIndex)
    case 'Search':
      return decideSearch(state, action.containerId)
    case 'PushProp':
      return decidePush(state, action.propId)
    case 'SetStance':
      return decideStance(state, action.stance)
    case 'Aim':
      return decideAim(state)
    case 'AddWave':
      return decideAddWave(state, action.monsters, rng)
    case 'EndTurn':
      return decideEndTurn(state)
  }
}

// decide → fold, also returning the events produced (empty on rejection). The
// solo client folds these into state for rendering AND persists them to IndexedDB
// so a closed tab resumes via the same replay() the server uses. A rejection with
// a message still appends that feedback line (old reducer behaviour) but yields no
// events; a silent rejection is a no-op.
export const reduceWithEvents = (
  state: SoloState,
  action: Action,
  rng: Rng = Math.random,
  byActor?: string,
  byPlayer?: string
): {state: SoloState; events: SoloEvent[]} => {
  const result = decide(state, action, rng, byActor, byPlayer)
  if ('rejected' in result) {
    return {state: result.rejected ? appendLines(state, [result.rejected]) : state, events: []}
  }
  return {state: result.events.reduce(foldSolo, state), events: result.events}
}

// Thin compatibility shim: decide → fold, discarding the event log.
export const reduce = (
  state: SoloState,
  action: Action,
  rng: Rng = Math.random,
  byActor?: string,
  byPlayer?: string
): SoloState => reduceWithEvents(state, action, rng, byActor, byPlayer).state
