// 3D Highway visualization plugin — Three.js note highway with a
// 6-string fretboard, fret wires, beat lines, and a camera that
// follows the playhead.
//
// Wave C (slopsmith#36): structural alignment with the Wave C
// plugin pattern (piano / drums / tabview / jumpingtab). Wave B
// (PR #4) already shipped the per-instance refactor — state in
// closure, no module-level singletons except the memoized Three.js
// library load, no `getElementById('highway')`, no `song:ready`
// subscription. This wave adds: the standard `_ss*()` splitscreen
// helper wrappers consumed by the other Wave C plugins, a
// `_nextInstanceId` counter for DOM tagging, the `_focusSubscribed`
// belt-and-suspenders pattern around onFocusChange, and a
// focus-driven scene dim so an unfocused panel's 3D scene visibly
// recedes when looking at a 4-up quad. Plus a DPR cap reduction
// under splitscreen since N concurrent WebGLRenderers each at
// devicePixelRatio:2 would burn GPU bandwidth fast.
//
// 3dhighway doesn't have settings panels or MIDI input, so the
// `_ss*()` surface it consumes is narrower than piano / drums:
// just `isActive` + `isCanvasFocused` + `onFocusChange` /
// `offFocusChange`. The `_ssActive()` validator gates on exactly
// those — partial helpers that lack the focus surface fall back
// to the main-player single-instance fast path.

