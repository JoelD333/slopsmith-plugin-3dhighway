(function () {
    'use strict';

    /* ======================================================================
     *  Constants
     * ====================================================================== */

    const CDN =
        'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    // Rocksmith string colours  (0 = low-E … 5 = high-e)
    const S_COL = [
        0xcc2222, // Red
        0xddaa00, // Yellow
        0x2266dd, // Blue
        0xdd8800, // Orange
        0x22aa22, // Green
        0x8822cc, // Purple
    ];

    // Fretboard geometry
    const SCALE  = 200;
    const NFRETS = 24;
    const NSTR   = 6;
    const S_GAP  = 3;
    const DOTS   = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
    const DDOTS  = new Set([12, 24]);

    // Time / display
    const AHEAD  = 3.0;
    const BEHIND = 0.5;
    const TS     = 150;  // world-units per second

    // Note dimensions
    const NW = 2.8, NH = 2.0, ND = 1.5;
    const SW = 0.7, SH = 0.5;  // sustain cross-section

    // Camera
    const CY = 32, CZ = 50, LZ = -130;
    const LERP = 0.04;

    /* ======================================================================
     *  State
     * ====================================================================== */

    let T;                              // THREE namespace
    let on = false;
    let scene, cam, ren, wrap;
    let fretG, noteG, beatG, lblG;
    let raf = null;
    let tgtX = 0, curX = 0;

    // Shared geometry & materials
    let gNote, gSus, gBeat, gBracket;
    let mStr = [], mGlow = [], mSus = [];
    let mBeatM, mBeatQ;
    let txtCache = {};

    // Object pools
    let pNote, pSus, pLbl, pBeat, pBrack, pSec;

    /* ======================================================================
     *  Helpers
     * ====================================================================== */

    const fretX   = f => (f <= 0 ? 0 : SCALE - SCALE / Math.pow(2, f / 12));
    const fretMid = f => (f <= 0 ? -2 : (fretX(f - 1) + fretX(f)) / 2);
    const sY      = s => s * S_GAP;
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
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'z-index:15;display:none;';
        player.insertBefore(wrap, document.getElementById('highway').nextSibling);

        ren = new T.WebGLRenderer({ antialias: true });
        ren.setPixelRatio(Math.min(devicePixelRatio, 2));
        ren.setClearColor(0x08080e);
        wrap.appendChild(ren.domElement);

        scene = new T.Scene();
        scene.fog = new T.Fog(0x08080e, 260, 520);

        cam = new T.PerspectiveCamera(50, 1, 0.5, 2000);

        scene.add(new T.AmbientLight(0xffffff, 0.65));
        const dl = new T.DirectionalLight(0xffffff, 0.55);
        dl.position.set(60, 80, 40);
        scene.add(dl);

        fretG = new T.Group(); scene.add(fretG);
        noteG = new T.Group(); scene.add(noteG);
        beatG = new T.Group(); scene.add(beatG);
        lblG  = new T.Group(); scene.add(lblG);

        gNote    = new T.BoxGeometry(NW, NH, ND);
        gSus     = new T.BoxGeometry(1, 1, 1);
        gBeat    = new T.BufferGeometry().setFromPoints(
            [new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0)],
        );
        gBracket = new T.BoxGeometry(0.25, 1, 0.25);

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
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
    }

    /* ======================================================================
     *  Fretboard (static geometry)
     * ====================================================================== */

    function buildBoard() {
        while (fretG.children.length) fretG.remove(fretG.children[0]);

        const bw = fretX(NFRETS) + 10;
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
        p.position.set(bw / 2 - 5, -1.2, -bl / 2 + TS * BEHIND);
        fretG.add(p);

        const zN = TS * BEHIND;
        const zF = -TS * AHEAD;

        // String lane lines (left edge, running into distance)
        for (let s = 0; s < NSTR; s++) {
            const g = new T.BufferGeometry().setFromPoints([
                new T.Vector3(-4, sY(s), zN),
                new T.Vector3(-4, sY(s), zF),
            ]);
            fretG.add(
                new T.Line(
                    g,
                    new T.LineBasicMaterial({
                        color: S_COL[s],
                        transparent: true,
                        opacity: 0.22,
                    }),
                ),
            );
        }

        // Fret wires at Z = 0 (the now-line reference)
        for (let f = 0; f <= NFRETS; f++) {
            const x = fretX(f);
            const g = new T.BufferGeometry().setFromPoints([
                new T.Vector3(x, -0.5, 0),
                new T.Vector3(x, sY(NSTR - 1) + 1, 0),
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

        // Now-line (bright cyan)
        const nw = bw + 5;
        const ng = new T.BufferGeometry().setFromPoints([
            new T.Vector3(-6, -0.3, 0),
            new T.Vector3(nw, -0.3, 0),
        ]);
        fretG.add(new T.Line(ng, new T.LineBasicMaterial({ color: 0x00dddd })));

        // Now-line glow strip
        const gg = new T.PlaneGeometry(nw + 6, 3);
        const gm = new T.MeshBasicMaterial({
            color: 0x00dddd,
            transparent: true,
            opacity: 0.06,
            side: T.DoubleSide,
        });
        const gp = new T.Mesh(gg, gm);
        gp.rotation.x = -Math.PI / 2;
        gp.position.set(nw / 2 - 3, -1, 0);
        fretG.add(gp);

        // Fret dots
        const dg = new T.SphereGeometry(0.45, 8, 6);
        const dm = new T.MeshBasicMaterial({ color: 0x556677 });
        const my = sY(NSTR - 1) / 2;
        for (const f of DOTS) {
            const cx = fretMid(f);
            if (DDOTS.has(f)) {
                let d = new T.Mesh(dg, dm);
                d.position.set(cx, my - 2.5, 0);
                fretG.add(d);
                d = new T.Mesh(dg, dm);
                d.position.set(cx, my + 2.5, 0);
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

        const t0 = now - BEHIND;
        const t1 = now + AHEAD;

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
                if (n.f > 0) {
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
                const mxs = Math.max(
                    0,
                    ...ch.notes.map(n => n.sus || 0),
                );
                if (ch.t + mxs < t0 || ch.t > t1) continue;

                let sMin = 5, sMax = 0, cf = 99;

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
                    );
                    sMin = Math.min(sMin, cn.s);
                    sMax = Math.max(sMax, cn.s);
                    if (cn.f > 0) {
                        cf = Math.min(cf, cn.f);
                        fMin = Math.min(fMin, cn.f);
                        fMax = Math.max(fMax, cn.f);
                        got = true;
                    }
                }

                // Bracket connecting chord notes
                if (sMax > sMin) {
                    const bx =
                        cf < 99 ? fretX(Math.max(0, cf - 1)) - 1.8 : -4;
                    const bB = sY(sMin) - 1;
                    const bH = sY(sMax) - sY(sMin) + 2;
                    const br = pBrack.get();
                    br.position.set(bx, bB + bH / 2, dZ(ch.t - now));
                    br.scale.set(1, bH, 1);
                }
            }
        }

        /* ── beat lines ── */
        if (beats) {
            const bw = fretX(NFRETS) + 8;
            let lastM = -1;
            for (const b of beats) {
                const meas = b.measure !== lastM;
                lastM = b.measure;
                if (b.time < t0 || b.time > t1) continue;
                const bl = pBeat.get();
                bl.material = meas ? mBeatM : mBeatQ;
                bl.scale.set(bw, 1, 1);
                bl.position.set(-4, -0.6, dZ(b.time - now));
            }
        }

        /* ── section labels ── */
        if (sections) {
            for (const s of sections) {
                if (s.time < t0 || s.time > t1) continue;
                const sp = pSec.get();
                sp.material = txtMat(s.name, '#00cccc', true);
                sp.scale.set(12, 3, 1);
                sp.position.set(
                    fretX(12),
                    sY(NSTR - 1) + 8,
                    dZ(s.time - now),
                );
            }
        }

        /* ── camera target ── */
        if (got) tgtX = fretMid(Math.round((fMin + fMax) / 2));
    }

    function drawNote(n, now) {
        const s  = n.s;
        const dt = n.t - now;
        const z  = dZ(dt);
        const x  = fretMid(n.f);
        const y  = sY(s);
        const hit = dt > -0.12 && dt < 0.12;

        // Note box
        const box = pNote.get();
        box.material = hit ? mGlow[s] : mStr[s];
        box.position.set(x, y, z);

        // Fret number label
        if (n.f >= 0) {
            const lb = pLbl.get();
            lb.material = txtMat(n.f, hit ? '#fff' : '#ddd', false);
            lb.scale.set(NW * 0.65, NH * 0.65, 1);
            lb.position.set(x, y, z + 0.01);
        }

        // Sustain trail
        if (n.sus > 0) {
            const len = Math.min(n.sus, AHEAD) * TS;
            const tr  = pSus.get();
            tr.material = mSus[s];
            tr.position.set(x, y, z - len / 2 - ND / 2);
            tr.scale.set(SW, SH, len);
        }

        // Technique indicators
        if (n.bn > 0) {
            const l = pLbl.get();
            l.material = txtMat('\u2191', '#ff4', false);
            l.scale.set(2, 2, 1);
            l.position.set(x, y + NH + 0.5, z);
        }
        if (n.sl && n.sl !== -1) {
            const l = pLbl.get();
            l.material = txtMat(
                n.sl > n.f ? '\u2197' : '\u2198',
                '#ff4',
                false,
            );
            l.scale.set(1.6, 1.6, 1);
            l.position.set(x + NW * 0.45, y + NH * 0.5, z);
        }
        if (n.ho) {
            const l = pLbl.get();
            l.material = txtMat('H', '#fff', false);
            l.scale.set(1.4, 1.4, 1);
            l.position.set(x + NW * 0.45, y + NH * 0.5, z);
        }
        if (n.po) {
            const l = pLbl.get();
            l.material = txtMat('P', '#fff', false);
            l.scale.set(1.4, 1.4, 1);
            l.position.set(x + NW * 0.45, y + NH * 0.5, z);
        }
        if (n.tp) {
            const l = pLbl.get();
            l.material = txtMat('T', '#0ff', false);
            l.scale.set(1.4, 1.4, 1);
            l.position.set(x + NW * 0.45, y + NH * 0.5, z);
        }
        if (n.hm || n.hp) {
            const l = pLbl.get();
            l.material = txtMat('\u25C7', '#0ff', false);
            l.scale.set(1.8, 1.8, 1);
            l.position.set(x, y + NH + 0.5, z);
        }
        if (n.pm) {
            const l = pLbl.get();
            l.material = txtMat('PM', '#888', true);
            l.scale.set(2, 1.5, 1);
            l.position.set(x, y - NH, z);
        }
    }

    /* ======================================================================
     *  Camera
     * ====================================================================== */

    function camUpdate() {
        curX += (tgtX - curX) * LERP;
        cam.position.set(curX, CY, CZ);
        cam.lookAt(curX, sY(NSTR - 1) / 2, LZ);
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
            hw.style.display = 'none';
            btn.className =
                'px-3 py-1.5 bg-blue-900/50 rounded-lg text-xs text-blue-300 transition';
            resize();
            animate();
        } else {
            wrap.style.display = 'none';
            hw.style.display = 'block';
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
        pNote = pSus = pLbl = pBeat = pBrack = pSec = null;
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
            document.getElementById('highway').style.display = 'none';
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
