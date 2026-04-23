import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getDatabase, ref as dbRef, onValue, set, serverTimestamp } from 'firebase/database';
import { firebaseApp } from './firebase.js';

const CANVAS_W = 1200;
const CANVAS_H = 700;
const DEFAULT_COLOR = '#00D4FF';
const COLORS = ['#FFFFFF', '#00D4FF', '#F43F5E', '#10B981', '#FBBF24', '#A78BFA'];
const SIDE_PANEL_W = 300;

function makeId(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    room: params.get('room') || '',
    mode: params.get('mode') || '',
  };
}

function setUrlState({ room, mode }) {
  const params = new URLSearchParams(window.location.search);
  if (room) params.set('room', room);
  else params.delete('room');
  if (mode) params.set('mode', mode);
  else params.delete('mode');
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

function getJoinUrl(room) {
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room)}&mode=participant`;
}

function normalizePoint(p) {
  return {
    x: Math.max(0, Math.min(1, p.x)),
    y: Math.max(0, Math.min(1, p.y)),
  };
}

// Render one path (series of points) onto a canvas context directly.
function drawPath(ctx, points, color, size) {
  if (!points?.length) return;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color || DEFAULT_COLOR;
  ctx.lineWidth = size || 4;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
}

// Render a character centred at (cx, cy), scaled to maxSizePx, rotated by angle.
// When swimming leftward the character is flipped on the x-axis so it never
// appears upside-down regardless of direction.
function drawCharacterAt(ctx, character, cx, cy, maxSizePx, angle = 0) {
  const paths = character.paths
    ? character.paths
    : [{ points: character.points, color: character.color, size: character.size }];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const path of paths) {
    for (const p of (path.points || [])) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return;

  const bw = maxX - minX || 0.05;
  const bh = maxY - minY || 0.05;
  const scale = maxSizePx / Math.max(bw, bh);
  const mcx = (minX + maxX) / 2;
  const mcy = (minY + maxY) / 2;

  // Flip horizontally when swimming left so the creature never goes upside-down.
  const goingLeft = Math.cos(angle) < 0;

  for (const path of paths) {
    if (!path.points?.length) continue;

    ctx.save();
    ctx.translate(cx, cy);
    if (goingLeft) {
      ctx.scale(-1, 1);
      ctx.rotate(Math.PI - angle);
    } else {
      ctx.rotate(angle);
    }

    const mapped = path.points.map((p) => ({
      x: (p.x - mcx) * scale,
      y: (p.y - mcy) * scale,
    }));

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = path.color || DEFAULT_COLOR;
    ctx.lineWidth = Math.max(2, (path.size || 4) * scale / 400);
    ctx.shadowColor = path.color || DEFAULT_COLOR;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(mapped[0].x, mapped[0].y);
    for (let i = 1; i < mapped.length; i++) ctx.lineTo(mapped[i].x, mapped[i].y);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Transport layer — Firebase Realtime Database (cross-device sync).
// Strokes are stored under rooms/{roomId}/strokes/{strokeId}.
// Presence is stored under rooms/{roomId}/presence/{clientId}.
// onValue listeners fire immediately with current data (catch-up) and then
// on every subsequent change, so no separate readState/writeState is needed.
// ---------------------------------------------------------------------------
function createTransport(roomId) {
  const db = getDatabase(firebaseApp);
  const strokesRef = dbRef(db, `rooms/${roomId}/strokes`);
  const presenceRef = dbRef(db, `rooms/${roomId}/presence`);
  const listeners = new Set();
  const handle = (msg) => listeners.forEach((fn) => fn(msg));

  const unsubStrokes = onValue(strokesRef, (snapshot) => {
    const strokes = [];
    snapshot.forEach((child) => { if (child.val()) strokes.push(child.val()); });
    handle({ type: 'room:state', payload: { strokes } });
  });

  const unsubPresence = onValue(presenceRef, (snapshot) => {
    const participants = {};
    snapshot.forEach((child) => {
      if (child.val()) participants[child.key] = { ...child.val(), lastSeen: Date.now() };
    });
    handle({ type: 'room:state', payload: { participants } });
  });

  return {
    send(message) {
      if (message.type === 'character:add' || message.type === 'stroke:add') {
        const stroke = message.payload;
        set(dbRef(db, `rooms/${roomId}/strokes/${stroke.id}`), stroke);
      } else if (message.type === 'canvas:clear') {
        set(strokesRef, null);
      } else if (message.type === 'presence:update') {
        set(dbRef(db, `rooms/${roomId}/presence/${message.clientId}`), {
          ...message.payload,
          ts: serverTimestamp(),
        });
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    readState() { return null; },
    writeState() {},
    destroy() {
      unsubStrokes();
      unsubPresence();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// MediaPipe Hands loader — loads CDN script once, resolves when ready.
// ---------------------------------------------------------------------------
let _mpHandsPromise = null;
function loadMediaPipeHands() {
  if (_mpHandsPromise) return _mpHandsPromise;
  _mpHandsPromise = new Promise((resolve, reject) => {
    if (window.Hands) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
    s.crossOrigin = 'anonymous';
    s.onload = () => (window.Hands ? resolve() : reject(new Error('Hands global missing')));
    s.onerror = () => reject(new Error('Failed to load MediaPipe Hands'));
    document.head.appendChild(s);
  });
  return _mpHandsPromise;
}

// ---------------------------------------------------------------------------
// useHandTracking — webcam + MediaPipe, calls onStart/onEnd via pinchCbRef.
// Returns { fingertipPos, pinchCbRef } where pinchCbRef.current = { onStart, onEnd }.
// ---------------------------------------------------------------------------
function useHandTracking(enabled) {
  const [fingertipPos, setFingertipPos] = useState(null);
  const pinchCbRef = useRef({ onStart: null, onEnd: null });
  const prevPinchRef = useRef(false);

  useEffect(() => {
    if (!enabled) { setFingertipPos(null); return; }
    let active = true;

    async function init() {
      try {
        await loadMediaPipeHands();
        if (!active) return;

        const hands = new window.Hands({
          locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 0,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.5,
        });
        const smoothRef = { x: null, y: null };
        const SMOOTH = 0.5; // lerp factor: lower = smoother but laggier

        hands.onResults((results) => {
          if (!active) return;
          if (!results.multiHandLandmarks?.length) {
            setFingertipPos(null);
            smoothRef.x = null;
            smoothRef.y = null;
            if (prevPinchRef.current) {
              prevPinchRef.current = false;
              pinchCbRef.current.onEnd?.(null);
            }
            return;
          }
          const lm = results.multiHandLandmarks[0];
          const tip = lm[8];   // index fingertip
          const thumb = lm[4]; // thumb tip
          // Mirror x so it matches the user's perspective
          const rawX = (1 - tip.x) * window.innerWidth;
          const rawY = tip.y * window.innerHeight;
          // Exponential smoothing to reduce jitter
          if (smoothRef.x === null) { smoothRef.x = rawX; smoothRef.y = rawY; }
          else { smoothRef.x += (rawX - smoothRef.x) * SMOOTH; smoothRef.y += (rawY - smoothRef.y) * SMOOTH; }
          const sx = smoothRef.x;
          const sy = smoothRef.y;
          setFingertipPos({ x: sx, y: sy });

          const dx = (tip.x - thumb.x) * window.innerWidth;
          const dy = (tip.y - thumb.y) * window.innerHeight;
          const pinching = Math.sqrt(dx * dx + dy * dy) < 55;

          if (pinching && !prevPinchRef.current) pinchCbRef.current.onStart?.({ x: sx, y: sy });
          if (!pinching && prevPinchRef.current) pinchCbRef.current.onEnd?.({ x: sx, y: sy });
          prevPinchRef.current = pinching;
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
        });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }

        const video = document.createElement('video');
        video.srcObject = stream;
        video.playsInline = true;
        await video.play();

        let rafId;
        const loop = async () => {
          if (!active) return;
          if (video.readyState >= 2) await hands.send({ image: video });
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);

        return () => {
          active = false;
          cancelAnimationFrame(rafId);
          stream.getTracks().forEach((t) => t.stop());
        };
      } catch (err) {
        console.warn('Hand tracking unavailable:', err);
      }
    }

    const cleanupPromise = init();
    return () => {
      active = false;
      cleanupPromise.then((cleanup) => cleanup?.());
    };
  }, [enabled]);

  return { fingertipPos, pinchCbRef };
}

// ---------------------------------------------------------------------------
// Shared room hook — manages strokes (now characters) + participants.
// ---------------------------------------------------------------------------
function useSharedRoom(roomId, client) {
  const [strokes, setStrokes] = useState([]);
  const [participants, setParticipants] = useState({});
  const transportRef = useRef(null);

  useEffect(() => {
    if (!roomId) return undefined;

    // Clear stale state from the previous room before loading the new one.
    setStrokes([]);
    setParticipants({});

    const transport = createTransport(roomId);
    transportRef.current = transport;

    const initial = transport.readState();
    if (initial?.payload?.strokes) setStrokes(initial.payload.strokes);
    if (initial?.payload?.participants) setParticipants(initial.payload.participants);

    const unsub = transport.subscribe((message) => {
      if (!message) return;

      if (
        (message.type === 'character:add' || message.type === 'stroke:add') &&
        message.clientId !== client.clientId
      ) {
        setStrokes((prev) => {
          if (prev.some((s) => s.id === message.payload?.id)) return prev;
          return [...prev, message.payload];
        });
      }

      if (message.type === 'canvas:clear') setStrokes([]);

      if (message.type === 'presence:update' && message.clientId !== client.clientId) {
        setParticipants((prev) => ({
          ...prev,
          [message.clientId]: { ...message.payload, lastSeen: Date.now() },
        }));
      }

      if (message.type === 'room:state' && message.payload) {
        if (Array.isArray(message.payload.strokes)) setStrokes(message.payload.strokes);
        if (message.payload.participants && typeof message.payload.participants === 'object') {
          setParticipants(message.payload.participants);
        }
      }
    });

    const heartbeat = setInterval(() => {
      transport.send({
        type: 'presence:update',
        clientId: client.clientId,
        payload: { name: client.name, role: client.role, color: client.color },
      });
    }, 2000);

    return () => {
      clearInterval(heartbeat);
      unsub?.();
      transport.destroy();
    };
  }, [roomId, client.clientId, client.name, client.role, client.color]);

  // Prune stale participants.
  useEffect(() => {
    const id = setInterval(() => {
      setParticipants((prev) => {
        const next = { ...prev };
        const now = Date.now();
        Object.keys(next).forEach((k) => { if (now - (next[k].lastSeen || 0) > 7000) delete next[k]; });
        return next;
      });
    }, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!transportRef.current || !roomId) return;
    transportRef.current.writeState({ strokes, participants });
  }, [roomId, strokes, participants]);

  return useMemo(() => ({
    strokes,
    participants,
    addCharacter(character) {
      setStrokes((prev) => {
        if (prev.some((s) => s.id === character.id)) return prev;
        return [...prev, character];
      });
      transportRef.current?.send({
        type: 'character:add',
        clientId: client.clientId,
        payload: character,
      });
    },
    clearCanvas() {
      setStrokes([]);
      transportRef.current?.send({ type: 'canvas:clear', clientId: client.clientId, payload: null });
    },
  }), [strokes, participants, client.clientId]);
}

// ---------------------------------------------------------------------------
// Background scenery — seaweed, kelp, algae, rocks, pebbles, coral,
//                      anemones, starfish, urchins, sea fans.
// ---------------------------------------------------------------------------
function rnd(lo, hi) { return lo + Math.random() * (hi - lo); }
function pick(arr)   { return arr[Math.floor(Math.random() * arr.length)]; }

function irregularPolygon(sides) {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2 + rnd(-0.45, 0.45);
    const r = rnd(0.48, 1.0);
    return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
  });
}

// Build a branching coral/sea-fan tree in normalised world coordinates.
function buildBranches(out, px, py, angle, len, depth) {
  if (depth === 0 || len < 0.006) return;
  const ex = px + Math.cos(angle) * len;
  const ey = py + Math.sin(angle) * len;
  out.push({ x1: px, y1: py, x2: ex, y2: ey, d: depth });
  const spread = rnd(0.22, 0.46);
  buildBranches(out, ex, ey, angle - spread, len * rnd(0.62, 0.74), depth - 1);
  buildBranches(out, ex, ey, angle + spread, len * rnd(0.62, 0.74), depth - 1);
  if (depth > 2 && Math.random() > 0.55)
    buildBranches(out, ex, ey, angle + rnd(-0.2, 0.2), len * 0.45, depth - 2);
}

function generateBg() {
  // ── colours ──────────────────────────────────────────────────────────────
  const seaweedC  = ['#0b4422','#0f5228','#083318','#135c2e','#0a3d1e','#0d4825'];
  const kelpC     = ['#184a10','#1f5c14','#134008','#1a5210'];
  const algaeC    = ['#0c4a42','#0f5248','#083835','#12564e','#0a4040'];
  const rockC     = ['#0f2030','#162840','#0c1a2c','#1c3045','#111e30'];
  const pebbleC   = ['#0c1820','#14222e','#0a1620','#182a38'];
  const coralC    = ['#c04060','#b03070','#a03090','#c05030','#903090','#802fa0'];
  const fanC      = ['#8822aa','#6618cc','#aa3366','#cc4422'];
  const starC     = ['#c04010','#aa2030','#8a1a50','#b04080','#903020'];
  const urchinC   = ['#1a0a30','#0a1a10','#200a20','#0a1830'];

  const anemPal = [
    { body:'#8b2252', tip:'#ff88aa', stroke:'#dd4488' },
    { body:'#7a3000', tip:'#ffaa44', stroke:'#ff8822' },
    { body:'#2a1a6a', tip:'#bb99ff', stroke:'#7755dd' },
    { body:'#083a2a', tip:'#44ffcc', stroke:'#22ddaa' },
    { body:'#502010', tip:'#ffcc55', stroke:'#dd9922' },
  ];

  // ── seaweed ───────────────────────────────────────────────────────────────
  const seaweed = Array.from({ length: 20 }, () => ({
    x: rnd(0.01, 0.99), baseY: rnd(0.90, 0.96),
    height: rnd(0.13, 0.28), swayAmp: rnd(0.016, 0.046),
    swayFreq: rnd(0.13, 0.22), swayPhase: rnd(0, Math.PI * 2),
    color: pick(seaweedC), lineWidth: rnd(2, 4.5),
    xOff: rnd(-0.016, 0.016),
  }));

  // ── kelp — wide ribbon strands ────────────────────────────────────────────
  const kelp = Array.from({ length: 10 }, () => ({
    x: rnd(0.01, 0.99), baseY: rnd(0.89, 0.95),
    height: rnd(0.22, 0.40), swayAmp: rnd(0.024, 0.052),
    swayFreq: rnd(0.10, 0.18), swayPhase: rnd(0, Math.PI * 2),
    color: pick(kelpC), lineWidth: rnd(4, 9),
    ripplePhase: rnd(0, Math.PI * 2),
  }));

  // ── algae ─────────────────────────────────────────────────────────────────
  const algae = Array.from({ length: 24 }, () => {
    const fc = 2 + Math.floor(Math.random() * 4);
    return {
      x: rnd(0.01, 0.99), baseY: rnd(0.91, 0.96),
      height: rnd(0.045, 0.110), swayAmp: rnd(0.009, 0.022),
      swayFreq: rnd(0.18, 0.34), swayPhase: rnd(0, Math.PI * 2),
      color: pick(algaeC), lineWidth: rnd(1.4, 3.2),
      fronds: Array.from({ length: fc }, (_, i) => ({
        fanAngle: (i / Math.max(fc - 1, 1) - 0.5) * 1.0,
        hFactor: rnd(0.55, 1.0),
      })),
    };
  });

  // ── rocks ─────────────────────────────────────────────────────────────────
  const rocks = Array.from({ length: 14 }, () => ({
    x: Math.random(), y: rnd(0.86, 0.97),
    rx: rnd(0.020, 0.058), ry: rnd(0.011, 0.030),
    angle: rnd(-0.7, 0.7), color: pick(rockC),
    pts: irregularPolygon(6 + Math.floor(Math.random() * 5)),
  }));

  // ── pebbles ───────────────────────────────────────────────────────────────
  const pebbles = Array.from({ length: 50 }, () => ({
    x: Math.random(), y: rnd(0.88, 0.98),
    rx: rnd(0.003, 0.010), ry: rnd(0.002, 0.006),
    angle: Math.random() * Math.PI, color: pick(pebbleC),
  }));

  // ── branching coral ───────────────────────────────────────────────────────
  const corals = Array.from({ length: 10 }, () => {
    const branches = [];
    buildBranches(branches, rnd(0.03, 0.97), rnd(0.90, 0.96),
      -Math.PI / 2 + rnd(-0.35, 0.35), rnd(0.08, 0.15), 4);
    return { branches, color: pick(coralC) };
  });

  // ── sea fans (wide flat fans) ─────────────────────────────────────────────
  const fans = Array.from({ length: 6 }, () => {
    const branches = [];
    buildBranches(branches, rnd(0.03, 0.97), rnd(0.89, 0.95),
      -Math.PI / 2 + rnd(-0.15, 0.15), rnd(0.10, 0.18), 5);
    return { branches, color: pick(fanC) };
  });

  // ── anemones ──────────────────────────────────────────────────────────────
  const anemones = Array.from({ length: 12 }, () => {
    const tc = 7 + Math.floor(Math.random() * 7);
    const pal = pick(anemPal);
    return {
      x: rnd(0.02, 0.98), baseY: rnd(0.92, 0.96),
      bodyColor: pal.body, tipColor: pal.tip, strokeColor: pal.stroke,
      tentacles: Array.from({ length: tc }, (_, i) => ({
        baseAngle: -Math.PI * 0.85 + (i / Math.max(tc - 1, 1)) * Math.PI * 0.70,
        length: rnd(0.038, 0.072),
        swayPhase: rnd(0, Math.PI * 2),
        swayFreq: rnd(0.26, 0.48),
        swayAmp: rnd(0.09, 0.20),
      })),
    };
  });

  // ── starfish ──────────────────────────────────────────────────────────────
  const starfish = Array.from({ length: 7 }, () => ({
    x: Math.random(), y: rnd(0.88, 0.95),
    r: rnd(0.011, 0.022), rotation: Math.random() * Math.PI,
    color: pick(starC),
  }));

  // ── urchins ───────────────────────────────────────────────────────────────
  const urchins = Array.from({ length: 8 }, () => ({
    x: Math.random(), y: rnd(0.89, 0.96),
    r: rnd(0.006, 0.013), spines: 18 + Math.floor(Math.random() * 10),
    spineLen: rnd(1.6, 2.8), color: pick(urchinC),
  }));

  return { seaweed, kelp, algae, rocks, pebbles, corals, fans, anemones, starfish, urchins };
}

// Render all static elements onto an offscreen canvas once (or on resize).
// Rocks, pebbles, coral, fans, starfish, urchins, anemones — never redrawn
// per-frame.
function renderStaticBg(bg, W, H) {
  const oc  = document.createElement('canvas');
  oc.width  = W;
  oc.height = H;
  const ctx = oc.getContext('2d');
  const { rocks, pebbles, corals, fans, starfish, urchins, anemones } = bg;

  for (const p of pebbles) {
    ctx.save();
    ctx.translate(p.x * W, p.y * H);
    ctx.rotate(p.angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, p.rx * W, p.ry * H, 0, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.restore();
  }

  for (const rock of rocks) {
    ctx.save();
    ctx.translate(rock.x * W, rock.y * H);
    ctx.rotate(rock.angle);
    const rw = rock.rx * W, rh = rock.ry * H;
    ctx.beginPath();
    ctx.moveTo(rock.pts[0].x * rw, rock.pts[0].y * rh);
    for (let i = 1; i < rock.pts.length; i++) ctx.lineTo(rock.pts[i].x * rw, rock.pts[i].y * rh);
    ctx.closePath();
    ctx.fillStyle = rock.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  for (const s of starfish) {
    const cx = s.x * W, cy = s.y * H, outerR = s.r * Math.min(W, H), innerR = outerR * 0.42;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(s.rotation);
    ctx.fillStyle = s.color;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 5;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      i === 0 ? ctx.moveTo(r * Math.cos(a), r * Math.sin(a))
              : ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (const u of urchins) {
    const cx = u.x * W, cy = u.y * H, r = u.r * Math.min(W, H);
    ctx.save();
    ctx.fillStyle = u.color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = u.color;
    ctx.lineWidth = 0.8;
    for (let i = 0; i < u.spines; i++) {
      const a = (i / u.spines) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * r * u.spineLen, cy + Math.sin(a) * r * u.spineLen);
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const coral of corals) {
    ctx.save();
    ctx.strokeStyle = coral.color;
    ctx.lineCap = 'round';
    ctx.shadowColor = coral.color;
    ctx.shadowBlur = 9;
    for (const b of coral.branches) {
      ctx.lineWidth = b.d * 0.85 + 0.4;
      ctx.beginPath();
      ctx.moveTo(b.x1 * W, b.y1 * H);
      ctx.lineTo(b.x2 * W, b.y2 * H);
      ctx.stroke();
    }
    ctx.restore();
  }

  for (const fan of fans) {
    ctx.save();
    ctx.strokeStyle = fan.color;
    ctx.lineCap = 'round';
    ctx.shadowColor = fan.color;
    ctx.shadowBlur = 7;
    ctx.globalAlpha = 0.75;
    for (const b of fan.branches) {
      ctx.lineWidth = b.d * 0.6 + 0.3;
      ctx.beginPath();
      ctx.moveTo(b.x1 * W, b.y1 * H);
      ctx.lineTo(b.x2 * W, b.y2 * H);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // Anemones frozen at neutral pose (sway = 0).
  for (const a of anemones) {
    const bx = a.x * W, by = a.baseY * H;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = a.strokeColor;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = a.strokeColor;
    for (const tent of a.tentacles) {
      const angle = tent.baseAngle; // no sway
      const len   = tent.length * H;
      const tipX  = bx + Math.cos(angle) * len;
      const tipY  = by + Math.sin(angle) * len;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(
        bx + Math.cos(angle + 0.38) * len * 0.52,
        by + Math.sin(angle + 0.38) * len * 0.52,
        tipX, tipY,
      );
      ctx.stroke();
      ctx.shadowBlur = 4;
      ctx.fillStyle = a.tipColor;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = a.bodyColor;
    ctx.beginPath();
    ctx.ellipse(bx, by, 5, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  return oc;
}

// Per-frame: only the swaying plants (seaweed, kelp, algae).
function drawAnimatedPlants(ctx, bg, t, W, H) {
  const { seaweed, kelp, algae } = bg;

  for (const p of kelp) {
    const sway   = Math.sin(t * p.swayFreq * Math.PI * 2 + p.swayPhase) * p.swayAmp;
    const ripple = Math.sin(t * p.swayFreq * 3 * Math.PI * 2 + p.ripplePhase) * p.swayAmp * 0.35;
    const bx = p.x * W, by = p.baseY * H, ht = p.height * H;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineCap = 'round';
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.lineWidth = p.lineWidth;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.bezierCurveTo(
      bx + (sway + ripple) * W, by - ht * 0.32,
      bx + (sway - ripple) * W, by - ht * 0.65,
      bx + sway * W,            by - ht,
    );
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  for (const p of seaweed) {
    const sway = Math.sin(t * p.swayFreq * Math.PI * 2 + p.swayPhase) * p.swayAmp;
    const bx = p.x * W, by = p.baseY * H, ht = p.height * H;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineCap = 'round';
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 5;
    ctx.lineWidth = p.lineWidth;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.bezierCurveTo(
      bx + sway * 0.30 * W, by - ht * 0.35,
      bx + sway * 0.68 * W, by - ht * 0.68,
      bx + sway * W,        by - ht,
    );
    ctx.stroke();
    const bx2 = bx + p.xOff * W;
    ctx.lineWidth = p.lineWidth * 0.5;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(bx2, by);
    ctx.bezierCurveTo(
      bx2 + sway * 0.25 * W, by - ht * 0.28,
      bx2 + sway * 0.58 * W, by - ht * 0.60,
      bx2 + sway * W,        by - ht * 0.85,
    );
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  for (const p of algae) {
    const sway = Math.sin(t * p.swayFreq * Math.PI * 2 + p.swayPhase) * p.swayAmp;
    const bx = p.x * W, by = p.baseY * H, ht = p.height * H;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.lineCap = 'round';
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 3;
    for (const frond of p.fronds) {
      const tx = bx + (sway + frond.fanAngle * 0.04) * W;
      const ty = by - ht * frond.hFactor;
      ctx.lineWidth = p.lineWidth * (0.5 + frond.hFactor * 0.5);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(
        bx + (sway + frond.fanAngle * 0.02) * W, by - ht * frond.hFactor * 0.55,
        tx, ty,
      );
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Aquarium canvas — animated host display.
// heldIdRef   — ref to the id of a creature being dragged (skip its physics)
// heldPosRef  — ref to {x,y} normalised position of that creature
// positionsRef — ref that this component fills each frame with [{id,x,y}]
// teleportRef — ref set by HostView when a creature is dropped: {id, x, y}
//               normalised; AquariumCanvas consumes it and moves the creature
// ---------------------------------------------------------------------------
function AquariumCanvas({ strokes, heldIdRef = null, heldPosRef = null, positionsRef = null, teleportRef = null }) {
  const canvasRef = useRef(null);
  const charactersRef = useRef([]);
  const bubblesRef = useRef([]);
  const charBubblesRef = useRef([]);
  const bubbleStreamsRef = useRef([]); // collision streams: trickle bubbles upward over time
  const bgRef = useRef(null);
  const staticLayerRef = useRef(null);
  const animRef = useRef(null);
  const knownIdsRef = useRef(new Set());

  // Generate bg data once, then fit canvas + bake static layer (re-bake on resize).
  useEffect(() => {
    bgRef.current = generateBg();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      canvas.width  = canvas.parentElement?.offsetWidth  || window.innerWidth;
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight;
      staticLayerRef.current = renderStaticBg(bgRef.current, canvas.width, canvas.height);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Spawn bubbles once.
  useEffect(() => {
    bubblesRef.current = Array.from({ length: 26 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 1.5 + Math.random() * 3.2,
      speed: 0.00018 + Math.random() * 0.00032,
      opacity: 0.10 + Math.random() * 0.18,
      wobble: Math.random() * Math.PI * 2,
      wobbleSpeed: 0.4 + Math.random() * 0.9,
    }));
  }, []);

  // Sync incoming strokes → animated character entries.
  // Also removes creatures that have been taken out of strokes (e.g. dragged
  // to the side panel) so they don't linger in the animation loop.
  useEffect(() => {
    if (strokes.length === 0) {
      charactersRef.current = [];
      charBubblesRef.current = [];
      bubbleStreamsRef.current = [];
      knownIdsRef.current.clear();
      return;
    }
    const strokeIds = new Set(strokes.map((s) => s.id));
    charactersRef.current = charactersRef.current.filter((c) => strokeIds.has(c.id));
    knownIdsRef.current = new Set([...knownIdsRef.current].filter((id) => strokeIds.has(id)));
    for (const stroke of strokes) {
      if (!knownIdsRef.current.has(stroke.id)) {
        knownIdsRef.current.add(stroke.id);
        charactersRef.current.push({
          id: stroke.id,
          character: stroke,
          phase: 'drop',
          x: 0.10 + Math.random() * 0.80,
          y: -0.18,
          dropPhase: Math.random() * Math.PI * 2,
          targetY: 0.38 + Math.random() * 0.20,
          // Populated when swim starts:
          dir: Math.random() < 0.5 ? 1 : -1,
          speed: 0.0009 + Math.random() * 0.0007,
          lastBumpAt: -999,
          holdUntil: 0,
          baseY: 0,
          waveFreq: 0.5 + Math.random() * 0.8,
          wavePhase: Math.random() * Math.PI * 2,
          waveAmp: 0.010 + Math.random() * 0.016,
          nextBubbleAt: 0,
        });
      }
    }
  }, [strokes]);

  // Main animation loop — runs for the lifetime of the component.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let startTime = null;

    const frame = (ts) => {
      if (!startTime) startTime = ts;
      const t = (ts - startTime) / 1000;
      const W = canvas.width;
      const H = canvas.height;

      // Deep ocean background.
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#0d2137');
      bg.addColorStop(0.55, '#091828');
      bg.addColorStop(1, '#050e18');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // Blit pre-rendered static scenery (rocks, coral, starfish, etc.) in one GPU call.
      if (staticLayerRef.current) ctx.drawImage(staticLayerRef.current, 0, 0);
      // Animate only the swaying plants on top.
      if (bgRef.current) drawAnimatedPlants(ctx, bgRef.current, t, W, H);

      // Floor gradient — fades plant bases and deepens the bottom.
      const floor = ctx.createLinearGradient(0, H * 0.82, 0, H);
      floor.addColorStop(0, 'rgba(5, 14, 24, 0)');
      floor.addColorStop(1, 'rgba(5, 14, 24, 0.96)');
      ctx.fillStyle = floor;
      ctx.fillRect(0, H * 0.82, W, H * 0.18);

      // Surface light caustic.
      const surf = ctx.createLinearGradient(0, 0, 0, H * 0.28);
      surf.addColorStop(0, 'rgba(30, 110, 190, 0.14)');
      surf.addColorStop(1, 'rgba(30, 110, 190, 0)');
      ctx.fillStyle = surf;
      ctx.fillRect(0, 0, W, H * 0.28);

      // Bubbles.
      for (const b of bubblesRef.current) {
        b.y -= b.speed;
        b.wobble += b.wobbleSpeed * 0.016;
        if (b.y < -0.04) { b.y = 1.03; b.x = Math.random(); }
        const bx = (b.x + Math.sin(b.wobble) * 0.006) * W;
        const by = b.y * H;
        ctx.save();
        ctx.beginPath();
        ctx.arc(bx, by, b.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(140, 210, 255, ${b.opacity})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        // Specular highlight.
        ctx.beginPath();
        ctx.arc(bx - b.r * 0.32, by - b.r * 0.35, b.r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220, 245, 255, ${b.opacity * 0.85})`;
        ctx.fill();
        ctx.restore();
      }

      // Consume any pending teleport (creature dropped at a specific position).
      if (teleportRef?.current) {
        const { id, x, y } = teleportRef.current;
        teleportRef.current = null;
        const tc = charactersRef.current.find((c) => c.id === id);
        if (tc) { tc.x = x; tc.y = y; tc.baseY = y; tc.phase = 'swim'; tc.holdUntil = 0; }
      }

      // Characters.
      const charSize = Math.min(W, H) * 0.13;
      for (const c of charactersRef.current) {
        const isHeld = heldIdRef?.current === c.id;

        // Held by fingertip — rendered by the full-screen overlay instead.
        if (isHeld) continue;

        if (c.phase === 'drop') {
          // Spring toward target depth — fast at first, eases off as it arrives.
          c.y += (c.targetY - c.y) * 0.028;
          // Gentle side-to-side drift, like sinking through water.
          c.dropPhase += 0.032;
          c.x += Math.sin(c.dropPhase) * 0.0007;
          if (Math.abs(c.targetY - c.y) < 0.005) {
            c.y = c.targetY;
            c.baseY = c.targetY;
            c.phase = 'swim';
            c.nextBubbleAt = t + 3 + Math.random() * 9;
          }
          drawCharacterAt(ctx, c.character, c.x * W, c.y * H, charSize, 0);
        } else {
          // Horizontal swim — paused during a bump hold.
          if (t >= c.holdUntil) {
            c.x += c.dir * c.speed;
            if (c.x <= 0.04) { c.x = 0.04; c.dir = 1; }
            if (c.x >= 0.96) { c.x = 0.96; c.dir = -1; }
          }

          // Vertical undulation via sine wave — each creature has its own
          // frequency, amplitude and phase so nothing moves in sync.
          c.y = c.baseY + Math.sin(t * c.waveFreq * Math.PI * 2 + c.wavePhase) * c.waveAmp;

          // Emit a small cluster of bubbles occasionally.
          if (t >= c.nextBubbleAt) {
            const count = 1 + Math.floor(Math.random() * 2);
            for (let i = 0; i < count; i++) {
              charBubblesRef.current.push({
                x: c.x + (Math.random() - 0.5) * 0.05,
                y: c.y - 0.02,
                r: 1.2 + Math.random() * 2.2,
                vy: 0.00022 + Math.random() * 0.00028,
                opacity: 0.35 + Math.random() * 0.3,
                wobble: Math.random() * Math.PI * 2,
                wobbleSpeed: 0.3 + Math.random() * 0.5,
              });
            }
            c.nextBubbleAt = t + 5 + Math.random() * 12;
          }

          // Facing direction: mirror horizontally when going left, no tilt.
          drawCharacterAt(ctx, c.character, c.x * W, c.y * H, charSize, c.dir === -1 ? Math.PI : 0);
        }
      }

      // Export normalised creature positions for drag hit-testing.
      if (positionsRef) {
        positionsRef.current = charactersRef.current.map((c) => ({ id: c.id, x: c.x, y: c.y }));
      }

      // Collision — only fire when characters are actively swimming toward each
      // other. On contact: flip both directions (bounce) + push apart so they
      // never overlap, then burst bubbles.
      const swimmers = charactersRef.current.filter((c) => c.phase === 'swim');
      for (let i = 0; i < swimmers.length; i++) {
        for (let j = i + 1; j < swimmers.length; j++) {
          const a = swimmers[i];
          const b = swimmers[j];
          const dx = Math.abs(a.x - b.x) * W;
          const dy = Math.abs(a.y - b.y) * H;

          // Simple distance check — if they overlap, react.
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist >= charSize * 1.2) continue;

          // Cooldown so a bounce doesn't retrigger immediately.
          if (t - a.lastBumpAt < 2 || t - b.lastBumpAt < 2) continue;

          a.lastBumpAt = t;
          b.lastBumpAt = t;

          // Flip directions now but freeze movement for 500ms —
          // they hold at the contact point while bubbles rise, then swim away.
          a.dir *= -1;
          b.dir *= -1;
          a.holdUntil = t + 0.5;
          b.holdUntil = t + 0.5;

          // Start a bubble stream at the contact point.
          bubbleStreamsRef.current.push({
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
            startT: t,
            duration: 2.0 + Math.random() * 1.5,
            lastEmitT: -99,
          });
        }
      }

      // Bubble streams from collisions — trickle upward until expired.
      bubbleStreamsRef.current = bubbleStreamsRef.current.filter((s) => t - s.startT < s.duration);
      for (const s of bubbleStreamsRef.current) {
        if (t - s.lastEmitT > 0.07) {
          s.lastEmitT = t;
          const n = 1 + Math.floor(Math.random() * 2);
          for (let k = 0; k < n; k++) {
            charBubblesRef.current.push({
              x: s.x + (Math.random() - 0.5) * 0.018,
              y: s.y - (Math.random() * 0.02),
              r: 1.5 + Math.random() * 3.0,
              vy: 0.0005 + Math.random() * 0.0005,
              opacity: 0.65 + Math.random() * 0.3,
              wobble: Math.random() * Math.PI * 2,
              wobbleSpeed: 0.5 + Math.random() * 0.8,
            });
          }
        }
      }

      // Character-emitted bubbles.
      charBubblesRef.current = charBubblesRef.current.filter((b) => b.opacity > 0.02);
      for (const b of charBubblesRef.current) {
        b.y -= b.vy;
        b.wobble += b.wobbleSpeed * 0.016;
        b.opacity -= 0.0008;
        const bx = (b.x + Math.sin(b.wobble) * 0.004) * W;
        const by = b.y * H;
        ctx.save();
        ctx.beginPath();
        ctx.arc(bx, by, b.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(160, 220, 255, ${b.opacity})`;
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(bx - b.r * 0.3, by - b.r * 0.35, b.r * 0.28, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220, 245, 255, ${b.opacity * 0.7})`;
        ctx.fill();
        ctx.restore();
      }

      animRef.current = requestAnimationFrame(frame);
    };

    animRef.current = requestAnimationFrame(frame);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, []);

  return <canvas ref={canvasRef} className="aquarium-canvas" />;
}

