// Integration seam with the Cepheus Character Generator (~/Source/
// cepheus-character-generator). A character generated there can later be dropped
// into an encounter: its characteristics map straight onto our Stats (same
// lowercase str/dex/end names) and its `"Gun Combat-2"` skill strings parse into
// our Skills map. Equipment mapping (its `Dmg`/`AR`/`Category` → our gear) is the
// next seam and is deliberately left for when import lands.
import type {Skills, Stats} from './model'

// The subset of ccg's Characteristics we consume (it also carries int/edu/soc/psi
// which the tactical game doesn't use).
export type CcgCharacteristics = {
  str?: number | null
  dex?: number | null
  end?: number | null
}

export const statsFromCharacteristics = (characteristics: CcgCharacteristics): Stats => ({
  str: characteristics.str ?? 0,
  dex: characteristics.dex ?? 0,
  end: characteristics.end ?? 0
})

// Parse ccg's skill arrays (e.g. ["Gun Combat-2", "Medicine-1", "Animals-0"]) into
// a name → level map. Duplicates keep the highest level (matching ccg's tally).
export const parseCcgSkills = (entries: string[]): Skills => {
  const skills: Skills = {}
  for (const entry of entries) {
    const split = entry.lastIndexOf('-')
    if (split <= 0) {
      if (!(entry in skills)) skills[entry] = 0
      continue
    }
    const name = entry.slice(0, split).trim()
    const level = Number(entry.slice(split + 1))
    if (!name || !Number.isFinite(level)) continue
    skills[name] = Math.max(skills[name] ?? Number.NEGATIVE_INFINITY, level)
  }
  return skills
}
