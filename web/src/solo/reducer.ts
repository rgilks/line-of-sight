// The single-player game reducer: a total, pure (state, action) → state. No DOM,
// no randomness — so a whole session replays from an action list and unit-tests
// headless. Animation/timing lives in the DOM shell (solo.ts), never here.
import {distanceToOccluder, doorReachForGrid, visibilityPolygon} from '../../../core/los'
import {pointInPolygon} from '../../../core/rules'
import {cellCenter, cellOf, isFloor} from './grid'
import {
  activeEntity,
  isActive,
  moveBudgetPx,
  type Action,
  type Entity,
  type SoloState
} from './model'

const withLog = (state: SoloState, line: string): SoloState => ({
  ...state,
  log: [...state.log.slice(-40), line]
})

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

// Cells occupied by any living entity other than `exclude`.
const occupiedCells = (state: SoloState, exclude: Entity): Set<string> => {
  const set = new Set<string>()
  for (const entity of state.entities) {
    if (entity === exclude || !isActive(entity)) continue
    const cell = cellOf(state.grid, entity.x, entity.y)
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

// Move the active entity to the floor cell containing `to`, if reachable: within
// the remaining budget, on a floor cell, visible, and unoccupied.
const applyMove = (state: SoloState, to: {x: number; y: number}): SoloState => {
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || !isActive(actor)) return state

  const cell = cellOf(state.grid, to.x, to.y)
  if (!isFloor(state.grid, cell.cx, cell.cy)) return withLog(state, 'That way is blocked.')

  const dest = cellCenter(state.grid, cell.cx, cell.cy)
  const distance = Math.hypot(dest.x - actor.x, dest.y - actor.y)
  if (distance < 0.5) return state // already there
  if (distance > state.moveRemainingPx + 0.5) return withLog(state, 'Out of movement this turn.')
  if (!canSee(state, actor, dest.x, dest.y)) return withLog(state, "Can't move where you can't see.")
  if (occupiedCells(state, actor).has(cellKey(cell.cx, cell.cy))) {
    return withLog(state, 'A squadmate is already there.')
  }

  const entities = state.entities.map((entity) =>
    entity === actor ? {...entity, x: dest.x, y: dest.y} : entity
  )
  return {...state, entities, moveRemainingPx: state.moveRemainingPx - distance}
}

// Open/close a door the active entity is standing next to.
const applyToggleDoor = (state: SoloState, doorId: string): SoloState => {
  const actor = activeEntity(state)
  if (!actor || actor.faction !== 'pc' || !isActive(actor)) return state
  const door = state.map.occluders.find((o) => o.id === doorId && o.type === 'door')
  if (!door) return state
  if (distanceToOccluder({x: actor.x, y: actor.y}, door) > doorReachForGrid(state.grid.gridScale)) {
    return withLog(state, 'Too far from that door.')
  }
  const open = !(state.doorStates[doorId]?.open ?? false)
  return {
    ...state,
    doorStates: {...state.doorStates, [doorId]: {open}},
    log: [...state.log.slice(-40), open ? `${actor.label} opens a door.` : `${actor.label} closes a door.`]
  }
}

// Advance to the next living entity in initiative order; wrap → next round.
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
  return {
    ...state,
    turnPtr: ptr,
    round,
    moveRemainingPx: moveBudgetPx(state.grid.gridScale)
  }
}

export const reduce = (state: SoloState, action: Action): SoloState => {
  switch (action.t) {
    case 'Move':
      return applyMove(state, action.to)
    case 'ToggleDoor':
      return applyToggleDoor(state, action.doorId)
    case 'EndTurn':
      return applyEndTurn(state)
  }
}