// ---------------------------------------------------------------------------
// HeldCreatureOverlay — full-screen fixed canvas that draws the grabbed
// creature directly at fingertip pixel coordinates, unrestricted by panel
// boundaries, so it travels smoothly across both the aquarium and side panel.
// ---------------------------------------------------------------------------
function HeldCreatureOverlay({ creature, pos }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Use plain CSS pixel dimensions — no DPR scaling. This overlay is a
    // transient drag layer; retina sharpness is not needed, and DPR transforms
    // cause coordinate mismatches with the fingertip CSS pixel position.
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!creature || !pos) return;
    const size = Math.min(W, H) * 0.13;
    ctx.save();
    ctx.shadowColor = '#00D4FF';
    ctx.shadowBlur = 30;
    drawCharacterAt(ctx, creature, pos.x, pos.y, size, 0);
    ctx.restore();
  }, [creature, pos]);

  return <canvas ref={canvasRef} className="held-creature-overlay" />;
}

// ---------------------------------------------------------------------------
// Side aquarium — static glowing display of creatures dragged from main tank.
// ---------------------------------------------------------------------------
function SideAquarium({ creatures, onReleaseAll }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a1a30');
    bg.addColorStop(1, '#050e18');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    if (!creatures.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Drag creatures here', W / 2, H / 2 - 8);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillText('using your fingertip', W / 2, H / 2 + 10);
      return;
    }

    const size = Math.min(W * 0.6, 72);
    creatures.forEach((creature) => {
      // Use stored drop position, clamped to canvas bounds.
      const cx = Math.max(size / 2, Math.min(W - size / 2, creature.dropX ?? W / 2));
      const cy = Math.max(size / 2, Math.min(H - size / 2, creature.dropY ?? H / 2));
      ctx.save();
      ctx.shadowColor = 'rgba(0, 212, 255, 0.45)';
      ctx.shadowBlur = 22;
      drawCharacterAt(ctx, creature, cx, cy, size, 0);
      ctx.restore();
    });
  }, [creatures]);

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">Showcase</span>
        {creatures.length > 0 && (
          <button type="button" className="hud-btn" onClick={onReleaseAll} style={{ fontSize: '0.7rem' }}>
            Release all
          </button>
        )}
      </div>
      <canvas ref={canvasRef} className="side-canvas" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawing pad — multi-stroke, bundles on Send.
