// The four pre-statted player characters for v1 (no character generation yet).
// Plain Cepheus stat blocks. Skill names match the character generator's parent
// skills ("Gun Combat", "Melee Combat", "Medicine") so a ccg-made character can
// later replace one of these wholesale. `spareAmmo` is rounds beyond the loaded
// magazine; `medkits` are first-aid kits carried.
import type {CounterKind} from '../../../core/rules'
import type {Skills, Stats} from './model'

export type PreGen = {
  id: string
  kind: CounterKind
  label: string
  stats: Stats
  skills: Skills
  weaponId: string
  armorId: string | null
  spareAmmo: number
  medkits: number
}

export const PARTY: PreGen[] = [
  {
    id: 'pc-vance',
    kind: 'marine',
    label: 'Vance',
    stats: {str: 9, dex: 8, end: 10},
    skills: {'Gun Combat': 2, 'Melee Combat': 1},
    weaponId: 'autorifle',
    armorId: 'cloth',
    spareAmmo: 40,
    medkits: 1
  },
  {
    id: 'pc-rell',
    kind: 'scout',
    label: 'Rell',
    stats: {str: 7, dex: 10, end: 7},
    skills: {'Gun Combat': 1, 'Melee Combat': 1},
    weaponId: 'autopistol',
    armorId: 'jack',
    spareAmmo: 45,
    medkits: 1
  },
  {
    id: 'pc-sora',
    kind: 'medic',
    label: 'Sora',
    stats: {str: 6, dex: 7, end: 8},
    skills: {Medicine: 2, 'Gun Combat': 0},
    weaponId: 'autopistol',
    armorId: 'cloth',
    spareAmmo: 30,
    medkits: 3
  },
  {
    id: 'pc-kade',
    kind: 'engineer',
    label: 'Kade',
    stats: {str: 8, dex: 6, end: 9},
    skills: {'Gun Combat': 1, 'Melee Combat': 0},
    weaponId: 'shotgun',
    armorId: 'cloth',
    spareAmmo: 18,
    medkits: 1
  }
]
