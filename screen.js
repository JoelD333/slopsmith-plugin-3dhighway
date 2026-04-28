// 3D Highway visualization plugin — Three.js note highway.
// Visual layer from joel's prototype (vibrant palette, glowing strings,
// fret heat, dynamic lane, chord frame-boxes, per-note connector labels,
// board projection, outline+core note meshes) adapted into the
// slopsmithViz setRenderer contract (slopsmith#36) so it works in the
// main player and per-panel in splitscreen without any architectural
// changes.

(function () {
    'use strict';

    /* ======================================================================
     *  Constants
     * ====================================================================== */

    const CDN =
        'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    // Selectable per-string color palettes (issue #10). Each palette has
    // 8 entries to match MAX_RENDER_STRINGS so 6/7/8-string arrangements
    // all index safely. Default is the original Rocksmith+ neon set; Neon
    // pushes saturation harder; Pastel desaturates for long-session
    // comfort. Per-panel selection lives in settings.html / localStorage.
    const PALETTES = {
        default: [
            0xfc2d5d, 0xffe100, 0x00ccff, 0xff9d00,
            0x10e62c, 0xbc00ff, 0xff6bd5, 0x6bffe6,
        ],
        neon: [
            0xff1090, 0xfaff00, 0x00fff0, 0xff7700,
            0x40ff40, 0xc040ff, 0xff40d0, 0x40ffd0,
        ],
        pastel: [
            0xe89aa0, 0xefdf90, 0x9adfee, 0xefb898,
            0xa6e0a8, 0xc4a6e0, 0xe0a6c8, 0xa6e0d8,
        ],
    };
    const PALETTE_IDS = Object.keys(PALETTES);
    // Default palette at module scope so out-of-IIFE consumers (e.g. the
    // out-of-range warning's reference to "palette size") still have a
    // canonical length to compare against.
    const S_COL = PALETTES.default;

    const SCALE = 2.25;
    const K = SCALE / 300;

    const NFRETS = 24;
    const NSTR = 6;
    // Per-string materials and projection meshes are built via S_COL.map(),
    // so the renderer can only address strings 0..S_COL.length-1. Using a
    // higher count would index undefined into mGlow/mStr/mSus/projMeshArr.
    // Extend S_COL above to support more strings.
    const MAX_RENDER_STRINGS = S_COL.length;

    // Resolve the string count for the active arrangement. Prefer
    // bundle.stringCount (exposed by slopsmith core since #93 — derived
    // from notes/chords/tuning, so it works for 5-string bass, 7- and
    // 8-string guitar, etc.). Fall back to arrangement-name detection
    // for older slopsmith cores that don't emit the field. Clamp to the
    // palette size so a malformed bundle or a 12-string chart doesn't
    // index past the per-string material arrays.
    function resolveStringCount(bundle) {
        const sc = bundle && bundle.stringCount;
        if (Number.isFinite(sc) && sc >= 1) {
            return Math.min(Math.trunc(sc), MAX_RENDER_STRINGS);
        }
        return /bass/i.test(bundle?.songInfo?.arrangement || '') ? 4 : NSTR;
    }

    const STR_THICK = 0.25 * K;

    const S_BASE = 3 * K;
    const S_GAP = 4 * K;

    const AHEAD = 3.0;
    const BEHIND = 0.5;
    const TS = 200 * K;

    // Shorter, flatter notes (joel style)
    const NW = 5 * K, NH = 3 * K, ND = 0.5 * K;
    const N_RAD = 1.5 * K;
    const SW = 2 * K, SH = 1.5 * K;

    const CAM_H_BASE = 150 * K;
    const CAM_DIST_BASE = 240 * K;
    const REF_ASPECT = 16 / 9;
    const FOCUS_D = 600 * K;
    const CAM_LERP_BASE = 0.02;

    // Camera-X targeting (issue #34). The visible AHEAD = 3.0 s window is
    // far too coarse for picking where the camera should sit — a single
    // 17th-fret bend 2.5 s away yanks tgtX several frets even though the
    // immediate playing area hasn't moved. These constants are bounds for
    // a smoothing dial (0 = twitchy, 1 = calm); the runtime lerps between
    // the pair using the user's `cameraSmoothing` setting.
    const CAM_TGT_BEHIND   = 0.2;   // s behind hit line for X targeting
    const CAM_TGT_AHEAD_T  = 2.0;   // s — twitchy: longer lookahead (more reactive)
    const CAM_TGT_AHEAD_C  = 0.7;   // s — calm: shorter lookahead (ignore distant outliers)
    const CAM_TGT_TAU_T    = 0.35;  // s — twitchy: short recency time-constant
    const CAM_TGT_TAU_C    = 0.9;   // s — calm: longer time-constant (averages more)
    const CAM_TGT_HYST_T   = 0.25;  // frets — twitchy: tiny dead zone
    const CAM_TGT_HYST_C   = 2.5;   // frets — calm: wide dead zone

    const FOG_START = 200 * K;
    const FOG_END = 670 * K;

    const DOTS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
    const DDOTS = new Set([12, 24]);

    const FRET_COOLDOWN = 0.5; // seconds a lane fret stays active after last note

    /* ======================================================================
     *  Pure helpers
     * ====================================================================== */

    function bendText(bn) {
        if (bn === 0.5) return '½';
        if (bn === 1) return 'full';
        if (bn === 1.5) return '1½';
        if (bn >= 2) return String(Math.round(bn));
        return bn.toFixed(1);
    }

    const fretX = f => (f <= 0 ? 0 : SCALE - SCALE / Math.pow(2, f / 12));
    const fretMid = f => (f <= 0 ? -2 * K : (fretX(f - 1) + fretX(f)) / 2);
    const dZ = dt => -dt * TS;

    // World-units-per-fret near mid-neck. Used by the camera-X hysteresis
    // gate (issue #34) to convert a fret-equivalent dead zone into world
    // units. Pure function of SCALE — hoist out of update()'s hot path.
    const FRET_WIDTH_MID = fretX(7) - fretX(6);

    function computeBPM(beats, t) {
        if (!beats || beats.length < 2) return 120;
        let lo = 0, hi = beats.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (beats[mid].time < t) lo = mid + 1; else hi = mid;
        }
        let closest = lo;
        if (lo === beats.length) closest = beats.length - 1;
        else if (lo > 0 && Math.abs(beats[lo - 1].time - t) < Math.abs(beats[lo].time - t)) closest = lo - 1;
        const start = Math.max(0, closest - 2);
        const end = Math.min(beats.length - 1, closest + 2);
        let sum = 0, count = 0;
        for (let i = start; i < end; i++) {
            const dt = beats[i + 1].time - beats[i].time;
            if (dt > 0) { sum += dt; count++; }
        }
        return count > 0 && sum > 0 ? 60 / (sum / count) : 120;
    }

    /* ======================================================================
     *  Three.js module — lazily loaded, memoized
     * ====================================================================== */

    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(CDN)
                .then(mod => { T = mod; return mod; })
                .catch(e => {
                    console.error('[3D-Hwy] Three.js load failed:', e);
                    threeLoadPromise = null;
                    throw e;
                });
        }
        return threeLoadPromise;
    }

    /* ======================================================================
     *  Splitscreen helpers
     * ====================================================================== */

    function _ssActive() {
        const ss = window.slopsmithSplitscreen;
        if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
        return typeof ss.isCanvasFocused === 'function'
            && typeof ss.onFocusChange === 'function'
            && typeof ss.offFocusChange === 'function';
    }

    function _ssIsCanvasFocused(highwayCanvas) {
        const ss = window.slopsmithSplitscreen;
        if (!_ssActive()) return true;
        return !!(ss && typeof ss.isCanvasFocused === 'function' &&
            ss.isCanvasFocused(highwayCanvas));
    }

    /* ======================================================================
     *  Background animations (issue #13)
     *
     *  Audio-reactive ambient scenery in the fog band beyond the highway.
     *  Module-level singletons share an AudioContext + AnalyserNode tap on
     *  the slopsmith core <audio id="audio"> element across all panel
     *  instances; per-panel settings live in localStorage with a global
     *  fallback so settings.html drives a single default while per-panel
     *  overrides (h3d_bg_panel<idx>_*) can be set for splitscreen layouts.
     *
     *  Caveat: createMediaElementSource() can only be called once per
     *  element. 3dhighway owns that source for now; future plugins
     *  needing an analyser will have to share through a core API.
     * ====================================================================== */

    // Returned from _bgReadBands when reactive=false or analyser
    // unavailable; shared so the per-frame non-reactive path doesn't
    // allocate. Declared up-front because _bgBandsCache initializes to
    // it during the same IIFE execution pass.
    const BG_ZERO_BANDS = Object.freeze({ bass: 0, mid: 0, treble: 0 });

    // Module-level AudioContext singleton. Intentionally never torn
    // down: createMediaElementSource(<audio>) is irrevocable — once
    // called, the element's audio is permanently routed through this
    // context for the page's lifetime. Closing the context would
    // silence playback. The leak (one AudioContext + one AnalyserNode,
    // a few KB) is the cost of having a plugin tap audio at all.
    let _bgAudio = null;
    let _bgAudioFailedAt = 0;  // performance.now() of last failure, 0 = never
    const _BG_AUDIO_RETRY_MS = 1000;
    function _bgGetAnalyser() {
        if (_bgAudio && !_bgAudio.failed) return _bgAudio;
        if (_bgAudio && _bgAudio.failed) {
            // Distinguish permanent failures from transient ones.
            // InvalidStateError on createMediaElementSource means the
            // <audio> element is already tapped by another consumer —
            // there's no recovering from that without a page reload, so
            // don't retry. Transient failures (NotAllowedError before
            // first user gesture, etc.) get a once-per-second retry so
            // reactivity recovers once the blocking condition clears.
            if (_bgAudio.permanent) return null;
            if (performance.now() - _bgAudioFailedAt < _BG_AUDIO_RETRY_MS) return null;
        }
        const audio = document.getElementById('audio');
        if (!audio) return null;
        // Hoist ctx out of the try so we can close() it if a later step
        // throws (e.g. createMediaElementSource on an element that
        // already has a source node). Otherwise the AudioContext leaks.
        let ctx = null;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) throw new Error('Web Audio API not available');
            ctx = new Ctx();
            const source = ctx.createMediaElementSource(audio);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyser.connect(ctx.destination);
            _bgAudio = { ctx, analyser, freq: new Uint8Array(analyser.frequencyBinCount) };
            // Browsers with autoplay restrictions hand back a suspended
            // AudioContext; createMediaElementSource then routes the
            // <audio> through that suspended graph and playback goes
            // silent (and the analyser reads zeros) until we resume.
            // Try once now (fine if the page already had a user gesture)
            // and again on every play event so the first successful
            // user-initiated play unblocks the graph.
            const resume = () => {
                if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
                    ctx.resume().catch(() => { /* no gesture yet, retry on next play */ });
                }
            };
            resume();
            audio.addEventListener('play', resume);
            return _bgAudio;
        } catch (e) {
            if (ctx && typeof ctx.close === 'function') {
                try { ctx.close(); } catch (_) { /* close errors during failure path are noise */ }
            }
            console.warn('[3D-Hwy] failed to set up audio analyser:', e);
            const permanent = !!(e && e.name === 'InvalidStateError');
            _bgAudio = { failed: true, permanent };
            _bgAudioFailedAt = performance.now();
            return null;
        }
    }

    // Bands cache: in splitscreen, every panel asks for bands per frame.
    // The analyser is shared, so the answer is identical — cache for a
    // few ms so 4-up splitscreen pays one getByteFrequencyData + one sum
    // pass per frame instead of four.
    const _BG_BANDS_CACHE_MS = 5;
    let _bgBandsLastT = -Infinity;
    // Mutable cache reused across reads — refreshing in place keeps the
    // per-frame allocation count at zero. Style.update() uses the bands
    // synchronously within the same frame so the live-mutation contract
    // is safe.
    const _bgBandsCache = { bass: 0, mid: 0, treble: 0 };
    function _bgReadBands() {
        const a = _bgGetAnalyser();
        if (!a) return BG_ZERO_BANDS;
        const t = performance.now();
        if (t - _bgBandsLastT < _BG_BANDS_CACHE_MS) return _bgBandsCache;
        _bgBandsLastT = t;
        a.analyser.getByteFrequencyData(a.freq);
        let bass = 0, mid = 0, treble = 0;
        for (let i = 0; i < 8; i++) bass += a.freq[i];
        for (let i = 8; i < 40; i++) mid += a.freq[i];
        for (let i = 40; i < 128; i++) treble += a.freq[i];
        _bgBandsCache.bass = bass / (8 * 255);
        _bgBandsCache.mid = mid / (32 * 255);
        _bgBandsCache.treble = treble / (88 * 255);
        return _bgBandsCache;
    }

    const BG_DEFAULTS = { style: 'particles', intensity: 0.5, reactive: true, palette: 'default', showFretOnNote: false, cameraSmoothing: 0.5, customImageDataUrl: '', customImageName: '', customVideoName: '' };
    const BG_STYLE_IDS = ['off', 'particles', 'silhouettes', 'lights', 'geometric', 'image', 'video'];

    function _bgPanelKey(canvas) {
        const ss = window.slopsmithSplitscreen;
        const idx = (ss && typeof ss.panelIndexFor === 'function') ? ss.panelIndexFor(canvas) : null;
        return (idx == null) ? 'main' : 'panel' + idx;
    }
    // In-memory fallback for when localStorage is blocked (private mode,
    // sandboxed iframes, some test runners). _bgWriteGlobal stages the
    // value here too, and _bgReadSetting falls through to it before
    // BG_DEFAULTS. Without this, a write that silently failed to
    // persist would still emit a change event — and the listener would
    // read back the default, immediately blowing away what the user
    // just picked in settings.html.
    const _bgMemFallback = Object.create(null);
    function _bgReadSetting(panelKey, key) {
        try {
            const panelVal = localStorage.getItem('h3d_bg_' + panelKey + '_' + key);
            if (panelVal !== null && panelVal !== undefined) return _bgCoerce(key, panelVal);
            const globalVal = localStorage.getItem('h3d_bg_' + key);
            if (globalVal !== null && globalVal !== undefined) return _bgCoerce(key, globalVal);
        } catch (_) { /* storage blocked — fall through to in-memory */ }
        if (key in _bgMemFallback) return _bgCoerce(key, _bgMemFallback[key]);
        return BG_DEFAULTS[key];
    }
    // Shared "stored string -> bool" coercion for every boolean
    // setting. Mirrors settings.html's coerceBool so the renderer and
    // the UI hydration always agree on what a corrupted/unknown value
    // means (fall back to default rather than silently flipping to
    // false). Add new boolean keys to BG_DEFAULTS and they pick this
    // up via the dispatch below.
    const _BG_BOOL_KEYS = new Set(['reactive', 'showFretOnNote']);
    function _bgCoerceBool(val, fallback) {
        if (val === 'true' || val === '1') return true;
        if (val === 'false' || val === '0') return false;
        return fallback;
    }
    function _bgCoerce(key, val) {
        if (key === 'intensity' || key === 'cameraSmoothing') {
            const n = parseFloat(val);
            return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : BG_DEFAULTS[key];
        }
        if (_BG_BOOL_KEYS.has(key)) return _bgCoerceBool(val, BG_DEFAULTS[key]);
        if (key === 'style') return BG_STYLE_IDS.includes(val) ? val : BG_DEFAULTS.style;
        if (key === 'palette') return PALETTE_IDS.includes(val) ? val : BG_DEFAULTS.palette;
        return val;
    }
    function _bgWriteGlobal(key, val) {
        const s = String(val);
        try { localStorage.setItem('h3d_bg_' + key, s); } catch (_) { /* storage blocked */ }
        // Stage in memory regardless of storage success, so a blocked-
        // storage browser still applies the change and persists it for
        // the rest of the session.
        _bgMemFallback[key] = s;
        _bgEmitChange(key);
    }

    // Pub-sub so settings.html can update live across all panel instances.
    const _bgListeners = new Set();
    function _bgSubscribe(fn) { _bgListeners.add(fn); }
    function _bgUnsubscribe(fn) { _bgListeners.delete(fn); }
    function _bgEmitChange(key) {
        for (const fn of _bgListeners) {
            try { fn(key); } catch (e) { console.error('[3D-Hwy] bg listener threw', e); }
        }
    }

    // Settings.html setters — global keys; per-panel overrides via direct
    // localStorage edits today, runtime UI in a follow-up.
    window.h3dBgSetStyle = (v) => _bgWriteGlobal('style', v);
    window.h3dBgSetIntensity = (v) => _bgWriteGlobal('intensity', v);
    window.h3dBgSetReactive = (v) => _bgWriteGlobal('reactive', !!v);
    window.h3dBgSetPalette = (v) => _bgWriteGlobal('palette', v);
    window.h3dBgSetShowFretOnNote = (v) => _bgWriteGlobal('showFretOnNote', !!v);
    window.h3dBgSetCameraSmoothing = (v) => _bgWriteGlobal('cameraSmoothing', v);
    // Custom image asset for the 'image' bg style (#19). Composite setter:
    // writes both the data URL (the bytes that drive the texture) and the
    // display filename, each emitting a change event. The listener
    // rebuilds on customImageDataUrl change when the image style is
    // active; customImageName is display-only and skips rebuild.
    window.h3dBgSetCustomImage = (asset) => {
        const a = asset || {};
        _bgWriteGlobal('customImageDataUrl', a.dataUrl || '');
        _bgWriteGlobal('customImageName', a.name || '');
    };
    window.h3dBgClearCustomImage = () => {
        _bgWriteGlobal('customImageDataUrl', '');
        _bgWriteGlobal('customImageName', '');
    };
    // Custom video asset for the 'video' bg style (#19 follow-up).
    // Bytes live on disk under {config_dir}/plugin_uploads/highway_3d/
    // and are served by routes.py — localStorage only stores the
    // filename, which the renderer maps to the served URL. Single
    // global slot; the file picker in settings.html POSTs to the
    // upload route and then calls this setter with the response name.
    window.h3dBgSetCustomVideo = (asset) => {
        _bgWriteGlobal('customVideoName', (asset && asset.name) || '');
    };
    window.h3dBgClearCustomVideo = () => _bgWriteGlobal('customVideoName', '');
    // Back-compat alias for any caller that picked up the original
    // (inconsistent) name during this PR's review window.
    window.h3dSetPalette = window.h3dBgSetPalette;

    // Procedural silhouette bitmap, drawn once and shared across panels.
    // The Canvas2D bitmap is module-level (cheap, CPU-only); each layer
    // wraps it in its own CanvasTexture so per-layer texture.offset.x
    // can drive a seam-free scroll without coupling to other layers /
    // panels (a shared CanvasTexture would synchronize all offsets).
    let _silCanvas = null;
    function _bgEnsureSilhouetteCanvas() {
        if (_silCanvas) return _silCanvas;
        const c = document.createElement('canvas');
        c.width = 1024; c.height = 64;
        const cx = c.getContext('2d');
        if (!cx) {
            // Restrictive environments (some sandboxed iframes, headless
            // tests) can return null. Without a guard, the clearRect/
            // fillRect calls below would throw TypeError and the silhouette
            // style would never become available.
            throw new Error('[3D-Hwy] 2D canvas context unavailable for silhouette texture');
        }
        cx.clearRect(0, 0, c.width, c.height);
        cx.fillStyle = '#000814';
        let x = 0;
        while (x < c.width) {
            const w = 8 + Math.random() * 30;
            const h = 20 + Math.random() * 40;
            cx.fillRect(x, c.height - h, w, h);
            x += w + Math.random() * 10;
        }
        _silCanvas = c;
        return c;
    }

    // Helpers shared by the asset-driven bg styles (image, video).
    // Both render a "stage backdrop" plane that's full-bleed: sized
    // each frame to fill the camera's view frustum at a fixed
    // distance and positioned to track the camera (so the user's
    // image/video reads as the entire visible BG, with highway and
    // notes painting on top via renderOrder).
    //
    // Distance is chosen far enough back that no note ever lands
    // beyond it; depthWrite=false on the plane material plus
    // renderOrder=-1 means notes still paint on top regardless.
    const BG_BACKDROP_DISTANCE = FOG_END * 0.95;

    // Module-level scratch vector reused each frame to avoid GC
    // churn from per-frame Vector3 allocation. Only valid for the
    // duration of a single update() call.
    const _bgBackdropTmp = (() => {
        // Lazily created when T is available (T isn't bound at module
        // parse time — initScene assigns it inside loadThree().then).
        // Returning a getter that allocates on first read keeps the
        // dependency timing clean.
        let v = null;
        return () => v || (v = new T.Vector3());
    })();

    // Frustum-fit a plane mesh: scale a unit PlaneGeometry to exactly
    // fill the camera's view at the configured distance, then position
    // it `distance` units in front of the camera and orient it so the
    // texture faces the camera. Called whenever cam.aspect changes
    // (resize) and to position-track the camera each frame.
    function _bgFitBackdropPlane(state) {
        const cam = state.cam;
        const d = state.distance;
        const halfFovRad = cam.fov * Math.PI / 360;
        const visibleHeight = 2 * Math.tan(halfFovRad) * d;
        const visibleWidth = visibleHeight * cam.aspect;
        if (state.lastAspect !== cam.aspect ||
            state.lastVisibleHeight !== visibleHeight) {
            state.mesh.scale.set(visibleWidth, visibleHeight, 1);
            state.lastAspect = cam.aspect;
            state.lastVisibleHeight = visibleHeight;
            // Aspect change shifts the cover-crop ratio; re-apply.
            if (state.applyCoverCrop) state.applyCoverCrop();
        }
        // Track camera each frame: position = cam.position +
        // cam.forward * distance, orient toward camera.
        const fwd = cam.getWorldDirection(_bgBackdropTmp());
        state.mesh.position.copy(cam.position).addScaledVector(fwd, d);
        state.mesh.lookAt(cam.position);
    }

    // Cover-crop a texture to the plane aspect: the larger axis fills
    // the plane (cropped if needed), centered. For wider-than-plane
    // textures the X offset is left at the centered value but the
    // image style's drift loop overwrites it per frame; the video
    // style leaves it centered.
    function _bgCoverCrop(tex, srcW, srcH, planeAspect) {
        if (srcW <= 0 || srcH <= 0) return;
        tex.repeat.set(1, 1);
        tex.offset.set(0, 0);
        const srcAspect = srcW / srcH;
        if (srcAspect > planeAspect) {
            tex.repeat.x = planeAspect / srcAspect;
            tex.offset.x = (1 - tex.repeat.x) * 0.5;
        } else {
            tex.repeat.y = srcAspect / planeAspect;
            tex.offset.y = (1 - tex.repeat.y) * 0.5;
        }
        tex.needsUpdate = true;
    }

    // Background-style registry. Each entry returns a per-panel state
    // object from build() and reads from it in update() / teardown().
    // T (THREE) is set by the time these are invoked (initScene runs
    // inside loadThree().then).
    const BG_STYLES = {
        off: {
            build() { return null; },
            update() { },
            teardown() { },
        },
        particles: {
            build(scene, settings) {
                const N = Math.max(20, Math.floor(80 + 200 * settings.intensity));
                const positions = new Float32Array(N * 3);
                for (let i = 0; i < N; i++) {
                    positions[i * 3] = (Math.random() - 0.5) * 800 * K;
                    positions[i * 3 + 1] = (Math.random() - 0.4) * 80 * K;
                    // Spawn within the visible fog range. Fog reaches
                    // its far limit at FOG_END * 1.2 from the camera,
                    // and cam.position.z is updated each frame in
                    // camUpdate() (`dist * 0.75`, where dist tracks
                    // aspectScale). Anything beyond that camera-relative
                    // distance gets fully fogged out, so the cutoff in
                    // world z is dynamic — the earlier "push past notes"
                    // fix placed particles at -FOG_END * (0.95..1.20)
                    // which sat past fog far at any camera z, making
                    // them invisible. renderOrder = -1 on the bg stage
                    // already keeps particles behind notes regardless
                    // of z, so depth-based separation wasn't needed and
                    // was actively breaking visibility.
                    positions[i * 3 + 2] = -FOG_START - Math.random() * (FOG_END - FOG_START) * 0.85;
                }
                const geo = new T.BufferGeometry();
                geo.setAttribute('position', new T.BufferAttribute(positions, 3));
                const mat = new T.PointsMaterial({
                    // size 5*K (bumped from 1.5*K). At distance ~700*K
                    // with sizeAttenuation the prior sprite shrank
                    // below 2 pixels — practically invisible against
                    // dark fog. 5*K reads as a small bright dot.
                    // Build-time opacity is overridden every frame in
                    // update() — the runtime formula is the source of
                    // truth.
                    color: 0xa0c0ff, size: 5 * K, transparent: true,
                    blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
                });
                const points = new T.Points(geo, mat);
                scene.add(points);
                return { points, geo, mat, N };
            },
            update(s, bands, dt) {
                const positions = s.geo.attributes.position.array;
                const dx = dt * (3 + bands.mid * 12) * K;
                for (let i = 0; i < s.N; i++) {
                    positions[i * 3] += dx;
                    if (positions[i * 3] > 400 * K) positions[i * 3] -= 800 * K;
                }
                s.geo.attributes.position.needsUpdate = true;
                // Bumped opacity floor 0.4 → 0.55 + treble headroom
                // 0.4 → 0.45 so particles read as visible specks even
                // when bgReactive is false / treble≈0 (was effectively
                // 0.4 floor, below noise floor against dark fog).
                s.mat.opacity = 0.55 + bands.treble * 0.45;
            },
            teardown(s) {
                if (!s) return;
                s.points.parent?.remove(s.points);
                s.geo.dispose();
                s.mat.dispose();
            },
        },
        silhouettes: {
            build(scene, settings) {
                const canvas = _bgEnsureSilhouetteCanvas();
                // Inside the visible fog range. Fog far = FOG_END * 1.2
                // from the camera, and cam.position.z is dynamic
                // (camUpdate() sets `dist * 0.75`). renderOrder = -1
                // on the bg stage handles "behind notes" regardless
                // of z. Spread the three layers across the back half
                // of the visible fog band for parallax separation.
                const depths = [-FOG_END * 0.55, -FOG_END * 0.70, -FOG_END * 0.85];
                const layers = [];
                const allocated = [];
                try {
                    for (const z of depths) {
                        // Per-layer CanvasTexture wrapping the shared
                        // canvas: lets each layer scroll independently
                        // via texture.offset.x without coupling to its
                        // siblings or to other panels.
                        const tex = new T.CanvasTexture(canvas);
                        tex.wrapS = T.RepeatWrapping;
                        const geo = new T.PlaneGeometry(800 * K, 50 * K);
                        const mat = new T.MeshBasicMaterial({
                            map: tex, transparent: true, opacity: 0.4, depthWrite: false,
                        });
                        const mesh = new T.Mesh(geo, mat);
                        mesh.position.set(0, -10 * K, z);
                        scene.add(mesh);
                        // Parallax: nearer layers move more than farther
                        // ones (perspective). distance = -z; small d ->
                        // large parallax. Scaled so the nearest sits
                        // around 0.32 and farthest around 0.18.
                        const distance = -z;
                        const parallax = Math.max(0.05, 1 - distance / (FOG_END * 1.4));
                        const layer = { mesh, geo, mat, tex, z, drift: 0, parallax };
                        layers.push(layer);
                        allocated.push(layer);
                    }
                    return { layers, intensity: settings.intensity };
                } catch (e) {
                    // Build threw partway — clean up any per-layer
                    // textures we already created. _bgMountStyle's catch
                    // disposes the stage tree's meshes, but a partial-
                    // build's CanvasTextures aren't reachable from any
                    // mesh yet, so this catch owns them.
                    for (const L of allocated) {
                        L.tex?.dispose?.();
                    }
                    throw e;
                }
            },
            update(s, bands, dt) {
                // Intensity multiplier: 0 dims to ~50% of base, 1
                // brightens to ~120%. Below-base values still leave the
                // silhouettes faintly visible so users know the style
                // is on; above-base lets the layers read as a real
                // backdrop on louder passages.
                const intensityMul = 0.5 + s.intensity * 0.7;
                for (const L of s.layers) {
                    // Scroll via texture.offset.x with RepeatWrapping —
                    // unbounded, no modulus snap. The mesh stays put;
                    // the texture wraps continuously across the visible
                    // surface. (offset is in normalized texture space,
                    // so we keep it small and let the wrap do the job.)
                    L.drift += dt * (0.05 + bands.mid * 0.15) * L.parallax;
                    L.mat.map.offset.x = L.drift;
                    L.mesh.position.y = -10 * K + bands.bass * 4 * K;
                    L.mat.opacity = (0.25 + 0.5 * L.parallax) * intensityMul;
                }
            },
            teardown(s) {
                if (!s) return;
                for (const L of s.layers) {
                    L.mesh.parent?.remove(L.mesh);
                    L.geo.dispose();
                    L.mat.dispose();
                    L.tex.dispose();
                }
            },
        },
        lights: {
            build(scene, settings) {
                // Lights count scales 6 → 14 over intensity 0 → 1.
                // _bgCoerce clamps intensity to [0,1] before it reaches
                // here, so no further clamp is needed.
                const N = Math.floor(6 + 8 * settings.intensity);
                const lights = [];
                // Palette comes from the calling panel's settings so
                // each splitscreen panel picks its own (issue #10).
                // Falls back to the default palette if the caller
                // doesn't supply one (e.g. an older code path).
                const palette = settings.palette || PALETTES.default;
                for (let i = 0; i < N; i++) {
                    const color = palette[i % palette.length];
                    // 30*K plane reads as a real stage glow at distance.
                    // Build-time opacity is overridden every frame in
                    // update() — the runtime formula is the source of
                    // truth.
                    const geo = new T.PlaneGeometry(30 * K, 30 * K);
                    const mat = new T.MeshBasicMaterial({
                        color, transparent: true,
                        blending: T.AdditiveBlending, depthWrite: false,
                    });
                    const mesh = new T.Mesh(geo, mat);
                    mesh.position.set(
                        (Math.random() - 0.5) * 600 * K,
                        (Math.random() - 0.3) * 80 * K,
                        // Inside visible fog range; renderOrder = -1
                        // keeps lights behind notes regardless of z.
                        -FOG_START - Math.random() * (FOG_END - FOG_START) * 0.85
                    );
                    scene.add(mesh);
                    lights.push({ mesh, geo, mat, baseScale: 1 + Math.random() * 0.5, phase: Math.random() * Math.PI * 2 });
                }
                return { lights };
            },
            update(s, bands, dt, t) {
                // Bumped opacity floor 0.35 → 0.55 + treble headroom
                // 0.3 → 0.4 so lights read as visible stage glows at
                // distance instead of faint specks (was effectively
                // 0.35 floor since the build-time bump was overridden
                // by this formula).
                for (const L of s.lights) {
                    const pulse = 1 + bands.bass * 1.5 + Math.sin(t * 1.5 + L.phase) * 0.2;
                    L.mesh.scale.set(L.baseScale * pulse, L.baseScale * pulse, 1);
                    L.mat.opacity = 0.55 + bands.treble * 0.4;
                }
            },
            teardown(s) {
                if (!s) return;
                for (const L of s.lights) {
                    L.mesh.parent?.remove(L.mesh);
                    L.geo.dispose();
                    L.mat.dispose();
                }
            },
        },
        geometric: {
            build(scene, settings) {
                const meshes = [];
                // Bumped opacity floor (0.25 → 0.45) + ceiling so the
                // wireframes read as real shapes instead of barely-
                // there ghosts at low intensity.
                const op = 0.45 + 0.25 * settings.intensity;
                const ico = new T.Mesh(
                    new T.IcosahedronGeometry(30 * K, 1),
                    new T.MeshBasicMaterial({ color: 0x6080c0, wireframe: true, transparent: true, opacity: op, depthWrite: false }),
                );
                // Inside visible fog range; renderOrder = -1 keeps
                // wireframes behind notes regardless of z.
                ico.position.set(-100 * K, 30 * K, -FOG_END * 0.65);
                scene.add(ico);
                meshes.push(ico);
                const torus = new T.Mesh(
                    new T.TorusGeometry(22 * K, 4 * K, 6, 12),
                    new T.MeshBasicMaterial({ color: 0xc06080, wireframe: true, transparent: true, opacity: op * 0.9, depthWrite: false }),
                );
                torus.position.set(120 * K, 20 * K, -FOG_END * 0.75);
                scene.add(torus);
                meshes.push(torus);
                return { meshes };
            },
            update(s, bands, dt) {
                const speed = 0.2 + bands.mid * 0.4;
                const pulse = 1 + bands.bass * 0.25;
                for (const m of s.meshes) {
                    m.rotation.x += dt * speed * 0.3;
                    m.rotation.y += dt * speed * 0.4;
                    m.scale.setScalar(pulse);
                }
            },
            teardown(s) {
                if (!s) return;
                for (const m of s.meshes) {
                    m.parent?.remove(m);
                    m.geometry.dispose();
                    m.material.dispose();
                }
            },
        },
        // Custom image backdrop (#19). User uploads a JPG/PNG/WebP
        // through settings.html; the bytes are persisted as a base64
        // data URL in localStorage under h3d_bg_customImageDataUrl and
        // passed in via settings.customImageDataUrl. Renders as a
        // PlaneGeometry in the silhouette parallax band, "cover" cropped
        // (via texture.repeat / offset) so non-matching aspects fill
        // the plane without distortion. Slow horizontal drift on
        // texture.offset.x for life. When no asset is uploaded, build
        // returns null and the style is inert (settings.html disables
        // the picker option in that case).
        image: {
            build(scene, settings) {
                // Upfront validation: only accept the same raster image
                // formats settings.html lets the user upload (jpeg /
                // png / webp). Without this, a corrupt localStorage
                // value (truncated base64, wrong scheme, plain string)
                // OR an unsupported type (e.g. data:image/svg+xml)
                // reaches TextureLoader and can fail asynchronously
                // after the plane has been mounted — a silent black
                // backdrop with no clear cause. Returning null here
                // treats invalid bytes the same as "no asset uploaded":
                // style is inert, the user can clear and re-upload
                // from settings.html.
                const dataUrl = (typeof settings.customImageDataUrl === 'string')
                    ? settings.customImageDataUrl.trim() : '';
                if (!/^data:image\/(jpeg|png|webp);/i.test(dataUrl)) return null;
                // Renderer-side encoded-length cap. settings.html
                // enforces the same limit on upload, but a manually
                // edited localStorage value (or legacy data from
                // before the upload guard existed) could still feed
                // an arbitrarily large data URL into TextureLoader
                // and burn memory / CPU during decode. Treat overlong
                // values as "no asset" — style is inert, user can
                // clear and re-upload from settings.
                if (dataUrl.length > 2.5 * 1024 * 1024) return null;
                // Renderer-side decompression-bomb caps. Mirror
                // settings.html's upload-time guard so a manual
                // localStorage edit (or legacy data from before that
                // guard existed) can't sneak a 50000×50000 PNG past
                // and OOM the GPU on texture upload.
                const MAX_IMAGE_DIM = 4096;
                const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
                // Full-bleed backdrop: unit plane, scaled per frame in
                // _bgFitBackdropPlane to fill the camera's view at
                // BG_BACKDROP_DISTANCE. fog: false so the backdrop
                // shows in full color; notes drawn on top still pick
                // up atmospheric fog as before.
                const state = {
                    mesh: null, geo: null, mat: null, tex: null,
                    drift: 0.5, intensity: settings.intensity, loaded: false,
                    cam: settings.cam, distance: BG_BACKDROP_DISTANCE,
                    lastAspect: 0, lastVisibleHeight: 0,
                };
                // Helper closure for cover-crop refresh — called both
                // on async decode (initial) and from _bgFitBackdropPlane
                // when the camera aspect changes (resize).
                state.applyCoverCrop = function () {
                    if (!state.tex || !state.tex.image) return;
                    _bgCoverCrop(
                        state.tex,
                        state.tex.image.width  || 0,
                        state.tex.image.height || 0,
                        state.cam.aspect,
                    );
                };
                const tex = new T.TextureLoader().load(
                    dataUrl,
                    (loaded) => {
                        // Image dimensions are only known after async decode.
                        const imgW = loaded.image?.width  || 0;
                        const imgH = loaded.image?.height || 0;
                        if (imgW > MAX_IMAGE_DIM || imgH > MAX_IMAGE_DIM || (imgW * imgH) > MAX_IMAGE_PIXELS) {
                            // Bail before the texture gets uploaded to
                            // the GPU (Three.js uploads on first render
                            // of a visible mesh — hiding the mesh here
                            // skips that). Disposing the texture too,
                            // belt-and-suspenders, in case anything
                            // else holds a reference.
                            console.warn('[3D-Hwy] custom image dimensions too large to render', imgW + 'x' + imgH);
                            if (state.mesh) state.mesh.visible = false;
                            loaded.dispose();
                            return;
                        }
                        state.applyCoverCrop();
                        // Reset drift to the centered triangle-wave
                        // phase now that repeat.x is final. Without
                        // this reset, drift accumulated during the
                        // async decode would phase-shift the initial
                        // offset by a non-deterministic amount —
                        // wider images would open at whatever crop
                        // the elapsed-decode-time happened to land on.
                        state.drift = 0.5;
                        state.loaded = true;
                    },
                    undefined,
                    // Async-failure path: the upfront regex catches the
                    // common "corrupted/truncated bytes" case, but a
                    // valid-looking data URL can still fail to decode
                    // (e.g. wrong MIME / unsupported codec). Hide the
                    // mesh so we don't paint a frozen blank plane on
                    // top of fog, and log so the failure isn't silent.
                    (err) => {
                        console.error('[3D-Hwy] custom image decode failed', err);
                        if (state.mesh) state.mesh.visible = false;
                    },
                );
                tex.colorSpace = T.SRGBColorSpace;
                // ClampToEdge on both axes — user uploads are non-
                // power-of-two in general, and WebGL1 rejects RepeatWrapping
                // on NPOT textures (renders black or emits GL errors). The
                // drift logic below uses a triangle-wave so the offset
                // stays inside [0, 1-repeat] and never needs wrap.
                tex.wrapS = T.ClampToEdgeWrapping;
                tex.wrapT = T.ClampToEdgeWrapping;
                // User uploads aren't power-of-two in general; mipmaps
                // are noisy for a single static backdrop and burn memory.
                tex.generateMipmaps = false;
                tex.minFilter = T.LinearFilter;
                tex.magFilter = T.LinearFilter;
                const geo = new T.PlaneGeometry(1, 1);
                const mat = new T.MeshBasicMaterial({
                    map: tex, transparent: false, depthWrite: false, fog: false,
                });
                const mesh = new T.Mesh(geo, mat);
                scene.add(mesh);
                state.mesh = mesh;
                state.geo  = geo;
                state.mat  = mat;
                state.tex  = tex;
                // Initial fit so the first frame is correctly sized
                // and positioned, even if update() hasn't run yet.
                _bgFitBackdropPlane(state);
                return state;
            },
            update(s, bands, dt) {
                if (!s) return;
                // Track camera position / aspect every frame. The
                // helper resizes the plane and refreshes cover-crop
                // when aspect changes, and re-positions the plane to
                // stay BG_BACKDROP_DISTANCE in front of the camera.
                _bgFitBackdropPlane(s);
                // Skip drift advance until the texture has finished
                // decoding. Without this guard, drift accumulates
                // during the async load while repeat.x is still 1
                // (its default), and once the cover-crop applies the
                // image opens at a phase-shifted offset whose value
                // depends on how long the decode took — the
                // "centered start" intent becomes non-deterministic.
                if (!s.loaded) return;
                // Triangle-wave ping-pong drift inside the cropped slack.
                // ClampToEdge on wrapS means we cannot wrap across the
                // texture boundary (would render edge pixels stretched);
                // ping-pong oscillates the visible window between the
                // image's left and right edges, which gives the same
                // "alive" feel without the WebGL1 NPOT-Repeat hazard.
                // Slack is the horizontal margin between the cropped
                // window and the texture edges; for taller-than-plane
                // images repeat.x stays 1, slack collapses to 0, and
                // the offset stays at 0 — the image sits still, which
                // is correct (it's already filling horizontally).
                s.drift += dt * 0.02 * s.intensity;
                const slack = Math.max(0, 1 - s.tex.repeat.x);
                // Period of 2 drift units ≈ 100 s at intensity = 0.5;
                // gentle, cinematic. cyc ∈ [0, 2), tri ∈ [0, 1] then back.
                const cyc = ((s.drift % 2) + 2) % 2;
                const tri = cyc < 1 ? cyc : 2 - cyc;
                s.tex.offset.x = tri * slack;
            },
            teardown(s) {
                if (!s) return;
                s.mesh.parent && s.mesh.parent.remove(s.mesh);
                s.geo.dispose();
                s.mat.dispose();
                // This style owns the texture lifecycle (per the comment
                // at _bgDisposeGroupTree: tree dispose does NOT touch
                // material.map textures).
                s.tex.dispose();
            },
        },
        // Custom video backdrop (#19 follow-up). User uploads a
        // .mp4/.webm via settings.html; routes.py stores it on disk and
        // serves a same-origin URL (avoids CORS taint on VideoTexture).
        // localStorage holds only the filename — bytes live in
        // {config_dir}/plugin_uploads/highway_3d/. Per-panel video
        // element so each panel can mount/teardown independently;
        // browsers cache the video bytes after first fetch so multi-
        // panel splitscreen pays only the decoder cost, not the
        // network or disk-read cost.
        video: {
            build(scene, settings) {
                // Lowercase before validation so a manual localStorage
                // edit like `current.MP4` doesn't pass a case-insensitive
                // regex check and then 404 against the server, which
                // only ever produces and serves lowercase
                // current.<ext> (the upload route lowercases the
                // extension; routes.py's GET pattern is case-sensitive).
                const filename = (typeof settings.customVideoName === 'string')
                    ? settings.customVideoName.trim().toLowerCase() : '';
                // Strict pattern matches routes.py's deterministic
                // single-slot naming. Any other shape (corrupt
                // localStorage, future schema change) → style is
                // inert, no <video> created, no orphan request to a
                // 404 endpoint.
                if (!/^current\.(mp4|webm)$/.test(filename)) return null;
                const url = '/api/plugins/highway_3d/files/' + filename;

                // Track partial allocations so a throw between any of
                // them can clean up. _bgMountStyle's failure path
                // disposes the stage tree but explicitly does NOT
                // dispose textures (per the comment at
                // _bgDisposeGroupTree), and the <video> element is
                // parented to document.body — not the stage — so
                // neither would be reached without an explicit catch.
                let videoEl = null, tex = null, geo = null, mat = null, mesh = null;
                try {
                    // muted + playsInline + autoplay is the cross-
                    // browser recipe that bypasses gesture requirements
                    // (Chrome, Firefox, Safari desktop + mobile).
                    // preload='auto' lets the first frame land before
                    // play() is called. src is deliberately NOT set
                    // yet — we want every piece of state (mesh, tex)
                    // to exist before the browser can fire
                    // loadedmetadata or error events on a cached
                    // resource. The handlers close over state.tex /
                    // state.mesh; setting src first would create a
                    // window where a fast cache hit could fire an
                    // event into half-initialized state.
                    videoEl = document.createElement('video');
                    // No crossOrigin attribute: the URL is same-origin
                    // (/api/plugins/highway_3d/files/…), so VideoTexture
                    // never sees a tainted canvas. Setting
                    // `crossOrigin = "anonymous"` would also strip
                    // cookies from the fetch, which would 401 against
                    // any cookie-protected slopsmith deployment. If
                    // this ever needs to fetch cross-origin, switch
                    // to `use-credentials` AND have the server send
                    // the matching CORS headers.
                    videoEl.muted = true;
                    videoEl.playsInline = true;
                    videoEl.loop = true;
                    videoEl.autoplay = true;
                    videoEl.preload = 'auto';
                    videoEl.style.display = 'none';
                    document.body.appendChild(videoEl);

                    // Build mesh + texture before registering listeners
                    // and before setting src. By the time loadedmetadata
                    // or error can fire, state.tex and state.mesh are
                    // both populated.
                    tex = new T.VideoTexture(videoEl);
                    tex.colorSpace = T.SRGBColorSpace;
                    tex.wrapS = T.ClampToEdgeWrapping;
                    tex.wrapT = T.ClampToEdgeWrapping;
                    tex.minFilter = T.LinearFilter;
                    tex.magFilter = T.LinearFilter;
                    tex.generateMipmaps = false;
                    geo = new T.PlaneGeometry(1, 1);
                    mat = new T.MeshBasicMaterial({
                        map: tex, transparent: false, depthWrite: false, fog: false,
                    });
                    mesh = new T.Mesh(geo, mat);
                    scene.add(mesh);

                    // Full-bleed backdrop: scaled and positioned each
                    // frame in update() via _bgFitBackdropPlane.
                    // cam + distance + lastAspect / lastVisibleHeight
                    // power that helper.
                    const state = {
                        videoEl, mesh, geo, mat, tex,
                        cam: settings.cam, distance: BG_BACKDROP_DISTANCE,
                        lastAspect: 0, lastVisibleHeight: 0,
                    };
                    state.applyCoverCrop = function () {
                        if (!state.videoEl) return;
                        _bgCoverCrop(
                            state.tex,
                            state.videoEl.videoWidth  || 0,
                            state.videoEl.videoHeight || 0,
                            state.cam.aspect,
                        );
                    };

                    // Cover-crop math runs on loadedmetadata since
                    // video dimensions aren't known until then.
                    // _bgFitBackdropPlane will also re-apply when the
                    // camera aspect changes.
                    videoEl.addEventListener('loadedmetadata', () => {
                        state.applyCoverCrop();
                    });
                    videoEl.addEventListener('error', () => {
                        // Fired for: codec unsupported, 404 from
                        // server, truncated file, etc. Hide the mesh
                        // so we don't paint a frozen blank plane on
                        // top of fog.
                        console.error('[3D-Hwy] custom video load failed', videoEl.error);
                        state.mesh.visible = false;
                    });

                    // Set src last — this is what triggers the async
                    // load. With handlers and state in place, any
                    // synchronous-feeling event from a cached resource
                    // is still safely received and handled.
                    videoEl.src = url;

                    // play() can reject for transient reasons (tab
                    // backgrounded at mount time, low-power mode,
                    // brief autoplay-policy timing window) even with
                    // muted + autoplay set — but the browser retries
                    // on its own once conditions improve (visibility
                    // change, foregrounding, gesture). Real load /
                    // codec failures come through the `error` event
                    // we registered above and DO hide the mesh. So
                    // just log here and leave the mesh visible; the
                    // next ready frame will paint.
                    videoEl.play().catch((err) => {
                        console.warn('[3D-Hwy] custom video play() rejected (will retry on visibility/gesture)', err);
                    });
                    // Initial fit so the first frame is correctly
                    // sized and positioned even before update() runs.
                    _bgFitBackdropPlane(state);
                    return state;
                } catch (err) {
                    // Best-effort cleanup of whatever was allocated
                    // before the throw. Each step is independently
                    // guarded so a secondary failure (e.g. dispose
                    // throwing on an already-disposed object) can't
                    // mask the original error.
                    try {
                        if (videoEl) {
                            videoEl.pause();
                            videoEl.removeAttribute('src');
                            videoEl.load();
                            if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
                        }
                    } catch (_) { /* ignore */ }
                    try { if (mesh && mesh.parent) mesh.parent.remove(mesh); } catch (_) { /* ignore */ }
                    try { if (geo) geo.dispose(); } catch (_) { /* ignore */ }
                    try { if (mat) mat.dispose(); } catch (_) { /* ignore */ }
                    try { if (tex) tex.dispose(); } catch (_) { /* ignore */ }
                    throw err;
                }
            },
            update(s) {
                if (!s) return;
                // VideoTexture auto-updates from the playing element —
                // Three.js samples the current frame each render. No
                // per-frame texture mutation here. Drift on offset.x
                // is intentionally omitted: the video's own motion is
                // the "life", drifting the crop on top would feel
                // busy and compete with playback. The only per-frame
                // work is keeping the plane camera-locked and resized
                // when aspect changes (handled inside the helper).
                _bgFitBackdropPlane(s);
            },
            teardown(s) {
                if (!s) return;
                if (s.videoEl) {
                    try { s.videoEl.pause(); } catch (_) {}
                    s.videoEl.removeAttribute('src');
                    // load() with no src tells the browser to release
                    // any decoder/buffer state for this element.
                    try { s.videoEl.load(); } catch (_) {}
                    if (s.videoEl.parentNode) s.videoEl.parentNode.removeChild(s.videoEl);
                }
                if (s.mesh) s.mesh.parent && s.mesh.parent.remove(s.mesh);
                if (s.geo) s.geo.dispose();
                if (s.mat) s.mat.dispose();
                if (s.tex) s.tex.dispose();
            },
        },
    };

    /* ======================================================================
     *  Per-instance counter
     * ====================================================================== */

    let _nextInstanceId = 0;

    /* ======================================================================
     *  Factory — slopsmith#36 setRenderer contract
     * ====================================================================== */

    function createFactory() {
        const _instanceId = ++_nextInstanceId;

        // ── Per-instance Three.js state ───────────────────────────────────
        let scene = null, cam = null, ren = null;
        let wrap = null;
        let ambLight = null, dirLight = null;
        let fretG = null, noteG = null, beatG = null, lblG = null;
        let gNote = null, gSus = null, gBeat = null, gTechArrow = null, gTapChevron = null;
        let mStr = [], mGlow = [], mSus = [], mProj = [], mProjGlow = [];
        let mWhiteOutline = null, mSusOutline = null;
        // Notedetect feedback outlines (issue #9). Created in initScene
        // alongside mWhiteOutline; swapped onto the note's outline mesh
        // when a recent notedetect:hit / :miss event matches the note's
        // (s, f, t).
        let mHitOutline = null, mMissOutline = null;
        let pSusOutline = null;
        let projMeshArr = null, projGlowArr = null;
        let _probe = null;
        let _laneTargetColor = null;
        let _renderScale = 1;
        let lyricsCanvas = null, lyricsCtx = null;
        let _diagChord = null;
        let _lastHwW = 0, _lastHwH = 0;
        let mBeatM = null, mBeatQ = null;
        let txtCache = {};
        // Cloned sprite materials cached on individual sprite instances
        // (e.g. pmMark._pmMat). pLbl pool reuses sprites across labels,
        // so when a sprite is later assigned a different material the
        // _pmMat stays referenced on the sprite itself but isn't reached
        // by the scene.traverse-based dispose. Track them here so
        // teardown can dispose them explicitly.
        const _ownedClonedMats = [];

        // Background animation state (issue #13). bgGroup is the parent
        // container for all bg meshes so teardown is one remove + dispose
        // pass. bgState is the active style's per-panel state object.
        let bgGroup = null, bgStage = null, bgState = null;
        let bgStyleId = 'particles', bgIntensity = 0.5, bgReactive = true;
        // Active palette for this panel (issue #10). Materials and per-
        // frame color reads inside createFactory all consult this rather
        // than the module-level S_COL, so a palette swap re-tints the
        // panel live without touching module-level state.
        let activePalette = PALETTES.default;
        // Show fret number on each fretted note body (issue #12). Off
        // by default — opt-in setting for players who like the at-a-
        // glance fret cue.
        let showFretOnNote = false;
        // Camera-X smoothing dial (issue #34). 0 = twitchy (track every
        // upcoming fret), 1 = calm (ignore small intra-cluster shifts).
        // Cached here and refreshed via the bg listener to avoid a
        // per-frame localStorage hit inside update().
        let cameraSmoothing = 0.5;
        // Custom image asset (issue #19). Data URL is the bytes that
        // drive the 'image' bg style's texture; name is display-only
        // metadata that settings.html shows next to the file picker.
        let bgCustomImageDataUrl = '';
        let bgCustomImageName = '';
        // Custom video asset (issue #19 follow-up). Stores the
        // server-side filename only; bytes live on disk via routes.py.
        // The renderer composes the served URL from this filename in
        // BG_STYLES.video.build.
        let bgCustomVideoName = '';
        let _bgListener = null;
        let _bgLastT = 0;  // ms timestamp for dt

        // Notedetect feedback (issue #9). Per-panel mark queues populated
        // by `notedetect:hit` / `notedetect:miss` window events. drawNote
        // looks up its (s, f, t) against these arrays each frame and
        // swaps the outline material when a match is current. Marks
        // expire after _ND_TTL_MS so the visual flash is brief. Marks
        // self-prune lazily in the listener to keep the arrays small.
        const _ND_TTL_MS = 500;
        const _ND_TIME_EPS = 0.01;
        let _ndHitMarks = [];
        let _ndMissMarks = [];
        let _ndOnHit = null, _ndOnMiss = null;
        // Per-frame timestamp captured by update() and used by its
        // prune pass for the notedetect mark arrays. drawNote itself
        // no longer reads it — pruning lives once per frame so
        // drawNote's hot path is just the bounded (s, f, t) match.
        let _ndFrameNowMs = 0;

        // Object pools
        let pNote, pSus, pLbl, pBeat, pSec;
        let pFretLbl, pLane, pLaneDivider;
        let pChordBox, pChordLbl, pBarreLine;
        let pNoteFretLabel, pConnectorLine, pDropLine, pTechArrow, pTapChevron;

        // Dynamic glowing string meshes (BoxGeometry, one per string)
        let stringLines = [];
        // Per-fret last-active timestamp for lane persistence
        let fretLastActiveTime = new Array(NFRETS + 1).fill(0);

        // Active string count for the current arrangement (resolved each
        // frame from bundle.stringCount and clamped to MAX_RENDER_STRINGS).
        let nStr = NSTR;
        // Set true once a chart with out-of-range s indices has triggered
        // its warning. Reset only on teardown or when nStr changes (e.g.
        // arrangement switch from guitar to bass) — same-nStr songs share
        // the suppression, which is fine for what is purely a developer
        // aid log.
        let _oobStringWarned = false;

        // Per-string bounds check used by every loop that indexes a
        // per-string array (noteState.*, nextNoteByString, lastFretForString,
        // mStr/mGlow/mSus, ...). Skipping out-of-range s upstream keeps
        // sparse-array extension out of those arrays AND keeps drawNote's
        // material lookup safe in one place.
        function validString(s) {
            const ok = Number.isInteger(s) && s >= 0 && s < nStr;
            if (!ok && !_oobStringWarned) {
                _oobStringWarned = true;
                let msg = '[3D-Hwy] dropping notes with s out of range [0,' + nStr + ')';
                if (nStr === S_COL.length) msg += ' (extended-range chart beyond palette size)';
                console.warn(msg);
            }
            return ok;
        }

        // filter() allocates a new array per chord per frame, even though
        // the vast majority of charts have no out-of-range strings. Scan
        // first; only allocate when there's actually something to drop.
        // The unfiltered array is reused as-is in the common case.
        function filterValidNotes(notes) {
            for (let i = 0; i < notes.length; i++) {
                if (!validString(notes[i].s)) {
                    return notes.filter(cn => validString(cn.s));
                }
            }
            return notes;
        }

        // Camera state
        let tgtX = 0, curX = 0;
        let tgtDist = CAM_DIST_BASE, curDist = CAM_DIST_BASE;
        let tgtLookY = 0, curLookY = 0;   // lerped look-at Y for self-correcting camera
        let aspectScale = 1;

        // Lifecycle flags
        let _isReady = false;
        let _destroyed = false;
        let _invertedCached = false;
        let _invertedForBoard = false;
        let _initToken = 0;
        let highwayCanvas = null;

        // ── Focus state (splitscreen dim) ─────────────────────────────────
        let _focusSubscribed = false;
        let _isFocused = true;
        const _onFocusChange = () => _updateFocusState();

        function _unsubscribeFocus() {
            if (!_focusSubscribed) return;
            const ss = window.slopsmithSplitscreen;
            if (ss && typeof ss.offFocusChange === 'function') ss.offFocusChange(_onFocusChange);
            _focusSubscribed = false;
        }

        function _updateFocusState() {
            if (_destroyed || !_isReady) return;
            const focused = _ssIsCanvasFocused(highwayCanvas);
            if (focused === _isFocused) return;
            _isFocused = focused;
            if (ambLight) ambLight.intensity = focused ? 0.85 : 0.4;
            if (dirLight) dirLight.intensity = focused ? 0.8 : 0.35;
        }

        // ── String-to-Y (respects invert) ─────────────────────────────────
        const sY = s => S_BASE + (_invertedCached ? s : (nStr - 1 - s)) * S_GAP;

        // ── Text-sprite cache ──────────────────────────────────────────────
        function txtMat(text, col, wide) {
            const k = (wide ? 'W' : '') + text + '|' + col;
            if (txtCache[k]) return txtCache[k];
            const w = wide ? 512 : 128, h = 128;
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
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

        // ── Object pool ────────────────────────────────────────────────────
        function pool(parent, mk) {
            const a = [];
            let n = 0;
            return {
                get() {
                    if (n < a.length) { a[n].visible = true; return a[n++]; }
                    const o = mk(); parent.add(o); a.push(o); n++; return o;
                },
                reset() { for (let i = 0; i < a.length; i++) a[i].visible = false; n = 0; },
            };
        }

        /* ── Lyrics overlay (2D canvas on top of WebGL) ─────────────────── */
        function drawChordDiagram(ctx, { name, frets, chDt }, inverted) {
            const CELL = 22, COLS = 6, ROWS = 4;
            const DOT_R = CELL * 0.3, PAD = 14;
            const HEADER = Math.round(CELL * 1.6);
            const MARKER = Math.round(CELL * 0.7);
            const gridW = CELL * (COLS - 1);
            const gridH = CELL * ROWS;
            const boxW = gridW + PAD * 2;
            const boxH = HEADER + MARKER + gridH + PAD;
            const bx = PAD, by = PAD;
            const gx = bx + PAD, gy = by + HEADER + MARKER;
            const opacity = Math.max(0, 1 + chDt / 0.55);

            const playedFrets = frets.filter(f => f > 0);
            const minFret = playedFrets.length > 0 ? Math.min(...playedFrets) : 1;
            const startFret = Math.max(1, minFret);
            const isFirstPos = startFret === 1;

            ctx.save();
            ctx.globalAlpha = opacity;

            // Background
            ctx.fillStyle = 'rgba(8, 14, 22, 0.88)';
            ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); ctx.stroke();

            // Chord name
            ctx.fillStyle = '#e8d080';
            ctx.font = `bold ${Math.round(CELL * 0.85)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(name, bx + boxW / 2, by + HEADER * 0.55);

            // Nut
            if (isFirstPos) { ctx.fillStyle = '#ffffff'; ctx.fillRect(gx, gy, gridW, 3); }

            // Fret lines
            ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
            for (let r = (isFirstPos ? 1 : 0); r <= ROWS; r++) {
                ctx.beginPath(); ctx.moveTo(gx, gy + r * CELL); ctx.lineTo(gx + gridW, gy + r * CELL); ctx.stroke();
            }

            // String lines
            for (let s = 0; s < COLS; s++) {
                ctx.beginPath(); ctx.moveTo(gx + s * CELL, gy); ctx.lineTo(gx + s * CELL, gy + ROWS * CELL); ctx.stroke();
            }

            // Open/muted markers + dots
            // Standard orientation: col 0 = low E (string 5), col 5 = high e (string 0)
            // Inverted flips: col 0 = high e (string 0), col 5 = low E (string 5)
            for (let col = 0; col < COLS; col++) {
                const strIdx = inverted ? col : (COLS - 1 - col);
                const f = frets[strIdx];
                const sx = gx + col * CELL;
                const markerY = gy - MARKER * 0.5;
                if (f < 0) {
                    const r = CELL * 0.18;
                    ctx.strokeStyle = '#cc4444'; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.moveTo(sx - r, markerY - r); ctx.lineTo(sx + r, markerY + r); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(sx + r, markerY - r); ctx.lineTo(sx - r, markerY + r); ctx.stroke();
                } else if (f === 0) {
                    ctx.strokeStyle = '#88bbff'; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(sx, markerY, CELL * 0.2, 0, Math.PI * 2); ctx.stroke();
                } else {
                    const row = f - startFret;
                    if (row >= 0 && row < ROWS) {
                        ctx.fillStyle = '#ffffff';
                        ctx.beginPath(); ctx.arc(sx, gy + row * CELL + CELL * 0.5, DOT_R, 0, Math.PI * 2); ctx.fill();
                    }
                }
            }
            ctx.restore();
        }

        function drawLyrics(lyrics, currentTime, ctx, W, H) {
            if (!lyrics._lines) {
                const lines = [];
                let line = null, word = null;
                const flushWord = () => { if (word && word.length) line.words.push(word); word = null; };
                const flushLine = () => { flushWord(); if (line && line.words.length) lines.push(line); line = null; };
                for (let i = 0; i < lyrics.length; i++) {
                    const l = lyrics[i];
                    const raw = l.w || '';
                    const endsLine = raw.endsWith('+');
                    const continuesWord = raw.endsWith('-');
                    if (line && i > 0 && l.t - (lyrics[i - 1].t + lyrics[i - 1].d) > 4.0) flushLine();
                    if (!line) line = { words: [], start: l.t, end: l.t + l.d };
                    if (!word) word = [];
                    word.push(l);
                    line.end = Math.max(line.end, l.t + l.d);
                    if (!continuesWord) flushWord();
                    if (endsLine) flushLine();
                }
                flushLine();
                lyrics._lines = lines;
            }
            const allLines = lyrics._lines;
            if (!allLines.length) return;

            let currentIdx = -1;
            for (let i = 0; i < allLines.length; i++) {
                if (allLines[i].start <= currentTime) currentIdx = i;
                else break;
            }
            if (currentIdx === -1) {
                if (allLines[0].start - currentTime > 2.0) return;
                currentIdx = 0;
            }
            const currentLine = allLines[currentIdx];
            const nextLine = allLines[currentIdx + 1] || null;
            const gapToNext = nextLine ? (nextLine.start - currentLine.end) : Infinity;
            if (currentTime > currentLine.end + 0.5 && gapToNext > 3.0) return;

            const linesToShow = [currentLine];
            if (nextLine && gapToNext <= 3.0) linesToShow.push(nextLine);

            const fontSize = Math.max(18, H * 0.028) | 0;
            const lineY = H * 0.04;
            const sylText = s => { const t = s.w || ''; return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t; };

            ctx.font = `bold ${fontSize}px sans-serif`;
            const spaceWidth = ctx.measureText(' ').width;
            const maxWidth = W * 0.8;

            const rows = [];
            for (const authoredLine of linesToShow) {
                let row = [], rowWidth = 0;
                for (const wordSyls of authoredLine.words) {
                    const parts = [];
                    let wordWidth = 0;
                    for (const s of wordSyls) {
                        const text = sylText(s);
                        const w = ctx.measureText(text).width;
                        parts.push({ syl: s, text, width: w });
                        wordWidth += w;
                    }
                    const advance = wordWidth + spaceWidth;
                    if (row.length > 0 && rowWidth + advance > maxWidth) { rows.push(row); row = []; rowWidth = 0; }
                    row.push({ parts, advance });
                    rowWidth += advance;
                }
                if (row.length) rows.push(row);
            }

            const rowHeight = fontSize + 6;
            const totalHeight = rows.length * rowHeight + 10;
            let bgWidth = 0;
            for (const row of rows) {
                const rw = row.reduce((s, w) => s + w.advance, 0) - spaceWidth;
                if (rw > bgWidth) bgWidth = rw;
            }
            bgWidth = Math.min(bgWidth + 30, W * 0.85);

            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.beginPath();
            const bx = W / 2 - bgWidth / 2, by = lineY - 4, br = 8;
            ctx.moveTo(bx + br, by); ctx.lineTo(bx + bgWidth - br, by);
            ctx.quadraticCurveTo(bx + bgWidth, by, bx + bgWidth, by + br);
            ctx.lineTo(bx + bgWidth, by + totalHeight - br);
            ctx.quadraticCurveTo(bx + bgWidth, by + totalHeight, bx + bgWidth - br, by + totalHeight);
            ctx.lineTo(bx + br, by + totalHeight);
            ctx.quadraticCurveTo(bx, by + totalHeight, bx, by + totalHeight - br);
            ctx.lineTo(bx, by + br);
            ctx.quadraticCurveTo(bx, by, bx + br, by);
            ctx.closePath();
            ctx.fill();

            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (let r = 0; r < rows.length; r++) {
                const row = rows[r];
                const rowWidth = row.reduce((s, w) => s + w.advance, 0) - spaceWidth;
                let xPos = W / 2 - rowWidth / 2;
                const yPos = lineY + r * rowHeight + 2;
                for (const w of row) {
                    for (const part of w.parts) {
                        const l = part.syl;
                        const isActive = currentTime >= l.t && currentTime < l.t + l.d;
                        const isPast = currentTime >= l.t + l.d;
                        ctx.fillStyle = isActive ? '#4ae0ff' : isPast ? '#8899aa' : '#556677';
                        ctx.font = `${isActive ? 'bold' : 'normal'} ${fontSize}px sans-serif`;
                        ctx.fillText(part.text, xPos, yPos);
                        xPos += part.width;
                    }
                    xPos += spaceWidth;
                }
            }
        }

        /* ── Scene initialisation ─────────────────────────────────────────── */
        function initScene() {
            if (!highwayCanvas || !highwayCanvas.parentNode) {
                console.error('[3D-Hwy] initScene: canvas has no parent; aborting');
                return false;
            }

            // Reset per-song lane state
            fretLastActiveTime.fill(0);

            wrap = document.createElement('div');
            wrap.id = 'h3d-wrap-' + _instanceId;
            wrap.className = 'h3d-wrap';
            wrap.dataset.h3dInstance = String(_instanceId);
            wrap.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:2;pointer-events:none;';
            highwayCanvas.parentNode.insertBefore(wrap, highwayCanvas.nextSibling);

            ren = new T.WebGLRenderer({ antialias: true });
            _probe = new T.Vector3();
            ren.setClearColor(0x101820);
            wrap.appendChild(ren.domElement);

            lyricsCanvas = document.createElement('canvas');
            lyricsCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
            lyricsCtx = lyricsCanvas.getContext('2d');
            wrap.appendChild(lyricsCanvas);

            scene = new T.Scene();
            scene.fog = new T.Fog(0x101820, FOG_START * 0.8, FOG_END * 1.2);

            cam = new T.PerspectiveCamera(70, 1, 0.01, FOG_END * 3);

            ambLight = new T.AmbientLight(0xffffff, 0.85);
            scene.add(ambLight);
            dirLight = new T.DirectionalLight(0xffffff, 0.8);
            dirLight.position.set(40 * K, 120 * K, 80 * K);
            scene.add(dirLight);

            fretG = new T.Group(); scene.add(fretG);
            noteG = new T.Group(); scene.add(noteG);
            beatG = new T.Group(); scene.add(beatG);
            lblG = new T.Group(); scene.add(lblG);

            // Rectangular note geometry
            gNote = new T.BoxGeometry(NW, NH, ND);

            gSus = new T.BoxGeometry(1, 1, 1);
            gBeat = new T.BufferGeometry().setFromPoints(
                [new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0)],
            );
            const arrowShape = new T.Shape();
            arrowShape.moveTo(-0.5, 0);
            arrowShape.lineTo(0, 1);
            arrowShape.lineTo(0.5, 0);
            arrowShape.closePath();
            gTechArrow = new T.ExtrudeGeometry(arrowShape, {
                depth: 0.04 * K,
                bevelEnabled: false,
            });
            gTechArrow.translate(0, -0.5, 0); // Center the geometry vertically

            // Tap chevron (open V pointing downward) — line segments

            const chevronShape = new T.Shape();

            // Adjusting points for a "stubby" look
            // Width: increased to +/- 0.8 for a broader look
            // Height: capped at 0.2 to make it significantly shorter
            chevronShape.moveTo(-0.6, 0.3);   // Top left point (further out, lower down)
            chevronShape.lineTo(0, -0.1);     // Interior vertex (shallower V)
            chevronShape.lineTo(0.6, 0.3);    // Top right point (further out, lower down)

            chevronShape.lineTo(0.8, 0.0);    // Right outer thickness point
            chevronShape.lineTo(0, -0.3);     // Bottom vertex / Outer point (less deep)
            chevronShape.lineTo(-0.8, 0.0);   // Left outer thickness point

            chevronShape.closePath();

            // Create the 3D mesh geometry with a small depth
            gTapChevron = new T.ExtrudeGeometry(chevronShape, {
                depth: 0.04 * K,
                bevelEnabled: false,
            });

            // Optional: Center the geometry if the pivot point feels off
            gTapChevron.computeBoundingBox();
            const centerOffset = -0.5 * (gTapChevron.boundingBox.max.y + gTapChevron.boundingBox.min.y);
            gTapChevron.translate(0, centerOffset, 0);

            // String materials: emissive so they glow when lit
            mStr = activePalette.map(c => new T.MeshStandardMaterial({
                color: c, emissive: c, emissiveIntensity: 0.002,
                transparent: true, opacity: 0.4, roughness: 1,
            }));
            mGlow = activePalette.map(c => new T.MeshLambertMaterial({
                color: 0xffffff, emissive: c, emissiveIntensity: 1.5,
            }));
            mProj = activePalette.map(c => new T.MeshStandardMaterial({
                color: c, emissive: c, emissiveIntensity: 0.002,
                transparent: true, opacity: 0.15, roughness: 1,
            }));
            mProjGlow = activePalette.map(c => new T.MeshLambertMaterial({
                color: 0xffffff, emissive: c, emissiveIntensity: 1.5,
                transparent: true, opacity: 0.1,
            }));
            _laneTargetColor = new T.Color(0x4488ff);
            mSus = activePalette.map(c => new T.MeshLambertMaterial({
                color: c, transparent: true, opacity: 0.35,
            }));
            mWhiteOutline = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 });
            // Notedetect feedback (issue #9): bright green / red outline
            // tints. Note rendering swaps its outline.material between
            // mWhiteOutline / mHitOutline / mMissOutline based on
            // recent notedetect events.
            mHitOutline = new T.MeshLambertMaterial({ color: 0x40ff70, emissive: 0x40ff70, emissiveIntensity: 1.0 });
            mMissOutline = new T.MeshLambertMaterial({ color: 0xff4040, emissive: 0xff4040, emissiveIntensity: 1.0 });
            mSusOutline = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3, transparent: true, opacity: 0.75, depthWrite: false });
            mBeatM = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
            mBeatQ = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 });

            // ── Projection meshes — one per string, own material clone each ──
            projMeshArr = activePalette.map((_, s) => {
                const m = new T.Mesh(gNote, mProj[s].clone());
                m.visible = false;
                noteG.add(m);
                return m;
            });
            projGlowArr = activePalette.map((_, s) => {
                const m = new T.Mesh(gNote, mProjGlow[s].clone());
                m.visible = false;
                m.renderOrder = -1;
                noteG.add(m);
                return m;
            });

            // ── Pools ──────────────────────────────────────────────────────
            pNote = pool(noteG, () => new T.Mesh(gNote, mStr[0]));
            pSus = pool(noteG, () => new T.Mesh(gSus, mSus[0]));
            pSusOutline = pool(noteG, () => new T.Mesh(gSus, mSusOutline));
            pTechArrow = pool(noteG, () => new T.Mesh(gTechArrow, new T.MeshLambertMaterial({
                color: 0xffffff,
                emissive: 0xffffff,
                emissiveIntensity: 0.9,
                transparent: false,
                opacity: 1.0,
                side: T.DoubleSide,
                depthWrite: true,
            })));
            pTapChevron = pool(noteG, () => {
                return new T.Mesh(gTapChevron, new T.MeshLambertMaterial({
                    color: 0xd4d4d4,
                    emissive: 0xd4d4d4,
                    emissiveIntensity: 0.9,
                    transparent: true,
                    opacity: 0.85,
                    side: T.DoubleSide,
                    depthWrite: false,
                }));
            });
            pLbl = pool(lblG, () => new T.Sprite(txtMat('0', '#fff', false)));
            pBeat = pool(beatG, () => new T.Line(gBeat, mBeatQ));
            pSec = pool(lblG, () => new T.Sprite(txtMat('', '#0dd', true)));

            // Dynamic fret number labels (heat-coloured, updated each frame)
            pFretLbl = pool(lblG, () => new T.Sprite(txtMat('0', '#888', false)));

            // Highlight lane plane over active fret range
            pLane = pool(noteG, () => new T.Mesh(
                new T.PlaneGeometry(1, 1),
                new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
            ));

            // Vertical fret dividers within active lane
            const gLaneDivider = new T.BoxGeometry(0.15 * K, 0.15 * K, 1);
            const mLaneDivider = new T.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.08, fog: false, depthWrite: false,
            });
            pLaneDivider = pool(noteG, () => new T.Mesh(gLaneDivider, mLaneDivider));

            // Chord frame-boxes (replaces old bracket approach)
            pChordBox = pool(noteG, () => new T.Mesh(
                new T.BoxGeometry(1, 1, 1),
                new T.MeshStandardMaterial({
                    color: 0x88ccff, transparent: true, opacity: 0.12,
                    depthWrite: false, side: T.DoubleSide, metalness: 0.5, roughness: 0.2,
                }),
            ));

            pChordLbl = pool(lblG, () => new T.Sprite(txtMat('', '#e8d080', true).clone()));
            pBarreLine = pool(noteG, () => new T.Mesh(
                new T.BoxGeometry(1, 1, 1),
                new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, transparent: true, depthWrite: false }),
            ));

            // Per-note fret number below note with connector line
            pNoteFretLabel = pool(lblG, () => new T.Sprite(txtMat('0', '#ffffff', false).clone()));
            pConnectorLine = pool(noteG, () => new T.Line(
                new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 1, 0)]),
                new T.LineBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.5 }),
            ));
            pDropLine = pool(noteG, () => new T.Line(
                new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, 1, 0)]),
                new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
            ));

            buildBoard();

            // Background animations (#13). Read settings keyed by this
            // panel and mount the active style's meshes. Subscribe to
            // in-app settings changes (settings.html via window.h3dBgSet*)
            // so they propagate without a reload. Manual localStorage
            // edits don't fire the pub-sub and require a reload.
            _bgLoadSettings();
            bgGroup = new T.Group();
            // Note: renderOrder on a Group is a no-op (Three.js Groups
            // are transforms, not rendered objects, so renderOrder only
            // affects the actual meshes inside). _bgMountStyle stamps
            // renderOrder = -1 on every child after build, which IS what
            // forces background to render before gameplay geometry.
            // Combined with the deeper-than-note-range placements below,
            // background never paints over notes.
            scene.add(bgGroup);
            _bgMountStyle();
            _bgListener = (changedKey) => {
                if (changedKey === 'reactive' || changedKey === 'showFretOnNote' || changedKey === 'cameraSmoothing') {
                    // Reactive flag flips don't need a mesh rebuild —
                    // just refresh the per-instance flag for the next
                    // frame to consult. Same shape for showFretOnNote
                    // (#12) and cameraSmoothing (#34), both read per-
                    // frame in update().
                    _bgLoadSettings();
                    return;
                }
                if (changedKey === 'palette') {
                    // Palette change has three effects:
                    //  1. _bgLoadSettings -> _applyPaletteToMaterials
                    //     retints the per-instance shared materials
                    //     (notes, glows, sustain trails, projection).
                    //  2. buildBoard rebuilds the fretboard meshes
                    //     (LineBasicMaterial lane lines + per-string
                    //     BoxGeometry materials). These are created at
                    //     build time with palette-baked colors and
                    //     aren't reachable from _applyPaletteToMaterials.
                    //  3. lights bg style bakes palette colors into
                    //     sprite quads at build time, so it needs a
                    //     full mesh rebuild — fire _bgRebuild when
                    //     that style is active.
                    _bgLoadSettings();
                    if (fretG) buildBoard();
                    if (bgStyleId === 'lights') _bgRebuild();
                    return;
                }
                if (changedKey === 'customImageDataUrl') {
                    // Asset bytes changed. Rebuild only when the image
                    // style is active — otherwise the new bytes will
                    // pick up next time the user picks `image`.
                    _bgLoadSettings();
                    if (bgStyleId === 'image') _bgRebuild();
                    return;
                }
                if (changedKey === 'customImageName') {
                    // Display-only metadata; no mesh rebuild.
                    _bgLoadSettings();
                    return;
                }
                if (changedKey === 'customVideoName') {
                    // Filename change → new <video> source. Rebuild
                    // only when the video style is currently active;
                    // otherwise the new bytes pick up next time the
                    // user picks `video`.
                    _bgLoadSettings();
                    if (bgStyleId === 'video') _bgRebuild();
                    return;
                }
                if (changedKey === 'intensity') {
                    _bgLoadSettings();
                    // Image style reads s.intensity per frame inside
                    // update() to scale the drift speed, so a live
                    // mutation is enough — no need to tear down and
                    // re-decode the texture for every slider change.
                    // The procedural styles bake intensity into mesh
                    // count, opacity, and size at build time, so they
                    // still need a full rebuild.
                    if (bgStyleId === 'image' && bgState) {
                        bgState.intensity = bgIntensity;
                        return;
                    }
                    _bgRebuild();
                    return;
                }
                if (!changedKey || changedKey === 'style') {
                    _bgRebuild();
                }
            };
            _bgSubscribe(_bgListener);

            // Notedetect feedback (#9). Listen for hit/miss events on
            // window. Notedetect dispatches both globally and on its
            // instanceRoot; the global fire is fine for our case since
            // each 3dhighway panel just stores any event into its own
            // queue and renders only the matching note. Listeners are
            // per-panel so destroy() can cleanly remove them; cost is
            // a per-event branch + push, negligible vs per-frame work.
            // Validate every payload field we'll later compare against
            // chart-data fields (s, f, t). drawNote compares with
            // Math.abs(m.noteTime - n.t) and trusts the values are
            // finite, so reject any payload missing one of those
            // fields here rather than letting bogus data into the
            // arrays. Prune expired marks on every push so the arrays
            // settle back to empty when notedetect stops emitting —
            // drawNote's fast-path short-circuit
            // (`if (_ndHitMarks.length || _ndMissMarks.length)`) only
            // works if expired entries don't linger.
            const _ndPushMark = (arr, d) => {
                if (!d || !d.note) return arr;
                if (!Number.isFinite(d.note.s) || !Number.isFinite(d.note.f) || !Number.isFinite(d.noteTime)) return arr;
                const now = performance.now();
                // In-place prune only when the oldest mark is actually
                // expired. Marks are pushed in chronological order so
                // checking arr[0] tells us in O(1) whether anything
                // needs to go. splice keeps the same array (no fresh
                // allocation) — saves a per-event filter() copy in the
                // common case where nothing has expired yet.
                if (arr.length !== 0 && arr[0].expiresAt <= now) {
                    let firstLive = 0;
                    while (firstLive < arr.length && arr[firstLive].expiresAt <= now) firstLive++;
                    if (firstLive >= arr.length) arr.length = 0;
                    else arr.splice(0, firstLive);
                }
                arr.push({ s: d.note.s, f: d.note.f, noteTime: d.noteTime, expiresAt: now + _ND_TTL_MS });
                return arr;
            };
            _ndOnHit = (e) => { _ndHitMarks = _ndPushMark(_ndHitMarks, e.detail); };
            _ndOnMiss = (e) => { _ndMissMarks = _ndPushMark(_ndMissMarks, e.detail); };
            window.addEventListener('notedetect:hit', _ndOnHit);
            window.addEventListener('notedetect:miss', _ndOnMiss);

            return true;
        }

        function _bgLoadSettings() {
            const panelKey = _bgPanelKey(highwayCanvas);
            bgStyleId = _bgReadSetting(panelKey, 'style');
            bgIntensity = _bgReadSetting(panelKey, 'intensity');
            bgReactive = _bgReadSetting(panelKey, 'reactive');
            const newPaletteId = _bgReadSetting(panelKey, 'palette');
            const newPalette = PALETTES[newPaletteId] || PALETTES.default;
            if (newPalette !== activePalette) {
                activePalette = newPalette;
                _applyPaletteToMaterials();
            }
            showFretOnNote = _bgReadSetting(panelKey, 'showFretOnNote');
            cameraSmoothing = _bgReadSetting(panelKey, 'cameraSmoothing');
            // Custom image asset is a single GLOBAL slot — bytes are
            // shared across panels (per-panel choice is which style
            // each panel renders, not which asset). Reading via
            // _bgReadSetting would let a stray h3d_bg_panel<idx>_*
            // override silently re-introduce the per-panel asset
            // duplication this design deliberately avoids (and
            // h3dBgClearCustomImage wouldn't reach those overrides).
            // Read globals directly instead.
            //
            // Precedence: in-memory fallback BEFORE localStorage. The
            // setter always populates _bgMemFallback (even when the
            // localStorage write fails on quota), so the fallback
            // holds the most-recent staged value. Reading localStorage
            // first would mean a failed write leaves the renderer
            // pointed at the previous asset while settings.html shows
            // a "session-only" warning claiming the new bytes are in
            // effect — UI and renderer would silently disagree.
            const memDataUrl = _bgMemFallback.customImageDataUrl;
            const memName    = _bgMemFallback.customImageName;
            try {
                const gDataUrl = (memDataUrl !== undefined) ? memDataUrl : localStorage.getItem('h3d_bg_customImageDataUrl');
                const gName    = (memName    !== undefined) ? memName    : localStorage.getItem('h3d_bg_customImageName');
                bgCustomImageDataUrl = (gDataUrl != null) ? gDataUrl : BG_DEFAULTS.customImageDataUrl;
                bgCustomImageName    = (gName    != null) ? gName    : BG_DEFAULTS.customImageName;
            } catch (_) {
                bgCustomImageDataUrl = (memDataUrl !== undefined) ? memDataUrl : BG_DEFAULTS.customImageDataUrl;
                bgCustomImageName    = (memName    !== undefined) ? memName    : BG_DEFAULTS.customImageName;
            }
            // Custom video filename: also a single global slot, same
            // mem-first precedence as the image keys (a quota-failed
            // setItem leaves _bgMemFallback ahead of localStorage).
            const memVideoName = _bgMemFallback.customVideoName;
            try {
                const gVideoName = (memVideoName !== undefined) ? memVideoName : localStorage.getItem('h3d_bg_customVideoName');
                bgCustomVideoName = (gVideoName != null) ? gVideoName : BG_DEFAULTS.customVideoName;
            } catch (_) {
                bgCustomVideoName = (memVideoName !== undefined) ? memVideoName : BG_DEFAULTS.customVideoName;
            }
        }
        // Live-swap palette by mutating existing materials in place.
        // Three.js colors propagate to all sharing meshes on the next
        // render — no rebuild, no GC. Glow materials (mGlow, mProjGlow)
        // were authored with .color = white and the per-string color in
        // .emissive only; we preserve that here so the glow look stays
        // consistent before/after a palette swap rather than tinting
        // the diffuse white. Lane lines and drop lines that read
        // activePalette[s] per frame pick up automatically. Per-string
        // fretboard materials built inside buildBoard() are independent
        // and aren't reachable from here — buildBoard re-runs from the
        // palette listener to regenerate them with the new colors.
        //
        // projMeshArr / projGlowArr meshes hold per-mesh CLONES of
        // mProj / mProjGlow (each string needs its own opacity,
        // overridden per-frame in drawNote), so updating mProj/mProjGlow
        // alone wouldn't retint the projection ghosts. Walk those
        // cloned materials too.
        function _applyPaletteToMaterials() {
            for (let s = 0; s < activePalette.length; s++) {
                const c = activePalette[s];
                if (mStr[s]) { mStr[s].color.setHex(c); mStr[s].emissive.setHex(c); }
                if (mGlow[s]) mGlow[s].emissive.setHex(c);
                if (mSus[s]) mSus[s].color.setHex(c);
                if (mProj[s]) { mProj[s].color.setHex(c); mProj[s].emissive.setHex(c); }
                if (mProjGlow[s]) mProjGlow[s].emissive.setHex(c);
                // Clones live on the projection meshes themselves.
                const pm = projMeshArr && projMeshArr[s];
                if (pm && pm.material) {
                    pm.material.color.setHex(c);
                    pm.material.emissive?.setHex?.(c);
                }
                const pg = projGlowArr && projGlowArr[s];
                if (pg && pg.material) {
                    pg.material.emissive?.setHex?.(c);
                }
            }
        }
        function _bgMountStyle() {
            const style = BG_STYLES[bgStyleId] || BG_STYLES.off;
            // Build into a fresh stage group so a partial throw can't
            // orphan meshes inside bgGroup. On success the stage joins
            // bgGroup atomically; on failure the stage and everything
            // in it are disposed and bgState stays null.
            const stage = new T.Group();
            let result = null;
            try {
                result = style.build(stage, {
                    intensity: bgIntensity,
                    palette: activePalette,
                    customImageDataUrl: bgCustomImageDataUrl,
                    customVideoName: bgCustomVideoName,
                    cam: cam,
                }) || null;
            } catch (e) {
                console.error('[3D-Hwy] bg style build failed', bgStyleId, e);
                _bgDisposeGroupTree(stage);
                bgState = null;
                bgStage = null;
                return;
            }
            // renderOrder on a Group doesn't propagate to its children
            // (Three.js sorts by per-object renderOrder, and a Group is a
            // transform, not a rendered object). Stamp every mesh in the
            // stage so transparent bg objects always sort behind notes
            // regardless of their z relative to gameplay geometry.
            stage.traverse((c) => { c.renderOrder = -1; });
            bgGroup.add(stage);
            bgStage = stage;
            bgState = result;
        }
        function _bgUnmountStyle() {
            const style = BG_STYLES[bgStyleId] || BG_STYLES.off;
            try { style.teardown(bgState); } catch (e) { console.error('[3D-Hwy] bg teardown', e); }
            bgState = null;
            // Belt + suspenders: even if a style's teardown forgets to
            // dispose something, the stage tree dispose mops up.
            if (bgStage) {
                bgStage.parent?.remove(bgStage);
                _bgDisposeGroupTree(bgStage);
                bgStage = null;
            }
        }
        // Recursively dispose geometries / materials attached to an
        // Object3D tree, then detach. Used as a safety net during
        // _bgMountStyle failures and on _bgUnmountStyle.
        //
        // Deliberately does NOT dispose material.map textures — texture
        // lifetime belongs to whoever allocated the texture. The
        // silhouettes style allocates a per-layer CanvasTexture wrapping
        // the shared _silCanvas bitmap, and disposes those textures in
        // its own teardown. Disposing them here would double-dispose,
        // and any future plugin texture sharing across panels (e.g. an
        // upcoming custom-background feature) would break the same way.
        // Style teardown owns texture release.
        function _bgDisposeGroupTree(obj) {
            if (!obj) return;
            obj.traverse((child) => {
                child.geometry?.dispose?.();
                const mat = child.material;
                if (mat) {
                    const mats = Array.isArray(mat) ? mat : [mat];
                    for (const m of mats) m?.dispose?.();
                }
            });
            obj.parent?.remove(obj);
        }
        function _bgRebuild() {
            if (!bgGroup) return;
            // Order matters: teardown must run against the (style id,
            // state) pair that built the meshes, so unmount BEFORE
            // reloading settings. Reload, then mount with the new id.
            _bgUnmountStyle();
            _bgLoadSettings();
            _bgMountStyle();
            // Reset dt accounting so the first frame after a switch
            // doesn't see a huge "since last update" window — that
            // would clamp to 0.1 and visibly snap motion / rotation.
            _bgLastT = 0;
        }

        /* ── Fretboard (static geometry) ────────────────────────────────── */
        function buildBoard() {
            // Dispose before clearing
            while (fretG.children.length) {
                const child = fretG.children[0];
                if (child.material && !Array.isArray(child.material) &&
                    !(child instanceof T.Sprite)) {
                    child.geometry?.dispose?.();
                    child.material.dispose?.();
                }
                fretG.remove(child);
            }
            stringLines = [];

            const bw = fretX(NFRETS) + 4 * K;
            const bl = TS * (AHEAD + BEHIND);

            // Fretboard plane
            const pg = new T.PlaneGeometry(bw, bl);
            const pm = new T.MeshLambertMaterial({ color: 0x08080e, transparent: true, opacity: 0.6 });
            const p = new T.Mesh(pg, pm);
            p.rotation.x = -Math.PI / 2;
            p.position.set(bw / 2 - 2 * K, S_BASE - NH / 2 - 2 * K, -bl / 2 + TS * BEHIND);
            fretG.add(p);

            // Thin Line strings (glow layer)
            for (let s = 0; s < nStr; s++) {
                const pts = [new T.Vector3(-2 * K, sY(s), 0), new T.Vector3(fretX(NFRETS) + 2 * K, sY(s), 0)];
                const g = new T.BufferGeometry().setFromPoints(pts);
                fretG.add(new T.Line(g, new T.LineBasicMaterial({ color: activePalette[s], transparent: true, opacity: 0.15 })));
            }

            // BoxGeometry strings — emissive glow driven by updateStringHighlights()
            const strLen = fretX(NFRETS) + 4 * K;
            for (let s = 0; s < nStr; s++) {
                const g = new T.BoxGeometry(strLen, STR_THICK, STR_THICK);
                // Each string gets its own material instance so emissiveIntensity is per-string
                const mat = new T.MeshStandardMaterial({
                    color: activePalette[s], emissive: activePalette[s],
                    emissiveIntensity: 0.002,
                    transparent: true, opacity: 0.4, roughness: 1,
                });
                const mesh = new T.Mesh(g, mat);
                mesh.position.set(strLen / 2 - 2 * K, sY(s), 0);
                fretG.add(mesh);
                stringLines.push(mesh);
            }

            // Fret wires
            const yTop = Math.max(sY(0), sY(nStr - 1));
            const yBottom = Math.min(sY(0), sY(nStr - 1));
            for (let f = 0; f <= NFRETS; f++) {
                const x = fretX(f);
                const isMain = DOTS.includes(f);
                const g = new T.BufferGeometry().setFromPoints([
                    new T.Vector3(x, yBottom - S_GAP * 0.3, 0),
                    new T.Vector3(x, yTop + S_GAP * 0.3, 0),
                ]);
                fretG.add(new T.Line(g, new T.LineBasicMaterial({
                    color: isMain ? 0xbbbbff : 0x666688,
                    transparent: true,
                    opacity: isMain ? 0.8 : 0.4,
                })));
            }

            // Fret dots
            const dg = new T.SphereGeometry(1.5 * K, 8, 6);
            const dm = new T.MeshBasicMaterial({ color: 0x556677 });
            const my = (sY(0) + sY(nStr - 1)) / 2;
            for (const f of DOTS) {
                const cx = fretMid(f);
                if (DDOTS.has(f)) {
                    let d = new T.Mesh(dg, dm); d.position.set(cx, my - S_GAP * 0.7, 0); fretG.add(d);
                    d = new T.Mesh(dg, dm); d.position.set(cx, my + S_GAP * 0.7, 0); fretG.add(d);
                } else {
                    const d = new T.Mesh(dg, dm); d.position.set(cx, my, 0); fretG.add(d);
                }
            }
        }

        /* ── String glow (called each frame) ────────────────────────────── */
        function updateStringHighlights(noteState) {
            const BASE_GLOW = 0.02;
            const MAX_GLOW = 3.5;
            const IDLE_OP = 0.4;

            for (let s = 0; s < nStr; s++) {
                const mesh = stringLines[s];
                if (!mesh) continue;
                const intensity = Math.max(
                    noteState.stringSustain[s] ? 1 : 0,
                    noteState.stringAnticipation[s] || 0,
                );
                mesh.material.emissiveIntensity = BASE_GLOW + intensity * MAX_GLOW;
                mesh.material.opacity = IDLE_OP + intensity * (1 - IDLE_OP);
                mesh.scale.set(1, 1 + intensity * 0.3, 1 + intensity * 0.3);
            }
        }

        /* ── Per-frame rendering ─────────────────────────────────────────── */
        function update(bundle) {
            pNote.reset(); pSus.reset(); pSusOutline.reset(); pTechArrow.reset(); pTapChevron.reset(); pLbl.reset();
            pBeat.reset(); pSec.reset();
            if (projMeshArr) for (const m of projMeshArr) m.visible = false;
            if (projGlowArr) for (const m of projGlowArr) m.visible = false;
            pFretLbl.reset(); pLane.reset(); pLaneDivider.reset();
            pChordBox.reset(); pChordLbl.reset(); pBarreLine.reset(); pNoteFretLabel.reset(); pConnectorLine.reset(); pDropLine.reset();

            // Prune expired notedetect marks once per frame instead of
            // once per drawNote call (issue #9 perf nit). drawNote then
            // only does the bounded (s, f, t) match — no per-note
            // performance.now() / filter() needed.
            _ndFrameNowMs = performance.now();
            if (_ndHitMarks.length && _ndHitMarks[0].expiresAt <= _ndFrameNowMs) {
                _ndHitMarks = _ndHitMarks.filter(m => m.expiresAt > _ndFrameNowMs);
            }
            if (_ndMissMarks.length && _ndMissMarks[0].expiresAt <= _ndFrameNowMs) {
                _ndMissMarks = _ndMissMarks.filter(m => m.expiresAt > _ndFrameNowMs);
            }

            const now = bundle.currentTime;
            const t0 = now - BEHIND;
            const t1 = now + AHEAD;

            const notes = bundle.notes;
            const chords = bundle.chords;
            const beats = bundle.beats;
            const sections = bundle.sections;

            // ── Frame state ───────────────────────────────────────────────
            const noteState = {
                stringSustain: new Array(nStr).fill(false),
                stringAnticipation: new Array(nStr).fill(0),
                fretHeat: new Array(NFRETS + 1).fill(0),
                strGlow: new Array(nStr).fill(0.5),
            };

            // Compute sustain / anticipation / fret heat / per-string glow
            if (notes) {
                for (const n of notes) {
                    if (!validString(n.s)) continue;
                    const dt = n.t - now;
                    const susEnd = n.t + (n.sus || 0);
                    if (dt > 0 && dt < 0.6)
                        noteState.stringAnticipation[n.s] = Math.max(noteState.stringAnticipation[n.s], 1 - dt / 0.6);
                    if (n.f > 0) {
                        if (now >= n.t && now <= susEnd) noteState.fretHeat[n.f] = 1;
                        else if (n.t > now) noteState.fretHeat[n.f] = Math.max(noteState.fretHeat[n.f], Math.max(0, 1 - dt / 2));
                    }
                    if (now >= n.t && now <= susEnd) noteState.stringSustain[n.s] = true;
                    const sustained = dt < 0 && (n.sus || 0) > 0 && now <= susEnd;
                    const hitDist = Math.abs(dt);
                    if (hitDist < 0.15 || sustained) {
                        const hitFade = sustained ? 0.7 : (1 - hitDist / 0.15);
                        noteState.strGlow[n.s] = Math.max(noteState.strGlow[n.s], 1.0 + hitFade * 1.5);
                    }
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes) continue;
                    const chordNotes = filterValidNotes(ch.notes);
                    if (chordNotes.length === 0) continue;
                    let maxSus = 0;
                    for (const n of chordNotes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                    const susEnd = ch.t + maxSus;
                    const dt = ch.t - now;
                    for (const cn of chordNotes) {
                        if (dt > 0 && dt < 0.6)
                            noteState.stringAnticipation[cn.s] = Math.max(noteState.stringAnticipation[cn.s], 1 - dt / 0.6);
                        if (cn.f > 0) {
                            if (now >= ch.t && now <= susEnd) { noteState.fretHeat[cn.f] = 1; continue; }
                            if (ch.t > now) noteState.fretHeat[cn.f] = Math.max(noteState.fretHeat[cn.f], Math.max(0, 1 - dt / 2));
                        }
                    }
                    if (now >= ch.t && now <= susEnd)
                        for (const cn of chordNotes) noteState.stringSustain[cn.s] = true;
                    const sustained = dt < 0 && maxSus > 0 && now <= susEnd;
                    const hitDist = Math.abs(dt);
                    if (hitDist < 0.15 || sustained) {
                        const hitFade = sustained ? 0.7 : (1 - hitDist / 0.15);
                        for (const cn of chordNotes) {
                            noteState.strGlow[cn.s] = Math.max(noteState.strGlow[cn.s], 1.0 + hitFade * 1.5);
                        }
                    }
                }
            }

            updateStringHighlights(noteState);
            for (let s = 0; s < nStr; s++) mGlow[s].emissiveIntensity = noteState.strGlow[s];

            // ── Next-note-by-string lookahead (for anticipation projection) ──
            const nextNoteByString = new Array(nStr).fill(null);
            if (notes) {
                for (const n of notes) {
                    if (n.t <= now) continue;
                    if (!validString(n.s)) continue;
                    if (!nextNoteByString[n.s] || n.t < nextNoteByString[n.s].t) nextNoteByString[n.s] = n;
                    if (n.f > 0 && n.t > now - 0.1 && n.t < now + 2) fretLastActiveTime[n.f] = now;
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes || ch.t <= now) continue;
                    for (const cn of ch.notes) {
                        if (!validString(cn.s)) continue;
                        if (!nextNoteByString[cn.s] || ch.t < nextNoteByString[cn.s].t)
                            nextNoteByString[cn.s] = { ...cn, t: ch.t };
                        if (cn.f > 0 && ch.t > now - 0.1 && ch.t < now + 2) fretLastActiveTime[cn.f] = now;
                    }
                }
            }

            // Active frets (notes in cooldown window) + highway intensity
            const activeFrets = new Set();
            let highwayIntensity = 0;
            for (let f = 1; f <= NFRETS; f++) {
                if (now - fretLastActiveTime[f] < FRET_COOLDOWN) activeFrets.add(f);
            }

            // Camera targeting. fMin/fMax over the full visible window
            // continue to drive tgtDist (zoom-out for wide chords). tgtX
            // is driven separately by a recency-weighted centroid in
            // world units over a narrower window (issue #34) so distant
            // outliers don't yank the camera left/right.
            let fMin = 99, fMax = 0, got = false;
            const cs        = cameraSmoothing;
            const camAhead  = CAM_TGT_AHEAD_T + (CAM_TGT_AHEAD_C - CAM_TGT_AHEAD_T) * cs;
            const camTau    = CAM_TGT_TAU_T   + (CAM_TGT_TAU_C   - CAM_TGT_TAU_T)   * cs;
            const camHystF  = CAM_TGT_HYST_T  + (CAM_TGT_HYST_C  - CAM_TGT_HYST_T)  * cs;
            const camT0     = now - CAM_TGT_BEHIND;
            const camT1     = now + camAhead;
            let camWX = 0, camWSum = 0;

            // ── Single notes ──────────────────────────────────────────────
            const lastFretForString = new Array(nStr).fill(undefined);
            if (notes) {
                for (const n of notes) {
                    if (n.f > 0 && n.t > now && n.t < now + 2) activeFrets.add(n.f);
                    if (n.t > now) {
                        const dt = n.t - now;
                        if (dt < AHEAD) highwayIntensity = Math.max(highwayIntensity, 1 - dt / AHEAD);
                    }
                    if (n.t + (n.sus || 0) < t0 || n.t > t1) continue;
                    if (!validString(n.s)) continue;
                    const isNext = nextNoteByString[n.s] && Math.abs(nextNoteByString[n.s].t - n.t) < 0.001;
                    const skipLabel = lastFretForString[n.s] === n.f;
                    drawNote(n, now, undefined, isNext, skipLabel, false);
                    lastFretForString[n.s] = n.f;
                    if (n.f > 0 && n.t <= t1) { fMin = Math.min(fMin, n.f); fMax = Math.max(fMax, n.f); got = true; }
                    if (n.f > 0 && n.t >= camT0 && n.t <= camT1) {
                        const w = Math.exp(-Math.max(0, n.t - now) / camTau);
                        camWX   += fretMid(n.f) * w;
                        camWSum += w;
                    }
                }
            }

            // ── Chords ────────────────────────────────────────────────────
            if (chords) {
                let prevChordSig = null;
                let prevChordTime = -1;

                for (const ch of chords) {
                    if (!ch.notes) continue;
                    // Filter chord notes to in-range strings once. All
                    // chord-level aggregations (maxSus, repeat-chord
                    // signature, open-string centroid, frame-box bounds,
                    // active-fret highlights, fMin/fMax) read from
                    // chordNotes so a clamped 9th-string note can't, for
                    // instance, extend the chord's linger beyond its
                    // visible sustain.
                    const chordNotes = filterValidNotes(ch.notes);
                    if (chordNotes.length === 0) continue;

                    if (ch.t > now) {
                        const dt = ch.t - now;
                        if (dt < AHEAD) highwayIntensity = Math.max(highwayIntensity, 1 - dt / AHEAD);
                    }
                    if (ch.t > now && ch.t < now + 2)
                        for (const cn of chordNotes) { if (cn.f > 0) activeFrets.add(cn.f); }

                    let maxSus = 0;
                    for (const n of chordNotes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                    if (ch.t + maxSus < t0 || ch.t > t1) continue;

                    // Repeat-chord detection (consecutive same shape)
                    const currentSig = chordNotes.slice().sort((a, b) => a.s - b.s).map(n => `${n.s}:${n.f}`).join('|');
                    const isRepeat = prevChordSig === currentSig && Math.abs(ch.t - prevChordTime) < 0.5;
                    prevChordSig = currentSig;
                    prevChordTime = ch.t;

                    // Open-string center X
                    let chordCX = curX;
                    let cxL = Infinity, cxR = -Infinity, fretted = 0;
                    for (const cn of chordNotes) {
                        if (cn.f > 0) { const fx = fretMid(cn.f); if (fx < cxL) cxL = fx; if (fx > cxR) cxR = fx; fretted++; }
                    }
                    if (fretted > 0) chordCX = (cxL + cxR) / 2;

                    const chWindowed = ch.t >= camT0 && ch.t <= camT1;
                    const chW        = chWindowed ? Math.exp(-Math.max(0, ch.t - now) / camTau) : 0;
                    for (const cn of chordNotes) {
                        const isNext = nextNoteByString[cn.s] && Math.abs(nextNoteByString[cn.s].t - ch.t) < 0.001;
                        const skipLabel = lastFretForString[cn.s] === cn.f;
                        drawNote({ ...cn, t: ch.t, sus: cn.sus || 0 }, now, cn.f === 0 ? chordCX : undefined, isNext, skipLabel, isRepeat, 0.55);
                        lastFretForString[cn.s] = cn.f;
                        if (cn.f > 0 && ch.t <= t1) { fMin = Math.min(fMin, cn.f); fMax = Math.max(fMax, cn.f); got = true; }
                        if (cn.f > 0 && chWindowed) { camWX += fretMid(cn.f) * chW; camWSum += chW; }
                    }

                    // Chord frame-box
                    const chDt = ch.t - now;
                    if (chordNotes.length > 1 && chDt > -0.55 && chDt < AHEAD) {
                        const z = Math.min(0, dZ(chDt));
                        let fMinCh = 99, fMaxCh = 0;
                        for (const cn of chordNotes) { if (cn.f > 0) { fMinCh = Math.min(fMinCh, cn.f); fMaxCh = Math.max(fMaxCh, cn.f); } }
                        if (fMinCh < 99) {
                            const xLeft = fretX(fMinCh - 1);
                            const xRight = fretX(Math.max(fMaxCh, fMinCh + 2));
                            const padX = NW * 0.4;
                            const width = (xRight - xLeft) + padX * 2;
                            const cx = xLeft + width / 2 - padX;
                            const yA = sY(0), yB = sY(nStr - 1);
                            const yMinF = Math.min(yA, yB) - S_GAP * 0.8;
                            const yMaxF = Math.max(yA, yB) + S_GAP * 0.8;
                            let height = yMaxF - yMinF;
                            if (isRepeat) height *= 0.5;
                            const cY = (yMinF + yMaxF) / 2;
                            const fade = Math.max(0, 1 - chDt / AHEAD);
                            const baseOp = isRepeat ? 0.05 + fade * 0.1 : 0.12 + fade * 0.2;
                            const thick = 0.25 * K;
                            const drawEdge = (px, py, sx, sy) => {
                                const b = pChordBox.get(); b.position.set(px, py, z); b.scale.set(sx, sy, thick); b.material.opacity = baseOp;
                            };
                            drawEdge(cx - width / 2, cY, thick, height); // left
                            drawEdge(cx + width / 2, cY, thick, height); // right
                            drawEdge(cx, cY - height / 2, width, thick); // bottom
                            drawEdge(cx, cY + height / 2, width, thick); // top
                            const fill = pChordBox.get();
                            fill.position.set(cx, cY, z); fill.scale.set(width, height, thick * 0.5);
                            fill.material.opacity = isRepeat ? 0.02 : 0.04;

                            const chordName = bundle.chordTemplates?.[ch.id]?.name;
                            if (chordName) {
                                const postFade = chDt < 0 ? Math.max(0, 1 + chDt / 0.55) : 1;
                                const lblW = 28 * K, lblH = 9 * K;
                                const lbl = pChordLbl.get();
                                const mat = txtMat(chordName, '#e8d080', true);
                                if (lbl.material.map !== mat.map) { lbl.material.map = mat.map; lbl.material.needsUpdate = true; }
                                lbl.material.opacity = Math.min(1, 0.3 + fade * 0.7) * postFade;
                                lbl.position.set((cx - width / 2) + lblW / 2, yMaxF + lblH / 2, z);
                                lbl.scale.set(lblW, lblH, 1);

                                if (/barre/i.test(chordName) && chDt <= 0) {
                                    let bFret = Infinity;
                                    for (const cn of chordNotes) if (cn.f > 0) bFret = Math.min(bFret, cn.f);
                                    if (bFret < Infinity) {
                                        const bx = fretMid(bFret);
                                        const yTop = Math.max(sY(0), sY(nStr - 1));
                                        const yBot = Math.min(sY(0), sY(nStr - 1));
                                        const lineH = yTop - yBot;
                                        const postFadeB = Math.max(0, 1 + chDt / 0.55);
                                        const bl = pBarreLine.get();
                                        bl.position.set(bx, (yTop + yBot) / 2, 0.05 * K);
                                        bl.scale.set(0.5 * K, lineH, 0.5 * K);
                                        bl.material.opacity = 0.8 * postFadeB;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ── Dynamic highway lane ──────────────────────────────────────
            if (activeFrets.size > 0) {
                let minF = 99, maxF = 0;
                activeFrets.forEach(f => { if (f > 0) { minF = Math.min(minF, f); maxF = Math.max(maxF, f); } });
                let dMin = minF - 1, dMax = maxF;
                if (dMax - dMin < 4) {
                    dMax = dMax + (3 - (dMax - dMin));
                    if (dMax > NFRETS) { dMax = NFRETS; dMin = Math.max(0, dMax - 4); }
                }
                const xL = fretX(dMin), xR = fretX(dMax);
                const margin = NW * 0.5;
                const laneW = (xR - xL) + margin * 2;
                const laneLen = TS * AHEAD;
                const boardY = S_BASE - NH / 2 - 2 * K;
                const lane = pLane.get();
                lane.position.set((xL + xR) / 2, boardY + 0.02 * K, -laneLen / 2 + TS * BEHIND);
                lane.rotation.x = -Math.PI / 2;
                lane.scale.set(laneW, laneLen, 1);
                lane.material.opacity = 0.04 + highwayIntensity * 0.13;
                lane.material.color.set(0x112233).lerp(_laneTargetColor, highwayIntensity);
                lane.renderOrder = 1;

                // Lane dividers (fret wires inside active range)
                if (highwayIntensity > 0.05) {
                    const divLen = TS * (AHEAD + BEHIND) * 0.6;
                    const yPos = boardY + 0.03 * K;
                    for (let f = Math.floor(dMin); f <= Math.ceil(dMax); f++) {
                        const div = pLaneDivider.get();
                        div.position.set(fretX(f), yPos, dZ(0) - divLen * 0.5 + TS * BEHIND);
                        div.scale.set(1, 1, divLen);
                        div.material.opacity = 0.02 + highwayIntensity * 0.1;
                        div.renderOrder = 2;
                    }
                }
            }

            // ── Dynamic fret number row (heat-coloured) ───────────────────
            // Two-part fix for issue #35:
            //  1. renderOrder = 1000 forces these sprites to the end of
            //     the transparent queue so they always paint on top of
            //     notes, sustain trails, lane plane, etc. depthTest is
            //     already disabled by txtMat(), but `depthTest: false`
            //     only exempts the sprite from depth comparison — it
            //     doesn't pin draw order. Without an explicit
            //     renderOrder, a note rendered after the label in the
            //     transparent pass would still overdraw it. Match the
            //     pattern already used for lane and dividers.
            //  2. Y-offset bumped from S_GAP * 0.6 to S_GAP * 1.4 so the
            //     label band sits clearly below the lowest string in
            //     screen space, even at the largest active scale
            //     (intensity-driven, up to ~5.7 * K vertical extent).
            //     This buys a real visual gap between notes-on-the-
            //     lowest-string and the row, on top of the renderOrder
            //     guarantee — labels never share screen with what's
            //     happening on the playing strings just above them.
            {
                const yBottom = Math.min(sY(0), sY(nStr - 1));
                for (let f = 1; f <= NFRETS; f++) {
                    const lb = pFretLbl.get();
                    const isActive = activeFrets.has(f);
                    lb.material = txtMat(f, isActive ? '#ffe84d' : '#9ab8cc', false);
                    lb.position.set(fretMid(f), yBottom - S_GAP * 0.6, 0.5 * K);
                    const intensity = noteState.fretHeat[f];
                    lb.material.opacity = 0.35 + intensity * 0.65;
                    const scale = 3.5 + intensity * 2.2;
                    lb.scale.set(scale * K, scale * K, 1);
                    lb.renderOrder = 1000;
                }
            }

            // ── Beat lines ────────────────────────────────────────────────
            if (beats) {
                const bw2 = fretX(NFRETS) + 4 * K;
                let lastM = -1;
                for (const b of beats) {
                    const meas = b.measure !== lastM; lastM = b.measure;
                    if (b.time < t0 || b.time > t1) continue;
                    const bl2 = pBeat.get();
                    bl2.material = meas ? mBeatM : mBeatQ;
                    bl2.scale.set(bw2, 1, 1);
                    bl2.position.set(-2 * K, S_BASE - NH / 2 - 1.5 * K, dZ(b.time - now));
                }
            }

            // ── Section labels ────────────────────────────────────────────
            if (sections) {
                const labelY = Math.max(sY(0), sY(nStr - 1)) + 8 * K;
                for (const s of sections) {
                    if (s.time < t0 || s.time > t1) continue;
                    const sp = pSec.get();
                    sp.material = txtMat(s.name, '#00cccc', true);
                    sp.scale.set(20 * K, 5 * K, 1);
                    sp.position.set(fretX(12), labelY, dZ(s.time - now));
                }
            }

            // ── Camera target ─────────────────────────────────────────────
            // tgtDist still tracks the visible-window fret span so wide
            // chords pull the camera back; tgtX uses the narrowed,
            // recency-weighted centroid with a hysteresis dead zone so
            // small intra-cluster shifts don't produce visible motion.
            if (got) {
                tgtDist = (65 + Math.max(fMax - fMin, 4) * 3) * K;
            }
            if (camWSum > 0) {
                const candidateX = camWX / camWSum;
                const hystWorld  = camHystF * FRET_WIDTH_MID;
                if (Math.abs(candidateX - tgtX) > hystWorld) tgtX = candidateX;
            }

            // ── Chord diagram: track most recently hit chord in linger window ─
            _diagChord = null;
            if (chords) {
                let bestT = -Infinity;
                for (const ch of chords) {
                    if (!ch.notes) continue;
                    const chDt = ch.t - now;
                    if (chDt <= 0 && chDt > -0.55) {
                        const tmpl = bundle.chordTemplates?.[ch.id];
                        if (tmpl?.name && tmpl?.frets && ch.t > bestT) {
                            bestT = ch.t;
                            _diagChord = { name: tmpl.name, frets: tmpl.frets, chDt };
                        }
                    }
                }
            }
        }

        /* ── Note renderer ───────────────────────────────────────────────── */
        // skipLabel: don't draw per-note connector label (repeated fret)
        // skipBody:  don't draw the 3D note mesh (repeat chord — still shows projection)
        function drawNote(n, now, openX, isNext, skipLabel, skipBody, linger = 0.05) {
            const s = n.s;
            // Belt + suspenders: callers already gate via validString(),
            // but drawNote is also entered through { ...cn } chord-note
            // spreads, so re-check here before indexing material arrays.
            if (!validString(s)) return;
            const dt = n.t - now;
            const y = sY(s);
            const susEnd = n.t + (n.sus || 0);
            const hasSus = n.sus > 0;
            if (dt < -linger && (!hasSus || now > susEnd)) return;

            const sustained = dt < 0 && hasSus && now <= susEnd;
            const hitDist = Math.abs(dt);
            const hit = hitDist < 0.15 || sustained;
            const hitFade = sustained ? 0.7 : (hitDist < 0.15 ? 1 - hitDist / 0.15 : 0);
            const vibrato = sustained ? Math.sin(now * 30) * 0.3 * K : 0;
            const noteZ = sustained ? 0 : Math.min(0, dZ(dt));
            const x = n.f === 0 ? (openX !== undefined ? openX : curX) : fretMid(n.f);
            const isHarm = n.hm || n.hp;

            if (!skipBody) {
                // Rotate from vertical (π/2) when entering to horizontal (0) at the hit line; skip for open strings
                const approachRot = n.f > 0 ? Math.max(0, Math.min(1, dt / AHEAD)) * Math.PI / 2 : 0;

                // ── Outline (slightly larger, bright emissive) ────────────
                // Notedetect feedback (#9): if a recent hit/miss event
                // matches this note's (s, f, t), swap the outline tint.
                // Linear scan over a small bounded array — typical
                // queues are 0-5 entries, expired marks pruned by the
                // listener. Hit takes precedence over miss so the user
                // sees the more positive feedback if both happen
                // (shouldn't, but cheap guard).
                let _ndOutline = mWhiteOutline;
                // update() prunes expired marks once per frame and
                // caches performance.now() in _ndFrameNowMs so the hot
                // path here just does the bounded match — no extra
                // now() / filter() per note. After update()'s prune,
                // every entry in the arrays has expiresAt > _ndFrameNowMs,
                // so we don't re-validate inside the loop.
                if (_ndHitMarks.length || _ndMissMarks.length) {
                    for (let i = 0; i < _ndHitMarks.length; i++) {
                        const m = _ndHitMarks[i];
                        if (m.s === n.s && m.f === n.f && Math.abs(m.noteTime - n.t) < _ND_TIME_EPS) {
                            _ndOutline = mHitOutline; break;
                        }
                    }
                    if (_ndOutline === mWhiteOutline) {
                        for (let i = 0; i < _ndMissMarks.length; i++) {
                            const m = _ndMissMarks[i];
                            if (m.s === n.s && m.f === n.f && Math.abs(m.noteTime - n.t) < _ND_TIME_EPS) {
                                _ndOutline = mMissOutline; break;
                            }
                        }
                    }
                }
                const outline = pNote.get();
                outline.material = _ndOutline;
                outline.position.set(x, y + vibrato, noteZ);
                outline.rotation.z = approachRot + (isHarm ? Math.PI / 4 : 0);
                if (n.f === 0) {
                    outline.scale.set((35 * K / NW) * 1.1, 0.1 * 1.1, 0.6 * 1.1);
                } else {
                    outline.scale.set(1.1, 1.1, 2.8);
                }

                // ── Core (filled note body) ───────────────────────────────
                const core = pNote.get();
                core.material = hit ? mGlow[s] : mStr[s];
                core.position.set(x, y + vibrato, noteZ + 0.001);
                core.rotation.z = approachRot + (isHarm ? Math.PI / 4 : 0);
                if (n.f === 0) {
                    core.scale.set(40 * K / NW, 0.1, 0.6);
                } else {
                    core.scale.set(1, 1, 2.5);
                }
                if (n.f === 0) {
                    // "0" label on open string
                    const lb = pLbl.get();
                    lb.material = txtMat(0, hit ? '#fff' : '#ddd', false);
                    lb.scale.set(NW * 0.7, NH * 0.8, 1);
                    lb.position.set(x, y + vibrato, noteZ + 0.01 * K);
                } else if (showFretOnNote && n.f > 0) {
                    // Embedded fret number on the note body (issue #12).
                    // The `n.f > 0` guard is redundant in the normal
                    // path (we're already in the else of `n.f === 0`)
                    // but matches the rest of the renderer's "fretted
                    // means n.f > 0" convention (e.g. approachRot,
                    // connector label) and side-steps any bogus
                    // negative / NaN fret values from a malformed
                    // chart. Sprite is camera-facing so it stays
                    // readable through the note's approach-rotation.
                    // Core sits at noteZ + 0.001 (raw world units, not
                    // K-scaled), so place the label at noteZ + 0.005
                    // — definitively in front of the core regardless
                    // of how K resolves, units consistent with the
                    // core's offset.
                    const lb = pLbl.get();
                    lb.material = txtMat(n.f, hit ? '#fff' : '#eee', false);
                    lb.scale.set(NW * 0.7, NH * 0.85, 1);
                    lb.position.set(x, y + vibrato, noteZ + 0.005);
                }

                // ── Sustain trail ─────────────────────────────────────────
                if (hasSus) {
                    const susStart = Math.max(n.t, now);
                    const remSus = susEnd - susStart;
                    if (remSus > 0.01) {
                        const len = Math.min(remSus, AHEAD) * TS;
                        const zPos = dZ(susStart - now) - len / 2;
                        const tw = NW * 0.85, th = NH * 0.12;
                        const trOut = pSusOutline.get();
                        trOut.position.set(x, y, zPos);
                        trOut.scale.set(tw + 0.4 * K, th + 0.4 * K, len);
                        const tr = pSus.get();
                        tr.material = mSus[s];
                        tr.position.set(x, y, zPos);
                        tr.scale.set(tw, th, len);
                    }
                }

                // ── Lane drop line (anchors note to its lane) ─────────────
                if (dt > 0) {
                    const boardY = S_BASE - NH / 2 - 2 * K;
                    const lineTop = y - NH / 2 - NH * 0.4;
                    const lineBot = boardY + NH * 0.5;
                    const lineLen = lineTop - lineBot;
                    if (lineLen > 0.001) {
                        const dl = pDropLine.get();
                        dl.material.color.set(activePalette[s]);
                        dl.position.set(x, lineBot, noteZ);
                        dl.scale.set(1, lineLen, 1);
                    }
                }

                // ── Technique labels ──────────────────────────────────────
                // Label scale = base × LBL_MULT × distFactor.
                // distFactor compensates for perspective shrink so a
                // label far from the camera (note approaching at dt≈AHEAD)
                // doesn't collapse to a single dim pixel. LBL_MULT bumps
                // every base scale uniformly. Issues #21-25 track proper
                // visual upgrades (3D arrows, ribbons, glows); this is
                // the cheap legibility win in the meantime.
                //
                // Offsets scale with sLbl too. The labels grow in world
                // units to compensate for perspective; if the offsets
                // didn't grow, stacked labels would overlap each other
                // and the first label would overlap the note at the
                // AHEAD edge. In screen space the offset stays roughly
                // constant — labels appear anchored to the note even
                // though the world-space distance grows.
                const LBL_MULT = 1.6;
                const distFactor = 1 + Math.max(0, Math.min(1, dt / AHEAD)) * 1.5;
                const sLbl = LBL_MULT * distFactor;
                let yo = y + NH * 0.8 * sLbl;
                if (n.bn > 0) {
                    const l = pLbl.get();
                    l.material = txtMat('↑' + bendText(n.bn), '#fff', true);
                    l.scale.set(NH * 3.6 * sLbl, NH * 1.5 * sLbl, 1); l.position.set(x, yo, noteZ); yo += NH * 1.2 * sLbl;
                }
                if (n.sl && n.sl !== -1) {
                    const l = pLbl.get();
                    l.material = txtMat(n.sl > n.f ? '↗' : '↘', '#fff', false);
                    l.scale.set(NH * 1.6 * sLbl, NH * 1.6 * sLbl, 1); l.position.set(x + NW * 0.6 * sLbl, yo, noteZ);
                }
                if (n.ho || n.po || n.tp) {
                    if (n.ho || n.po) {
                        const arrow = pTechArrow.get();
                        const arrowScale = NH * 0.75 * sLbl;
                        arrow.position.set(x, y + vibrato, noteZ + 1.1 * K);
                        arrow.rotation.z = (isHarm ? Math.PI / 4 : 0);
                        arrow.scale.set(arrowScale, n.ho ? -arrowScale : arrowScale, 1);
                        arrow.renderOrder = 2;
                    } else {
                        const chevron = pTapChevron.get();
                        const chevronScale = NH * 0.8 * sLbl; // Slightly increased for readability
                        chevron.position.set(x, y + vibrato, noteZ + 1.1 * K);
                        chevron.rotation.z = (isHarm ? Math.PI / 4 : 0);
                        chevron.scale.set(chevronScale, chevronScale, 1);
                        chevron.renderOrder = 2;
                    }
                }
                if (n.ac) {
                    const l = pLbl.get();
                    l.material = txtMat('>', '#fff', false);
                    l.scale.set(NH * 1.6 * sLbl, NH * 1.6 * sLbl, 1); l.position.set(x, yo, noteZ); yo += NH * 1.2 * sLbl;
                }
                if (n.tr) {
                    const l = pLbl.get();
                    l.material = txtMat('~~~', '#ff0', true);
                    l.scale.set(NH * 3.0 * sLbl, NH * 1.2 * sLbl, 1); l.position.set(x, yo, noteZ);
                }
                if (n.pm) {
                    // Palm mute: "X" overlay on the note body — bumped
                    // by LBL_MULT but not by distFactor since it's
                    // anchored to the body not floating above.
                    const pmMark = pLbl.get();
                    if (!pmMark._pmMat) {
                        pmMark._pmMat = txtMat('X', '#ffffff', false).clone();
                        _ownedClonedMats.push(pmMark._pmMat);
                    }
                    pmMark.material = pmMark._pmMat;
                    pmMark.position.set(x, y + vibrato, noteZ + 0.1 * K);
                    const pmScale = NH * 1.35 * LBL_MULT;
                    pmMark.scale.set(pmScale, pmScale, 1);
                    pmMark.material.opacity = hit ? 1.0 : 0.8;
                }
                if (n.hp) {
                    const l = pLbl.get();
                    l.material = txtMat('PH', '#ff0', true);
                    l.scale.set(NH * 2.1 * sLbl, NH * 1.2 * sLbl, 1); l.position.set(x, y - NH * 1.1 * sLbl, noteZ);
                }

                // ── Per-note fret connector label ─────────────────────────
                if (n.f > 0 && !skipLabel) {
                    const minStringY = Math.min(sY(0), sY(nStr - 1));
                    const labelY = minStringY - S_GAP * 0.8;
                    // fade out in the last 0.5 s so it doesn't overlap the fret-row label at Z=0
                    const alpha = Math.max(0, Math.min(1, dt / 0.5)) * Math.min(1, (AHEAD - dt) / (AHEAD * 0.4));

                    const fretLabel = pNoteFretLabel.get();
                    const cachedMat = txtMat(n.f, '#ffffff', false);
                    if (fretLabel.material.map !== cachedMat.map) {
                        fretLabel.material.map = cachedMat.map;
                        fretLabel.material.needsUpdate = true;
                    }
                    fretLabel.position.set(x, labelY, noteZ);
                    fretLabel.scale.set(NH * 2.2, NH * 2.2, 1);
                    fretLabel.material.opacity = alpha;

                    const line = pConnectorLine.get();
                    line.position.set(x, labelY, noteZ);
                    line.scale.set(1, y - labelY, 1);
                    line.material.opacity = alpha * 0.8;
                }
            }

            // ── Board projection (ghost at Z=0, always drawn for isNext) ─
            const PROJ_WIN = 0.6;
            const projFactor = Math.max(0, Math.min(1, 1 - dt / PROJ_WIN));
            const isBlocked = dt < 0.15 && n.sus > 0;
            if (n.f > 0 && isNext && dt > 0 && dt < PROJ_WIN && projFactor > 0.05 && !isBlocked) {
                const proj = projMeshArr[s];
                proj.material.opacity = (skipBody ? 0.1 : 0.15) + projFactor * 0.6;
                proj.position.set(x, y, 0.02);
                proj.scale.set(1, 1, 1);
                proj.rotation.z = isHarm ? Math.PI / 4 : 0;
                proj.visible = true;

                const glow = projGlowArr[s];
                glow.material.opacity = (0.05 + projFactor * 0.25) * (0.9 + Math.sin(now * 10) * 0.1);
                glow.position.set(x, y, 0.019);
                glow.scale.set(projFactor * 1.1, projFactor * 1.1, 1);
                glow.rotation.z = isHarm ? Math.PI / 4 : 0;
                glow.visible = true;
            }
        }

        /* ── Camera smooth lerp ──────────────────────────────────────────── */
        function camUpdate(bundle) {
            const bpm = computeBPM(bundle.beats, bundle.currentTime);
            const lerp = CAM_LERP_BASE * Math.max(bpm, 60) / 120;
            curX += (tgtX - curX) * lerp;
            curDist += (tgtDist - curDist) * lerp;
            const dist = curDist * aspectScale;
            const h = CAM_H_BASE * (dist / CAM_DIST_BASE);
            cam.position.set(curX + 20 * K, h * 0.95, dist * 0.75);

            // Self-correcting look-at Y: project the fretboard's near-edge centre
            // to NDC space. If it drifts toward the frame edge, nudge tgtLookY
            // toward the fretboard centre so the camera tilts to re-frame it.
            // This lets the camera adapt to any panel aspect ratio automatically.
            const fretMidY = (sY(0) + sY(nStr - 1)) / 2;
            _probe.set(curX, fretMidY, 0);                  // play-line fretboard centre
            cam.lookAt(curX, curLookY, -FOCUS_D * 0.35);    // tentative look — needed for project()
            cam.updateMatrixWorld();
            _probe.project(cam);                             // _probe.y → NDC in [-1, 1]

            // Keep fretboard centre in the lower third of the screen (NDC ≈ -0.35).
            const DESIRED_NDC_Y = -0.35;
            if (_probe.y < DESIRED_NDC_Y - 0.15 || _probe.y > DESIRED_NDC_Y + 0.15) {
                // _probe.y too low → fretboard near bottom → tgtLookY decreases → camera tilts down → fretboard rises
                // _probe.y too high → fretboard near top  → tgtLookY increases → camera tilts up   → fretboard drops
                const correction = (DESIRED_NDC_Y - _probe.y) * fretMidY * 0.5;
                tgtLookY = Math.max(-fretMidY, Math.min(fretMidY, tgtLookY - correction));
            }
            curLookY += (tgtLookY - curLookY) * lerp;

            // Final look-at with the corrected Y (overrides the tentative one above)
            cam.lookAt(curX, curLookY, -FOCUS_D * 0.35);
        }

        /* ── Resize helper ───────────────────────────────────────────────── */
        function applySize(w, h) {
            if (!ren || !cam || !wrap) return;
            if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
            const baseDPR = _ssActive() ? Math.min(devicePixelRatio, 1.25) : Math.min(devicePixelRatio, 2);
            ren.setPixelRatio(_renderScale * baseDPR);
            ren.setSize(w, h);
            wrap.style.height = h + 'px';
            if (lyricsCanvas) { lyricsCanvas.width = w; lyricsCanvas.height = h; }
            cam.aspect = w / h;
            cam.updateProjectionMatrix();
            aspectScale = Math.max(1, REF_ASPECT / Math.max(cam.aspect, 0.5));
        }

        /* ── Teardown ────────────────────────────────────────────────────── */
        function teardown() {
            // Background animations (#13). Drop the listener first so any
            // mid-teardown settings change doesn't try to rebuild a torn-
            // down scene; then dispose the active style's resources.
            if (_bgListener) { _bgUnsubscribe(_bgListener); _bgListener = null; }
            // Notedetect listeners (issue #9). Remove on destroy so a
            // panel that stops doesn't keep accumulating marks. Marks
            // arrays are cleared too — they hold stale chart positions
            // that next init() may reuse (drawNote keys on (s, f, t)).
            if (_ndOnHit) { window.removeEventListener('notedetect:hit', _ndOnHit); _ndOnHit = null; }
            if (_ndOnMiss) { window.removeEventListener('notedetect:miss', _ndOnMiss); _ndOnMiss = null; }
            _ndHitMarks = [];
            _ndMissMarks = [];
            _bgUnmountStyle();
            bgGroup = null; _bgLastT = 0;

            if (wrap) { wrap.remove(); wrap = null; }
            if (scene) {
                // Don't dispose material.map textures here. Texture
                // lifetime belongs to whoever allocated it; the bg
                // styles' per-layer CanvasTextures (e.g. silhouettes'
                // wrappers around the shared _silCanvas) are released
                // in their own teardowns. txtCache textures are
                // explicitly disposed below; mStr/mGlow/etc. don't have
                // a .map. Disposing here would either double-free or
                // yank a still-in-use texture out from under another
                // mount.
                scene.traverse((obj) => {
                    obj.geometry?.dispose?.();
                    if (obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        for (const m of mats) m?.dispose?.();
                    }
                });
            }
            gNote?.dispose?.(); gSus?.dispose?.(); gBeat?.dispose?.(); gTechArrow?.dispose?.(); gTapChevron?.dispose?.();
            for (const m of mStr) m?.dispose?.();
            for (const m of mGlow) m?.dispose?.();
            for (const m of mSus) m?.dispose?.();
            for (const m of mProj) m?.dispose?.();
            for (const m of mProjGlow) m?.dispose?.();
            mBeatM?.dispose?.(); mBeatQ?.dispose?.();
            // Notedetect outline materials (#9). May not be reachable
            // via scene.traverse if no event ever fired (never attached
            // to a mesh), so dispose explicitly.
            mHitOutline?.dispose?.(); mMissOutline?.dispose?.();
            for (const k in txtCache) { txtCache[k].map?.dispose(); txtCache[k].dispose(); }
            // Dispose per-sprite cloned materials (e.g. pmMark._pmMat).
            // These aren't reachable via scene.traverse once the sprite
            // gets reassigned a different material, so the array tracks
            // them at allocation time.
            for (const m of _ownedClonedMats) m?.dispose?.();
            _ownedClonedMats.length = 0;
            txtCache = {};
            if (ren) { ren.dispose(); ren = null; }
            scene = cam = noteG = beatG = lblG = fretG = null;
            ambLight = dirLight = null;
            mStr = []; mGlow = []; mSus = []; mProj = []; mProjGlow = []; mWhiteOutline = mSusOutline = null; mHitOutline = mMissOutline = null; stringLines = [];
            lyricsCanvas = lyricsCtx = null;
            projMeshArr = projGlowArr = null;
            _probe = null;
            _laneTargetColor = null;
            _renderScale = 1;
            mBeatM = mBeatQ = null;
            pNote = pSus = pSusOutline = pLbl = pBeat = pSec = null;
            pFretLbl = pLane = pLaneDivider = pChordBox = pChordLbl = pBarreLine = pNoteFretLabel = pConnectorLine = pDropLine = pTechArrow = pTapChevron = null;
            gNote = gSus = gBeat = gTechArrow = gTapChevron = null;
            tgtX = curX = 0; tgtDist = curDist = CAM_DIST_BASE; tgtLookY = curLookY = 0; nStr = NSTR; _oobStringWarned = false;
        }

        function canvasSize(canvas) {
            if (canvas) {
                // If the canvas has zero bounds (hidden via any mechanism — inline style,
                // CSS class, or hidden ancestor) fall back to the parent container
                // (the splitscreen panelDiv) which is always visible and correctly sized.
                const rect = canvas.getBoundingClientRect();
                const target = (rect.width === 0 || rect.height === 0) && canvas.parentNode ? canvas.parentNode : canvas;
                const sz = target === canvas ? rect : target.getBoundingClientRect();
                if (sz.width > 0 && sz.height > 0) return { w: sz.width, h: sz.height };
            }
            const ch = document.getElementById('player-controls')?.offsetHeight || 50;
            return { w: innerWidth, h: innerHeight - ch };
        }

        /* ── setRenderer contract ────────────────────────────────────────── */
        return {
            init(canvas, bundle) {
                _unsubscribeFocus();
                if (wrap || ren) {
                    teardown();
                }
                _destroyed = _isReady = false;
                _isFocused = true;
                const myToken = ++_initToken;
                highwayCanvas = canvas;
                _invertedCached = !!(bundle && bundle.inverted);
                _renderScale = (bundle && bundle.renderScale) || 1;

                if (_ssActive()) {
                    window.slopsmithSplitscreen.onFocusChange(_onFocusChange);
                    _focusSubscribed = true;
                }

                loadThree().then(() => {
                    if (_destroyed || _initToken !== myToken) return;
                    try {
                        nStr = resolveStringCount(bundle);
                        _invertedForBoard = _invertedCached;
                        if (!initScene()) { _unsubscribeFocus(); return; }
                        const sz = canvasSize(highwayCanvas);
                        // Mark ready before RAF so any resize(w,h) calls that arrive
                        // in the meantime (e.g. from sizeCanvases()) are applied directly.
                        _isReady = true;
                        _updateFocusState();
                        if (sz.w > 0 && sz.h > 0) {
                            applySize(sz.w, sz.h);
                        } else {
                            // Panel container not yet laid out (sizeCanvases() runs after
                            // initPanel() in the setup sequence). Retry each frame until
                            // the panelDiv has real dimensions.
                            (function retrySize() {
                                if (_destroyed || !_isReady) return;
                                const s = canvasSize(highwayCanvas);
                                if (s.w > 0 && s.h > 0) applySize(s.w, s.h);
                                else requestAnimationFrame(retrySize);
                            })();
                        }
                    } catch (e) {
                        console.error('[3D-Hwy] init .then() threw:', e);
                        _isReady = false;
                        _unsubscribeFocus(); teardown();
                    }
                }).catch(e => {
                    if (_initToken !== myToken || _destroyed) return;
                    console.error('[3D-Hwy] Three.js unavailable:', e);
                    _unsubscribeFocus();
                });
            },

            draw(bundle) {
                if (!_isReady) return;
                _invertedCached = !!bundle.inverted;
                const newNStr = resolveStringCount(bundle);
                const newScale = bundle.renderScale || 1;
                if (_invertedCached !== _invertedForBoard || newNStr !== nStr) {
                    if (newNStr !== nStr) _oobStringWarned = false;
                    nStr = newNStr;
                    buildBoard();
                    _invertedForBoard = _invertedCached;
                }
                if (newScale !== _renderScale) {
                    _renderScale = newScale;
                    const s = canvasSize(highwayCanvas);
                    if (s.w > 0 && s.h > 0) applySize(s.w, s.h);
                }
                // Auto-resize lyricsCanvas when the highway canvas changes size.
                // In splitscreen the hw.resize override resizes the canvas element
                // but does not call renderer.resize(), so we detect the change here.
                if (highwayCanvas && (highwayCanvas.width !== _lastHwW || highwayCanvas.height !== _lastHwH)) {
                    _lastHwW = highwayCanvas.width;
                    _lastHwH = highwayCanvas.height;
                    const s = canvasSize(highwayCanvas);
                    if (s.w > 0 && s.h > 0) applySize(s.w, s.h);
                }
                update(bundle);
                camUpdate(bundle);

                // Background animations (#13). Compute frame dt once,
                // read audio bands when reactivity is on, delegate to
                // the active style's update().
                if (bgGroup && bgStyleId !== 'off') {
                    const nowMs = performance.now();
                    const dt = _bgLastT === 0 ? 1 / 60 : Math.min(0.1, (nowMs - _bgLastT) / 1000);
                    _bgLastT = nowMs;
                    const bands = bgReactive ? _bgReadBands() : BG_ZERO_BANDS;
                    const style = BG_STYLES[bgStyleId];
                    if (style && bgState) {
                        try { style.update(bgState, bands, dt, nowMs / 1000); }
                        catch (e) { console.error('[3D-Hwy] bg update threw', bgStyleId, e); }
                    }
                }

                ren.render(scene, cam);
                if (lyricsCtx && lyricsCanvas) {
                    lyricsCtx.clearRect(0, 0, lyricsCanvas.width, lyricsCanvas.height);
                    if (bundle.lyricsVisible && bundle.lyrics?.length) {
                        drawLyrics(bundle.lyrics, bundle.currentTime, lyricsCtx, lyricsCanvas.width, lyricsCanvas.height);
                    }
                    if (_diagChord) {
                        drawChordDiagram(lyricsCtx, _diagChord, _invertedCached);
                    }
                }
            },

            resize(w, h) {
                if (!_isReady) return;
                const s = canvasSize(highwayCanvas);
                applySize(s.w > 0 ? s.w : w, s.h > 0 ? s.h : h);
            },

            destroy() {
                _destroyed = true; _isReady = false; _diagChord = null;
                _lastHwW = 0; _lastHwH = 0;
                _unsubscribeFocus(); teardown();
                highwayCanvas = null;
            },
        };
    }

    window.slopsmithViz_highway_3d = createFactory;

})();
