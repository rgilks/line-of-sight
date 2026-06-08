// Tiny IndexedDB persistence for the solo game's event log, so closing the tab and
// reopening resumes the exact game via the same pure replay() the server Durable
// Object uses. The store holds only {seed, events} per game id — fog and camera are
// derived from positions and need no persistence — so the footprint stays small.
// No dependency and no schema migrations: one object store, one version. Every
// operation is best-effort: if IndexedDB is unavailable or evicted (e.g. iOS Safari
// under storage pressure), reads return null and writes silently no-op, so the game
// degrades to "no resume" rather than failing.
import type {SoloEvent} from './reducer'

export type SavedGame = {seed: number; events: SoloEvent[]; updatedAt: number}

const DB_NAME = 'los-solo'
const STORE = 'games'
const VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

const open = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

const run = <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = action(db.transaction(STORE, mode).objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
  )

// Load a saved game by id, or null if none / IndexedDB is unavailable.
export const loadGame = async (gameId: string): Promise<SavedGame | null> => {
  try {
    return (await run<SavedGame | undefined>('readonly', (store) => store.get(gameId))) ?? null
  } catch {
    return null
  }
}

// Persist (overwrite) the whole record for a game id. Cheap: a solo run is a few
// hundred small events, and the caller coalesces rapid writes.
export const saveGame = async (gameId: string, game: SavedGame): Promise<void> => {
  try {
    await run('readwrite', (store) => store.put(game, gameId))
  } catch {
    /* best-effort: a failed write just means this turn won't resume */
  }
}

// Forget a saved game (e.g. when starting a fresh deck under the same id).
export const clearGame = async (gameId: string): Promise<void> => {
  try {
    await run('readwrite', (store) => store.delete(gameId))
  } catch {
    /* ignore */
  }
}
