// Curated weapons + armour for v1. Shapes mirror the character generator's
// Equipment so a ccg item maps straight in: `damage` is a ccg `Dmg` string
// ("3d6-3"), `ar` is a ccg `AR` number, and `category` maps to ccg's
// RANGED_WEAPON / MELEE_WEAPON / ARMOR. Range DMs fold the SRD weapon×range
// difficulty into a modifier on the base 8+ attack throw.

export type RangeBand = 'personal' | 'close' | 'short' | 'medium' | 'long'

export type Weapon = {
  id: string
  name: string // matches a ccg Equipment.Name where possible
  category: 'melee' | 'ranged'
  skill: string // ccg parent skill: 'Gun Combat' | 'Melee Combat'
  damage: string // SRD dice in ccg Dmg format, e.g. '3d6-3'
  // Attack DM at each reachable range band; a band that's absent is out of range.
  rangeDm: Partial<Record<RangeBand, number>>
  magazine?: number // ranged: rounds in a full load (absent ⇒ melee / no ammo)
}

export type Armor = {id: string; name: string; ar: number}

// Player + improvised weapons, plus natural weapons monsters use (so one attack
// resolver covers both — a monster just equips 'claws'/'spit').
export const WEAPONS: Record<string, Weapon> = {
  blade: {
    id: 'blade',
    name: 'Blade',
    category: 'melee',
    skill: 'Melee Combat',
    damage: '2d6',
    rangeDm: {personal: 0}
  },
  autopistol: {
    id: 'autopistol',
    name: 'Autopistol',
    category: 'ranged',
    skill: 'Gun Combat',
    damage: '3d6-3',
    rangeDm: {personal: -1, close: 0, short: 0, medium: -2, long: -4},
    magazine: 15
  },
  autorifle: {
    id: 'autorifle',
    name: 'Autorifle',
    category: 'ranged',
    skill: 'Gun Combat',
    damage: '3d6',
    rangeDm: {personal: -2, close: 0, short: 1, medium: 0, long: -2},
    magazine: 20
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    category: 'ranged',
    skill: 'Gun Combat',
    damage: '4d6',
    rangeDm: {personal: 2, close: 1, short: 0, medium: -3},
    magazine: 6
  },
  // --- natural weapons (monsters) ---
  claws: {
    id: 'claws',
    name: 'Claws',
    category: 'melee',
    skill: 'Melee Combat',
    damage: '2d6',
    rangeDm: {personal: 0}
  },
  maw: {
    id: 'maw',
    name: 'Maw',
    category: 'melee',
    skill: 'Melee Combat',
    damage: '3d6',
    rangeDm: {personal: 0}
  },
  spit: {
    id: 'spit',
    name: 'Acid spit',
    category: 'ranged',
    skill: 'Gun Combat',
    damage: '2d6',
    rangeDm: {close: 0, short: 0, medium: -2}
  }
}

export const ARMORS: Record<string, Armor> = {
  jack: {id: 'jack', name: 'Jack', ar: 2},
  cloth: {id: 'cloth', name: 'Cloth', ar: 5},
  combat: {id: 'combat', name: 'Combat armour', ar: 8},
  // natural hides for monsters
  hide: {id: 'hide', name: 'Hide', ar: 1},
  carapace: {id: 'carapace', name: 'Carapace', ar: 4}
}

export const weaponById = (id: string): Weapon => WEAPONS[id] ?? WEAPONS.blade

export const armorRating = (id: string | null): number => (id ? (ARMORS[id]?.ar ?? 0) : 0)
