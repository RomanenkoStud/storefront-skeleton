# ADR-0009: WebGL graffiti-wall landing intro (three.js)

**Superseded by [ADR-0014](0014-fresh-drop-hero-and-brand-slots.md)** (proposed): the intro is retired, and the never-built v5 "Shopfront" amendment (not on this branch) is withdrawn.

Status: **Proposed** (amended for v3 and v4 below). Replaces the flat SVG spray overlay that the lead rejected after a preview. Needs lead acceptance before the branch is promoted. Partly supersedes the homepage motion brief (no longer in the repository) for this one effect; the brief's rules for ordinary controls still apply.

Note: the sections down to "Revisit when" record the v2 decision; the [v3 amendment](#amendment-v3-replay-every-load-concrete-wall-sticker-piece-lathe-can) at the end supersedes them where they conflict (replay policy, brick wall, Sedgwick font, 3.7 s timeline, once-per-session flag).

## Context

- **Lead request.** On entering the landing page, play an arcade-style 3D graffiti tagging animation: colour spray on a real 3D wall with real textures, using a JavaScript library. The reference is a style only. The scene, wall, lettering and motion are original, with no characters, art, logos, music or level design from any game.
- **Constraints.** The hero text and poster must paint immediately (LCP is untouched). The effect is decorative, never blocks input and is skipped for reduced motion and when WebGL2 or storage is unavailable. Light catalog first: the heavy code loads lazily and only after the poster has loaded.

## Options considered

| Option | Result | Outcome |
| --- | --- | --- |
| **three.js 0.187.0, vanilla** (`import` only in `spray-scene.js`, lazy chunk) | PBR materials (diffuse, normal, roughness/AO), lights, camera dolly, particles, disposal and context handling are built in. About 140 kB gzip with tree-shaking | **Chosen** |
| React Three Fiber | Adds a React reconciler and drei-style helpers for one non-interactive scene with no component state | Rejected: more runtime and maintenance for no gain here |
| Raw WebGL2 | Smallest payload, but PBR shading, texture handling and loss recovery would be hand-written and hard to review | Rejected |
| OGL or similar minimal library | Smaller, but no PBR material and no maintained lighting model | Rejected |
| CSS 3D transforms | No real lighting or normal-mapped relief; cannot give raking-light brick | Rejected: does not meet "real 3D wall" |

## Decision

- A lazy chunk (`SprayIntro.jsx`, `spray-scene.js`, `spray-paint.js`, three.js) renders a Poly Haven `red_brick_03` wall (CC0) with diffuse, normal and ARM maps under a raking key light. A coplanar paint plane shares the wall's normal, AO and roughness maps, so paint follows the brick relief with a glossier roughness. A 2D canvas builds the piece (Sedgwick Ave Display, lime to yellow to pink gradient, dark outline and extrude, highlights, drips) and is revealed by soft dabs along a deterministic nozzle path. Mist particles, a nozzle point light and a small can complete the scene (at most 8 draw calls).
- Timeline 3.7 s: enter, fill with camera dolly (angled to frontal), outline, details, settle, fade. Then the renderer, geometries, textures and host are disposed and the WebGL context is released. There is no idle loop.
- Placement: poster mode on tablets and desktops (poster above its caption, at least 240 px), hero mode on phones (tap-through). The host is `position: fixed`, moved only by `transform`, `pointer-events: none` except a 44 px Skip button that is the first Tab stop.
- Boot stays tiny and in the main bundle (`spray-intro-boot.jsx`, `spray-gate.js`): gating, a WebGL2 probe, start after the poster has decoded and the browser is idle, a 3 s first-frame deadline, and `html[data-spray-intro-state]`. The once-per-session flag (`ls-spray-intro-v2`) is set only when the first frame is shown.
- Ends on pointer, wheel, scroll, Escape, width resize, hidden tab, context loss or frame guard (rolling median of frame times: drop DPR, then halve particles and upload rate, and end only if still very slow). Fallbacks (reduced motion, no WebGL2, load failure, deadline) mount nothing.
- Defaults the lead may override: L1 hand off to the existing hero (no persistent painted wall), L2 red brick (alternative: whitewashed brick), L3 phones play with tap-through and Skip (alternative: skip on phones), L4 palette lime, yellow, pink with a dark outline, L5 Sedgwick Ave Display (alternative: Rubik Spray Paint), D6 once per session, D7 512 px textures.

## Consequences

- New dependency `three` (exact `0.187.0`, MIT). Payload loaded only on first landing visit per session after the poster: about 325 kB compressed (chunk 141 kB gzip, three WebP textures 157 kB, font 25 kB). Main bundle growth is under 3 kB gzip.
- Assets: Poly Haven red_brick_03 (CC0, Rob Tuytel) and Sedgwick Ave Display (SIL OFL 1.1). Sources, parameters and licence text: `apps/web/src/assets/spray-intro/README.md`, `apps/web/public/licenses/spray-intro.txt`.
- Playwright's software WebGL (SwiftShader) is slow, so e2e specs disable the frame guard through the `window.__lsSprayIntroTest` hook. Frame rates there are not representative.
- `/products/*` is server-rendered HTML without the app bundle, so no `html[data-spray-intro-state]` attribute is set there (nothing runs, nothing loads). Specs assert the attribute only on routes served by the app shell (`/`, `/cart`, `/account`, `/admin`).
- Stored once-per-session key changed to v2, so people who saw the SVG version see this one again.

## Revisit when

- The lead wants a persistent painted wall (changes hero markup and CSS that differ on staging) or the intro on every visit.
- Real-device traces show the frame guard ending the intro on common phones, or LCP/CLS regress.
- A second 3D scene appears; then compare a shared renderer or R3F.
- A smaller engine meets the same material needs.

## Amendment v3: replay every load, concrete wall, sticker piece, lathe can

The lead previewed the v2 build and asked for: the intro on every page reload, a visible moving spray can, colours in the site's palette, a wall like the one in the banner, a Subway-Surfers-like spray motion and a CS2-like graffiti look. Both games are style references only; nothing of theirs (characters, art, audio, assets) is used and all assets are CC0, OFL or procedural.

- **Replay policy.** The intro plays on every document load of `/` (navigate or reload). Root cause of "can't see it on reload": v2 stored a once-per-session flag, so reload was `skipped:seen`; the flag also was set on the first frame and early input ended it, and the 3 s deadline started before the poster. v3 removes all storage. Skips (recorded in `html[data-spray-intro-state]`): route, hash, back-forward (`performance.getEntriesByType('navigation')`), reduced motion, opt-out (`?intro=0` or the test hook), no-webgl, hero-not-top. `?intro=1` forces play, bypassing hash, back-forward and hero-not-top (it scrolls to the top) but never reduced motion or WebGL absence (it logs the reason with `console.info`). Input before the first frame abandons (`abandoned:user-input`); after it only a scroll of more than 2 px, a wheel, pointer, Escape, width resize, hidden tab or context loss ends it. `history.scrollRestoration` is `manual` only while the intro is a play candidate and is restored to `auto` on every end or skip. The deadline clock starts after the poster has loaded and decoded (poster cap 6 s, forced 10 s); chunks, font and textures then load in parallel with a 3.5 s budget (forced 15 s) and miss gives `abandoned:deadline`. Cost: other e2e specs that open `/` now see the intro on each load (it is `pointer-events: none`; use `?intro=0` to opt out).
- **Wall decision: option A.** Poly Haven `concrete_wall_008` (CC0), colour-graded to the banner photo, 512 px WebP diffuse, normal and ARM, tiled about 0.9 times per frame height under a neutral key light plus hemisphere. The banner shows weathered poured concrete, not brick (the v2 premise was wrong). Option B (painting onto the photo itself with a Sobel normal map) was rejected: the model covers most of the wall so the tag lands on the person or is illegible, a Sobel normal bakes the person into the relief, a single flat photo card cannot take the angled camera, and the payload is about 280 kB. Option C (a tiled crop of the photo as albedo) was rejected: visible tiling seams and the photo is not CC0.
- **Font.** Knewave (SIL OFL 1.1, Reserved Font Name "Knewave", shipped unmodified, 17.4 kB latin woff2) replaces Sedgwick Ave Display: chunky, slanted, sticker-friendly letterforms. Fallback if needed: Bangers.
- **Piece.** A flat sticker stack on a 2D canvas using only storefront tokens: ink overspray halo, cream outer outline, moss extrude, ink outline, lime fill with a deeper lower band, off-white inner highlight, light grain, olive swoosh, cream sparkles, tapered lime drips from the first word only. Paint alpha is at most 0.96 so the concrete shows through. No gradient and no extra accent colour.
- **Lathe can.** A procedural aerosol (LatheGeometry: bevel, body, bead, domed shoulder, neck, valve cup; canvas label; cream actuator with an ink nozzle; metallic clearcoat material lit by a small procedural environment). No CC0 glTF aerosol of suitable quality was found, so no model asset is added. It is rigged to the nozzle target with a critically damped spring, wrist roll from velocity, yaw toward the wall, recoil kicks and entrance/exit slides. The test hook reports its projected height (`canPx`), asserted at least 28 % of the box in hero mode and 22 % in poster mode.
- **Choreography** (pure, `spray-choreo.js`, 4.2 s): enter, shake, aim with a camera push-in, four fill passes with recoil gaps and overspray puffs, outline pass, highlight flick, exit, hold, fade. The brief's 3.6 s was lengthened to 4.2 s so that the finished piece is on screen for at least 1.1 s before the fade (outline done at 2.7 s, fade starts at 3.85 s).
- **Frame guard ladder.** Rolling median of frame times, one step at a time: fewer particles and no puffs, DPR 1, paint upload on every second frame with no mipmaps, no nozzle light; when all steps are used and frames are still slow the intro jumps to the finished piece (`complete-snap`), holds and fades. It never aborts to a blank banner.
- **ReadPixels.** The Chromium "GPU stall due to ReadPixels" warnings seen under Playwright come from the headless GL presentation path on the first WebGL canvas per process (a bare three.js cube reproduces them), not from app code; the 2D paint canvases are CPU-backed and no pixel is read while playing. With `--use-angle=swiftshader --enable-unsafe-swiftshader` the warnings are absent, and the spray spec uses those launch options and asserts zero ReadPixels messages. Real GPUs were not tested.
- **Context release.** `forceContextLoss()` flushes the GPU queue and blocked the main thread for over a second under software GL, so it runs 1.5 s after the overlay is gone; geometries, textures and the renderer are disposed immediately.
- **Payload.** Main bundle +2.4 kB gzip; lazy about 200 kB compressed (three.js chunk 137 kB gzip, intro chunk 7 kB, textures 42 kB, font 17 kB).

## Amendment v4: persistent chrome piece on the generated hero wall

The lead approved the draft look: "looks awesome, just too metallic". The intro no longer disappears; it ends with the finished piece painted permanently on the hero banner.

- **Assets.** The hero poster is `hero-wall.webp`, a generated graffiti-spot image supplied by the lead. It replaces `jump.jpg` (deleted; nothing else referenced it) and the earlier concrete textures. The piece is a generated chrome artwork, keyed from a magenta ground and split by colour into layers (`piece.webp`, `piece-layers.png`). No third-party assets or fonts remain; provenance is in `assets/spray-intro/README.md` and `public/licenses/spray-intro.txt`. The Poly Haven textures, Sedgwick Ave Display and Knewave from v2/v3 are gone.
- **Persistence.** At the end the finished 2D paint canvas is copied into a static canvas inside the poster (`[data-spray-final]`, `pointer-events: none`, `aria-hidden`), placed with a CSS `matrix3d` homography that is recomputed on resize. The WebGL renderer is then disposed; nothing keeps drawing. Skip and every other dismissal also persist the finished piece. When the animation does not play on `/` (reduced motion, no WebGL2, `?intro=0`, back/forward, hash, deadline, load failure) the same piece is shown statically. Other routes show nothing. `?intro=` now survives the catalog filter URL sync (`withPreserved` in `catalog-filters.js`).
- **Look.** Matte sprayed silver and white paint, not metal: the scene's paint is an unlit `MeshBasicMaterial` over a transparent canvas whose backdrop is the real poster photo (no 3D wall copy), so there is no specular and the 3D scene matches the persisted overlay (both use `PAINT_OPACITY` 0.95). Wall pores, a warm sunlight multiply and soft grain are baked into every layer once (`spray-paint.js`), so highlights come only from the painted shines and sparkles.
- **Perspective.** The piece is a quad fitted to the wall's receding formwork seams (vanishing point to the right), rendered as a 24x14 grid mesh with per-vertex homography in the scene and as `matrix3d` in the overlay.
- **Choreography (8.7 s).** Rattle, test burst, thin traced black outline sketch, silver letter by letter, re-shake and colour swap, black outline, block shadow (separate passes), white STORE and bars, lime edge, sparkles, drips running in real time, exit, host fade onto the already persisted piece.
- **Phones.** At narrow widths the poster sits below the hero copy. The static piece is shown first; the intro starts only once at least 60% of the poster is visible (IntersectionObserver) and scrolling has been idle for 250 ms, and the deadline clock starts then. A visitor who never scrolls simply keeps the static piece. Scrolling while waiting is not treated as an interruption.
- **Dismissal.** Ending hides the animation synchronously (visibility, opacity, pointer events) after persisting the piece, restores `history.scrollRestoration` immediately (also on `pagehide`), and disposes on the next task. Errors in the frame loop end the intro cleanly. A forced snap cannot rewind. Key repeat and modifier-only keys do not cancel a pending intro.
- **Draw calls.** Measured at most 7 per frame: paint, can body, three actuator parts (two cylinders and the nozzle hole disc), points and the contact shadow (the wall mesh was removed in the v4 fix round, see below). The earlier "at most 6" figure from v3 no longer holds.
- **Payload.** Lazy: three.js chunk about 138 kB gzip, intro chunk about 8 kB, `piece.webp` 178 kB, `piece-layers.png` 23 kB (the hero image is the poster itself and is requested by the page, 247 kB). Main bundle growth stays under 3 kB gzip.

### v4 fix round

- **Phone wait holds nothing.** The gate lives in the lazy `spray-run.js`. `history.scrollRestoration = 'manual'` and the early-input listeners are installed only after the poster is visible (>= 60% and scroll settled 250 ms); the IntersectionObserver uses the last entry and is disconnected on resolve, abandon and `pagehide`; a bfcache restore (`pageshow.persisted`) never resumes the old wait. A phone that never scrolls keeps the static piece and requests no animation assets. The static piece is removed only once the first animation frame is on screen (one shared static-piece promise, so it cannot reappear under the host).
- **Main entry.** `spray-intro-boot.jsx` now only decides (route, hash, reduced motion, opt-out, WebGL2) and lazily imports `spray-run.js` (gate, deadline, input guards) or `spray-static.js` (the static piece). Main entry gzip: 134.02 kB against the 132.03 base (+1.99 kB).
- **Transparent scene.** The WebGL canvas is transparent and draws only the piece, the can, mist and a contact shadow over the real poster photo. There is no 3D wall copy and the camera is static, so the hand-off to the persisted overlay has no wall mismatch (measured mean absolute difference inside the piece area: 5.8 at 1280, 4.8 at 375, bias under 2 grey levels). This supersedes the v2/v3 camera push-in and the v2 AC14 half-size paint canvas on phones (`qualityTier` no longer has paint size fields; the artwork has one size).
- **Static path** loads `piece-final.webp` (about 146 kB) only; no `createPaint`, no layer map. Temporary canvases in `createPaint` are zeroed after use.
- **Safari.** The soft edge of the black layers uses the shadow-blur trick instead of `ctx.filter`.
- **Poster crop.** Between 651 and 900 px the poster's `object-position` is 53% so the piece quad stays inside the crop (asserted at 375, 700, 768, 900 and 1280 px).
- **Can label.** The approved can reference has no text; the label stays text-free by decision (lime band, grid, stripes, tick marks), now larger on screen (about 21% of the poster height).
- **Fix round 2.** The static image has its own marker (`data-spray-static`) and `mountFinal` replaces it, so dismissing while `piece-final.webp` is still loading can no longer remove the persisted canvas. On phones the static image is removed only when the host is fully opaque. The scene's paint mesh is hidden in the same frame that the overlay is persisted (no double compositing). A failing animation chunk and a bfcache restore before the first frame show the static piece and end in a terminal state (`abandoned:load-failure`, `abandoned:bfcache`). The animation code (`spray-run`) is requested after the poster has loaded.

## Amendment v4.1: phones play while scrolling; piece moved left

The lead found that on phones the intro usually never played: the poster sits below the hero copy, and a touch or scroll (before or during the animation) abandoned or dismissed it.

- **Phone gate at 35%.** The intro starts once at least 35% of the poster is visible (`SPRAY_PHONE_VISIBLE`) and scrolling has been idle for 250 ms. This replaces the 60% gate in v4. A partly visible piece being drawn invites the visitor to scroll to it.
- **Touch and scroll never cancel on touch-first devices** (`touchFirst()`: width < 700 px or `pointer: coarse`). Before the first frame only a key press abandons. While playing, a tap (`click`) dismisses (the piece persists) and Skip still works; touching, dragging and scrolling do not. Desktop is unchanged: pointer, wheel, scroll and Escape dismiss.
- **The host scrolls with the page.** It is now `position: absolute` in document coordinates (translated to the poster's page position), not `position: fixed`, so it stays aligned with the poster while the page scrolls, without per-frame repositioning lag.
- **Piece placement.** `WALL_IMG.quad` moved left by 0.0625 of the image width (about 50 px on desktop) into the open area of the wall. The tablet crop (`max-width: 900px`) is now `object-position: 41%`, so the piece stays framed from 651 to 900 px. `piece-final.webp` was regenerated for the new quad.
