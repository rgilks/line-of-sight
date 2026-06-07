// The single-player game reducer: a total, pure (state, action) → state. The only
// impurity is an injectable `rng` for the combat throws (defaults to Math.random);
// pass a seeded rng to replay a fight deterministically. Animation/timing lives in
// the DOM shell (solo.ts), never here.
import {distanceToOccluder, doorReachForGrid, visibilityPolygon} from '../../../core/los'
import {orderByInitiative, pointInPolygon} from '../../../core/rules'
import {roll2D6, type Rng} from '../../../core/dice'
import {applyDamage, applyHeal, resolveAttack, resolveFirstAid} from './combat'
import {weaponById} from './gear'
import {cellCenter, cellOf, isFloor} from './grid'
import {
  activeEntity,
  AIM_MAX,
  canSeePoint,
  dexDm,
  entityById,
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
  type CombatStance,
  type Entity,
  type ItemStack,
  type SoloState
} from './model'

const LOG_KEEP = 60
const log = (state: SoloState, ...lines: string[]): SoloState => ({
  ...state,
  log: [...state.log, ...lines].slice(-LOG_KEEP)
})

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

// Cepheus action economy (see model.ts). The active entity's turn is a single
// budget (moveRemainingPx). A minor action costs one 6 m move's worth; a
// significant action costs two. Movement spends it continuously.
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

// --- movement --------------------------------------------------------------
const applyMove = (state: SoloState, to: {x: number; y: number}): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return state

  const cell = cellOf(state.grid, to.x, to.y)
  if (!isFloor(state.grid, cell.cx, cell.cy)) return log(state, 'That way is blocked.')

  const dest = cellCenter(state.grid, cell.cx, cell.cy)
  const distance = Math.hypot(dest.x - actor.x, dest.y - actor.y)
  const moveCost = distance * movementCostMultiplier(actor)
  if (distance < 0.5) return state
  if (moveCost > state.moveRemainingPx + 0.5) return log(state, 'Out of movement this turn.')
  if (!canSee(state, actor, dest.x, dest.y)) return log(state, "Can't move where you can't see.")
  if (blockedCells(state, actor).has(cellKey(cell.cx, cell.cy))) return log(state, 'Something is in the way.')

  return {
    ...state,
    entities: replace(state, actor.id, (e) => ({...e, x: dest.x, y: dest.y, aim: 0})), // moving breaks aim
    moveRemainingPx: state.moveRemainingPx - moveCost
  }
}

// --- stance ----------------------------------------------------------------
const applySetStance = (state: SoloState, stance: CombatStance): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return state
  if (actor.stance === stance) return state
  const cost = minorCost(state, actor)
  if (!enough(state, cost)) return log(state, `${actor.label} has no actions left this turn.`)
  return log(
    {
      ...state,
      entities: replace(state, actor.id, (e) => ({...e, stance})),
      moveRemainingPx: state.moveRemainingPx - cost
    },
    `${actor.label} goes ${stanceLabel(stance).toLowerCase()}.`
  )
}

// --- aim -------------------------------------------------------------------
// Take aim: a significant action that adds +1 to the next attack (up to AIM_MAX),
// stacking across rounds. Lost by moving or taking a wound; spent on the next shot.
const applyAim = (state: SoloState): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return state
  if (!enough(state, significantCost(state, actor))) return log(state, `${actor.label} has no action left this turn.`)
  const aim = Math.min(actor.aim + 1, AIM_MAX)
  return log(
    {
      ...state,
      entities: replace(state, actor.id, (e) => ({...e, aim})),
      actionUsed: true,
      moveRemainingPx: state.moveRemainingPx - significantCost(state, actor)
    },
    `${actor.label} takes aim (+${aim}).`
  )
}

