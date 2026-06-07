// SRD-flavoured custom aliens (not the SRD's random-animal tables). Each is a
// flat stat block: physical characteristics (which double as hits), a natural
// weapon + hide from the gear catalog, an attack skill, a move rate in metres,
// and a behaviour hint the Phase 4 AI reads. Three silhouettes — a fast swarmer,
// a slow bruiser, and a ranged spitter — so waves threaten from several angles.
import type {CounterKind} from '../../../core/rules'
import type {Skills, Stats} from './model'

export type MonsterBlock = {
  id: string
  kind: CounterKind // portrait
  name: string
  stats: Stats
  skills: Skills
  weaponId: string // key into WEAPONS (natural weapon)
  armorId: string | null // key into ARMORS (natural hide)
  moveMeters: number // some are faster than the 6 m PC default
  behaviour: 'hunter' | 'lurker'
}

export const MONSTERS: MonsterBlock[] = [
  {
    id: 'crawler',
    kind: 'insectoid',
    name: 'Crawler',
    stats: {str: 6, dex: 9, end: 5},
    skills: {'Melee Combat': 1},
    weaponId: 'claws',
    armorId: 'hide',
    moveMeters: 9, // fast swarmer
    behaviour: 'hunter'
  },
  {
    id: 'brute',
    kind: 'reptilian',
    name: 'Brute',
    stats: {str: 11, dex: 6, end: 12},
    skills: {'Melee Combat': 1},
    weaponId: 'maw',
    armorId: 'carapace',
    moveMeters: 6, // slow but tanky
    behaviour: 'hunter'
  },
  {
    id: 'spitter',
    kind: 'amphibian',
    name: 'Spitter',
    stats: {str: 5, dex: 8, end: 6},
    skills: {'Gun Combat': 1},
    weaponId: 'spit',
    armorId: null,
    moveMeters: 6, // hangs back and spits
    behaviour: 'lurker'
  }
]

export const monsterById = (id: string): MonsterBlock | undefined =>
  MONSTERS.find((monster) => monster.id === id)
