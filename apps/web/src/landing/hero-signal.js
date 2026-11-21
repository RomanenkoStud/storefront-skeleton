// "The hero's lead tile has settled" (its image loaded or failed, or the hero has no tiles). The rack room waits for it
// before requesting its many images, so they do not compete with the hero's lead image (ADR-0014 LCP gate).
let settled = false;
const subscribers = new Set();
export const heroSettled = () => settled;
export function markHeroSettled() {
  if (settled) return;
  settled = true;
  for (const fn of subscribers) fn();
  subscribers.clear();
}
export function onHeroSettled(fn) {
  if (settled) { fn(); return () => {}; }
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
