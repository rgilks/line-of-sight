// Monster turn planning. Pure: given the state and a monster id, decide where it
// steps and whether it attacks — no mutation, no animation. The DOM driver in
// solo.ts executes the plan (move with tweens, then attack).
//
// Behaviour: pick the nearest living PC; if already in weapon range with line of
// sight, attack; otherwise A* toward it (around walls, closed doors, crates, and
// other bodies), advance up to the move budget, and attack if the new position is
// in range. Barricades therefore actually stop monsters — a crate or shut door in
// the only corridor forces a detour or blocks them outright.
import {hasLineOfSight} from '../../../core/los'
import {findPath, type Cell} from '../../../core/pathfinding'
import {rangeBandFor} from './combat'
import {weaponById} from './gear'
import {cellCenter, cellOf, isFloor} from './grid'
import {isActive, type Entity, type SoloState} from './model'

export type MonsterPlan = {moves: Cell[]; attackTargetId?: string}

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`

const canAttackFrom = (state: SoloState, monster: Entity, target: Entity, fromX: number, fromY: number): boolean => {
  const weapon = weaponById(monster.weaponId)
  const band = rangeBandFor(Math.hypot(fromX - target.x, fromY - target.y), state.grid.gridScale)
  if (weapon.rangeDm[band] === undefined) return false
  return hasLineOfSight({x: fromX, y: fromY}, {x: target.x, y: target.y}, state.map.occluders, state.doorStates)
}

export const decideMonster = (state: SoloState, monsterId: string): MonsterPlan => {
  const monster = state.entities.find((e) => e.id === monsterId)
  if (!monster || !isActive(monster)) return {moves: []}

  const targets = state.entities.filter((e) => e.faction === 'pc' && isActive(e))
  if (targets.length === 0) return {moves: []}

  const distanceTo = (t: Entity): number => Math.hypot(monster.x - t.x, monster.y - t.y)
  const nearest = [...targets].sort((a, b) => distanceTo(a) - distanceTo(b))[0]

  // Already able to attack from where it stands?
  if (canAttackFrom(state, monster, nearest, monster.x, monster.y)) {
    return {moves: [], attackTargetId: nearest.id}
  }

  // Cells blocked for pathing: living bodies (not this monster) and crates.
  const blocked = new Set<string>()
  for (const e of state.entities) {
    if (e.id === monster.id || !isActive(e)) continue
    const c = cellOf(state.grid, e.x, e.y)
    blocked.add(cellKey(c.cx, c.cy))
  }
  for (const prop of state.props) {
    const c = cellOf(state.grid, prop.x, prop.y)
    blocked.add(cellKey(c.cx, c.cy))
  }

  const monsterCell = cellOf(state.grid, monster.x, monster.y)
  const targetCell = cellOf(state.grid, nearest.x, nearest.y)
  const path = findPath(monsterCell, targetCell, state.grid.cols, state.grid.rows, {
    canEnter: (cx, cy) => isFloor(state.grid, cx, cy) && !blocked.has(cellKey(cx, cy)),
    canStep: (from, to) =>
      hasLineOfSight(
        cellCenter(state.grid, from.cx, from.cy),
        cellCenter(state.grid, to.cx, to.cy),
        state.map.occluders,
        state.doorStates
      )
  })
  if (!path || path.length < 2) return {moves: []}

  // Steps between the monster and the target cell, capped to the move budget.
  const budgetCells = Math.max(0, Math.round((monster.moveMeters ?? 6) / 1.5))
  const interior = path.slice(1, -1) // drop the start and the target's (occupied) cell
  const steps = interior.slice(0, budgetCells)

  const finalCell = steps.length > 0 ? steps[steps.length - 1] : monsterCell
  const finalAt = cellCenter(state.grid, finalCell.cx, finalCell.cy)
  const attackable = [...targets]
    .sort((a, b) => Math.hypot(finalAt.x - a.x, finalAt.y - a.y) - Math.hypot(finalAt.x - b.x, finalAt.y - b.y))
    .find((t) => canAttackFrom(state, monster, t, finalAt.x, finalAt.y))

  return {moves: steps, attackTargetId: attackable?.id}
}
