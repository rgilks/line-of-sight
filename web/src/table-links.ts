const OWNER_KEY_PREFIX = 'los:table-owner-key:'

const normalizedTableId = (rawTableId: string): string => rawTableId.trim() || 'demo'

const randomHex = (bytes: number): string => {
  const data = new Uint8Array(bytes)
  crypto.getRandomValues(data)
  return [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const ownerKeyForTable = (rawTableId: string): string => {
  const tableId = normalizedTableId(rawTableId)
  const storageKey = `${OWNER_KEY_PREFIX}${tableId}`
  const existing = localStorage.getItem(storageKey)
  if (existing) return existing
  const next = randomHex(24)
  localStorage.setItem(storageKey, next)
  return next
}

export const ownerHeaders = (ownerKey: string): {'x-los-gm-key': string} => ({
  'x-los-gm-key': ownerKey
})

export const playerPlayUrl = (rawTableId: string): string => {
  const tableId = normalizedTableId(rawTableId)
  return `${location.origin}/play?table=${encodeURIComponent(tableId)}`
}

export const gmPlayUrl = (rawTableId: string, ownerKey = ownerKeyForTable(rawTableId)): string =>
  `${playerPlayUrl(rawTableId)}&gm=1&gmKey=${encodeURIComponent(ownerKey)}`

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
