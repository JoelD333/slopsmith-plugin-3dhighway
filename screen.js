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

    // Vibrant Rocksmith+ palette
    const S_COL = [
        0xfc2d5d, // String 1 — neon red/pink
        0xffe100, // String 2 — bright lemon yellow
        0x00ccff, // String 3 — electric cyan
        0xff9d00, // String 4 — vivid orange
        0x10e62c, // String 5 — bright lime
        0xbc00ff, // String 6 — intense violet
    ];

    const SCALE = 2.25;
    const K     = SCALE / 300;

    const NFRETS = 24;
    const NSTR   = 6;

    const STR_THICK = 0.25 * K;

    const S_BASE = 3 * K;
    const S_GAP  = 4 * K;

    const AHEAD  = 3.0;
    const BEHIND = 0.5;
    const TS     = 200 * K;

    // Shorter, flatter notes (joel style)
    const NW = 5 * K, NH = 3 * K, ND = 0.5 * K;
    const N_RAD = 1.5 * K;
    const SW = 2 * K, SH = 1.5 * K;

    const CAM_H_BASE    = 150 * K;
    const CAM_DIST_BASE = 240 * K;
    const REF_ASPECT    = 16 / 9;
    const FOCUS_D       = 600 * K;
    const CAM_LERP_BASE = 0.02;

    const FOG_START = 200 * K;
    const FOG_END   = 670 * K;

    const DOTS  = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
    const DDOTS = new Set([12, 24]);

    const FRET_COOLDOWN = 0.5; // seconds a lane fret stays active after last note

    /* ======================================================================
     *  Pure helpers
     * ====================================================================== */

    function bendText(bn) {
        if (bn === 0.5) return '½';
        if (bn === 1)   return 'full';
        if (bn === 1.5) return '1½';
        if (bn >= 2)    return String(Math.round(bn));
        return bn.toFixed(1);
    }

    const fretX   = f => (f <= 0 ? 0 : SCALE - SCALE / Math.pow(2, f / 12));
    const fretMid = f => (f <= 0 ? -2 * K : (fretX(f - 1) + fretX(f)) / 2);
    const dZ      = dt => -dt * TS;

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
        const end   = Math.min(beats.length - 1, closest + 2);
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
            && typeof ss.onFocusChange   === 'function'
            && typeof ss.offFocusChange  === 'function';
    }

    function _ssIsCanvasFocused(highwayCanvas) {
        const ss = window.slopsmithSplitscreen;
        if (!_ssActive()) return true;
        return !!(ss && typeof ss.isCanvasFocused === 'function' &&
                  ss.isCanvasFocused(highwayCanvas));
    }

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
        let gNote = null, gSus = null, gBeat = null;
        let mStr = [], mGlow = [], mSus = [], mProj = [], mProjGlow = [];
        let mWhiteOutline = null, mSusOutline = null;
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

        // Object pools
        let pNote, pSus, pLbl, pBeat, pSec;
        let pFretLbl, pLane, pLaneDivider;
        let pChordBox, pChordLbl, pBarreLine;
        let pNoteFretLabel, pConnectorLine, pDropLine;

        // Dynamic glowing string meshes (BoxGeometry, one per string)
        let stringLines = [];
        // Per-fret last-active timestamp for lane persistence
        let fretLastActiveTime = new Array(NFRETS + 1).fill(0);

        // Active string count — 4 for bass, 6 for everything else
        let nStr = NSTR;

        // Camera state
        let tgtX = 0, curX = 0;
        let tgtDist = CAM_DIST_BASE, curDist = CAM_DIST_BASE;
        let tgtLookY = 0, curLookY = 0;   // lerped look-at Y for self-correcting camera
        let aspectScale = 1;

        // Lifecycle flags
        let _isReady       = false;
        let _destroyed     = false;
        let _invertedCached    = false;
        let _invertedForBoard  = false;
        let _initToken     = 0;
        let highwayCanvas      = null;

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
            if (dirLight) dirLight.intensity = focused ? 0.8  : 0.35;
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
            const boxW  = gridW + PAD * 2;
            const boxH  = HEADER + MARKER + gridH + PAD;
            const bx = PAD, by = PAD;
            const gx = bx + PAD, gy = by + HEADER + MARKER;
            const opacity = Math.max(0, 1 + chDt / 0.55);

            const playedFrets = frets.filter(f => f > 0);
            const minFret   = playedFrets.length > 0 ? Math.min(...playedFrets) : 1;
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
            const nextLine    = allLines[currentIdx + 1] || null;
            const gapToNext   = nextLine ? (nextLine.start - currentLine.end) : Infinity;
            if (currentTime > currentLine.end + 0.5 && gapToNext > 3.0) return;

            const linesToShow = [currentLine];
            if (nextLine && gapToNext <= 3.0) linesToShow.push(nextLine);

            const fontSize    = Math.max(18, H * 0.028) | 0;
            const lineY       = H * 0.04;
            const sylText     = s => { const t = s.w || ''; return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t; };

            ctx.font = `bold ${fontSize}px sans-serif`;
            const spaceWidth = ctx.measureText(' ').width;
            const maxWidth   = W * 0.8;

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

            const rowHeight   = fontSize + 6;
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
                        const isPast   = currentTime >= l.t + l.d;
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
            wrap.id        = 'h3d-wrap-' + _instanceId;
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
            lblG  = new T.Group(); scene.add(lblG);

            // Rectangular note geometry
            gNote = new T.BoxGeometry(NW, NH, ND);

            gSus  = new T.BoxGeometry(1, 1, 1);
            gBeat = new T.BufferGeometry().setFromPoints(
                [new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0)],
            );

            // String materials: emissive so they glow when lit
            mStr  = S_COL.map(c => new T.MeshStandardMaterial({
                color: c, emissive: c, emissiveIntensity: 0.002,
                transparent: true, opacity: 0.4, roughness: 1,
            }));
            mGlow = S_COL.map(c => new T.MeshLambertMaterial({
                color: 0xffffff, emissive: c, emissiveIntensity: 1.5,
            }));
            mProj = S_COL.map(c => new T.MeshStandardMaterial({
                color: c, emissive: c, emissiveIntensity: 0.002,
                transparent: true, opacity: 0.15, roughness: 1,
            }));
            mProjGlow = S_COL.map(c => new T.MeshLambertMaterial({
                color: 0xffffff, emissive: c, emissiveIntensity: 1.5,
                transparent: true, opacity: 0.1,
            }));
            _laneTargetColor = new T.Color(0x4488ff);
            mSus = S_COL.map(c => new T.MeshLambertMaterial({
                color: c, transparent: true, opacity: 0.35,
            }));
            mWhiteOutline = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 });
            mSusOutline   = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3, transparent: true, opacity: 0.75, depthWrite: false });
            mBeatM = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25 });
            mBeatQ = new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07 });

            // ── Projection meshes — one per string, own material clone each ──
            projMeshArr = S_COL.map((_, s) => {
                const m = new T.Mesh(gNote, mProj[s].clone());
                m.visible = false;
                noteG.add(m);
                return m;
            });
            projGlowArr = S_COL.map((_, s) => {
                const m = new T.Mesh(gNote, mProjGlow[s].clone());
                m.visible = false;
                m.renderOrder = -1;
                noteG.add(m);
                return m;
            });

            // ── Pools ──────────────────────────────────────────────────────
            pNote       = pool(noteG, () => new T.Mesh(gNote, mStr[0]));
            pSus        = pool(noteG, () => new T.Mesh(gSus, mSus[0]));
            pSusOutline = pool(noteG, () => new T.Mesh(gSus, mSusOutline));
            pLbl  = pool(lblG,  () => new T.Sprite(txtMat('0', '#fff', false)));
            pBeat = pool(beatG, () => new T.Line(gBeat, mBeatQ));
            pSec  = pool(lblG,  () => new T.Sprite(txtMat('', '#0dd', true)));

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

            pChordLbl   = pool(lblG,  () => new T.Sprite(txtMat('', '#e8d080', true).clone()));
            pBarreLine  = pool(noteG, () => new T.Mesh(
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
            return true;
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
            const p  = new T.Mesh(pg, pm);
            p.rotation.x = -Math.PI / 2;
            p.position.set(bw / 2 - 2 * K, S_BASE - NH / 2 - 2 * K, -bl / 2 + TS * BEHIND);
            fretG.add(p);

            // Thin Line strings (glow layer)
            for (let s = 0; s < nStr; s++) {
                const pts = [new T.Vector3(-2 * K, sY(s), 0), new T.Vector3(fretX(NFRETS) + 2 * K, sY(s), 0)];
                const g   = new T.BufferGeometry().setFromPoints(pts);
                fretG.add(new T.Line(g, new T.LineBasicMaterial({ color: S_COL[s], transparent: true, opacity: 0.15 })));
            }

            // BoxGeometry strings — emissive glow driven by updateStringHighlights()
            const strLen = fretX(NFRETS) + 4 * K;
            for (let s = 0; s < nStr; s++) {
                const g = new T.BoxGeometry(strLen, STR_THICK, STR_THICK);
                // Each string gets its own material instance so emissiveIntensity is per-string
                const mat = new T.MeshStandardMaterial({
                    color: S_COL[s], emissive: S_COL[s],
                    emissiveIntensity: 0.002,
                    transparent: true, opacity: 0.4, roughness: 1,
                });
                const mesh = new T.Mesh(g, mat);
                mesh.position.set(strLen / 2 - 2 * K, sY(s), 0);
                fretG.add(mesh);
                stringLines.push(mesh);
            }

            // Fret wires
            const yTop    = Math.max(sY(0), sY(nStr - 1));
            const yBottom = Math.min(sY(0), sY(nStr - 1));
            for (let f = 0; f <= NFRETS; f++) {
                const x      = fretX(f);
                const isMain = DOTS.includes(f);
                const g = new T.BufferGeometry().setFromPoints([
                    new T.Vector3(x, yBottom - S_GAP * 0.3, 0),
                    new T.Vector3(x, yTop    + S_GAP * 0.3, 0),
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
                    d = new T.Mesh(dg, dm);     d.position.set(cx, my + S_GAP * 0.7, 0); fretG.add(d);
                } else {
                    const d = new T.Mesh(dg, dm); d.position.set(cx, my, 0); fretG.add(d);
                }
            }
        }

        /* ── String glow (called each frame) ────────────────────────────── */
        function updateStringHighlights(noteState) {
            const BASE_GLOW  = 0.02;
            const MAX_GLOW   = 3.5;
            const IDLE_OP    = 0.4;

            for (let s = 0; s < nStr; s++) {
                const mesh = stringLines[s];
                if (!mesh) continue;
                const intensity = Math.max(
                    noteState.stringSustain[s] ? 1 : 0,
                    noteState.stringAnticipation[s] || 0,
                );
                mesh.material.emissiveIntensity = BASE_GLOW + intensity * MAX_GLOW;
                mesh.material.opacity           = IDLE_OP   + intensity * (1 - IDLE_OP);
                mesh.scale.set(1, 1 + intensity * 0.3, 1 + intensity * 0.3);
            }
        }

        /* ── Per-frame rendering ─────────────────────────────────────────── */
        function update(bundle) {
            pNote.reset(); pSus.reset(); pSusOutline.reset(); pLbl.reset();
            pBeat.reset(); pSec.reset();
            if (projMeshArr) for (const m of projMeshArr) m.visible = false;
            if (projGlowArr) for (const m of projGlowArr) m.visible = false;
            pFretLbl.reset(); pLane.reset(); pLaneDivider.reset();
            pChordBox.reset(); pChordLbl.reset(); pBarreLine.reset(); pNoteFretLabel.reset(); pConnectorLine.reset(); pDropLine.reset();

            const now = bundle.currentTime;
            const t0  = now - BEHIND;
            const t1  = now + AHEAD;

            const notes    = bundle.notes;
            const chords   = bundle.chords;
            const beats    = bundle.beats;
            const sections = bundle.sections;

            // ── Frame state ───────────────────────────────────────────────
            const noteState = {
                stringSustain:    new Array(nStr).fill(false),
                stringAnticipation: new Array(nStr).fill(0),
                fretHeat:         new Array(NFRETS + 1).fill(0),
                strGlow:          new Array(nStr).fill(0.5),
            };

            // Compute sustain / anticipation / fret heat / per-string glow
            if (notes) {
                for (const n of notes) {
                    const dt     = n.t - now;
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
                    let maxSus = 0;
                    for (const n of ch.notes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                    const susEnd = ch.t + maxSus;
                    const dt     = ch.t - now;
                    for (const cn of ch.notes) {
                        if (dt > 0 && dt < 0.6)
                            noteState.stringAnticipation[cn.s] = Math.max(noteState.stringAnticipation[cn.s], 1 - dt / 0.6);
                        if (cn.f > 0) {
                            if (now >= ch.t && now <= susEnd) { noteState.fretHeat[cn.f] = 1; continue; }
                            if (ch.t > now) noteState.fretHeat[cn.f] = Math.max(noteState.fretHeat[cn.f], Math.max(0, 1 - dt / 2));
                        }
                    }
                    if (now >= ch.t && now <= susEnd)
                        for (const cn of ch.notes) noteState.stringSustain[cn.s] = true;
                    const sustained = dt < 0 && maxSus > 0 && now <= susEnd;
                    const hitDist = Math.abs(dt);
                    if (hitDist < 0.15 || sustained) {
                        const hitFade = sustained ? 0.7 : (1 - hitDist / 0.15);
                        for (const cn of ch.notes)
                            noteState.strGlow[cn.s] = Math.max(noteState.strGlow[cn.s], 1.0 + hitFade * 1.5);
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
                    if (!nextNoteByString[n.s] || n.t < nextNoteByString[n.s].t) nextNoteByString[n.s] = n;
                    if (n.f > 0 && n.t > now - 0.1 && n.t < now + 2) fretLastActiveTime[n.f] = now;
                }
            }
            if (chords) {
                for (const ch of chords) {
                    if (!ch.notes || ch.t <= now) continue;
                    for (const cn of ch.notes) {
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

            // Camera targeting
            let fMin = 99, fMax = 0, got = false;

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
                    const isNext      = nextNoteByString[n.s] && Math.abs(nextNoteByString[n.s].t - n.t) < 0.001;
                    const skipLabel   = lastFretForString[n.s] === n.f;
                    drawNote(n, now, undefined, isNext, skipLabel, false);
                    lastFretForString[n.s] = n.f;
                    if (n.f > 0 && n.t <= t1) { fMin = Math.min(fMin, n.f); fMax = Math.max(fMax, n.f); got = true; }
                }
            }

            // ── Chords ────────────────────────────────────────────────────
            if (chords) {
                let prevChordSig  = null;
                let prevChordTime = -1;

                for (const ch of chords) {
                    if (!ch.notes) continue;
                    if (ch.t > now) {
                        const dt = ch.t - now;
                        if (dt < AHEAD) highwayIntensity = Math.max(highwayIntensity, 1 - dt / AHEAD);
                    }
                    if (ch.t > now && ch.t < now + 2)
                        for (const cn of ch.notes) { if (cn.f > 0) activeFrets.add(cn.f); }

                    let maxSus = 0;
                    for (const n of ch.notes) if ((n.sus || 0) > maxSus) maxSus = n.sus;
                    if (ch.t + maxSus < t0 || ch.t > t1) continue;

                    // Repeat-chord detection (consecutive same shape)
                    const currentSig = ch.notes.slice().sort((a, b) => a.s - b.s).map(n => `${n.s}:${n.f}`).join('|');
                    const isRepeat   = prevChordSig === currentSig && Math.abs(ch.t - prevChordTime) < 0.5;
                    prevChordSig  = currentSig;
                    prevChordTime = ch.t;

                    // Open-string center X
                    let chordCX = curX;
                    let cxL = Infinity, cxR = -Infinity, fretted = 0;
                    for (const cn of ch.notes) {
                        if (cn.f > 0) { const fx = fretMid(cn.f); if (fx < cxL) cxL = fx; if (fx > cxR) cxR = fx; fretted++; }
                    }
                    if (fretted > 0) chordCX = (cxL + cxR) / 2;

                    for (const cn of ch.notes) {
                        const isNext    = nextNoteByString[cn.s] && Math.abs(nextNoteByString[cn.s].t - ch.t) < 0.001;
                        const skipLabel = lastFretForString[cn.s] === cn.f;
                        drawNote({ ...cn, t: ch.t, sus: cn.sus || 0 }, now, cn.f === 0 ? chordCX : undefined, isNext, skipLabel, isRepeat, 0.55);
                        lastFretForString[cn.s] = cn.f;
                        if (cn.f > 0 && ch.t <= t1) { fMin = Math.min(fMin, cn.f); fMax = Math.max(fMax, cn.f); got = true; }
                    }

                    // Chord frame-box
                    const chDt = ch.t - now;
                    if (ch.notes.length > 1 && chDt > -0.55 && chDt < AHEAD) {
                        const z = Math.min(0, dZ(chDt));
                        let fMinCh = 99, fMaxCh = 0;
                        for (const cn of ch.notes) { if (cn.f > 0) { fMinCh = Math.min(fMinCh, cn.f); fMaxCh = Math.max(fMaxCh, cn.f); } }
                        if (fMinCh < 99) {
                            const xLeft  = fretX(fMinCh - 1);
                            const xRight = fretX(Math.max(fMaxCh, fMinCh + 2));
                            const padX   = NW * 0.4;
                            const width  = (xRight - xLeft) + padX * 2;
                            const cx     = xLeft + width / 2 - padX;
                            const yA     = sY(0), yB = sY(nStr - 1);
                            const yMinF  = Math.min(yA, yB) - S_GAP * 0.8;
                            const yMaxF  = Math.max(yA, yB) + S_GAP * 0.8;
                            let   height = yMaxF - yMinF;
                            if (isRepeat) height *= 0.5;
                            const cY     = (yMinF + yMaxF) / 2;
                            const fade   = Math.max(0, 1 - chDt / AHEAD);
                            const baseOp = isRepeat ? 0.05 + fade * 0.1 : 0.12 + fade * 0.2;
                            const thick  = 0.25 * K;
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
                                    for (const cn of ch.notes) if (cn.f > 0) bFret = Math.min(bFret, cn.f);
                                    if (bFret < Infinity) {
                                        const bx    = fretMid(bFret);
                                        const yTop  = Math.max(sY(0), sY(nStr - 1));
                                        const yBot  = Math.min(sY(0), sY(nStr - 1));
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
                const xL     = fretX(dMin), xR = fretX(dMax);
                const margin = NW * 0.5;
                const laneW  = (xR - xL) + margin * 2;
                const laneLen = TS * AHEAD;
                const boardY = S_BASE - NH / 2 - 2 * K;
                const lane   = pLane.get();
                lane.position.set((xL + xR) / 2, boardY + 0.02 * K, -laneLen / 2 + TS * BEHIND);
                lane.rotation.x = -Math.PI / 2;
                lane.scale.set(laneW, laneLen, 1);
                lane.material.opacity = 0.04 + highwayIntensity * 0.13;
                lane.material.color.set(0x112233).lerp(_laneTargetColor, highwayIntensity);
                lane.renderOrder = 1;

                // Lane dividers (fret wires inside active range)
                if (highwayIntensity > 0.05) {
                    const divLen = TS * (AHEAD + BEHIND) * 0.6;
                    const yPos   = boardY + 0.03 * K;
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
            {
                const yBottom = Math.min(sY(0), sY(nStr - 1));
                for (let f = 1; f <= NFRETS; f++) {
                    const lb       = pFretLbl.get();
                    const isActive = activeFrets.has(f);
                    lb.material    = txtMat(f, isActive ? '#ffe84d' : '#9ab8cc', false);
                    lb.position.set(fretMid(f), yBottom - S_GAP * 0.6, 0.5 * K);
                    const intensity = noteState.fretHeat[f];
                    lb.material.opacity = 0.35 + intensity * 0.65;
                    const scale = 3.5 + intensity * 2.2;
                    lb.scale.set(scale * K, scale * K, 1);
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
            if (got) {
                tgtX   = fretMid(Math.round((fMin + fMax) / 2));
                tgtDist = (65 + Math.max(fMax - fMin, 4) * 3) * K;
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
            const s      = n.s;
            const dt     = n.t - now;
            const y      = sY(s);
            const susEnd = n.t + (n.sus || 0);
            const hasSus = n.sus > 0;
            if (dt < -linger && (!hasSus || now > susEnd)) return;

            const sustained = dt < 0 && hasSus && now <= susEnd;
            const hitDist   = Math.abs(dt);
            const hit       = hitDist < 0.15 || sustained;
            const hitFade   = sustained ? 0.7 : (hitDist < 0.15 ? 1 - hitDist / 0.15 : 0);
            const vibrato   = sustained ? Math.sin(now * 30) * 0.3 * K : 0;
            const noteZ     = sustained ? 0 : Math.min(0, dZ(dt));
            const x         = n.f === 0 ? (openX !== undefined ? openX : curX) : fretMid(n.f);
            const isHarm    = n.hm || n.hp;

            if (!skipBody) {
                // Rotate from vertical (π/2) when entering to horizontal (0) at the hit line; skip for open strings
                const approachRot = n.f > 0 ? Math.max(0, Math.min(1, dt / AHEAD)) * Math.PI / 2 : 0;

                // ── Outline (slightly larger, bright emissive) ────────────
                const outline = pNote.get();
                outline.material = mWhiteOutline;
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
                }

                // ── Sustain trail ─────────────────────────────────────────
                if (hasSus) {
                    const susStart = Math.max(n.t, now);
                    const remSus   = susEnd - susStart;
                    if (remSus > 0.01) {
                        const len  = Math.min(remSus, AHEAD) * TS;
                        const zPos = dZ(susStart - now) - len / 2;
                        const tw   = NW * 0.85, th = NH * 0.12;
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
                    const boardY  = S_BASE - NH / 2 - 2 * K;
                    const lineTop = y - NH / 2 - NH * 0.4;
                    const lineBot = boardY + NH * 0.5;
                    const lineLen = lineTop - lineBot;
                    if (lineLen > 0.001) {
                        const dl = pDropLine.get();
                        dl.material.color.set(S_COL[s]);
                        dl.position.set(x, lineBot, noteZ);
                        dl.scale.set(1, lineLen, 1);
                    }
                }

                // ── Technique labels ──────────────────────────────────────
                let yo = y + NH * 0.8;
                if (n.bn > 0) {
                    const l = pLbl.get();
                    l.material = txtMat('↑' + bendText(n.bn), '#fff', true);
                    l.scale.set(NH * 3.6, NH * 1.5, 1); l.position.set(x, yo, noteZ); yo += NH * 1.2;
                }
                if (n.sl && n.sl !== -1) {
                    const l = pLbl.get();
                    l.material = txtMat(n.sl > n.f ? '↗' : '↘', '#fff', false);
                    l.scale.set(NH * 1.6, NH * 1.6, 1); l.position.set(x + NW * 0.6, yo, noteZ);
                }
                if (n.ho || n.po || n.tp) {
                    const l = pLbl.get();
                    l.material = txtMat(n.ho ? 'H' : n.po ? 'P' : 'T', '#fff', false);
                    l.scale.set(NH * 1.5, NH * 1.5, 1); l.position.set(x + NW * 0.6, yo, noteZ);
                }
                if (n.ac) {
                    const l = pLbl.get();
                    l.material = txtMat('>', '#fff', false);
                    l.scale.set(NH * 1.6, NH * 1.6, 1); l.position.set(x, yo, noteZ); yo += NH * 1.2;
                }
                if (n.tr) {
                    const l = pLbl.get();
                    l.material = txtMat('~~~', '#ff0', true);
                    l.scale.set(NH * 3.0, NH * 1.2, 1); l.position.set(x, yo, noteZ);
                }
                if (n.pm) {
                    // Palm mute: "X" overlay on the note body
                    const pmMark = pLbl.get();
                    if (!pmMark._pmMat) pmMark._pmMat = txtMat('X', '#ffffff', false).clone();
                    pmMark.material = pmMark._pmMat;
                    pmMark.position.set(x, y + vibrato, noteZ + 0.1 * K);
                    const pmScale = NH * 1.35;
                    pmMark.scale.set(pmScale, pmScale, 1);
                    pmMark.material.opacity = hit ? 1.0 : 0.8;
                }
                if (n.hp) {
                    const l = pLbl.get();
                    l.material = txtMat('PH', '#ff0', true);
                    l.scale.set(NH * 2.1, NH * 1.2, 1); l.position.set(x, y - NH * 1.1, noteZ);
                }

                // ── Per-note fret connector label ─────────────────────────
                if (n.f > 0 && !skipLabel) {
                    const minStringY = Math.min(sY(0), sY(nStr - 1));
                    const labelY     = minStringY - S_GAP * 0.8;
                    // fade out in the last 0.5 s so it doesn't overlap the fret-row label at Z=0
                    const alpha      = Math.max(0, Math.min(1, dt / 0.5)) * Math.min(1, (AHEAD - dt) / (AHEAD * 0.4));

                    const fretLabel  = pNoteFretLabel.get();
                    const cachedMat  = txtMat(n.f, '#ffffff', false);
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
            const PROJ_WIN   = 0.6;
            const projFactor = Math.max(0, Math.min(1, 1 - dt / PROJ_WIN));
            const isBlocked  = dt < 0.15 && n.sus > 0;
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
            const bpm  = computeBPM(bundle.beats, bundle.currentTime);
            const lerp = CAM_LERP_BASE * Math.max(bpm, 60) / 120;
            curX    += (tgtX    - curX)    * lerp;
            curDist += (tgtDist - curDist) * lerp;
            const dist = curDist * aspectScale;
            const h    = CAM_H_BASE * (dist / CAM_DIST_BASE);
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
            if (wrap) { wrap.remove(); wrap = null; }
            if (scene) {
                scene.traverse((obj) => {
                    obj.geometry?.dispose?.();
                    if (obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
                    }
                });
            }
            gNote?.dispose?.(); gSus?.dispose?.(); gBeat?.dispose?.();
            for (const m of mStr)     m?.dispose?.();
            for (const m of mGlow)    m?.dispose?.();
            for (const m of mSus)     m?.dispose?.();
            for (const m of mProj)    m?.dispose?.();
            for (const m of mProjGlow) m?.dispose?.();
            mBeatM?.dispose?.(); mBeatQ?.dispose?.();
            for (const k in txtCache) { txtCache[k].map?.dispose(); txtCache[k].dispose(); }
            txtCache = {};
            if (ren) { ren.dispose(); ren = null; }
            scene = cam = noteG = beatG = lblG = fretG = null;
            ambLight = dirLight = null;
            mStr = []; mGlow = []; mSus = []; mProj = []; mProjGlow = []; mWhiteOutline = mSusOutline = null; stringLines = [];
            lyricsCanvas = lyricsCtx = null;
            projMeshArr = projGlowArr = null;
            _probe = null;
            _laneTargetColor = null;
            _renderScale = 1;
            mBeatM = mBeatQ = null;
            pNote = pSus = pSusOutline = pLbl = pBeat = pSec = null;
            pFretLbl = pLane = pLaneDivider = pChordBox = pChordLbl = pBarreLine = pNoteFretLabel = pConnectorLine = pDropLine = null;
            gNote = gSus = gBeat = null;
            tgtX = curX = 0; tgtDist = curDist = CAM_DIST_BASE; tgtLookY = curLookY = 0; nStr = NSTR;
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
                highwayCanvas      = canvas;
                _invertedCached    = !!(bundle && bundle.inverted);
                _renderScale       = (bundle && bundle.renderScale) || 1;

                if (_ssActive()) {
                    window.slopsmithSplitscreen.onFocusChange(_onFocusChange);
                    _focusSubscribed = true;
                }

                loadThree().then(() => {
                    if (_destroyed || _initToken !== myToken) return;
                    try {
                        nStr = /bass/i.test((bundle && bundle.songInfo?.arrangement) || '') ? 4 : NSTR;
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
                // TODO(byrongamatos/slopsmith-plugin-3dhighway#7): derive string count
                // dynamically rather than hard-coding 4 for bass. The ideal source is the max
                // string index present in the note/chord data, OR a dedicated stringCount field
                // on songInfo. song.py always emits a 6-element tuning array regardless of
                // instrument, so tuning.length cannot be used as a signal.
                const newNStr  = /bass/i.test(bundle.songInfo?.arrangement || '') ? 4 : NSTR;
                const newScale = bundle.renderScale || 1;
                if (_invertedCached !== _invertedForBoard || newNStr !== nStr) {
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
