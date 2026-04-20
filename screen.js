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
    let aspectScale = 1;           // updated on resize

    // Fog  (ChartPlayer: start=400, end=cameraDistance+focusDist)
    const FOG_START = 400 * K;
    const FOG_END   = 670 * K;

    const DOTS  = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
    const DDOTS = new Set([12, 24]);

    /* ======================================================================
     *  State
     * ====================================================================== */

    let T;
    let on = false;
    let scene, cam, ren, wrap;
    let fretG, noteG, beatG, lblG;
    let raf = null;
    let tgtX = 0, curX = 0;
    let tgtDist = CAM_DIST_BASE, curDist = CAM_DIST_BASE;

    let gNote, gSus, gBeat, gBracket;
    let mStr = [], mGlow = [], mSus = [];
    let mBeatM, mBeatQ;
    let txtCache = {};

    let pNote, pSus, pLbl, pBeat, pBrack, pSec, pChLine, pChBar, pChStem;
    let gChStem, mChord;

    /* ======================================================================
     *  Helpers
     * ====================================================================== */

    function bendText(bn) {
        if (bn === 0.5) return '\u00BD';
        if (bn === 1) return 'full';
        if (bn === 1.5) return '1\u00BD';
        if (bn >= 2) return String(Math.round(bn));
        return bn.toFixed(1);
    }

    const fretX   = f => (f <= 0 ? 0 : SCALE - SCALE / Math.pow(2, f / 12));
    const fretMid = f => (f <= 0 ? -2 * K : (fretX(f - 1) + fretX(f)) / 2);
    // When the core Invert toggle is on (highway.getInverted()), flip the
    // string-to-Y mapping so string 0 (low E) sits at the top instead of
    // the bottom. Read dynamically per call since the flag can change at
    // runtime via the toolbar button. See #1.
    const sY = s => S_BASE + (highway.getInverted() ? (NSTR - 1 - s) : s) * S_GAP;
    const dZ      = dt => -dt * TS;

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

    /* ======================================================================
     *  Three.js bootstrap
     * ====================================================================== */

    async function boot() {
        if (!T) T = await import(CDN);
    }

    function initScene() {
        const player = document.getElementById('player');

        wrap = document.createElement('div');
        wrap.id = 'h3d';
        wrap.style.cssText =
            'position:absolute;top:0;left:0;right:0;z-index:4;pointer-events:none;display:none;';
        player.insertBefore(wrap, document.getElementById('highway').nextSibling);

        ren = new T.WebGLRenderer({ antialias: true });
        ren.setPixelRatio(Math.min(devicePixelRatio, 2));
        ren.setClearColor(0x08080e);
        wrap.appendChild(ren.domElement);

        scene = new T.Scene();
        scene.fog = new T.Fog(0x08080e, FOG_START, FOG_END);

        cam = new T.PerspectiveCamera(45, 1, 0.01, FOG_END * 3);

        scene.add(new T.AmbientLight(0xffffff, 0.65));
        const dl = new T.DirectionalLight(0xffffff, 0.55);
        dl.position.set(60 * K, 80 * K, 40 * K);
        scene.add(dl);

        fretG = new T.Group(); scene.add(fretG);
        noteG = new T.Group(); scene.add(noteG);
        beatG = new T.Group(); scene.add(beatG);
        lblG  = new T.Group(); scene.add(lblG);

        // Rounded rectangle note shape (extruded 2D rounded rect)
        const noteShape = new T.Shape();
        const hw = NW / 2, hh = NH / 2, r = Math.min(N_RAD, hw, hh);
        noteShape.moveTo(-hw + r, -hh);
        noteShape.lineTo(hw - r, -hh);
        noteShape.quadraticCurveTo(hw, -hh, hw, -hh + r);
        noteShape.lineTo(hw, hh - r);
        noteShape.quadraticCurveTo(hw, hh, hw - r, hh);
        noteShape.lineTo(-hw + r, hh);
        noteShape.quadraticCurveTo(-hw, hh, -hw, hh - r);
        noteShape.lineTo(-hw, -hh + r);
        noteShape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
        gNote = new T.ExtrudeGeometry(noteShape, {
            depth: ND, bevelEnabled: false,
        });
        gNote.translate(0, 0, -ND / 2);  // center on Z
        gSus     = new T.BoxGeometry(1, 1, 1);
        gBeat    = new T.BufferGeometry().setFromPoints(
            [new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0)],
        );
        gBracket = new T.BoxGeometry(0.5 * K, 1, 0.5 * K);

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
        pBrack = pool(noteG, () =>
            new T.Mesh(
                gBracket,
                new T.MeshBasicMaterial({
                    color: 0xffffff,
                    transparent: true,
                    opacity: 0.5,
                }),
            ),
        );
        pSec = pool(lblG, () => new T.Sprite(txtMat('', '#0dd', true)));
        pChLine = pool(noteG, () => {
            const g = new T.BufferGeometry();
            g.setAttribute('position',
                new T.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
            return new T.Line(g, new T.LineBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.6,
            }));
        });

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
        resize();
        addEventListener('resize', resize);
    }

    function resize() {
        if (!ren) return;
        const ch =
            document.getElementById('player-controls')?.offsetHeight || 50;
        const w = innerWidth;
        const h = innerHeight - ch;
        ren.setSize(w, h);
        if (wrap) wrap.style.height = h + 'px';
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
        // Narrower windows need the camera further back to show the same fret range
        aspectScale = REF_ASPECT / Math.max(cam.aspect, 0.5);
    }

    /* ======================================================================
     *  Fretboard (static geometry)
     * ====================================================================== */

    function buildBoard() {
        while (fretG.children.length) fretG.remove(fretG.children[0]);

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

        const zN = TS * BEHIND;
        const zF = -TS * AHEAD;

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

        // Fret wires at Z = 0
        for (let f = 0; f <= NFRETS; f++) {
            const x = fretX(f);
            const g = new T.BufferGeometry().setFromPoints([
                new T.Vector3(x, S_BASE - NH / 2 - 1 * K, 0),
                new T.Vector3(x, sY(NSTR - 1) + 1 * K, 0),
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

    /* ======================================================================
     *  Per-frame rendering
     * ====================================================================== */

    function update(now) {
        pNote.reset();
        pSus.reset();
        pLbl.reset();
        pBeat.reset();
        pBrack.reset();
        pSec.reset();
        pChLine.reset();
        pChBar.reset();
        pChStem.reset();

        const t0 = now - BEHIND;
        const t1 = now + AHEAD;
        const tCam = t1;  // use full window for stable camera targeting

        const notes    = highway.getNotes();
        const chords   = highway.getChords();
        const beats    = highway.getBeats();
        const sections = highway.getSections();

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
                const mxs = Math.max(0, ...ch.notes.map(n => n.sus || 0));
                if (ch.t + mxs < t0 || ch.t > t1) continue;

                let sMin = 5, sMax = 0, cf = 99;

                // Find center X of fretted notes (for open string positioning)
                let chordCX = curX;
                const fretted = ch.notes.filter(cn => cn.f > 0);
                if (fretted.length > 0) {
                    let cxL = Infinity, cxR = -Infinity;
                    for (const fn of fretted) {
                        const fx = fretMid(fn.f);
                        cxL = Math.min(cxL, fx);
                        cxR = Math.max(cxR, fx);
                    }
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
                    sMin = Math.min(sMin, cn.s);
                    sMax = Math.max(sMax, cn.s);
                    if (cn.f > 0) {
                        cf = Math.min(cf, cn.f);
                        if (ch.t <= tCam) {
                            fMin = Math.min(fMin, cn.f);
                            fMax = Math.max(fMax, cn.f);
                            got = true;
                        }
                    }
                }

                // Chord bracket: horizontal bar + vertical stems (L-corners)
                // Hide bracket once chord has crossed the strings
                const chDt = ch.t - now;
                if (ch.notes.length > 1 && chDt > -0.05) {
                    const cz = dZ(chDt);
                    const barY = sY(sMax) + S_GAP * 0.6;

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
            for (const s of sections) {
                if (s.time < t0 || s.time > t1) continue;
                const sp = pSec.get();
                sp.material = txtMat(s.name, '#00cccc', true);
                sp.scale.set(20 * K, 5 * K, 1);
                sp.position.set(
                    fretX(12),
                    sY(NSTR - 1) + 8 * K,
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
            l.material = txtMat('\u2191' + bendText(n.bn), '#fff', true);
            l.scale.set(NH * 3.6, NH * 1.5, 1);
            l.position.set(x, yo, noteZ);
            yo += NH * 1.2;
        }

        // Slide: diagonal arrow
        if (n.sl && n.sl !== -1) {
            const l = pLbl.get();
            l.material = txtMat(
                n.sl > n.f ? '\u2197' : '\u2198', '#fff', false,
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

    /* ======================================================================
     *  Camera  (ChartPlayer FretCamera smooth lerp)
     * ====================================================================== */

    function camUpdate() {
        // Scale lerp by tempo: faster songs get faster camera response
        const bpm = highway.getBPM(highway.getTime());
        const lerp = CAM_LERP_BASE * Math.max(bpm, 60) / 120;
        curX += (tgtX - curX) * lerp;
        curDist += (tgtDist - curDist) * lerp;
        // Scale camera back for narrower viewports so fret coverage stays consistent
        const dist = curDist * aspectScale;
        const h = CAM_H_BASE * (dist / CAM_DIST_BASE);
        cam.position.set(curX, h, dist);
        cam.lookAt(curX, sY(2.5), -FOCUS_D * 0.3);
    }

    /* ======================================================================
     *  Animation loop
     * ====================================================================== */

    function animate() {
        if (!on) return;
        raf = requestAnimationFrame(animate);
        update(highway.getTime());
        camUpdate();
        ren.render(scene, cam);
    }

    /* ======================================================================
     *  Toggle & button
     * ====================================================================== */

    function toggle() {
        if (!T) return;
        on = !on;

        const btn = document.getElementById('btn-h3d');
        const hw  = document.getElementById('highway');

        if (on) {
            if (!ren) initScene();
            wrap.style.display = 'block';
            btn.className =
                'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-300 transition';
            resize();
            animate();
        } else {
            wrap.style.display = 'none';
            btn.className =
                'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
            if (raf) {
                cancelAnimationFrame(raf);
                raf = null;
            }
        }
    }

    function injectBtn() {
        const c = document.getElementById('player-controls');
        if (!c || document.getElementById('btn-h3d')) return;
        const last = c.querySelector('button:last-child');
        const b = document.createElement('button');
        b.id = 'btn-h3d';
        b.className =
            'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        b.textContent = '3D';
        b.title = 'Toggle 3D highway view';
        b.onclick = toggle;
        c.insertBefore(b, last);
    }

    /* ======================================================================
     *  Cleanup
     * ====================================================================== */

    function teardown() {
        on = false;
        if (raf) {
            cancelAnimationFrame(raf);
            raf = null;
        }
        if (wrap) {
            wrap.remove();
            wrap = null;
        }
        if (ren) {
            ren.dispose();
            ren = null;
        }
        for (const k in txtCache) {
            txtCache[k].map?.dispose();
            txtCache[k].dispose();
        }
        txtCache = {};
        scene = cam = noteG = beatG = lblG = fretG = null;
        mStr = mGlow = mSus = [];
        pNote = pSus = pLbl = pBeat = pBrack = pSec = pChLine = pChBar = pChStem = null;
    }

    /* ======================================================================
     *  Hooks
     * ====================================================================== */

    const _play = window.playSong;
    window.playSong = async function (f, a) {
        await _play(f, a);
        try {
            await boot();
        } catch (e) {
            console.error('[3D-Hwy]', e);
            return;
        }
        injectBtn();
        if (on) {
            teardown();
            on = true;
            initScene();
            wrap.style.display = 'block';
            const b = document.getElementById('btn-h3d');
            if (b)
                b.className =
                    'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-300 transition';
            resize();
            animate();
        }
    };

    const _show = window.showScreen;
    window.showScreen = function (id) {
        if (id !== 'player') teardown();
        _show(id);
    };
})();