// --- doors -----------------------------------------------------------------
const applyToggleDoor = (state: SoloState, doorId: string): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return state
  const door = state.map.occluders.find((o) => o.id === doorId && o.type === 'door')
  if (!door) return state
  if (distanceToOccluder({x: actor.x, y: actor.y}, door) > doorReachForGrid(state.grid.gridScale)) {
    return log(state, 'Too far from that door.')
  }
  const cost = minorCost(state, actor) // working a door is a minor action
  if (!enough(state, cost)) return log(state, `${actor.label} has no actions left this turn.`)
  const open = !(state.doorStates[doorId]?.open ?? false)
  return log(
    {...state, doorStates: {...state.doorStates, [doorId]: {open}}, moveRemainingPx: state.moveRemainingPx - cost},
    open ? `${actor.label} opens a door.` : `${actor.label} closes a door.`
  )
}

// --- attack ----------------------------------------------------------------
const applyAttack = (state: SoloState, targetId: string, rng: Rng): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return state
  if (!enough(state, significantCost(state, actor))) return log(state, `${actor.label} has no action left this turn.`)
  const target = entityById(state, targetId)
  if (!target || target.faction === actor.faction || isDead(target)) return state

  const weapon = weaponById(actor.weaponId)
  if (weapon.magazine !== undefined && actor.loadedRounds <= 0) {
    return log(state, `${actor.label} is out of ammo — reload!`)
  }

  // You can only fire on a foe you can personally see — not one only an ally has
  // line of sight to. No shooting through walls.
  if (!canSeePoint(state, actor, target.x, target.y)) {
    return log(state, `${actor.label} has no line of sight to ${target.label}.`)
  }

  const result = resolveAttack(actor, target, rng, state.grid.gridScale)
  if (result.outOfRange) return log(state, `${target.label} is out of range.`)

  const entities = state.entities.map((e) => {
    let next = e
    if (e.id === actor.id) {
      next = {...next, aim: 0} // the shot is taken — spend the aim
      if (weapon.magazine !== undefined) next = {...next, loadedRounds: next.loadedRounds - 1}
    }
    if (e.id === target.id && result.hit) next = applyDamage(next, result.damage) // applyDamage also clears the target's aim
    return next
  })

  const lines = [
    result.hit
      ? `${actor.label} hits ${target.label} for ${result.damage} (effect ${result.effect}).`
      : `${actor.label} misses ${target.label}.`
  ]
  const after = entities.find((e) => e.id === targetId)
  if (after && isDead(after)) lines.push(`${target.label} is killed.`)
  else if (after && isDown(after)) lines.push(`${target.label} is down.`)

  // Record the shot so the DOM shell can play the matching sound + visual effect.
  const lastAttack = {
    attackerId: actor.id,
    targetId,
    weaponId: weapon.id,
    hit: result.hit,
    effect: result.effect,
    damage: result.damage,
    killed: !!(after && isDead(after))
  }

  return checkLoss(
    log(
      {...state, entities, actionUsed: true, moveRemainingPx: state.moveRemainingPx - significantCost(state, actor), lastAttack},
      ...lines
    )
  )
}

// --- reload ----------------------------------------------------------------
const applyReload = (state: SoloState): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return state
  const weapon = weaponById(actor.weaponId)
  if (weapon.magazine === undefined) return state
  const need = weapon.magazine - actor.loadedRounds
  if (need <= 0) return log(state, `${actor.label}'s weapon is already loaded.`)
  const stackIndex = actor.inventory.findIndex(
    (s) => s.kind === 'ammo' && s.weaponId === actor.weaponId && s.count > 0
  )
  if (stackIndex < 0) return log(state, `${actor.label} has no spare ammo.`)
  const cost = minorCost(state, actor) // reloading is a minor action
  if (!enough(state, cost)) return log(state, `${actor.label} has no actions left this turn.`)
  const take = Math.min(need, actor.inventory[stackIndex].count)
  const inventory = actor.inventory
    .map((s, i) => (i === stackIndex ? {...s, count: s.count - take} : s))
    .filter((s) => s.count > 0)
  return log(
    {
      ...state,
      entities: replace(state, actor.id, (e) => ({...e, loadedRounds: e.loadedRounds + take, inventory})),
      moveRemainingPx: state.moveRemainingPx - cost
    },
    `${actor.label} reloads (${take} rounds).`
  )
}

