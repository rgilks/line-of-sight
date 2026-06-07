import {describe, expect, it} from 'vitest'
import {parseCcgSkills, statsFromCharacteristics} from './ccg'

describe('ccg adapter', () => {
  it('parses "Name-Level" skill strings, keeping the highest of duplicates', () => {
    const skills = parseCcgSkills(['Gun Combat-2', 'Medicine-1', 'Animals-0', 'Gun Combat-1'])
    expect(skills).toEqual({'Gun Combat': 2, Medicine: 1, Animals: 0})
  })

  it('treats a bare skill name as level 0', () => {
    expect(parseCcgSkills(['Carousing'])).toEqual({Carousing: 0})
  })

  it('maps ccg characteristics onto Stats, defaulting nulls to 0', () => {
    expect(statsFromCharacteristics({str: 7, dex: 10, end: null})).toEqual({str: 7, dex: 10, end: 0})
  })
})