(function () {
    'use strict';

    /* ======================================================================
     *  Constants — derived from ChartPlayer's FretPlayerScene3D.cs
     *  All ref values are from ChartPlayer (scaleLength=300 space).
     *  K = SCALE / 300 maps them into our world-unit space.
     * ====================================================================== */

    const CDN =
        'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    const S_COL = [
        0xcc2222, 0xddaa00, 0x2266dd, 0xdd8800, 0x22aa22, 0x8822cc,
    ];

    const SCALE  = 3;
    const K      = SCALE / 300;      // unit scale factor

    const NFRETS = 24;
    const NSTR   = 6;

    // String layout  (ChartPlayer: Y = 3 + string * 4)
    const S_BASE = 3 * K;
    const S_GAP  = 4 * K;

    // Time  (ChartPlayer: timeScale = NoteDisplayDistance / NoteDisplaySeconds = 600/3)
    const AHEAD  = 3.0;
    const BEHIND = 0.5;
    const TS     = 200 * K;

    // Note dimensions — vertical rounded rectangles
    const NW = 5 * K,  NH = 7 * K,  ND = 2 * K;
    const N_RAD = 1.5 * K;   // corner radius
    const SW = 2 * K,  SH = 1.5 * K;

    // Camera  (ChartPlayer FretCamera base, pulled back to see full board)
    const CAM_H_BASE = 150 * K;
    const CAM_DIST_BASE = 240 * K;
    const REF_ASPECT = 16 / 9;    // reference aspect ratio these values were tuned for
    const FOCUS_D  = 600 * K;
    const CAM_LERP_BASE = 0.02;   // base lerp at 120 BPM (~highway.js rate)

    // Fog  (ChartPlayer: start=400, end=cameraDistance+focusDist)
    const FOG_START = 400 * K;
    const FOG_END   = 670 * K;

    const DOTS  = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
    const DDOTS = new Set([12, 24]);

    /* ======================================================================
     *  Pure helpers (no per-instance state)
     * ====================================================================== */

    function bendText(bn) {
        if (bn === 0.5) return '½';
        if (bn === 1) return 'full';
        if (bn === 1.5) return '1½';
        if (bn >= 2) return String(Math.round(bn));
        return bn.toFixed(1);
    }

    const fretX   = f => (f <= 0 ? 0 : SCALE - SCALE / Math.pow(2, f / 12));
    const fretMid = f => (f <= 0 ? -2 * K : (fretX(f - 1) + fretX(f)) / 2);
    const dZ      = dt => -dt * TS;

    // Compute BPM from beats nearest the given time. Replicates
    // highway.getBPM (not in the bundle) so we stay self-contained.
    // O(log n) — beats arrive sorted by time (slopsmith core guarantees),
    // so bisect to find the insertion index, then compare the two
    // candidates on either side to pick the closest. Matters for long
    // songs at 60fps: the original linear scan was O(beats) per frame.
    function computeBPM(beats, t) {
        if (!beats || beats.length < 2) return 120;
        // Bisect: find index `lo` such that beats[lo].time >= t (or
        // beats.length if t is past every beat).
        let lo = 0, hi = beats.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (beats[mid].time < t) lo = mid + 1;
            else hi = mid;
        }
        // Closest is either lo or lo-1.
        let closest = lo;
        if (lo === beats.length) {
            closest = beats.length - 1;
        } else if (lo > 0 &&
                   Math.abs(beats[lo - 1].time - t) < Math.abs(beats[lo].time - t)) {
            closest = lo - 1;
        }
        const start = Math.max(0, closest - 2);
        const end = Math.min(beats.length - 1, closest + 2);
        let sum = 0, count = 0;
        for (let i = start; i < end; i++) {
            const dt = beats[i + 1].time - beats[i].time;
            // Skip zero/negative intervals — duplicate timestamps or
            // out-of-order beats would otherwise drag sum to <= 0
            // and return Infinity/NaN, wedging the camera lerp with
            // poisoned values.
            if (dt > 0) {
                sum += dt;
                count++;
            }
        }
        return count > 0 && sum > 0 ? 60 / (sum / count) : 120;
    }

    /* ======================================================================
     *  Three.js module — loaded lazily on first init() so users who
     *  never pick 3D don't pay the CDN cost. The promise is memoized
     *  module-scope: every factory instance shares the same module and
     *  only the first init triggers the fetch. factory.init() awaits
     *  it before building its scene; draw() no-ops until init
     *  completes, so a rapid setRenderer() call before the CDN load
     *  finishes is safe.
     * ====================================================================== */

    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(CDN)
                .then(mod => { T = mod; return mod; })
                .catch(e => {
                    console.error('[3D-Hwy] Three.js load failed:', e);
                    threeLoadPromise = null;  // allow retry on next init
                    throw e;
                });
        }
        return threeLoadPromise;
    }

    /* ======================================================================
     *  Splitscreen helper wrappers
     * ======================================================================
     *
     *  Centralise the "am I in splitscreen?" / "is this canvas focused?"
     *  queries so factory code can read the runtime environment
     *  cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
     *  means "main-player, single-instance, always focused" from the
     *  plugin's POV.
     *
     *  3dhighway only consumes the focus surface (no settings panel,
     *  no MIDI input, no panel-chrome injection). _ssActive()
     *  validates exactly that surface so a partial helper that ships
     *  isActive but lacks isCanvasFocused / onFocusChange /
     *  offFocusChange falls back to the main-player fast path
     *  rather than reaching a half-broken state.
     */

    function _ssActive() {
        const ss = window.slopsmithSplitscreen;
        if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
        return typeof ss.isCanvasFocused === 'function'
            && typeof ss.onFocusChange === 'function'
            && typeof ss.offFocusChange === 'function';
    }

    function _ssIsCanvasFocused(highwayCanvas) {
        const ss = window.slopsmithSplitscreen;
        if (!_ssActive()) return true;  // main-player fast path
        return !!(ss && typeof ss.isCanvasFocused === 'function' &&
                  ss.isCanvasFocused(highwayCanvas));
    }

    /* ======================================================================
     *  Per-instance counter for DOM tagging
     * ====================================================================== */

    let _nextInstanceId = 0;

    /* ======================================================================
     *  Factory — slopsmith#36 setRenderer contract
     *
     *  Returns a renderer object matching {init, draw, resize, destroy}.
     *  Core's createHighway() calls init(canvas, bundle) when this viz
     *  is selected, draw(bundle) every rAF frame, resize(w, h) when the
     *  canvas dims change, and destroy() when swapped out or on stop().
     *
     *  Wave C: every per-instance state slot below is closured here so
     *  N concurrent factory instances (one per splitscreen panel) don't
     *  share state. Module-scope above stays minimal — `T` +
     *  `threeLoadPromise` are legitimate singletons (one Three.js
     *  module load per page); `_nextInstanceId` is a counter.
     * ====================================================================== */

    function createFactory() {
        const _instanceId = ++_nextInstanceId;
        // ── Per-instance state ────────────────────────────────────────
        let scene = null, cam = null, ren = null;
        let wrap = null;
        let ambLight = null, dirLight = null;  // captured for focus-driven dim
        let fretG = null, noteG = null, beatG = null, lblG = null;
        let gNote = null, gSus = null, gBeat = null;
        let mStr = [], mGlow = [], mSus = [];
        let mBeatM = null, mBeatQ = null;
        let txtCache = {};
        let pNote, pSus, pLbl, pBeat, pSec, pChBar, pChStem;
        let mChord = null;
        let tgtX = 0, curX = 0;
        let tgtDist = CAM_DIST_BASE, curDist = CAM_DIST_BASE;
        let aspectScale = 1;
        let _isReady = false;            // scene built; draw is a no-op until true
        let _destroyed = false;          // destroy called — discard any pending load
        let _invertedCached = false;     // read from bundle each frame
        let _invertedForBoard = false;   // last invert state the fretboard was built for
        let _pendingSize = null;         // resize() calls before _isReady stash here
        // Monotonic init counter. Each init() bumps it; the
        // loadThree().then / .catch closures capture the token and
        // bail if a newer init has started since. Guards against
        // init → init (no destroy between) where _destroyed alone
        // gets reset to false and would let the first load's
        // continuation fire against the second init's state.
        let _initToken = 0;

        let highwayCanvas = null;
        let prevHighwayDisplay = '';

        // ── Wave C focus state ────────────────────────────────────────
        //
        // Tracks whether we successfully subscribed to splitscreen
        // focus-change events. Necessary because subscribe is gated on
        // _ssActive() (full helper surface + isActive() === true), but
        // destroy() must still unsubscribe what was actually attached
        // — we can't re-derive "did we subscribe?" from a fresh
        // _ssActive() check at destroy time, since isActive() may have
        // flipped false (splitscreen toggled off) between init and
        // destroy. Without this flag a defensive offFocusChange call
        // against a subscription that never happened would be a no-op
        // for EventTarget but obscures intent; a missed unsubscribe of
        // one we DID register would leak the listener closure across
        // the destroy.
        let _focusSubscribed = false;
        let _isFocused = true;  // fast-path default; updated in
                                // _updateFocusState once focus state
                                // is queryable and the scene exists.

        // ── Listener ref (per-instance so destroy() detach matches) ──
        const _onFocusChange = () => _updateFocusState();

        // Unsubscribe helper. DRY: every init failure branch + destroy()
        // + defensive-teardown branch needs to drop the focus
        // subscription, and missing one (P3 finding from codex on the
        // initial commit stack) leaves a stale listener pointing at a
        // factory whose scene was never built / has been torn down.
        function _unsubscribeFocus() {
            if (!_focusSubscribed) return;
            const ss = window.slopsmithSplitscreen;
            if (ss && typeof ss.offFocusChange === 'function') {
                ss.offFocusChange(_onFocusChange);
            }
            _focusSubscribed = false;
        }

        function _updateFocusState() {
            // Belt-and-suspenders: skip if destroyed (a focus-change
            // event between destroy() and the offFocusChange landing
            // would otherwise mutate torn-down state).
            if (_destroyed) return;
            // Scene-not-ready guard. The async loadThree() window
            // spans init→_isReady; a focus event during that window
            // has no scene to dim. The init's .then() block calls
            // _updateFocusState explicitly after _isReady = true so
            // the freshly built scene picks up the current state.
            if (!_isReady) return;
            const focused = _ssIsCanvasFocused(highwayCanvas);
            if (focused === _isFocused) return;  // no-op when unchanged
            _isFocused = focused;
            // Dim the scene's lighting when this panel isn't focused
            // so the focused panel visibly pops in a multi-panel
            // layout. Single uniform intensity update — no rebuild,
            // no re-render trigger needed (next rAF picks it up).
            // Main-player path keeps full intensity because
            // _ssIsCanvasFocused returns the always-focused fast
            // path when _ssActive() is false.
            if (ambLight) ambLight.intensity = focused ? 0.65 : 0.35;
            if (dirLight) dirLight.intensity = focused ? 0.55 : 0.30;
        }

        // ── String-to-Y mapping (closes over _invertedCached) ─────────
        const sY = s => S_BASE + (_invertedCached ? (NSTR - 1 - s) : s) * S_GAP;

        // ── Text-sprite cache (closes over txtCache) ──────────────────
        function txtMat(text, col, wide) {
            const k = (wide ? 'W' : '') + text + '|' + col;
            if (txtCache[k]) return txtCache[k];
            const w = wide ? 512 : 128;
            const h = wide ? 128 : 128;
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const x = c.getContext('2d');
            x.fillStyle = col;
            x.font = `bold ${wide ? 64 : 80}px monospace`;
            x.textAlign = 'center';
            x.textBaseline = 'middle';
            x.fillText(String(text), w / 2, h / 2);
            const mat = new T.SpriteMaterial({
                map: new T.CanvasTexture(c),
                transparent: true,
                depthTest: false,
            });
            txtCache[k] = mat;
            return mat;
        }

        // ── Object pool (closes over parent group) ─────────────────────
        function pool(parent, mk) {
            const a = [];
            let n = 0;
            return {
                get() {
                    if (n < a.length) {
                        a[n].visible = true;
                        return a[n++];
                    }
                    const o = mk();
                    parent.add(o);
                    a.push(o);
                    n++;
                    return o;
                },
                reset() {
                    for (let i = 0; i < a.length; i++) a[i].visible = false;
                    n = 0;
                },
            };
        }

        /* ── Three.js scene setup. Returns false on missing DOM. ─── */
        function initScene() {
            // Use the canvas we were given instead of
            // document.getElementById('highway'). That keeps each
            // factory instance anchored to its own canvas — essential
            // for splitscreen where multiple panels each have their
            // own createHighway() call — and avoids a hardcoded id
            // the core doesn't strictly guarantee. The canvas's
            // parent is the container we insert the 3D overlay into.
            if (!highwayCanvas || !highwayCanvas.parentNode) {
                console.error('[3D-Hwy] initScene: canvas has no parent; aborting');
                return false;
            }

            wrap = document.createElement('div');
            // Per-instance DOM tagging. Wave C: N concurrent factory
            // instances under splitscreen each create their own wrap;
            // a fixed "h3d" id would collide on getElementById and
            // would prevent unique per-instance targeting. The shared
            // class + dataset attributes give plugin-wide CSS or
            // devtools queries a stable selector across instances,
            // while the per-instance id remains unique.
            wrap.id = 'h3d-wrap-' + _instanceId;
            wrap.className = 'h3d-wrap';
            wrap.dataset.h3dInstance = String(_instanceId);
            wrap.style.cssText =
                'position:absolute;top:0;left:0;right:0;z-index:4;pointer-events:none;';
            // Insert after the canvas so we overlay it.
            highwayCanvas.parentNode.insertBefore(wrap, highwayCanvas.nextSibling);

            ren = new T.WebGLRenderer({ antialias: true });
            // DPR cap — full devicePixelRatio (capped at 2) for the
            // main-player single-instance path; tighter cap under
            // splitscreen where N concurrent WebGLRenderers each
            // allocate framebuffers proportional to backing-store
            // size. A 4-up quad layout multiplies that 4x on top of
            // the per-panel halving from the layout itself, so
            // dropping to 1.25 keeps GPU bandwidth manageable on
            // worst-case configs while looking nearly identical at
            // half-screen physical sizes. _ssActive() returns false
            // outside splitscreen, preserving the original cap.
            ren.setPixelRatio(_ssActive()
                ? Math.min(devicePixelRatio, 1.25)
                : Math.min(devicePixelRatio, 2));
            ren.setClearColor(0x08080e);
            wrap.appendChild(ren.domElement);

            scene = new T.Scene();
            scene.fog = new T.Fog(0x08080e, FOG_START, FOG_END);

            cam = new T.PerspectiveCamera(45, 1, 0.01, FOG_END * 3);

            // Stash light refs so _updateFocusState can adjust
            // intensities when splitscreen focus moves between
            // panels. Main-player instances never dim — _ssActive()
            // returns false and _updateFocusState short-circuits.
            ambLight = new T.AmbientLight(0xffffff, 0.65);
            scene.add(ambLight);
            dirLight = new T.DirectionalLight(0xffffff, 0.55);
            dirLight.position.set(60 * K, 80 * K, 40 * K);
            scene.add(dirLight);

            fretG = new T.Group(); scene.add(fretG);
            noteG = new T.Group(); scene.add(noteG);
            beatG = new T.Group(); scene.add(beatG);
            lblG  = new T.Group(); scene.add(lblG);

            // Rounded rectangle note shape (extruded 2D rounded rect)
            const noteShape = new T.Shape();
            const nhw = NW / 2, nhh = NH / 2, r = Math.min(N_RAD, nhw, nhh);
            noteShape.moveTo(-nhw + r, -nhh);
            noteShape.lineTo(nhw - r, -nhh);
            noteShape.quadraticCurveTo(nhw, -nhh, nhw, -nhh + r);
            noteShape.lineTo(nhw, nhh - r);
            noteShape.quadraticCurveTo(nhw, nhh, nhw - r, nhh);
            noteShape.lineTo(-nhw + r, nhh);
            noteShape.quadraticCurveTo(-nhw, nhh, -nhw, nhh - r);
            noteShape.lineTo(-nhw, -nhh + r);
            noteShape.quadraticCurveTo(-nhw, -nhh, -nhw + r, -nhh);
            gNote = new T.ExtrudeGeometry(noteShape, {
                depth: ND, bevelEnabled: false,
            });
            gNote.translate(0, 0, -ND / 2);  // center on Z
            gSus     = new T.BoxGeometry(1, 1, 1);
            gBeat    = new T.BufferGeometry().setFromPoints(
                [new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0)],
            );

            mStr  = S_COL.map(c => new T.MeshLambertMaterial({ color: c }));
            mGlow = S_COL.map(c =>
                new T.MeshLambertMaterial({
                    color: 0xffffff,
                    emissive: c,
                    emissiveIntensity: 0.7,
                }),
            );
            mSus = S_COL.map(c =>
                new T.MeshLambertMaterial({
                    color: c,
                    transparent: true,
                    opacity: 0.35,
                }),
            );

            mBeatM = new T.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.25,
            });
            mBeatQ = new T.LineBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.07,
            });

            pNote  = pool(noteG, () => new T.Mesh(gNote, mStr[0]));
            pSus   = pool(noteG, () => new T.Mesh(gSus,  mSus[0]));
            pLbl   = pool(lblG,  () => new T.Sprite(txtMat('0', '#fff', false)));
            pBeat  = pool(beatG, () => new T.Line(gBeat, mBeatQ));
            pSec   = pool(lblG, () => new T.Sprite(txtMat('', '#0dd', true)));

            // Chord bracket pieces (all #50a0dc)
            mChord = new T.MeshBasicMaterial({ color: 0x50a0dc });
            const barThick = 1 * K;  // bar/stem thickness
            // Bar: unit-width box, scaled in X per chord
            const gChBarGeo = new T.BoxGeometry(1, barThick, ND * 0.5);
            pChBar = pool(noteG, () => new T.Mesh(gChBarGeo, mChord));
            // Stem: unit-height box, scaled in Y per stem
            const gChStemGeo = new T.BoxGeometry(barThick, 1, ND * 0.5);
            pChStem = pool(noteG, () => new T.Mesh(gChStemGeo, mChord));

            buildBoard();
            return true;
        }

        /* ── Fretboard (static geometry) ──────────────────────────── */
        function buildBoard() {
            // Dispose existing fretboard subtree before clearing.
            // buildBoard runs at init AND whenever bundle.inverted
            // toggles at runtime, so each rebuild would otherwise
            // leak the removed strings/fret-wires/dots/plane —
            // they're unreachable from teardown's scene.traverse
            // once Group.remove has detached them.
            while (fretG.children.length) {
                const child = fretG.children[0];
                child.geometry?.dispose?.();
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        for (const m of child.material) m?.dispose?.();
                    } else {
                        child.material.dispose?.();
                    }
                }
                fretG.remove(child);
            }

            const bw = fretX(NFRETS) + 4 * K;
            const bl = TS * (AHEAD + BEHIND);

            // Dark fretboard plane
            const pg = new T.PlaneGeometry(bw, bl);
            const pm = new T.MeshLambertMaterial({
                color: 0x10101a,
                transparent: true,
                opacity: 0.85,
            });
            const p = new T.Mesh(pg, pm);
            p.rotation.x = -Math.PI / 2;
            p.position.set(bw / 2 - 2 * K, S_BASE - NH / 2 - 2 * K, -bl / 2 + TS * BEHIND);
            fretG.add(p);

            // Colored strings across fretboard at Z = 0
            for (let s = 0; s < NSTR; s++) {
                const g = new T.BufferGeometry().setFromPoints([
                    new T.Vector3(-2 * K, sY(s), 0),
                    new T.Vector3(fretX(NFRETS) + 2 * K, sY(s), 0),
                ]);
                fretG.add(
                    new T.Line(
                        g,
                        new T.LineBasicMaterial({
                            color: S_COL[s],
                            transparent: true,
                            opacity: 0.5,
                        }),
                    ),
                );
            }

            // Fret wires at Z = 0. Span from the visually top-most
            // string to below the bottom-most, so the board still
            // spans the full string range under inversion — sY(NSTR-1)
            // is only the visual top when NOT inverted.
            const yTop = Math.max(sY(0), sY(NSTR - 1));
            const yBottom = Math.min(sY(0), sY(NSTR - 1));
            for (let f = 0; f <= NFRETS; f++) {
                const x = fretX(f);
                const g = new T.BufferGeometry().setFromPoints([
                    new T.Vector3(x, yBottom - NH / 2 - 1 * K, 0),
                    new T.Vector3(x, yTop + 1 * K, 0),
                ]);
                fretG.add(
                    new T.Line(
                        g,
                        new T.LineBasicMaterial({
                            color: 0x444466,
                            transparent: true,
                            opacity: 0.35,
                        }),
                    ),
                );
            }

            // Fret dots
            const dg = new T.SphereGeometry(1.5 * K, 8, 6);
            const dm = new T.MeshBasicMaterial({ color: 0x556677 });
            const my = (sY(0) + sY(NSTR - 1)) / 2;
            for (const f of DOTS) {
                const cx = fretMid(f);
                if (DDOTS.has(f)) {
                    let d = new T.Mesh(dg, dm);
                    d.position.set(cx, my - S_GAP * 0.7, 0);
                    fretG.add(d);
                    d = new T.Mesh(dg, dm);
                    d.position.set(cx, my + S_GAP * 0.7, 0);
                    fretG.add(d);
                } else {
                    const d = new T.Mesh(dg, dm);
                    d.position.set(cx, my, 0);
                    fretG.add(d);
                }
            }
        }

        /* ── Per-frame rendering (reads from bundle) ──────────────── */
        function update(bundle) {
            pNote.reset();
            pSus.reset();
            pLbl.reset();
            pBeat.reset();
            pSec.reset();
            pChBar.reset();
            pChStem.reset();

            const now = bundle.currentTime;
            const t0 = now - BEHIND;
            const t1 = now + AHEAD;
            const tCam = t1;  // use full window for stable camera targeting

            // Bundle's filter-aware arrays — no more highway.get* calls.
            const notes    = bundle.notes;
            const chords   = bundle.chords;
            const beats    = bundle.beats;
            const sections = bundle.sections;

            let fMin = 99, fMax = 0, got = false;

            /* ── single notes ── */
            if (notes) {
                for (const n of notes) {
                    if (n.t + (n.sus || 0) < t0 || n.t > t1) continue;
                    drawNote(n, now);
                    // Camera targeting: only track notes in the near window
                    if (n.f > 0 && n.t <= tCam) {
                        fMin = Math.min(fMin, n.f);
                        fMax = Math.max(fMax, n.f);
                        got = true;
                    }
                }
            }

            /* ── chords ── */
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes?.length) continue;
                    // Max sustain across the chord's notes. Simple loop
                    // (vs. Math.max(...map)) — no per-frame array
                    // allocation in the hot path.
                    let mxs = 0;
                    for (const n of ch.notes) {
                        const sus = n.sus || 0;
                        if (sus > mxs) mxs = sus;
                    }
                    if (ch.t + mxs < t0 || ch.t > t1) continue;

                    // Track the visually highest Y among chord notes
                    // for the bracket's bar position. Using sY(max(s))
                    // would be wrong under inversion because the
                    // numerically largest string index is the visual
                    // BOTTOM there; using the visual Y extent works
                    // in both orientations.
                    let maxNoteY = -Infinity;

                    // Find center X of fretted notes (for open string
                    // positioning). Single-pass scan over ch.notes —
                    // avoids per-frame filter() allocation in the
                    // hot path.
                    let chordCX = curX;
                    let cxL = Infinity, cxR = -Infinity;
                    let frettedCount = 0;
                    for (const cn of ch.notes) {
                        if (cn.f > 0) {
                            const fx = fretMid(cn.f);
                            if (fx < cxL) cxL = fx;
                            if (fx > cxR) cxR = fx;
                            frettedCount++;
                        }
                    }
                    if (frettedCount > 0) {
                        chordCX = (cxL + cxR) / 2;
                    }

                    for (const cn of ch.notes) {
                        drawNote(
                            {
                                t: ch.t, s: cn.s, f: cn.f,
                                sus: cn.sus || 0, bn: cn.bn,
                                ho: cn.ho, po: cn.po,
                                sl: cn.sl, pm: cn.pm,
                                ac: cn.ac, tp: cn.tp,
                                hm: cn.hm, hp: cn.hp,
                                tr: cn.tr,
                            },
                            now,
                            cn.f === 0 ? chordCX : undefined,
                        );
                        const ny = sY(cn.s);
                        if (ny > maxNoteY) maxNoteY = ny;
                        if (cn.f > 0 && ch.t <= tCam) {
                            fMin = Math.min(fMin, cn.f);
                            fMax = Math.max(fMax, cn.f);
                            got = true;
                        }
                    }

                    // Chord bracket: horizontal bar + vertical stems (L-corners)
                    // Hide bracket once chord has crossed the strings
                    const chDt = ch.t - now;
                    if (ch.notes.length > 1 && chDt > -0.05) {
                        const cz = dZ(chDt);
                        const barY = maxNoteY + S_GAP * 0.6;

                        // Find X extents (open strings use chord center)
                        let xMin = Infinity, xMax = -Infinity;
                        for (const cn of ch.notes) {
                            const nx = cn.f === 0 ? chordCX : fretMid(cn.f);
                            xMin = Math.min(xMin, nx);
                            xMax = Math.max(xMax, nx);
                        }

                        // Bar spans exactly between outer stems (center to center)
                        const barW = xMax - xMin;
                        const bar = pChBar.get();
                        bar.position.set(xMin + barW / 2, barY, cz);
                        bar.scale.set(barW, 1, 1);

                        // Vertical stems drop from bar bottom to note top
                        for (const cn of ch.notes) {
                            const nx = cn.f === 0 ? chordCX : fretMid(cn.f);
                            const noteTop = sY(cn.s) + NH * 0.5;
                            const stemH = barY - noteTop;
                            if (stemH <= 0) continue;
                            const stem = pChStem.get();
                            stem.position.set(nx, noteTop + stemH / 2, cz);
                            stem.scale.set(1, stemH, 1);
                        }
                    }
                }
            }

            /* ── beat lines ── */
            if (beats) {
                const bw = fretX(NFRETS) + 4 * K;
                let lastM = -1;
                for (const b of beats) {
                    const meas = b.measure !== lastM;
                    lastM = b.measure;
                    if (b.time < t0 || b.time > t1) continue;
                    const bl = pBeat.get();
                    bl.material = meas ? mBeatM : mBeatQ;
                    bl.scale.set(bw, 1, 1);
                    bl.position.set(-2 * K, S_BASE - NH / 2 - 1.5 * K, dZ(b.time - now));
                }
            }

            /* ── section labels ── */
            if (sections) {
                // Anchor above the visually topmost string, not a
                // fixed string index — `sY(NSTR - 1)` is only the top
                // when not inverted. Using Math.max(sY(0), sY(NSTR-1))
                // keeps labels above the fretboard in both
                // orientations.
                const labelY = Math.max(sY(0), sY(NSTR - 1)) + 8 * K;
                for (const s of sections) {
                    if (s.time < t0 || s.time > t1) continue;
                    const sp = pSec.get();
                    sp.material = txtMat(s.name, '#00cccc', true);
                    sp.scale.set(20 * K, 5 * K, 1);
                    sp.position.set(
                        fretX(12),
                        labelY,
                        dZ(s.time - now),
                    );
                }
            }

            /* ── camera target ── */
            if (got) {
                tgtX = fretMid(Math.round((fMin + fMax) / 2));
                // Dynamic camera distance based on fret span (ChartPlayer formula)
                const fretSpan = fMax - fMin;
                tgtDist = (65 + Math.max(fretSpan, 4) * 3) * K;
            }
        }

        function drawNote(n, now, openX) {
            const s  = n.s;
            const dt = n.t - now;           // negative = past the string
            const y  = sY(s);
            const susEnd = n.t + (n.sus || 0);
            const hasSus = n.sus > 0;

            // Destroy: non-sustained notes vanish after crossing, sustained notes after sustain ends
            if (dt < -0.05 && (!hasSus || now > susEnd)) return;

            // Is the note currently being sustained? (past the string, sustain still active)
            const sustained = dt < 0 && hasSus && now <= susEnd;
            // Approaching / at the string
            const hitDist = Math.abs(dt);
            const hit = hitDist < 0.15 || sustained;
            const hitFade = sustained ? 0.7 : (hitDist < 0.15 ? 1 - hitDist / 0.15 : 0);

            // Sustained notes pin to Z=0 (the string) with vibrato
            const vibrato = sustained ? Math.sin(now * 30) * 0.3 * K : 0;
            const noteZ = sustained ? 0 : dZ(dt);

            if (n.f === 0) {
                // Open string: wide horizontal bar centered on context or camera
                const lineW = 40 * K;
                const cx = openX !== undefined ? openX : curX;
                const box = pNote.get();
                // Reset rotation: pNote pool reuses meshes, and the
                // fretted branch below sets rotation.z = π/4 for
                // harmonics. Without this reset, an open-string bar
                // drawn after a harmonic would inherit that rotation.
                box.rotation.set(0, 0, 0);
                box.material = hit ? mGlow[s] : mStr[s];
                box.position.set(cx, y + vibrato, noteZ);
                box.scale.set(lineW / NW, 0.3, 0.6);

                // "0" label
                const lb = pLbl.get();
                lb.material = txtMat(0, hit ? '#fff' : '#ddd', false);
                lb.scale.set(NW * 0.7, NH * 0.8, 1);
                lb.position.set(cx, y + vibrato, noteZ + 0.01 * K);

                if (hasSus) {
                    // Remaining sustain trail (shrinks as sustain is consumed)
                    const susStart = Math.max(n.t, now);
                    const remSus = susEnd - susStart;
                    if (remSus > 0.01) {
                        const len = Math.min(remSus, AHEAD) * TS;
                        const trZ = dZ((susStart - now)) - len / 2;
                        const tr  = pSus.get();
                        tr.material = mSus[s];
                        tr.position.set(cx, y, trZ);
                        tr.scale.set(SW, SH, len);
                    }
                }
                return;
            }

            const x = fretMid(n.f);
            const isHarmonic = n.hm || n.hp;

            // Note box — diamond rotation for harmonics, glow at string intersection
            const box = pNote.get();
            if (hit) {
                box.material = mGlow[s];
                mGlow[s].emissiveIntensity = 0.4 + hitFade * 0.6;
            } else {
                box.material = mStr[s];
            }
            box.position.set(x, y + vibrato, noteZ);
            box.scale.set(1, 1, 1);
            box.rotation.z = isHarmonic ? Math.PI / 4 : 0;

            // Fret number label
            if (n.f > 0) {
                const lb = pLbl.get();
                lb.material = txtMat(n.f, hit ? '#fff' : '#ddd', false);
                lb.scale.set(NW * 0.7, NH * 0.8, 1);
                lb.position.set(x, y + vibrato, noteZ + 0.01 * K);
            }

            // Sustain trail (shrinks as consumed)
            if (hasSus) {
                const susStart = Math.max(n.t, now);
                const remSus = susEnd - susStart;
                if (remSus > 0.01) {
                    const len = Math.min(remSus, AHEAD) * TS;
                    const trZ = dZ((susStart - now)) - len / 2;
                    const tr  = pSus.get();
                    tr.material = mSus[s];
                    tr.position.set(x, y, trZ);
                    tr.scale.set(SW, SH, len);
                }
            }

            // ── Technique indicators (matches highway.js) ──

            const hasBend = n.bn > 0;
            let yo = y + NH * 0.8;

            // Bend: arrow + amount (½, full, 1½, 2)
            if (hasBend) {
                const l = pLbl.get();
                l.material = txtMat('↑' + bendText(n.bn), '#fff', true);
                l.scale.set(NH * 3.6, NH * 1.5, 1);
                l.position.set(x, yo, noteZ);
                yo += NH * 1.2;
            }

            // Slide: diagonal arrow
            if (n.sl && n.sl !== -1) {
                const l = pLbl.get();
                l.material = txtMat(
                    n.sl > n.f ? '↗' : '↘', '#fff', false,
                );
                l.scale.set(NH * 1.6, NH * 1.6, 1);
                l.position.set(x + NW * 0.6, yo, noteZ);
            }

            // Hammer-on / Pull-off / Tap
            if (n.ho || n.po || n.tp) {
                const label = n.ho ? 'H' : n.po ? 'P' : 'T';
                const l = pLbl.get();
                l.material = txtMat(label, '#fff', false);
                l.scale.set(NH * 1.5, NH * 1.5, 1);
                l.position.set(x + NW * 0.6, yo, noteZ);
            }

            // Accent: ">"
            if (n.ac) {
                const l = pLbl.get();
                l.material = txtMat('>', '#fff', false);
                l.scale.set(NH * 1.6, NH * 1.6, 1);
                l.position.set(x, yo, noteZ);
                yo += NH * 1.2;
            }

            // Tremolo: wavy yellow line
            if (n.tr) {
                const l = pLbl.get();
                l.material = txtMat('~~~', '#ff0', true);
                l.scale.set(NH * 3.0, NH * 1.2, 1);
                l.position.set(x, yo, noteZ);
            }

            // ── Below note ──

            // Palm mute
            if (n.pm) {
                const l = pLbl.get();
                l.material = txtMat('PM', '#aaa', true);
                l.scale.set(NH * 2.4, NH * 1.4, 1);
                l.position.set(x, y - NH * 0.9, noteZ);
            }

            // Pinch harmonic label
            if (n.hp) {
                const l = pLbl.get();
                l.material = txtMat('PH', '#ff0', true);
                l.scale.set(NH * 2.1, NH * 1.2, 1);
                l.position.set(x, y - NH * 1.1, noteZ);
            }
        }

        /* ── Camera smooth lerp (ChartPlayer FretCamera) ──────────── */
        function camUpdate(bundle) {
            // Scale lerp by tempo: faster songs get faster camera response
            const bpm = computeBPM(bundle.beats, bundle.currentTime);
            const lerp = CAM_LERP_BASE * Math.max(bpm, 60) / 120;
            curX += (tgtX - curX) * lerp;
            curDist += (tgtDist - curDist) * lerp;
            // Scale camera back for narrower viewports so fret coverage stays consistent
            const dist = curDist * aspectScale;
            const h = CAM_H_BASE * (dist / CAM_DIST_BASE);
            cam.position.set(curX, h, dist);
            cam.lookAt(curX, sY(2.5), -FOCUS_D * 0.3);
        }

        /* ── Apply a canvas size to the Three.js renderer + wrap ─── */
        function applySize(w, h) {
            if (!ren || !cam || !wrap) return;
            // Guard against 0 / negative / non-finite dims — resize
            // events can fire while the container is temporarily
            // collapsed (e.g. mid-layout transition), and dividing by
            // zero produces an Infinity aspect that wedges rendering.
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
            ren.setSize(w, h);
            wrap.style.height = h + 'px';
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
            // Narrower windows need the camera further back to show the same fret range
            aspectScale = REF_ASPECT / Math.max(cam.aspect, 0.5);
        }

        /* ── Teardown (release all GPU + DOM resources) ───────────── */
        function teardown() {
            if (wrap) {
                wrap.remove();
                wrap = null;
            }
            // Dispose scene resources BEFORE the renderer. three.js
            // coordinates GPU cleanup via dispose-event listeners the
            // renderer registers during setup; disposing the renderer
            // first unregisters those listeners and leaves some GPU
            // buffers resident even though geometry/material.dispose
            // fires afterwards. scene.traverse catches the
            // board-building meshes (string lines, fret wires, dot
            // spheres, backing plane) — their geometries/materials
            // aren't tracked anywhere else after buildBoard finishes.
            if (scene) {
                scene.traverse((obj) => {
                    if (obj.geometry && typeof obj.geometry.dispose === 'function') {
                        obj.geometry.dispose();
                    }
                    if (obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        for (const m of mats) {
                            m.map?.dispose?.();
                            m.dispose?.();
                        }
                    }
                });
            }
            // Explicit dispose of geometries held directly in closure
            // (the pooled templates). Some are also reached via the
            // traverse above through the pool's children, but disposing
            // twice is safe — three.js guards against it.
            gNote?.dispose?.();
            gSus?.dispose?.();
            gBeat?.dispose?.();
            // Pool / per-string material arrays
            for (const m of mStr)  m?.dispose?.();
            for (const m of mGlow) m?.dispose?.();
            for (const m of mSus)  m?.dispose?.();
            mBeatM?.dispose?.();
            mBeatQ?.dispose?.();
            mChord?.dispose?.();
            // Text sprite cache
            for (const k in txtCache) {
                txtCache[k].map?.dispose();
                txtCache[k].dispose();
            }
            txtCache = {};
            // Now safe to tear down the renderer — scene resources
            // have already had their dispose events fire.
            if (ren) {
                ren.dispose();
                ren = null;
            }
            scene = cam = noteG = beatG = lblG = fretG = null;
            ambLight = dirLight = null;
            mStr = []; mGlow = []; mSus = [];
            mBeatM = mBeatQ = null;
            pNote = pSus = pLbl = pBeat = pSec = pChBar = pChStem = null;
            mChord = null;
            gNote = gSus = gBeat = null;
            tgtX = curX = 0;
            tgtDist = curDist = CAM_DIST_BASE;
        }

        /* ── Read dims from the passed canvas's actual layout ────── */
        function canvasSize(canvas) {
            // Prefer the canvas's bounding rect so splitscreen panels
            // (or any non-full-window container) get correct
            // dimensions. Core's api.resize has already sized the
            // canvas element before the first init completes.
            if (canvas) {
                const rect = canvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { w: rect.width, h: rect.height };
                }
            }
            // Fallback: if the canvas has no layout yet, measure the
            // main player area. Only hit during unusual init races —
            // matches the pre-refactor behaviour so no regression.
            const ch = document.getElementById('player-controls')?.offsetHeight || 50;
            return { w: innerWidth, h: innerHeight - ch };
        }

        /* ── Lifecycle: the setRenderer contract (slopsmith#36) ───── */
        return {
            init(canvas, bundle) {
                // Reset any prior scene state from a previous init()
                // that wasn't paired with destroy(). Core's contract
                // says this shouldn't happen, but a double-init from a
                // buggy caller would otherwise leave orphaned wrap
                // elements + renderers in the DOM. Restore the prior
                // canvas's display BEFORE we re-capture
                // prevHighwayDisplay below — matters even when the
                // canvas reference is the same, otherwise we'd capture
                // "none" (the hidden state) as the "prior" and a later
                // destroy() would "restore" the canvas to hidden
                // permanently.
                // Unconditional focus-unsubscribe: a prior init() that
                // got mid-loadThree() then was superseded by THIS init()
                // (without destroy() in between, e.g. a rapid
                // setRenderer swap before the CDN load resolved) would
                // otherwise leave _focusSubscribed = true on a stale
                // closure, and the subscribe block below would attempt
                // to register again. EventTarget de-dups same-ref
                // listeners, but the cleaner posture is to drop the
                // prior subscription unconditionally at init start so
                // _focusSubscribed always reflects THIS lifetime's
                // state. Codex P3 surfaced this on the initial commit
                // stack — the pre-init unsubscribe was buried inside
                // the wrap-or-ren defensive-teardown branch.
                _unsubscribeFocus();
                if (wrap || ren) {
                    if (highwayCanvas) {
                        highwayCanvas.style.display = prevHighwayDisplay;
                    }
                    teardown();
                }
                _destroyed = false;
                _isReady = false;
                _pendingSize = null;
                // Reset cached focus state to the default-focused
                // value. Without this, a destroy/init cycle where the
                // new lifetime starts with the same focus state as
                // the previous lifetime ended would skip the
                // intensity update via _updateFocusState's
                // change-detect early-return — and the freshly-built
                // scene's lights default to FULL intensity in
                // initScene. Result: a previously-unfocused panel
                // stays bright after re-init even though
                // _ssIsCanvasFocused still says false.
                _isFocused = true;
                const myToken = ++_initToken;
                highwayCanvas = canvas;
                // Record the canvas's current display so destroy()
                // can restore it, BUT don't hide the canvas yet. If
                // Three.js fails to load or initScene aborts below,
                // we want the 2D highway visible as a fallback
                // instead of leaving the player blank while this
                // broken viz is still selected. Only hide once setup
                // has actually succeeded.
                prevHighwayDisplay = canvas.style.display;
                _invertedCached = !!(bundle && bundle.inverted);

                // Subscribe to splitscreen focus events synchronously
                // (BEFORE loadThree). A focus change during the async
                // CDN window otherwise wouldn't deliver, and the
                // _updateFocusState call after _isReady would never
                // run with the right initial value. _updateFocusState
                // is _isReady-gated internally, so events delivered
                // pre-scene-build no-op safely; the explicit
                // _updateFocusState() call after _isReady = true
                // catches up.
                //
                // Subscribe gated on _ssActive() (full helper surface).
                // A partial helper that ships on/offFocusChange but
                // lacks isCanvasFocused would otherwise let us
                // subscribe while _ssIsCanvasFocused fell back to
                // "always focused" (main-player path), so every
                // instance would believe itself focused.
                if (_ssActive()) {
                    window.slopsmithSplitscreen.onFocusChange(_onFocusChange);
                    _focusSubscribed = true;
                }

                // Kick off the lazy Three.js load (memoized at module
                // scope). Two guards in the continuation: _destroyed
                // (set by destroy()) and the token check (a newer init
                // on this same instance has started).
                loadThree().then(() => {
                    if (_destroyed || _initToken !== myToken) return;
                    try {
                        // Seed the invert-state tracker BEFORE initScene so
                        // buildBoard's first run uses the current value;
                        // draw's change-detection then skips the redundant
                        // rebuild on the first frame.
                        _invertedForBoard = _invertedCached;
                        if (!initScene()) {
                            // initScene already logged. Leave the 2D
                            // canvas visible so the user has a working
                            // highway even though this viz is in a broken
                            // state. They can switch back to "Highway" via
                            // the picker. Drop the focus subscription
                            // we registered synchronously in init() —
                            // there's no scene to dim, and leaving the
                            // listener attached against a never-built
                            // factory leaks the closure.
                            _unsubscribeFocus();
                            return;
                        }
                        // Scene is up — now safe to hide the 2D layer and
                        // let the 3D overlay own the view.
                        if (highwayCanvas) highwayCanvas.style.display = 'none';
                        // Honour any resize that came in while we were
                        // loading, otherwise fall back to measuring the
                        // player layout now. A collapsed container can
                        // produce 0/0 pending dims that applySize would
                        // quietly reject — treat that as "no pending"
                        // and measure the canvas layout, so we don't end
                        // up stuck at the default backing store if no
                        // further resize arrives.
                        const pendingValid = _pendingSize &&
                            _pendingSize.w > 0 && _pendingSize.h > 0;
                        const sz = pendingValid
                            ? _pendingSize
                            : canvasSize(highwayCanvas);
                        _pendingSize = null;
                        applySize(sz.w, sz.h);
                        _isReady = true;
                        // Apply the initial focus state now that the
                        // scene exists. Any focus events that arrived
                        // during the async loadThree() window were
                        // safely no-op'd by _updateFocusState's
                        // !_isReady gate; call it explicitly here so
                        // the current splitscreen focus is reflected
                        // on the first frame.
                        _updateFocusState();
                    } catch (e) {
                        // Anything thrown inside initScene / applySize /
                        // WebGLRenderer construction lands here. Without
                        // this we'd leave a partially-built wrap in the
                        // DOM and potentially a hidden highway canvas.
                        // Clean up and restore the 2D fallback so the
                        // user isn't stuck with a blank player. Also
                        // drop the focus subscription so a never-built
                        // factory doesn't keep receiving events.
                        console.error('[3D-Hwy] init .then() threw; cleaning up', e);
                        _isReady = false;
                        _pendingSize = null;
                        _unsubscribeFocus();
                        teardown();
                        if (highwayCanvas) {
                            highwayCanvas.style.display = prevHighwayDisplay;
                        }
                    }
                }).catch(e => {
                    // Bail on BOTH conditions: a newer init took over
                    // (token mismatch) OR destroy ran while the import
                    // was in-flight. Without the _destroyed check,
                    // a rapid setRenderer swap followed by a late CDN
                    // failure would log a spurious error for an
                    // instance no longer in use. In both bail cases
                    // the focus subscription belongs to the newer
                    // init / destroy already cleaned up — don't touch.
                    if (_initToken !== myToken || _destroyed) return;
                    console.error('[3D-Hwy] init aborted; Three.js unavailable', e);
                    // CDN load failed for THIS init lifetime. Drop the
                    // focus subscription registered synchronously in
                    // init() — no scene was built, and a stale
                    // listener against a never-rendered factory leaks
                    // the closure. 2D canvas was never hidden — no
                    // restore needed; core's next setRenderer(null) or
                    // arrangement switch will proceed cleanly.
                    _unsubscribeFocus();
                });
            },
            draw(bundle) {
                if (!_isReady) return;
                _invertedCached = !!bundle.inverted;
                // Fretboard geometry (string lines, fret wires, dots)
                // is built once in buildBoard(); if the user toggles
                // Invert at runtime, note placement flips via sY() but
                // the static board would stay in the old orientation
                // without this rebuild. buildBoard disposes its old
                // children's geometries/materials before removing,
                // so repeated rebuilds don't leak.
                if (_invertedCached !== _invertedForBoard) {
                    buildBoard();
                    _invertedForBoard = _invertedCached;
                }
                update(bundle);
                camUpdate(bundle);
                ren.render(scene, cam);
            },
            resize(w, h) {
                if (!_isReady) {
                    // Stash for application once initScene finishes —
                    // otherwise a resize that fires while Three.js is
                    // still loading would be dropped and first render
                    // would use stale dims.
                    _pendingSize = { w, h };
                    return;
                }
                applySize(w, h);
            },
            destroy() {
                // Set BEFORE attempting the (best-effort) unsubscribe
                // so any focus-change handler that sneaks through a
                // failed / missing offFocusChange call short-circuits
                // on the _destroyed guard inside _updateFocusState.
                _destroyed = true;
                _isReady = false;
                _pendingSize = null;
                _unsubscribeFocus();
                teardown();
                if (highwayCanvas) {
                    highwayCanvas.style.display = prevHighwayDisplay;
                    highwayCanvas = null;
                }
            },
        };
    }

    window.slopsmithViz_highway_3d = createFactory;

})();