// --- medkit (first aid) ----------------------------------------------------
const applyUseMedkit = (state: SoloState, targetId: string, rng: Rng): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return state
  if (!enough(state, significantCost(state, actor))) return log(state, `${actor.label} has no action left this turn.`)
  const medIndex = actor.inventory.findIndex((s) => s.kind === 'medkit' && s.count > 0)
  if (medIndex < 0) return log(state, `${actor.label} has no medkit.`)
  const target = entityById(state, targetId)
  if (!target || target.faction !== 'pc' || isDead(target)) return state
  if (!withinReach(actor, target, state.grid.gridScale)) return log(state, 'Move next to your patient.')

  const aid = resolveFirstAid(actor, rng)
  const spentInventory = actor.inventory
    .map((s, i) => (i === medIndex ? {...s, count: s.count - 1} : s))
    .filter((s) => s.count > 0)
  const entities = state.entities.map((e) => {
    let next = e
    if (e.id === actor.id) next = {...next, inventory: spentInventory}
    if (e.id === target.id && aid.heal > 0) next = applyHeal(next, aid.heal)
    return next
  })
  return log(
    {...state, entities, actionUsed: true, moveRemainingPx: state.moveRemainingPx - significantCost(state, actor)},
    aid.heal > 0 ? `${actor.label} treats ${target.label} (+${aid.heal}).` : `${actor.label}'s first aid fails.`
  )
}

// --- ground items ----------------------------------------------------------
const mergeStack = (inventory: ItemStack[], stack: ItemStack): ItemStack[] => {
  const index = inventory.findIndex((s) => s.kind === stack.kind && s.weaponId === stack.weaponId)
  if (index >= 0) return inventory.map((s, i) => (i === index ? {...s, count: s.count + stack.count} : s))
  return [...inventory, {...stack}]
}

const applyPickUp = (state: SoloState, groundItemId: string): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return state
  const item = state.ground.find((g) => g.id === groundItemId)
  if (!item) return state
  if (Math.hypot(actor.x - item.x, actor.y - item.y) > 1.6 * state.grid.gridScale) {
    return log(state, 'Too far to pick that up.')
  }
  const cost = minorCost(state, actor) // picking up is a minor action
  if (!enough(state, cost)) return log(state, `${actor.label} has no actions left this turn.`)
  const label =
    item.stack.kind === 'ammo'
      ? `${item.stack.count} rounds`
      : `${item.stack.count} medkit${item.stack.count > 1 ? 's' : ''}`
  return log(
    {
      ...state,
      entities: replace(state, actor.id, (e) => ({...e, inventory: mergeStack(e.inventory, item.stack)})),
      ground: state.ground.filter((g) => g.id !== groundItemId),
      moveRemainingPx: state.moveRemainingPx - cost
    },
    `${actor.label} picks up ${label}.`
  )
}

const applyDrop = (state: SoloState, stackIndex: number): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor)) return state
  const stack = actor.inventory[stackIndex]
  if (!stack) return state
  const item = {id: `g-${actor.id}-${state.ground.length}-${stackIndex}`, x: actor.x, y: actor.y, stack}
  return log(
    {
      ...state,
      entities: replace(state, actor.id, (e) => ({...e, inventory: e.inventory.filter((_, i) => i !== stackIndex)})),
      ground: [...state.ground, item]
    },
    `${actor.label} drops an item.`
  )
}

