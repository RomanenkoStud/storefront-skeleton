import React, { useEffect, useRef, useState } from 'react';
import { Icon, Notice } from './ui.jsx';

/** A reversible catalog operation still deserves a clear, keyboard-friendly choice. */
export default function ConfirmDialog({title,children,confirmLabel='Підтвердити',onConfirm,onClose,danger=false}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef(null),cancel=useRef(null);
  useEffect(()=>{
    const previous=document.activeElement,before=document.body.style.overflow;
    document.body.style.overflow='hidden';cancel.current?.focus();
    return()=>{document.body.style.overflow=before;if(previous?.isConnected)previous.focus();else document.querySelector('[data-dialog-return]')?.focus();};
  },[]);
  useEffect(()=>{if(busy)dialog.current?.focus();},[busy]);
  function keydown(e){
    if(e.key==='Escape'&&!busy){e.preventDefault();onClose();}
    if(e.key!=='Tab')return;
    const list=[...dialog.current.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled)')].filter(el=>el.getClientRects().length),first=list[0],last=list.at(-1);
    if(!first){e.preventDefault();dialog.current?.focus();return;}
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
    if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
  }
  async function confirm(){setBusy(true);setError('');try{await onConfirm();onClose();}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <div className="modal-backdrop"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description" className="modal confirm-modal" onKeyDown={keydown}><header className="modal-header"><h2 id="confirm-title">{title}</h2><button className="icon-button" aria-label="Закрити підтвердження" disabled={busy} onClick={onClose}><Icon name="close"/></button></header><div className="modal-body"><div id="confirm-description">{children}</div>{error&&<Notice>{error}</Notice>}</div><footer className="modal-footer"><button ref={cancel} className="button secondary" disabled={busy} onClick={onClose}>Скасувати</button><button className={`button ${danger?'danger':'primary'}`} disabled={busy} onClick={confirm}>{busy?'Виконуємо…':confirmLabel}</button></footer></section></div>;
}
