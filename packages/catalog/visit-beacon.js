// Cookieless visit beacon. One source for the storefront bundle and the Worker-rendered product
// page, which inlines `startVisitBeacon.toString()`: so the function must stay self-contained (no imports,
// no outer variables). It stores nothing on the device and honours Do Not Track / Global Privacy Control.
export function startVisitBeacon(win) {
  try {
    var nav = win.navigator, loc = win.location, doc = win.document;
    if (!nav || typeof nav.sendBeacon !== 'function' || nav.webdriver) return false;
    if (nav.globalPrivacyControl === true || nav.doNotTrack === '1' || win.doNotTrack === '1') return false;
    if (/^\/(admin|staff|account|cart|api)(\/|$)/.test(loc.pathname)) return false;
    var send = function (type) {
      try {
        var body = { type: type, path: loc.pathname };
        if (type === 'view' && doc.referrer) body.ref = doc.referrer;
        nav.sendBeacon('/api/visit', JSON.stringify(body));
      } catch (error) { /* best effort */ }
    };
    send('view');
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') send('leave'); });
    win.addEventListener('pagehide', function () { send('leave'); });
    return true;
  } catch (error) { return false; }
}

/** Inline <script> body for server-rendered pages. The Worker bundle is built with esbuild keepNames, which rewrites
 * inner functions as `__name(fn, "name")`; the wrapper defines a local identity `__name` so the copied source runs. */
export const VISIT_BEACON_INLINE = `(function(){var __name=function(f){return f};(${startVisitBeacon.toString()})(window);})();`;
