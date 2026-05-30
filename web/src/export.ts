import {boardSize, gridScale, occluders, setStatus, tokens} from './state'
import {isDoorOpen} from './visibility'

export const exportSidecar = async (): Promise<void> => {
  const sidecar = {
    assetRef: 'composed-board',
    width: boardSize.value.width,
    height: boardSize.value.height,
    gridScale: gridScale(),
    occluders: occluders.value.map((occluder) =>
      occluder.type === 'door'
        ? {
            ...occluder,
            open: isDoorOpen(occluder)
          }
        : occluder
    ),
    tokens: tokens.value
  }
  const json = `${JSON.stringify(sidecar, null, 2)}\n`
  try {
    await navigator.clipboard.writeText(json)
    setStatus('Exported sidecar JSON and copied it to the clipboard.')
  } catch {
    const blob = new Blob([json], {type: 'application/json'})
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'line-of-sight-sidecar.json'
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setStatus('Exported sidecar JSON as a download.')
  }
}