// Incremental drawing: each touchmove only draws one new segment, never
// repaints old strokes. Committed strokes live on an offscreen canvas that
// is blitted once on stroke-end, not on every move event.
// ---------------------------------------------------------------------------
function DrawingPad({ onCommit }) {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const committedRef = useRef(null); // offscreen canvas — all finished strokes
  const draftRef = useRef([]);
  const submittedRef = useRef([]);
  const drawingRef = useRef(false);
  const colorRef = useRef(DEFAULT_COLOR);
  const sizeRef = useRef(4);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [size, setSize] = useState(4);
  const [strokeCount, setStrokeCount] = useState(0);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);

  // Build/rebuild the offscreen committed canvas and blit it to the main canvas.
  const rebakeAndBlit = () => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    if (!committedRef.current) committedRef.current = document.createElement('canvas');
    const oc = committedRef.current;
    oc.width = canvas.width;
    oc.height = canvas.height;
    const ocCtx = oc.getContext('2d');
    ocCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ocCtx.fillStyle = '#0a1628';
    ocCtx.fillRect(0, 0, w, h);
    for (const path of submittedRef.current) {
      ocCtx.save();
      drawPath(ocCtx, path.points.map((p) => ({ x: p.x * w, y: p.y * h })), path.color, path.size);
      ocCtx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(oc, 0, 0, w, h);
  };

  // One-time canvas setup — sets physical pixel size, scales context,
  // and attaches native touch listeners with passive:false so
  // preventDefault() actually works and stops scroll on mobile.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, w, h);
    ctxRef.current = ctx;
    rebakeAndBlit();

    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end, { passive: false });
    return () => {
      canvas.removeEventListener('touchstart', start);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', end);
    };
  }, []);

  const getPoint = (event) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    const clientX = touch ? touch.clientX : event.clientX;
    const clientY = touch ? touch.clientY : event.clientY;
    return normalizePoint({ x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height });
  };

  const start = (event) => {
    event.preventDefault();
    drawingRef.current = true;
    const pt = getPoint(event);
    draftRef.current = [pt];
    // Blit committed so any previous live-stroke artifact is gone.
    rebakeAndBlit();
  };

  const move = (event) => {
    if (!drawingRef.current) return;
    event.preventDefault();
    const pt = getPoint(event);
    const prev = draftRef.current[draftRef.current.length - 1];
    draftRef.current.push(pt);

    // Draw only the new segment — no clear, no loop over previous points.
    const ctx = ctxRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas || !prev) return;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colorRef.current;
    ctx.lineWidth = sizeRef.current;
    ctx.beginPath();
    ctx.moveTo(prev.x * w, prev.y * h);
    ctx.lineTo(pt.x * w, pt.y * h);
    ctx.stroke();
  };

  const end = (event) => {
    if (!drawingRef.current) return;
    event.preventDefault();
    drawingRef.current = false;
    if (draftRef.current.length > 1) {
      submittedRef.current = [...submittedRef.current, {
        color: colorRef.current, size: sizeRef.current, points: [...draftRef.current],
      }];
      setStrokeCount((c) => c + 1);
    }
    draftRef.current = [];
    rebakeAndBlit();
  };

  const sendToScreen = () => {
    const allPaths = [...submittedRef.current];
    if (draftRef.current.length > 1) allPaths.push({ color: colorRef.current, size: sizeRef.current, points: [...draftRef.current] });
    if (allPaths.length === 0) return;
    onCommit({ id: crypto.randomUUID(), paths: allPaths });
    submittedRef.current = [];
    draftRef.current = [];
    setStrokeCount(0);
    rebakeAndBlit();
  };

  const clearPad = () => {
    submittedRef.current = [];
    draftRef.current = [];
    setStrokeCount(0);
    rebakeAndBlit();
  };

  return (
    <div className="pad-layout">
      <canvas
        ref={canvasRef}
        className="drawing-pad"
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
      />
      <div className="pad-controls">
        <div className="swatches-inline">
          {COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              onClick={() => setColor(swatch)}
              className={`swatch-sm ${color === swatch ? 'is-active' : ''}`}
              style={{ backgroundColor: swatch }}
              aria-label={`Choose ${swatch}`}
            />
          ))}
        </div>
        <div className="pad-actions">
          <button type="button" className="button button-secondary" onClick={clearPad} disabled={strokeCount === 0}>Clear</button>
          <button type="button" className="button" onClick={sendToScreen} disabled={strokeCount === 0}>Send</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function HostView({ room, shared, onResetRoom }) {
  const joinUrl = getJoinUrl(room);
  const [playing, setPlaying] = useState(false);
  const [handEnabled, setHandEnabled] = useState(false);
  const audioRef = useRef(null);

  // ── Drag state ────────────────────────────────────────────────────────────
  // Use refs for the hot path (updated every RAF frame) and state only for
  // values that must trigger a re-render.
  const heldIdRef = useRef(null);           // id of creature currently grabbed
  const heldPosRef = useRef(null);          // normalised {x,y} of that creature
  const hiddenIdsRef = useRef(new Set());   // ids moved to the side panel
  const creaturePositionsRef = useRef([]); // filled by AquariumCanvas each frame
  const teleportRef = useRef(null);         // consumed by AquariumCanvas to place dropped creature
  const sharedStrokesRef = useRef(shared.strokes);
  useEffect(() => { sharedStrokesRef.current = shared.strokes; }, [shared.strokes]);

  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [sideCreatures, setSideCreatures] = useState([]);
  const [heldCreature, setHeldCreature] = useState(null);

  // ── Hand tracking ─────────────────────────────────────────────────────────
  const { fingertipPos, pinchCbRef } = useHandTracking(handEnabled);

  // Keep heldPos in sync with the fingertip while dragging.
  useEffect(() => {
    if (!heldIdRef.current || !fingertipPos) return;
    const canvasW = window.innerWidth - SIDE_PANEL_W;
    const canvasH = window.innerHeight;
    heldPosRef.current = {
      x: Math.max(0, Math.min(1, fingertipPos.x / canvasW)),
      y: Math.max(0, Math.min(1, fingertipPos.y / canvasH)),
    };
  }, [fingertipPos]);

  // Wire pinch callbacks once — they read from refs so no stale-closure issue.
  useEffect(() => {
    pinchCbRef.current.onStart = (pos) => {
      if (heldIdRef.current || !pos) return;
      const canvasW = window.innerWidth - SIDE_PANEL_W;
      const canvasH = window.innerHeight;
      const normX = pos.x / canvasW;
      const normY = pos.y / canvasH;
      const threshold = Math.min(canvasW, canvasH) * 0.15;

      let nearest = null;
      let nearestDist = Infinity;
      for (const c of creaturePositionsRef.current) {
        if (hiddenIdsRef.current.has(c.id)) continue;
        const dx = (c.x - normX) * canvasW;
        const dy = (c.y - normY) * canvasH;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < nearestDist) { nearest = c; nearestDist = dist; }
      }
      if (nearest && nearestDist < threshold) {
        const creature = sharedStrokesRef.current.find((s) => s.id === nearest.id);
        heldIdRef.current = nearest.id;
        heldPosRef.current = { x: normX, y: normY };
        setHeldCreature(creature || null);
      }
    };

    pinchCbRef.current.onEnd = (pos) => {
      const id = heldIdRef.current;
      if (!id) return;
      const canvasW = window.innerWidth - SIDE_PANEL_W;

      if (pos && pos.x > canvasW) {
        // Dropped in side panel — store drop position relative to panel left edge.
        const creature = sharedStrokesRef.current.find((s) => s.id === id);
        if (creature) {
          setSideCreatures((prev) => [
            ...prev.filter((c) => c.id !== id),
            { ...creature, dropX: pos.x - canvasW, dropY: pos.y },
          ]);
          hiddenIdsRef.current = new Set([...hiddenIdsRef.current, id]);
          setHiddenIds(new Set(hiddenIdsRef.current));
        }
      } else if (pos) {
        // Dropped in main aquarium — teleport creature to drop position.
        teleportRef.current = {
          id,
          x: Math.max(0.04, Math.min(0.96, pos.x / canvasW)),
          y: Math.max(0.10, Math.min(0.88, pos.y / window.innerHeight)),
        };
      }

      heldIdRef.current = null;
      heldPosRef.current = null;
      setHeldCreature(null);
    };
  }, []);

  const toggleMusic = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.volume = 0.4; audio.play().catch(() => {}); setPlaying(true); }
  };

  const visibleStrokes = shared.strokes.filter((s) => !hiddenIds.has(s.id));

  return (
    <div className="host-fullscreen">
      <audio ref={audioRef} src="/music.mp3" loop />

      <div className="host-layout">
        <div className="aquarium-wrapper">
          <AquariumCanvas
            key={room}
            strokes={visibleStrokes}
            heldIdRef={heldIdRef}
            heldPosRef={heldPosRef}
            positionsRef={creaturePositionsRef}
            teleportRef={teleportRef}
          />
        </div>
        <SideAquarium
          creatures={sideCreatures}
          onReleaseAll={() => {
            setSideCreatures([]);
            hiddenIdsRef.current = new Set();
            setHiddenIds(new Set());
          }}
        />
      </div>

      <div className="host-hud">
        <span className="hud-room">Room&nbsp;<strong>{room}</strong></span>
        <span className="hud-divider" />
        <button type="button" className="hud-btn" onClick={shared.clearCanvas}>Clear</button>
        <button type="button" className="hud-btn" onClick={onResetRoom}>New room</button>
        <span className="hud-divider" />
        <button type="button" className="hud-btn" onClick={toggleMusic}>
          {playing ? '⏸ Music' : '▶ Music'}
        </button>
        <span className="hud-divider" />
        <button
          type="button"
          className={`hud-btn${handEnabled ? ' hud-btn-active' : ''}`}
          onClick={() => setHandEnabled((e) => !e)}
        >
          {handEnabled ? '✋ On' : '✋ Off'}
        </button>
      </div>

      <div className="qr-corner">
        <div className="qr-label">Scan to join</div>
        <QRCodeSVG value={joinUrl} size={110} bgColor="transparent" fgColor="#ffffff" />
        <div className="qr-room">{room}</div>
      </div>

      <HeldCreatureOverlay creature={heldCreature} pos={fingertipPos} />

      {fingertipPos && handEnabled && (
        <div
          className={`fingertip-cursor${heldCreature ? ' is-grabbing' : ''}`}
          style={{ transform: `translate(calc(${fingertipPos.x}px - 50%), calc(${fingertipPos.y}px - 50%))` }}
        />
      )}
    </div>
  );
}

