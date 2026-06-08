// The four pre-statted player characters for v1 (no character generation yet).
// Plain Cepheus stat blocks. Skill names match the character generator's parent
// skills ("Gun Combat", "Melee Combat", "Medicine", "Electronics") so a ccg-made character can
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

// The squad boards lightly equipped — a basic sidearm or blade, no armour, little
// spare ammo. Better weapons, ammunition, and armour are scavenged from the deck's
// containers and floor loot.
export const PARTY: PreGen[] = [
  {
    id: 'pc-vance',
    kind: 'marine',
    label: 'Vance',
    stats: {str: 9, dex: 8, end: 10},
    skills: {'Gun Combat': 2, 'Melee Combat': 1},
    weaponId: 'autopistol',
    armorId: null,
    spareAmmo: 15,
    medkits: 1
  },
  {
    id: 'pc-rell',
    kind: 'scout',
    label: 'Rell',
    stats: {str: 7, dex: 10, end: 7},
    skills: {'Gun Combat': 1, 'Melee Combat': 1, Electronics: 1},
    weaponId: 'autopistol',
    armorId: null,
    spareAmmo: 15,
    medkits: 1
  },
  {
    id: 'pc-sora',
    kind: 'medic',
    label: 'Sora',
    stats: {str: 6, dex: 7, end: 8},
    skills: {Medicine: 2, 'Gun Combat': 0},
    weaponId: 'autopistol',
    armorId: null,
    spareAmmo: 0,
    medkits: 2
  },
  {
    id: 'pc-kade',
    kind: 'engineer',
    label: 'Kade',
    stats: {str: 8, dex: 6, end: 9},
    skills: {'Gun Combat': 1, 'Melee Combat': 0, Electronics: 2},
    weaponId: 'blade',
    armorId: null,
    spareAmmo: 0,
    medkits: 1
  }
]
