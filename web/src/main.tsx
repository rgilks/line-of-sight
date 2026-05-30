import {effect} from '@preact/signals'
import {render as renderPreact, type ComponentChildren, type JSX} from 'preact'
import {useEffect, useRef} from 'preact/hooks'
import {detectWebGpu} from './gpu'
import './styles.css'
import {
  activeCounterGroup,
  activeCounterKind,
  activeDrawerTab,
  boardSize,
  columnsValue,
  counterDefinitions,
  counterGroupLetters,
  drawerOpen,
  dropDepth,
  exploredCtx,
  gpuStatus,
  gridValue,
  hideUnseen,
  occluders,
  preloadCounterPortraits,
  redoStack,
  requestCanvasRender,
  runtimeStatus,
  setStatus,
  setView,
  showWalls,
  sightValue,
  tiles,
  tool,
  undoStack
} from './state'
import type {DrawerTab, Tool} from './types'
import {analyzeTiles, arrangeTiles, loadMapFiles, syncCanvasSize} from './board'
import {redoEditorChange, undoEditorChange} from './history'
import {getPovToken, isDoorOpen, markExplored, setDoorOpen, setPovToken} from './visibility'
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

const counterDefinitionFor = (kind: (typeof counterDefinitions)[number]['kind']) =>
  counterDefinitions.find((definition) => definition.kind === kind) ?? counterDefinitions[0]

preloadCounterPortraits()

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

