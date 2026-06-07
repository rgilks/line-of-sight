// The four pre-statted player characters for v1 (no character generation yet).
// Plain Cepheus stat blocks; gear/skills are wired in the combat phase. Each maps
// to one of the shared counter portraits.
import type {CounterKind} from '../../../core/rules'
import type {Stats} from './model'

export type PreGen = {
  id: string
  kind: CounterKind
  label: string
  stats: Stats
}

export const PARTY: PreGen[] = [
  {id: 'pc-vance', kind: 'marine', label: 'Vance', stats: {str: 9, dex: 8, end: 10}},
  {id: 'pc-rell', kind: 'scout', label: 'Rell', stats: {str: 7, dex: 10, end: 7}},
  {id: 'pc-sora', kind: 'medic', label: 'Sora', stats: {str: 6, dex: 7, end: 8}},
  {id: 'pc-kade', kind: 'engineer', label: 'Kade', stats: {str: 8, dex: 6, end: 9}}
]