function ParticipantView({ room, shared, clientName, setClientName, clientColor }) {
  return (
    <div className="participant-shell">
      <div className="participant-header">
        <span className="pill">Room {room}</span>
        <span className="muted-text" style={{ fontSize: '0.8125rem' }}>Draw your creature</span>
      </div>
      <DrawingPad onCommit={shared.addCharacter} />
    </div>
  );
}

function HomeView({ onCreateHost, roomInput, setRoomInput, onJoinParticipant }) {
  return (
    <div className="home-shell">
      <div className="home-card">
        <div className="home-copy">
          <div className="eyebrow">Shared drawing MVP</div>
          <h1>Phones as brushes, laptop as canvas.</h1>
          <p>
            Start a room on your computer, then let people join from any phone browser and draw their creature onto the shared aquarium.
          </p>
        </div>

        <div className="home-actions">
          <section className="panel stack gap-12">
            <div>
              <div className="panel-title small">Start host screen</div>
              <p className="muted-text">Use this on your laptop or projector.</p>
            </div>
            <button type="button" className="button full-width" onClick={onCreateHost}>
              Create room
            </button>
          </section>

          <section className="panel stack gap-12">
            <div>
              <div className="panel-title small">Join as participant</div>
              <p className="muted-text">Paste a room code to join from a phone.</p>
            </div>
            <div className="row gap-8">
              <input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
                placeholder="Enter room code"
                className="text-input"
              />
              <button type="button" className="button" onClick={onJoinParticipant} disabled={!roomInput.trim()}>
                Join
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function App() {
  const initial = getUrlState();
  const [room, setRoom] = useState(initial.room);
  const [mode, setMode] = useState(initial.mode);
  const [roomInput, setRoomInput] = useState(initial.room);
  const [clientName, setClientName] = useState('');
  const clientId = useMemo(() => crypto.randomUUID(), []);
  const clientColor = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

  useEffect(() => { setUrlState({ room, mode }); }, [room, mode]);

  const shared = useSharedRoom(room, {
    clientId,
    name: clientName || (mode === 'host' ? 'Host' : 'Anonymous'),
    role: mode || 'participant',
    color: clientColor,
  });

  if (!room || !mode) {
    return (
      <HomeView
        roomInput={roomInput}
        setRoomInput={setRoomInput}
        onCreateHost={() => {
          const next = makeId();
          setRoom(next);
          setRoomInput(next);
          setMode('host');
        }}
        onJoinParticipant={() => {
          if (!roomInput.trim()) return;
          setRoom(roomInput.trim());
          setMode('participant');
        }}
      />
    );
  }

  if (mode === 'host') {
    return (
      <HostView
        room={room}
        shared={shared}
        onResetRoom={() => {
          const next = makeId();
          setRoom(next);
          setRoomInput(next);
          setMode('host');
        }}
      />
    );
  }

  return (
    <ParticipantView
      room={room}
      shared={shared}
      clientName={clientName}
      setClientName={setClientName}
      clientColor={clientColor}
    />
  );
}
