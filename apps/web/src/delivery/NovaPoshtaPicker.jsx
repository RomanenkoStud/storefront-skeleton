import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { KINDS, MESSAGES, createPickerController, initialPickerState, emptyView, cityOptionLabel, toPickerValue, valueSummary } from './np-picker-logic.js';
import './np-picker.css';

/**
 * Nova Poshta delivery-point picker (ADR-0011 section 11).
 * value: PickerValue|null = {type, cityRef, cityName, warehouseRef, warehouseNumber, warehouseName}
 * onChange(value|null): a point was selected, or the selection was cleared. Consumers send only {warehouseRef} to the server.
 * api: optional {searchCities, loadPoints} (tests).
 */
export default function NovaPoshtaPicker({ value = null, onChange, idPrefix = 'np', disabled = false, legend = 'Пункт Нової пошти', api, geo, timers }) {
  const [editing, setEditing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const changeButton = useRef(null), pendingFocus = useRef(null);
  // Move focus deliberately after a mode switch: the focused control is unmounted by it.
  useEffect(() => {
    const target = pendingFocus.current; pendingFocus.current = null;
    if (target === 'change') changeButton.current?.focus();
    else if (target === 'city') document.getElementById(`${idPrefix}-city`)?.focus();
  });
  const select = next => { if (disabled) return; pendingFocus.current = 'change'; setEditing(false); setAnnouncement(`Обрано: ${valueSummary(next)}`); onChange?.(next); };
  const edit = () => { pendingFocus.current = 'city'; setEditing(true); };
  const clear = () => { pendingFocus.current = 'city'; setEditing(false); setAnnouncement('Вибір очищено.'); onChange?.(null); };
  const cancel = () => { pendingFocus.current = 'change'; setEditing(false); };
  return (
    <fieldset className="np-picker" disabled={disabled} aria-describedby={`${idPrefix}-help`}>
      <legend>{legend}</legend>
      {value && !editing && (
        <div className="np-selected">
          <p id={`${idPrefix}-selected`}><strong>Обрано:</strong> <span>{valueSummary(value)}</span></p>
          <div className="np-actions">
            <button type="button" ref={changeButton} className="button secondary" onClick={edit}>Змінити пункт</button>
            <button type="button" className="button secondary" onClick={clear}>Очистити</button>
          </div>
        </div>
      )}
      {(!value || editing) && <PickerFlow initial={value} idPrefix={idPrefix} api={api} geo={geo} timers={timers} disabled={disabled} onSelect={select} onCancel={value ? cancel : null} />}
      <p id={`${idPrefix}-help`} className="np-help">Спершу оберіть місто, потім тип пункту.</p>
      <div className="np-sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    </fieldset>
  );
}

const noopController = new Proxy({}, { get: (_t, name) => (name === 'subscribe' ? () => () => {} : name === 'cityKeyDown' || name === 'pointKeyDown' ? () => ({ handled: false }) : () => undefined) });

function PickerFlow({ initial, idPrefix, api, geo, timers, disabled, onSelect, onCancel }) {
  // The controller (requests, timers, geolocation) is created and destroyed by the effect, never during render,
  // so remounts and StrictMode work. Until it exists the flow renders an inert initial state.
  const [controller, setController] = useState(null);
  useEffect(() => {
    const created = createPickerController({ initial, api, geo, timers });
    setController(created);
    return () => { created.destroy(); setController(null); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const active = controller ?? noopController;
  const idle = useRef(null);
  if (!idle.current) idle.current = initialPickerState(initial);
  const s = useSyncExternalStore(active.subscribe, controller ? controller.getState : () => idle.current, () => idle.current);
  return <PickerFlowView s={s} v={controller ? controller.view() : emptyView} locatable={controller ? controller.canLocate() : false} c={active} idPrefix={idPrefix} disabled={disabled} onSelect={onSelect} onCancel={onCancel} />;
}

/** Presentational flow: `s` controller state, `v` its view, `c` the controller (or a stub in render tests). */
export function PickerFlowView({ s, v, locatable, c: controller, idPrefix, disabled = false, onSelect, onCancel }) {
  const { rows, total, shown, hasMore } = v;
  const cityId = `${idPrefix}-city`, cityList = `${cityId}-list`, kindName = `${idPrefix}-kind`, pointId = `${idPrefix}-point`, pointList = `${pointId}-list`;
  const activeCityId = s.citiesOpen && s.activeCity >= 0 ? `${cityId}-opt-${s.activeCity}` : undefined;
  const activePointId = s.activePoint >= 0 && rows[s.activePoint] ? `${pointId}-opt-${s.activePoint}` : undefined;
  const locked = s.unavailable;
  const choose = point => !disabled && onSelect(toPickerValue(point, s.city, s.kind));
  useEffect(() => { if (activeCityId) document.getElementById(activeCityId)?.scrollIntoView?.({ block: 'nearest' }); }, [activeCityId]);
  useEffect(() => { if (activePointId) document.getElementById(activePointId)?.scrollIntoView?.({ block: 'nearest' }); }, [activePointId]);

  // Keep focus on a control that still exists after the focused one unmounts or is disabled.
  const focusAfter = useRef(null);
  useEffect(() => {
    if (!focusAfter.current || disabled) return;
    if (s.citiesStatus === 'loading' || s.pointsStatus === 'loading') return;
    const point = document.getElementById(pointId);
    if (focusAfter.current === 'more' && document.getElementById(`${pointId}-more`)) { focusAfter.current = null; return; }
    const target = focusAfter.current !== 'city' && s.city && point && !point.disabled ? point : document.getElementById(cityId);
    focusAfter.current = null;
    if (s.city && !point) return;
    // Retry failed again and the target is disabled: keep focus on the retry button.
    (target && !target.disabled ? target : document.querySelector(`#${cityId}`)?.closest('.np-flow')?.querySelector('.np-retry'))?.focus?.();
  });
  const refocus = (where, action) => () => { focusAfter.current = where; action(); };

  function cityKey(e) {
    if (e.key === 'Enter') e.preventDefault(); // never submit a surrounding form from a combobox
    if (disabled) return;
    const result = controller.cityKeyDown(e.key);
    if (result.handled) e.preventDefault();
  }
  function pointKey(e) {
    if (e.key === 'Enter') e.preventDefault();
    if (disabled) return;
    const result = controller.pointKeyDown(e.key);
    if (result.handled) e.preventDefault();
    if (result.point) choose(result.point);
  }
  const pointsReady = s.city && s.pointsStatus === 'ready';

  return (
    <div className="np-flow">
      <div className="np-field">
        <label htmlFor={cityId}>Місто</label>
        <input id={cityId} type="text" role="combobox" autoComplete="off" maxLength={50} value={s.query} disabled={locked}
          aria-expanded={s.citiesOpen && s.cities.length > 0} aria-controls={cityList} aria-autocomplete="list" aria-activedescendant={activeCityId}
          aria-busy={s.citiesStatus === 'loading'} placeholder="Почніть вводити назву міста"
          onChange={e => controller.setQuery(e.target.value)} onKeyDown={cityKey} onFocus={controller.openCities} onBlur={controller.closeCities} />
        {s.citiesOpen && s.cities.length > 0 && (
          <ul id={cityList} role="listbox" aria-label="Знайдені міста" className="np-options">
            {s.cities.map((city, i) => (
              <li key={city.ref} id={`${cityId}-opt-${i}`} role="option" aria-disabled={disabled || undefined} aria-selected={i === s.activeCity} className={i === s.activeCity ? 'active' : ''}
                onMouseDown={e => e.preventDefault()} onClick={disabled ? undefined : () => controller.pickCity(city)} onMouseMove={() => i !== s.activeCity && controller.setActiveCity(i)}>
                {cityOptionLabel(city)}
              </li>
            ))}
          </ul>
        )}
      </div>

      {s.city && (
        <fieldset className="np-kind" disabled={locked}>
          <legend>Тип пункту</legend>
          {KINDS.map(k => (
            <label key={k.value}><input type="radio" name={kindName} value={k.value} checked={s.kind === k.value} onChange={() => controller.setKind(k.value)} /> {k.label}</label>
          ))}
        </fieldset>
      )}

      {s.city && (
        <div className="np-field">
          <label htmlFor={pointId}>Пошук за номером або адресою</label>
          <input id={pointId} type="text" role="combobox" autoComplete="off" value={s.filter} disabled={locked || s.pointsStatus !== 'ready'}
            aria-expanded={Boolean(pointsReady) && total > 0} aria-controls={pointList} aria-autocomplete="list" aria-activedescendant={activePointId}
            aria-busy={s.pointsStatus === 'loading'} placeholder="Номер або частина адреси"
            onChange={e => controller.setFilter(e.target.value)} onKeyDown={pointKey} />
          {locatable && (
            <div className="np-geo">
              <button type="button" className="button secondary" disabled={locked || s.geoStatus === 'locating'} onClick={refocus('point', controller.locate)}>Найближчі до мене</button>
              {s.sorted && <button type="button" className="text-button" onClick={refocus('point', controller.clearLocation)}>Скинути сортування</button>}
            </div>
          )}
          {pointsReady && total > 0 && (
            <>
              <ul id={pointList} role="listbox" aria-label={`Пункти: ${KINDS.find(k => k.value === s.kind).label}, ${s.city.name}`} className="np-options np-points">
                {rows.map(({ point, distance }, i) => (
                  <li key={point.ref} id={`${pointId}-opt-${i}`} role="option" aria-disabled={disabled || undefined} aria-selected={i === s.activePoint} className={i === s.activePoint ? 'active' : ''}
                    onMouseDown={e => e.preventDefault()} onClick={disabled ? undefined : () => choose(point)} onMouseMove={() => i !== s.activePoint && controller.setActivePoint(i)}>
                    <span>{point.name}</span>{distance && <small className="np-distance"> {distance}</small>}
                  </li>
                ))}
              </ul>
              <p className="np-count">Показано {shown} з {total}</p>
              {hasMore && <button type="button" className="button secondary" id={`${pointId}-more`} onClick={refocus('more', controller.showMore)}>Показати ще</button>}
            </>
          )}
          {pointsReady && total === 0 && <p className="np-empty">Пунктів не знайдено. Змініть пошук або тип пункту.</p>}
        </div>
      )}

      {s.geoStatus === 'denied' && <p className="np-message">{MESSAGES.geoDenied}</p>}
      {s.geoStatus === 'failed' && <p className="np-message">{MESSAGES.geoFailed}</p>}
      {s.error && <p className="np-error">{s.error} <button type="button" className="text-button np-retry" onClick={refocus('point', controller.retry)}>Повторити</button></p>}
      {onCancel && <button type="button" className="text-button" onClick={onCancel}>Скасувати зміну</button>}
      <div className="np-sr" role="status" aria-live="polite" aria-atomic="true">{s.announcement}</div>
    </div>
  );
}
