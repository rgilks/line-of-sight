import {effect} from '@preact/signals'
import {render as renderPreact, type ComponentChildren, type JSX} from 'preact'
import {useEffect, useRef} from 'preact/hooks'
import {detectWebGpu} from './gpu'
import './styles.css'
import {
  activeCounterGroup,
  activeCounterKind,
  boardSize,
  columnsValue,
  counterDefinitions,
  counterGroupLetters,
  drawerOpen,
  dropDepth,
  exploredCtx,
  genSpec,
  gpuStatus,
  gridValue,
  hideUnseen,
  preloadCounterPortraits,
  requestCanvasRender,
  roomLabels,
  runtimeStatus,
  setStatus,
  setView,
  showRoomLabels,
  showWalls,
  sightValue,
  tiles,
  tool
} from './state'
import type {RoomType, Theme} from './synth/types'
import {GEN_ROOM_TYPES, GEN_THEMES, loadGeneratedMap, randomizedSpec} from './generate-board'
import type {Tool} from './types'
import {analyzeTiles, arrangeTiles, loadMapFiles, reorderTile, syncCanvasSize} from './board'
import {
  getPovToken,
  isDoorOpen,
  isDoorReachable,
  markExplored,
  setDoorOpen,
  setPovToken
} from './visibility'
import {renderBoard} from './rendering'
import {
  handleMapKeyDown,
  handlePointerCancel,
  handlePointerDown,
  handlePointerMove,
  handlePointerUp,
  handleWheel,
  nextTokenLabel,
  removeOccluder,
  removeToken
} from './interactions'
import {
  convertSelectedOccluder,
  getBoardStat,
  getDoorStat,
  getPovStat,
  getSelectedOccluder,
  getSelectedToken,
  handleDragEnter,
  handleDragLeave,
  handleDragOver,
  handleDrop
} from './ui-actions'
import {exportSidecar} from './export'
import {SessionPanel} from './session-panel'

const counterDefinitionFor = (kind: (typeof counterDefinitions)[number]['kind']) =>
  counterDefinitions.find((definition) => definition.kind === kind) ?? counterDefinitions[0]

preloadCounterPortraits()

const updateGenSpec = (patch: Partial<typeof genSpec.value>): void => {
  genSpec.value = {...genSpec.value, ...patch}
}

const parseRequired = (raw: string): RoomType[] =>
  raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is RoomType => (GEN_ROOM_TYPES as string[]).includes(entry))

const Icon = ({children}: {children: ComponentChildren}): JSX.Element => (
  <svg className="button-icon" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)

const ToolIcon = ({children}: {children: ComponentChildren}): JSX.Element => (
  <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)

const ToolButton = ({
  value,
  children,
  icon
}: {
  value: Tool
  children: ComponentChildren
  icon: ComponentChildren
}): JSX.Element => (
  <button
    className={`tool-button${tool.value === value ? ' active' : ''}`}
    type="button"
    data-tool={value}
    onClick={() => {
      tool.value = value
    }}
  >
    <ToolIcon>{icon}</ToolIcon>
    <span>{children}</span>
  </button>
)