// --- crates / barricades ---------------------------------------------------
// Shove an adjacent crate one cell directly away from the actor onto open floor.
// Costs the significant action. Push crates into doorways to wall off the horde.
const applyPush = (state: SoloState, propId: string): SoloState => {
  const actor = activeEntity(state)
  if (!actor || !isActive(actor) || state.actionUsed) return state
  if (!enough(state, significantCost(state, actor))) return log(state, `${actor.label} has no action left this turn.`)
  const prop = state.props.find((p) => p.id === propId)
  if (!prop) return state
  const ac = cellOf(state.grid, actor.x, actor.y)
  const pc = cellOf(state.grid, prop.x, prop.y)
  if (Math.abs(pc.cx - ac.cx) + Math.abs(pc.cy - ac.cy) !== 1) {
    return log(state, 'Stand right next to the crate to push it.')
  }
  const dest = {cx: pc.cx + Math.sign(pc.cx - ac.cx), cy: pc.cy + Math.sign(pc.cy - ac.cy)}
  if (!isFloor(state.grid, dest.cx, dest.cy)) return log(state, "The crate won't budge — something behind it.")
  if (blockedCells(state, actor).has(cellKey(dest.cx, dest.cy))) return log(state, 'Something is blocking the crate.')
  const at = cellCenter(state.grid, dest.cx, dest.cy)
  return log(
    {
      ...state,
      props: state.props.map((p) => (p.id === propId ? {...p, x: at.x, y: at.y} : p)),
      actionUsed: true,
      moveRemainingPx: state.moveRemainingPx - significantCost(state, actor)
    },
    `${actor.label} shoves a crate.`
  )
}

// --- turn order ------------------------------------------------------------
// Advance to the next living, conscious entity (PC or monster); wrap → next round.
const applyEndTurn = (state: SoloState): SoloState => {
  const count = state.entities.length
  if (count === 0) return state
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
  return checkLoss({
    ...state,
    turnPtr: ptr,
    round,
    moveRemainingPx: turnBudgetPx(state.grid.gridScale, state.entities[ptr]?.moveMeters),
    actionUsed: false
  })
}

// A fresh wave boards: add the monsters, re-roll initiative for everyone, and
// hand the turn to the first living PC.
const applyAddWave = (state: SoloState, monsters: Entity[], rng: Rng): SoloState => {
  const rolled = [...state.entities, ...monsters].map((entity) => {
    const [a, b] = roll2D6(rng)
    return {...entity, initiative: a + b + dexDm(entity)}
  })
  const ordered = orderByInitiative(rolled)
  const firstPc = Math.max(
    0,
    ordered.findIndex((entity) => entity.faction === 'pc' && isActive(entity))
  )
  return log(
    {
      ...state,
      entities: ordered,
      wave: state.wave + 1,
      round: state.round + 1,
      turnPtr: firstPc,
      moveRemainingPx: turnBudgetPx(state.grid.gridScale, ordered[firstPc]?.moveMeters),
      actionUsed: false
    },
    `Wave ${state.wave + 1} boards!`
  )
}

export const reduce = (state: SoloState, action: Action, rng: Rng = Math.random): SoloState => {
  switch (action.t) {
    case 'Move':
      return applyMove(state, action.to)
    case 'ToggleDoor':
      return applyToggleDoor(state, action.doorId)
    case 'Attack':
      return applyAttack(state, action.targetId, rng)
    case 'Reload':
      return applyReload(state)
    case 'UseMedkit':
      return applyUseMedkit(state, action.targetId, rng)
    case 'PickUp':
      return applyPickUp(state, action.groundItemId)
    case 'Drop':
      return applyDrop(state, action.stackIndex)
    case 'PushProp':
      return applyPush(state, action.propId)
    case 'SetStance':
      return applySetStance(state, action.stance)
    case 'Aim':
      return applyAim(state)
    case 'AddWave':
      return applyAddWave(state, action.monsters, rng)
    case 'EndTurn':
      return applyEndTurn(state)
  }
}
