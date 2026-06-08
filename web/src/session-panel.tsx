import {useState} from 'preact/hooks'
import type {JSX} from 'preact'
import {hasMap, occluders, publishTableId, tablePublished, tiles} from './state'
import {playLinksFor, publishToTable} from './publish'
import {copyText} from './table-links'

const Icon = ({children}: {children: JSX.Element | JSX.Element[]}): JSX.Element => (
  <svg className="button-icon" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)

const CopyButton = ({label, url, className = ''}: {label: string; url: string; className?: string}): JSX.Element => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void copyText(url).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        })
      }}
    >
      <Icon>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </Icon>
      <span>{copied ? 'Copied!' : label}</span>
    </button>
  )
}

const WorkflowStep = ({
  done,
  step,
  title,
  detail,
  action
}: {
  done: boolean
  step: number
  title: string
  detail: string
  action?: JSX.Element | null
}): JSX.Element => (
  <div className={`workflow-step${done ? ' done' : ''}`}>
    <span className="workflow-step-marker" aria-hidden="true">
      {done ? '✓' : step}
    </span>
    <div className="workflow-step-body">
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  </div>
)

export const SessionPanel = (): JSX.Element => {
  const mapReady = hasMap()
  const wallsReady = occluders.value.length > 0
  const published = tablePublished.value
  const tableId = publishTableId.value.trim() || 'demo'
  const links = playLinksFor(tableId)

  return (
    <div className="drawer-tab-panel" role="tabpanel">
      <div className="panel session-intro">
        <h2>Run a session</h2>
        <p className="panel-lead">
          Load your map, publish it to a table, then share the invite link. Open GM view to see every counter and
          control doors while players explore.
        </p>
      </div>

      <div className="panel">
        <h2>Checklist</h2>
        <div className="workflow-steps">
          <WorkflowStep
            done={mapReady}
            step={1}
            title="Load map tiles"
            detail="Drag a geomorph image onto the board or use Select map at the top of the drawer."
          />
          <WorkflowStep
            done={wallsReady}
            step={2}
            title="Detect walls & doors"
            detail="Walls and doors appear when maps load. Click lines on the map to fix mistakes, or Re-analyze after changing grid scale."
          />
          <WorkflowStep
            done={published}
            step={3}
            title="Publish & share"
            detail="Push the board to a named table, then copy the player invite link."
          />
        </div>
      </div>

      <div className="panel session-publish">
        <h2>Table</h2>
        <label className="field-block">
          <span>Table name</span>
          <input
            id="tableInput"
            type="text"
            spellcheck={false}
            placeholder="e.g. friday-night"
            value={publishTableId.value}
            onInput={(event) => {
              publishTableId.value = event.currentTarget.value
              tablePublished.value = false
            }}
          />
        </label>
        <p className="field-hint">
          Anyone with the link can join this table name — pick something unique for your group.
        </p>
        <button
          id="publishButton"
          type="button"
          className="primary-action full-width"
          disabled={!mapReady}
          onClick={() => void publishToTable(publishTableId.value)}
        >
          <Icon>
            <path d="M4 11a9 9 0 0 1 9 9" />
            <path d="M4 4a16 16 0 0 1 16 16" />
            <circle cx="5" cy="19" r="1" />
          </Icon>
          <span>{published ? 'Republish to table' : 'Publish to table'}</span>
        </button>
        {!mapReady ? <p className="field-hint warn">Load map tiles before publishing.</p> : null}
      </div>

      <div className="panel session-links">
        <h2>Share links</h2>
        <div className="link-card">
          <div className="link-card-head">
            <strong>Player invite</strong>
            <span>Send to your group — they move their own counter and see fog of war.</span>
          </div>
          <div className="link-row">
            <input type="text" readOnly value={links.player} aria-label="Player invite URL" />
            <CopyButton label="Copy invite" url={links.player} />
          </div>
        </div>
        <div className="link-card">
          <div className="link-card-head">
            <strong>GM view</strong>
            <span>You see all counters, toggle doors, and can lock door control for players.</span>
          </div>
          <div className="link-row">
            <input type="text" readOnly value={links.gm} aria-label="GM view URL" />
            <CopyButton label="Copy GM link" url={links.gm} className="secondary-action" />
          </div>
          <a className="open-gm-link" href={links.gm} target="_blank" rel="noopener noreferrer">
            Open GM view in new tab
          </a>
        </div>
      </div>

      <div className="panel session-footer">
        <p>
          <strong>During play:</strong> keep GM view open on a second screen. After the first publish, walls, doors, and
          map layout edits in the editor sync to connected players automatically; use Republish only if you need to
          force a full refresh.
        </p>
        <p className="player-join-hint">
          Players can also go to{' '}
          <a href="/play" target="_blank" rel="noopener noreferrer">
            /play
          </a>{' '}
          and enter the table name.
        </p>
        {tiles.value.length > 0 ? (
          <dl className="stats compact">
            <div>
              <dt>Tiles</dt>
              <dd>{tiles.value.length}</dd>
            </div>
            <div>
              <dt>Walls / doors</dt>
              <dd>{occluders.value.length}</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </div>
  )
}