const App = (): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!canvasRef.current || !viewportRef.current) {
      throw new Error('Line of Sight UI failed to mount.')
    }

    const canvasContext = canvasRef.current.getContext('2d')
    if (!canvasContext) throw new Error('Canvas 2D is required.')
    setView(canvasRef.current, viewportRef.current, canvasContext)
    syncCanvasSize(true)

    const dispose = effect(renderBoard)
    window.addEventListener('keydown', handleMapKeyDown)
    void detectWebGpu().then((status) => {
      gpuStatus.value = status
    })
    // Open on a generated deck rather than a blank board. Import still works for
    // bringing your own map (Select map / drag-drop).
    const firstSpec = randomizedSpec(genSpec.value)
    genSpec.value = firstSpec
    void loadGeneratedMap(firstSpec)

    return () => {
      dispose()
      window.removeEventListener('keydown', handleMapKeyDown)
      for (const tile of tiles.value) URL.revokeObjectURL(tile.url)
    }
  }, [])

  const activeTileCount = tiles.value.length
  const selectedOccluder = getSelectedOccluder()
  const selectedToken = getSelectedToken()
  const povToken = getPovToken()
  const selectedDoorReachable =
    selectedOccluder?.type === 'door' ? isDoorReachable(selectedOccluder) : false
  const nextCounterLabel = nextTokenLabel(activeCounterGroup.value)
  const spec = genSpec.value
  const hasRoomLabels = roomLabels.value.length > 0

  return (
    <main className="app-shell">
      <aside
        className={`control-drawer${drawerOpen.value ? ' open' : ' closed'}`}
        aria-label="Line of Sight controls"
      >
        <div className="drawer-panel">
          <header className="drawer-header">
            <a className="brand drawer-brand" href="https://tre.systems/" aria-label="Cepheus · Line of Sight">
              <img className="brand-logo" src="/favicon.svg" alt="" width="34" height="34" />
              <div className="brand-copy">
                <span className="brand-eyebrow">Cepheus</span>
                <h1>Line of Sight</h1>
                <p id="runtimeStatus" className="drawer-status">
                  {runtimeStatus.value}
                </p>
              </div>
            </a>
            <button
              className="drawer-toggle"
              type="button"
              aria-expanded={drawerOpen.value}
              aria-label={drawerOpen.value ? 'Hide controls' : 'Show controls'}
              onClick={() => {
                drawerOpen.value = !drawerOpen.value
              }}
            >
              <Icon>
                {drawerOpen.value ? (
                  <path d="m15 18-6-6 6-6" />
                ) : (
                  <path d="m9 18 6-6-6-6" />
                )}
              </Icon>
            </button>
          </header>

          <div className="drawer-actions" aria-label="Primary map actions">
            <button
              type="button"
              className="drawer-btn-primary"
              title="Generate a new starship deck from the current settings"
              onClick={() => {
                void loadGeneratedMap(genSpec.value)
              }}
            >
              <Icon>
                <path d="M3 7.5 12 3l9 4.5-9 4.5-9-4.5Z" />
                <path d="m3 12 9 4.5L21 12" />
                <path d="m3 16.5 9 4.5 9-4.5" />
              </Icon>
              <span>Generate map</span>
            </button>
            <label className="file-button drawer-btn-secondary" title="Import your own map image to trace walls">
              <input
                id="fileInput"
                type="file"
                accept="image/*"
                multiple
                onChange={(event) => {
                  void loadMapFiles(event.currentTarget.files ?? [])
                  event.currentTarget.value = ''
                }}
              />
              <Icon>
                <path d="M12 3v12" />
                <path d="m7 8 5-5 5 5" />
                <path d="M5 15v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-3" />
              </Icon>
              <span>Import image</span>
            </label>
          </div>

          <div className="drawer-content workbench-content">
            <section className="drawer-section">
              <div className="drawer-section-head">
                <h2>Generate</h2>
                <button
                  type="button"
                  className="drawer-badge-toggle"
                  aria-pressed={showRoomLabels.value}
                  disabled={!hasRoomLabels}
                  title="Show or hide GM-only room labels (players never see them)"
                  onClick={() => {
                    showRoomLabels.value = !showRoomLabels.value
                    requestCanvasRender()
                  }}
                >
                  {showRoomLabels.value ? 'Labels: GM' : 'Labels: off'}
                </button>
              </div>
              <p className="empty-hint">
                A random deck loads on start. Tweak the settings and Generate, or 🎲 for a new seed.
              </p>
              <div className="gen-grid">
                <label className="field-inline" title="Map seed — the same seed always makes the same deck">
                  <span>Seed</span>
                  <input
                    type="number"
                    value={spec.seed}
                    onInput={(event) => {
                      updateGenSpec({seed: Math.max(0, Number(event.currentTarget.value) || 0)})
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="drawer-btn-secondary gen-dice"
                  title="Random seed + theme, then generate"
                  onClick={() => {
                    const next = randomizedSpec(genSpec.value)
                    genSpec.value = next
                    void loadGeneratedMap(next)
                  }}
                >
                  🎲
                </button>
                <label className="field-inline" title="Deck theme — shifts the room mix and palette">
                  <span>Theme</span>
                  <select
                    value={spec.theme}
                    onChange={(event) => {
                      updateGenSpec({theme: event.currentTarget.value as Theme})
                    }}
                  >
                    {GEN_THEMES.map((theme) => (
                      <option key={theme} value={theme}>
                        {theme}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-inline" title="Deck size in grid cells (width × height)">
                  <span>Size</span>
                  <span className="gen-size">
                    <input
                      type="number"
                      min="12"
                      max="48"
                      value={spec.cols}
                      onInput={(event) => {
                        updateGenSpec({cols: Math.max(12, Math.min(48, Number(event.currentTarget.value) || 28))})
                      }}
                    />
                    <span aria-hidden="true">×</span>
                    <input
                      type="number"
                      min="12"
                      max="48"
                      value={spec.rows}
                      onInput={(event) => {
                        updateGenSpec({rows: Math.max(12, Math.min(48, Number(event.currentTarget.value) || 28))})
                      }}
                    />
                  </span>
                </label>
                <label className="field-inline" title="How densely rooms are furnished">
                  <span>Furniture</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={spec.furnitureDensity}
                    onInput={(event) => {
                      updateGenSpec({furnitureDensity: Number(event.currentTarget.value)})
                    }}
                  />
                </label>
                <label
                  className="field-inline gen-required"
                  title="Comma-separated room types to force in, e.g. bridge, cargo"
                >
                  <span>Require</span>
                  <input
                    type="text"
                    placeholder="bridge, cargo"
                    value={spec.required.join(', ')}
                    onInput={(event) => {
                      updateGenSpec({required: parseRequired(event.currentTarget.value)})
                    }}
                  />
                </label>
              </div>
            </section>

            <section className="drawer-section">
              <div className="drawer-section-head">
                <h2>Map</h2>
                <span className="drawer-badge">
                  {activeTileCount === 0 ? 'No map' : `${activeTileCount} tile${activeTileCount === 1 ? '' : 's'}`}
                </span>
              </div>
              <div className="map-settings-row">
                {activeTileCount > 1 ? (
                  <label
                    className="field-inline"
                    title="How many map images sit side by side before wrapping to the next row"
                  >
                    <span>Per row</span>
                    <input
                      id="columnsInput"
                      type="number"
                      min="1"
                      max="12"
                      value={columnsValue.value}
                      onInput={(event) => {
                        columnsValue.value = Math.max(1, Number(event.currentTarget.value) || 1)
                        arrangeTiles()
                      }}
                    />
                  </label>
                ) : null}
                <label
                  className="field-inline"
                  title="Wall/door detection scale in pixels — lower catches finer detail; re-analyze after changing"
                >
                  <span>Grid</span>
                  <input
                    id="gridInput"
                    type="number"
                    min="10"
                    max="200"
                    value={gridValue.value}
                    onInput={(event) => {
                      gridValue.value = Math.max(10, Number(event.currentTarget.value) || 50)
                      markExplored()
                      requestCanvasRender()
                    }}
                  />
                </label>
                <button
                  id="reanalyzeButton"
                  type="button"
                  className="drawer-btn-secondary"
                  disabled={activeTileCount === 0}
                  title="Re-run wall and door detection after changing grid scale"
                  onClick={() => {
                    void analyzeTiles()
                  }}
                >
                  <Icon>
                    <path d="M14 4h6v6" />
                    <path d="M20 4 13 11" />
                    <path d="M4 20 10.5 13.5" />
                    <path d="m8 4 1.5 3L13 8.5 9.5 10 8 13 6.5 10 3 8.5 6.5 7 8 4Z" />
                  </Icon>
                  <span>Re-analyze</span>
                </button>
              </div>
              {tiles.value.length === 0 ? (
                <p className="empty-hint">Generate a deck, or drop/Import an image to trace walls.</p>
              ) : (
                <>
                  {activeTileCount > 1 ? (
                    <p className="empty-hint tile-layout-hint">
                      List order is left-to-right, then down. Use Per row for width; ↑↓ to swap
                      positions.
                    </p>
                  ) : null}
                  <div
                    id="tileList"
                    className={`tile-list compact${activeTileCount > 1 ? ' multi' : ''}`}
                  >
                    {tiles.value.map((tile, index) => (
                      <div className="tile-item" key={tile.id}>
                        <img src={tile.url} alt="" />
                        <span>{`${tile.name} (${tile.width}×${tile.height})`}</span>
                        {activeTileCount > 1 ? (
                          <div className="tile-item-actions" aria-label={`Reorder ${tile.name}`}>
                            <button
                              type="button"
                              className="tile-move-button"
                              disabled={index === 0}
                              title="Move earlier in layout (left/up)"
                              aria-label="Move map earlier"
                              onClick={() => {
                                reorderTile(index, index - 1)
                              }}
                            >
                              <Icon>
                                <path d="m12 19-7-7 7-7" />
                              </Icon>
                            </button>
                            <button
                              type="button"
                              className="tile-move-button"
                              disabled={index === tiles.value.length - 1}
                              title="Move later in layout (right/down)"
                              aria-label="Move map later"
                              onClick={() => {
                                reorderTile(index, index + 1)
                              }}
                            >
                              <Icon>
                                <path d="m12 5 7 7-7 7" />
                              </Icon>
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="drawer-section">
              <h2>Tools</h2>
              <p className="empty-hint map-edit-hint">
                POV: click counters; click walls/doors to select. Wall/Door: drag to add. Erase: click a
                line. Del removes selection.
              </p>
              <div className="tool-grid" role="group" aria-label="Map editing tools">
                <ToolButton
                  value="viewer"
                  icon={
                    <>
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                      <circle cx="12" cy="12" r="2.5" />
                    </>
                  }
                >
                  POV
                </ToolButton>
                <ToolButton
                  value="wall"
                  icon={
                    <>
                      <path d="M4 8h16" />
                      <path d="M4 16h16" />
                      <path d="M8 8v8" />
                      <path d="M16 8v8" />
                    </>
                  }
                >
                  Wall
                </ToolButton>
                <ToolButton
                  value="door"
                  icon={
                    <>
                      <path d="M5 21V4h10v17" />
                      <path d="M15 8h4v13" />
                      <path d="M11 13h.01" />
                    </>
                  }
                >
                  Door
                </ToolButton>
                <ToolButton
                  value="token"
                  icon={
                    <>
                      <rect x="5" y="4" width="14" height="14" rx="2" />
                      <circle cx="12" cy="9" r="2" />
                      <path d="M9 16c.7-1.5 1.7-2.2 3-2.2s2.3.7 3 2.2" />
                      <path d="M16 20h3" />
                    </>
                  }
                >
                  Counter
                </ToolButton>
                <ToolButton
                  value="erase"
                  icon={
                    <>
                      <path d="m16 3 5 5-11 11H5l-3-3L16 3Z" />
                      <path d="M10 19h11" />
                    </>
                  }
                >
                  Erase
                </ToolButton>
              </div>
              {selectedOccluder ? (
                <div className="selection-actions" aria-label="Selected map line actions">
                  <span>{selectedOccluder.type === 'door' ? 'Door' : 'Wall'} on map</span>
                  <div className="selection-action-row">
                    <button
                      type="button"
                      aria-pressed={selectedOccluder.type === 'wall'}
                      onClick={() => {
                        convertSelectedOccluder('wall')
                      }}
                    >
                      Wall
                    </button>
                    <button
                      type="button"
                      aria-pressed={selectedOccluder.type === 'door'}
                      onClick={() => {
                        convertSelectedOccluder('door')
                      }}
                    >
                      Door
                    </button>
                  </div>
                  <div className="selection-action-row">
                    {selectedOccluder.type === 'door' ? (
                      <button
                        type="button"
                        disabled={!selectedDoorReachable}
                        title={
                          selectedDoorReachable
                            ? undefined
                            : 'Move the POV counter adjacent to this door to operate it.'
                        }
                        onClick={() => {
                          setDoorOpen(selectedOccluder.id, !isDoorOpen(selectedOccluder))
                        }}
                      >
                        {selectedDoorReachable
                          ? isDoorOpen(selectedOccluder)
                            ? 'Close'
                            : 'Open'
                          : 'Out of reach'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="danger-action"
                      onClick={() => {
                        removeOccluder(selectedOccluder.id)
                        markExplored()
                        requestCanvasRender()
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="drawer-section">
              <h2>Visibility</h2>
              <div className="drawer-action-grid">
                <label className="sight-control">
                  <span>
                    <Icon>
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                      <circle cx="12" cy="12" r="2.5" />
                    </Icon>
                    Sight
                  </span>
                  <input
                    id="radiusInput"
                    type="range"
                    min="50"
                    max="5000"
                    step="50"
                    value={sightValue.value}
                    onInput={(event) => {
                      sightValue.value = Math.max(50, Number(event.currentTarget.value) || 700)
                      markExplored()
                      requestCanvasRender()
                    }}
                  />
                  <output id="radiusValue" htmlFor="radiusInput">
                    {sightValue.value}
                  </output>
                </label>
                <button
                  id="showWallsButton"
                  type="button"
                  aria-pressed={showWalls.value}
                  onClick={() => {
                    showWalls.value = !showWalls.value
                    requestCanvasRender()
                  }}
                >
                  <Icon>
                    <path d="M4 7h16" />
                    <path d="M4 12h16" />
                    <path d="M4 17h16" />
                  </Icon>
                  <span>{showWalls.value ? 'Hide walls' : 'Show walls'}</span>
                </button>
                <button
                  id="fogModeButton"
                  type="button"
                  aria-pressed={hideUnseen.value}
                  title="Toggle whether never-seen areas hide the map"
                  onClick={() => {
                    hideUnseen.value = !hideUnseen.value
                    requestCanvasRender()
                  }}
                >
                  <Icon>
                    <path d="M3 3l18 18" />
                    <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
                    <path d="M9.9 4.2A9.8 9.8 0 0 1 12 4c6 0 9.5 8 9.5 8a17.4 17.4 0 0 1-2.2 3.3" />
                    <path d="M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 8 9.5 8a9.7 9.7 0 0 0 4.7-1.2" />
                  </Icon>
                  <span>{hideUnseen.value ? 'Unknown hidden' : 'Known map'}</span>
                </button>
                <button
                  id="resetFogButton"
                  type="button"
                  onClick={() => {
                    exploredCtx.clearRect(0, 0, boardSize.value.width, boardSize.value.height)
                    markExplored()
                    requestCanvasRender()
                  }}
                >
                  <Icon>
                    <path d="M3 12a9 9 0 1 0 3-6.7" />
                    <path d="M3 4v6h6" />
                  </Icon>
                  <span>Reset fog</span>
                </button>
                <button id="exportButton" type="button" onClick={() => void exportSidecar()}>
                  <Icon>
                    <path d="M12 3v12" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M5 21h14" />
                  </Icon>
                  <span>Export sidecar</span>
                </button>
              </div>
              <dl className="stats compact">
                <div>
                  <dt>Board</dt>
                  <dd id="boardStat">{getBoardStat()}</dd>
                </div>
                <div>
                  <dt>Doors</dt>
                  <dd id="doorStat">{getDoorStat()}</dd>
                </div>
                <div>
                  <dt>POV</dt>
                  <dd id="povStat">{getPovStat()}</dd>
                </div>
              </dl>
            </section>

            <section className="drawer-section">
              <h2>Counters</h2>
              <div className="counter-toolbar" aria-label="Counter identifier">
                <div className="counter-group-picker" role="group" aria-label="Counter letter group">
                  {counterGroupLetters.map((group) => (
                    <button
                      className={`counter-letter-button${
                        activeCounterGroup.value === group ? ' active' : ''
                      }`}
                      key={group}
                      type="button"
                      aria-label={`Group ${group}`}
                      aria-pressed={activeCounterGroup.value === group}
                      onClick={() => {
                        activeCounterGroup.value = group
                        tool.value = 'token'
                      }}
                    >
                      {group}
                    </button>
                  ))}
                </div>
                <span className="counter-next" aria-label={`Next counter ${nextCounterLabel}`}>
                  {nextCounterLabel}
                </span>
              </div>
              <div className="counter-grid" role="group" aria-label="Counter types">
                {counterDefinitions.map((definition) => (
                  <button
                    className={`counter-option${
                      activeCounterKind.value === definition.kind ? ' active' : ''
                    }`}
                    key={definition.kind}
                    type="button"
                    aria-pressed={activeCounterKind.value === definition.kind}
                    onClick={() => {
                      activeCounterKind.value = definition.kind
                      tool.value = 'token'
                    }}
                  >
                    <span className="counter-swatch" aria-hidden="true">
                      <img
                        className="counter-portrait-thumb"
                        src={definition.portrait}
                        alt=""
                        loading="lazy"
                      />
                    </span>
                    <span>{definition.name}</span>
                  </button>
                ))}
              </div>
              {selectedToken ? (
                <div className="selection-actions" aria-label="Selected counter actions">
                  <span>
                    {`${counterDefinitionFor(selectedToken.kind).name} ${selectedToken.label}${
                      povToken?.id === selectedToken.id ? ' POV' : ''
                    }`}
                  </span>
                  <div className="selection-action-row">
                    <button
                      type="button"
                      aria-pressed={povToken?.id === selectedToken.id}
                      disabled={povToken?.id === selectedToken.id}
                      onClick={() => {
                        setPovToken(selectedToken.id)
                      }}
                    >
                      {povToken?.id === selectedToken.id ? 'Current POV' : 'Use as POV'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        removeToken(selectedToken.id)
                        requestCanvasRender()
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <details className="session-details drawer-section">
              <summary>Session sharing</summary>
              <SessionPanel />
            </details>
          </div>
        </div>
      </aside>

      <section className="board-panel">
        <div
          id="boardViewport"
          ref={viewportRef}
          className={`board-viewport${dropDepth.value > 0 ? ' drag-over' : ''}`}
          onWheel={handleWheel}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="board-canvas-host">
            <canvas
              id="boardCanvas"
              ref={canvasRef}
              width="1000"
              height="1000"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
            />
          </div>
        </div>
      </section>
      {activeTileCount === 0 ? null : <span className="sr-only">{activeTileCount} map tiles loaded</span>}
    </main>
  )
}

const root = document.querySelector('#app')
if (!root) throw new Error('Line of Sight root element is missing.')

renderPreact(<App />, root)
