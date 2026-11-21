import React, { useId } from 'react';

/**
 * Collapsible filter panel for phones. Styled only inside the phone media range (admin-mobile/base.css): render it only
 * when useMediaQuery(PHONE) is true. It is an inline disclosure, not an overlay: no role="dialog" (useDialogFocus uses the first
 * [role="dialog"] in the document) and no focus trap.
 *
 * Props (controlled)
 *   count       number of active, non-default filters, shown as «Фільтри (N)»
 *   open        whether the panel is expanded
 *   onToggle    called when the toggle is pressed
 *   onReset     called by «Скинути фільтри»; the caller restores its defaults
 *   controlsId  id of the panel for aria-controls (a generated id is used when omitted)
 *   children    the stacked, full-width filter controls; they stay mounted while collapsed (the panel is `hidden`) so their state is kept
 */
export default function FilterDisclosure({ count = 0, open = false, onToggle, onReset, controlsId, children }) {
  const generated = useId();
  const id = controlsId || generated;
  return <div className="m-filters">
    <button type="button" className="button secondary m-filters-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>Фільтри ({count})<span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
    <div id={id} className="m-filters-panel" hidden={!open}>
      {children}
      <button type="button" className="button secondary" onClick={onReset}>Скинути фільтри</button>
    </div>
  </div>;
}
