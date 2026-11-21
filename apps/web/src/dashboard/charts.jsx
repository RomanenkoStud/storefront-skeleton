import React, { useId, useState } from 'react';
import { niceScale, shortDay, longDay } from './dashboard-logic.js';

// Single-series charts in plain HTML/CSS: one hue, thin marks, recessive grid, a hover/focus tooltip
// per mark and a table view, so no value is reachable by colour or pointer alone.

export function StatTile({ label, value, note, tone }) {
  return <div className={`dash-tile${tone ? ` dash-tile-${tone}` : ''}`}><span className="dash-tile-label">{label}</span><strong className="dash-tile-value">{value}</strong>{note && <small className="dash-tile-note">{note}</small>}</div>;
}

/** Daily columns. `series` [{day, value}], `format` renders a value. */
export function ColumnChart({ title, series, format, valueLabel }) {
  const [active, setActive] = useState(null), id = useId();
  const max = Math.max(0, ...series.map(d => d.value)), scale = niceScale(max);
  const every = series.length > 31 ? 14 : series.length > 14 ? 7 : series.length > 7 ? 2 : 1;
  const point = active === null ? null : series[active];
  return <figure className="dash-chart" aria-labelledby={`${id}-t`}>
    <figcaption id={`${id}-t`} className="dash-chart-title">{title}</figcaption>
    <div className="dash-columns-wrap">
      <div className="dash-axis" aria-hidden="true">{[...scale.ticks].reverse().map(t => <span key={t}>{format(t)}</span>)}</div>
      <div className="dash-plot" onMouseLeave={() => setActive(null)}>
        <div className="dash-grid" aria-hidden="true">{scale.ticks.map(t => <span key={t} style={{ bottom: `${(t / scale.max) * 100}%` }}/>)}</div>
        <ol className="dash-columns" aria-label={title}>
          {series.map((d, i) => <li key={d.day} className={active === i ? 'is-active' : ''}>
            <button type="button" className="dash-column-hit" aria-label={`${longDay(d.day)}: ${format(d.value)}`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
              <span className="dash-column" style={{ height: d.value > 0 ? `max(2px, ${(d.value / scale.max) * 100}%)` : 0 }}/>
            </button>
            <span className="dash-column-label" aria-hidden="true">{i % every === 0 || i === series.length - 1 ? shortDay(d.day) : ''}</span>
          </li>)}
        </ol>
        {point && <div className="dash-tooltip" role="status" style={{ left: `${((active + 0.5) / series.length) * 100}%` }}><strong>{format(point.value)}</strong><span>{longDay(point.day)}{valueLabel ? ` · ${valueLabel}` : ''}</span></div>}
      </div>
    </div>
    <details className="dash-table-toggle"><summary>Показати таблицею</summary>
      <div className="table-scroll"><table className="dash-table"><thead><tr><th scope="col">День</th><th scope="col">{valueLabel || title}</th></tr></thead>
        <tbody>{series.map(d => <tr key={d.day}><td>{longDay(d.day)}</td><td>{format(d.value)}</td></tr>)}</tbody></table></div>
    </details>
  </figure>;
}

/** Ranked horizontal bars. `items` [{key, label, value, note?}]. */
export function BarList({ title, items, format, empty = 'Ще немає даних за цей період.' }) {
  const max = Math.max(0, ...items.map(item => item.value));
  return <figure className="dash-chart dash-barlist">
    <figcaption className="dash-chart-title">{title}</figcaption>
    {items.length ? <ol className="dash-bars">{items.map(item => <li key={item.key} title={`${item.label}: ${format(item.value)}${item.note ? ` · ${item.note}` : ''}`}>
      <span className="dash-bar-label">{item.label}</span>
      <span className="dash-bar-value">{format(item.value)}{item.note && <small>{item.note}</small>}</span>
      <span className="dash-bar-track" aria-hidden="true"><span className="dash-bar" style={{ width: max > 0 ? `max(2px, ${(item.value / max) * 100}%)` : 0 }}/></span>
    </li>)}</ol> : <p className="dash-empty">{empty}</p>}
  </figure>;
}

/** Usage against a limit. `fraction` null means the limit or usage is unknown. */
export function Meter({ label, used, limit, fraction, tone, note }) {
  return <div className={`dash-meter dash-meter-${tone}`}>
    <div className="dash-meter-head"><span>{label}</span><strong>{used}{limit ? <small> з {limit}</small> : null}</strong></div>
    <div className="dash-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} aria-valuetext={fraction === null ? 'невідомо' : `${Math.round(fraction * 100)}%`}>
      {fraction !== null && <span className="dash-meter-fill" style={{ width: `max(2px, ${fraction * 100}%)` }}/>}
    </div>
    {(note || fraction !== null) && <small className="dash-meter-note">{fraction !== null ? `${Math.round(fraction * 100)}% ліміту` : ''}{note ? `${fraction !== null ? ' · ' : ''}${note}` : ''}</small>}
  </div>;
}