const DrawerTabButton = ({
  value,
  children
}: {
  value: DrawerTab
  children: ComponentChildren
}): JSX.Element => (
  <button
    className={`drawer-tab${activeDrawerTab.value === value ? ' active' : ''}`}
    type="button"
    role="tab"
    aria-selected={activeDrawerTab.value === value}
    onClick={() => {
      activeDrawerTab.value = value
      drawerOpen.value = true
    }}
  >
    {children}
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
    setStatus('Ready. Select local map images to start.')

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
  const nextCounterLabel = nextTokenLabel(activeCounterGroup.value)

  return (
    <main className="app-shell">
      <aside
        className={`control-drawer${drawerOpen.value ? ' open' : ' closed'}`}
        aria-label="Line of Sight controls"
      >
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

        <div className="drawer-panel">
          <a className="brand drawer-brand" href="https://tre.systems/" aria-label="Total Reality Engineering">
            <svg
              className="brand-logo"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 512 512"
              aria-hidden="true"
            >
              <g>
                <rect
                  x="214"
                  y="288"
                  width="80"
                  height="206"
                  fill="#19C15E"
                  transform="rotate(22, 262, 295)"
                />
                <path
                  d="M256 36 L72 476 L440 476 Z"
                  fill="none"
                  stroke="#F5F5F5"
                  strokeWidth="30"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle cx="256" cy="288" r="40" fill="#F5F5F5" />
              </g>
            </svg>
            <div className="brand-copy">
              <span>Total Reality Engineering</span>
              <h1>Line of Sight</h1>
              <p id="runtimeStatus">{runtimeStatus.value}</p>
            </div>
          </a>

          <div className="drawer-tabs" role="tablist" aria-label="Control sections">
            <DrawerTabButton value="tools">Tools</DrawerTabButton>
            <DrawerTabButton value="counters">Counters</DrawerTabButton>
            <DrawerTabButton value="maps">Maps</DrawerTabButton>
            <DrawerTabButton value="state">State</DrawerTabButton>
          </div>

          <div className="drawer-content">
            {activeDrawerTab.value === 'tools' ? (
              <div className="drawer-tab-panel" role="tabpanel">
                <div className="panel">
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
                      }}
                    >
                      <Icon>
                        <path d="M4 7h16" />
                        <path d="M4 12h16" />
                        <path d="M4 17h16" />
                      </Icon>
                      <span>{showWalls.value ? 'Hide walls' : 'Show walls'}</span>
                    </button>
                    <button id="analyzeButton" type="button" onClick={() => void analyzeTiles()}>
                      <Icon>
                        <path d="M14 4h6v6" />
                        <path d="M20 4 13 11" />
                        <path d="M4 20 10.5 13.5" />
                        <path d="m8 4 1.5 3L13 8.5 9.5 10 8 13 6.5 10 3 8.5 6.5 7 8 4Z" />
                      </Icon>
                      <span>Analyze</span>
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
                    <button
                      id="fogModeButton"
                      type="button"
                      aria-pressed={hideUnseen.value}
                      title="Toggle whether never-seen areas hide the map"
                      onClick={() => {
                        hideUnseen.value = !hideUnseen.value
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
                    <button id="exportButton" type="button" onClick={() => void exportSidecar()}>
                      <Icon>
                        <path d="M12 3v12" />
                        <path d="m7 10 5 5 5-5" />
                        <path d="M5 21h14" />
                      </Icon>
                      <span>Export</span>
                    </button>
                  </div>
                </div>

                <div className="panel">
                  <h2>Tools</h2>
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
                <span>{selectedOccluder.type === 'door' ? 'Door selected' : 'Wall selected'}</span>
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
                      onClick={() => {
                        setDoorOpen(selectedOccluder.id, !isDoorOpen(selectedOccluder))
                      }}
                    >
                      {isDoorOpen(selectedOccluder) ? 'Close' : 'Open'}
                    </button>
                  ) : null}
                  <button
                    type="button"
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
                </div>
              </div>
            ) : null}

            {activeDrawerTab.value === 'counters' ? (
              <div className="drawer-tab-panel" role="tabpanel">
                <div className="panel">
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
                </div>
              </div>
            ) : null}

            {activeDrawerTab.value === 'maps' ? (
              <div className="drawer-tab-panel" role="tabpanel">
                <div className="panel">
                  <h2>Map Setup</h2>
                  <div className="drawer-action-grid">
                    <label className="file-button primary-action">
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
                      <span>Select maps</span>
                    </label>
                    <button
                      id="undoButton"
                      type="button"
                      disabled={undoStack.value.length === 0}
                      title="Undo map correction"
                      onClick={undoEditorChange}
                    >
                      <Icon>
                        <path d="M9 14 4 9l5-5" />
                        <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
                      </Icon>
                      <span>Undo</span>
                    </button>
                    <button
                      id="redoButton"
                      type="button"
                      disabled={redoStack.value.length === 0}
                      title="Redo map correction"
                      onClick={redoEditorChange}
                    >
                      <Icon>
                        <path d="m15 14 5-5-5-5" />
                        <path d="M20 9H10a6 6 0 0 0 0 12h1" />
                      </Icon>
                      <span>Redo</span>
                    </button>
                    <label className="number-control">
                      <span>Columns</span>
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
                    <label className="number-control">
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
                  </div>
                </div>

                <div className="panel">
                  <h2>Tiles</h2>
                  <div id="tileList" className="tile-list">
                    {tiles.value.map((tile) => (
                      <div className="tile-item" key={tile.id}>
                        <img src={tile.url} alt="" />
                        <span>{`${tile.name} (${tile.width}x${tile.height})`}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}

            {activeDrawerTab.value === 'state' ? (
              <div className="drawer-tab-panel" role="tabpanel">
                <div className="panel">
                  <h2>State</h2>
                  <dl className="stats">
                    <div>
                      <dt>Board</dt>
                      <dd id="boardStat">{getBoardStat()}</dd>
                    </div>
                    <div>
                      <dt>Occluders</dt>
                      <dd id="occluderStat">{occluders.value.length}</dd>
                    </div>
                    <div>
                      <dt>Doors</dt>
                      <dd id="doorStat">{getDoorStat()}</dd>
                    </div>
                    <div>
                      <dt>POV</dt>
                      <dd id="povStat">{getPovStat()}</dd>
                    </div>
                    <div>
                      <dt>GPU</dt>
                      <dd id="gpuStat">{gpuStatus.value}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            ) : null}
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
      </section>
      {activeTileCount === 0 ? null : <span className="sr-only">{activeTileCount} map tiles loaded</span>}
    </main>
  )
}

const root = document.querySelector('#app')
if (!root) throw new Error('Line of Sight root element is missing.')

renderPreact(<App />, root)
