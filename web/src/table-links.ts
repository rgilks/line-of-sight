export const playerPlayUrl = (rawTableId: string): string => {
  const tableId = rawTableId.trim()
  return `${location.origin}/play?table=${encodeURIComponent(tableId || 'demo')}`
}

export const gmPlayUrl = (rawTableId: string): string => `${playerPlayUrl(rawTableId)}&gm=1`

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
