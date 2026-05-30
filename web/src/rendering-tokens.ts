import {drawCounterToken} from './counter-render'
import {
  counterDefinitions,
  counterPortraits,
  ctx,
  gridScale,
  hoveredTokenId,
  selectedTokenId,
  showWalls,
  tokens,
  zoom
} from './state'
import {getPovToken, getVisiblePolygon, pointInPolygon} from './visibility'

export const drawTokens = (): void => {
  const polygon = getVisiblePolygon()
  const pov = getPovToken()
  for (const token of tokens.value) {
    const isPov = pov?.id === token.id
    const visible = isPov || (polygon.length > 2 && pointInPolygon(token, polygon))
    if (!visible && !showWalls.value) continue
    drawCounterToken(ctx, token, {
      gridScale: gridScale(),
      portraits: counterPortraits,
      counterDefinitions,
      visible,
      selected: selectedTokenId.value === token.id,
      hovered: hoveredTokenId.value === token.id,
      isPov,
      zoom: zoom.value
    })
  }
}
