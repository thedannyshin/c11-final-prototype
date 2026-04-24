// Battle Arena game
// To delete this game: delete src/battle/ and remove its import from src/App.jsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { createBattleTransport } from './transport.js';
import './styles.css';

// ---------------------------------------------------------------------------
// Re-use drawing primitives from the aquarium module
// ---------------------------------------------------------------------------
import { drawCharacterAt, drawPath, generateBg, drawAnimatedPlants, renderStaticBg } from '../aquarium.jsx';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_COLOR = '#00D4FF';
const COLORS = ['#FFFFFF', '#00D4FF', '#F43F5E', '#10B981', '#FBBF24', '#A78BFA'];
const P1_COLOR = '#F43F5E';   // red
const P2_COLOR = '#00D4FF';   // blue
const BASE_SIZE = 0.12;       // player creature radius as fraction of min(W,H)
const MIN_SIZE = 0.030;       // below this = dead
const MAX_SIZE = 0.28;
const FOOD_RADIUS = 0.045;    // food item radius fraction
const PROJECTILE_SPEED = 0.007; // per frame, normalised
const SHOOT_COOLDOWN = 1200;  // ms between shots
const FOOD_DRIFT = 0.00018;   // how fast food drifts per frame
const HIT_SHRINK = 0.018;
const FOOD_GROW = 0.008;

function getJoinUrl(room, extra = '') {
  return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room)}&mode=battle-join${extra}`;
}
function makeId(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function normalizePoint(p) { return { x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }; }

// ---------------------------------------------------------------------------
// MediaPipe loader (same CDN, shared promise per window)
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
    s.onerror = () => reject(new Error('Failed to load MediaPipe'));
    document.head.appendChild(s);
  });
  return _mpHandsPromise;
}

// ---------------------------------------------------------------------------
// useHandTracking — single webcam. deviceId selects which camera to use.
// Returns { fingertipPos, pinchCbRef }
// ---------------------------------------------------------------------------
function useHandTracking(enabled, deviceId = null) {
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
        hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });

        const smoothRef = { x: null, y: null };
        const SMOOTH = 0.5;
        const CAM_PAD_X = 0.22;
        const CAM_PAD_Y = 0.15;

        hands.onResults((results) => {
          if (!active) return;
          if (!results.multiHandLandmarks?.length) {
            setFingertipPos(null); smoothRef.x = null; smoothRef.y = null;
            if (prevPinchRef.current) { prevPinchRef.current = false; pinchCbRef.current.onEnd?.(null); }
            return;
          }
          const lm = results.multiHandLandmarks[0];
          const tip = lm[8]; const thumb = lm[4];
          const normX = Math.max(0, Math.min(1, ((1 - tip.x) - CAM_PAD_X) / (1 - 2 * CAM_PAD_X)));
          const normY = Math.max(0, Math.min(1, (tip.y - CAM_PAD_Y) / (1 - 2 * CAM_PAD_Y)));
          const rawX = normX * window.innerWidth;
          const rawY = normY * window.innerHeight;
          if (smoothRef.x === null) { smoothRef.x = rawX; smoothRef.y = rawY; }
          else { smoothRef.x += (rawX - smoothRef.x) * SMOOTH; smoothRef.y += (rawY - smoothRef.y) * SMOOTH; }
          const sx = smoothRef.x; const sy = smoothRef.y;
          setFingertipPos({ x: sx, y: sy });

          const dx = (tip.x - thumb.x) * window.innerWidth;
          const dy = (tip.y - thumb.y) * window.innerHeight;
          const pinching = Math.sqrt(dx * dx + dy * dy) < 55;
          if (pinching && !prevPinchRef.current) pinchCbRef.current.onStart?.({ x: sx, y: sy });
          if (!pinching && prevPinchRef.current) pinchCbRef.current.onEnd?.({ x: sx, y: sy });
          prevPinchRef.current = pinching;
        });

        const constraints = { video: deviceId ? { deviceId: { exact: deviceId }, width: 640, height: 480 } : { width: 640, height: 480, facingMode: 'user' } };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }

        const video = document.createElement('video');
        video.srcObject = stream; video.playsInline = true;
        await video.play();

        let rafId;
        const loop = async () => {
          if (!active) return;
          if (video.readyState >= 2) await hands.send({ image: video });
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);

        return () => { active = false; cancelAnimationFrame(rafId); stream.getTracks().forEach((t) => t.stop()); };
      } catch (err) { console.warn('Hand tracking unavailable:', err); }
    }

    const cleanupPromise = init();
    return () => { active = false; cleanupPromise.then((cleanup) => cleanup?.()); };
  }, [enabled, deviceId]);

  return { fingertipPos, pinchCbRef };
}

// ---------------------------------------------------------------------------
// DrawingPad (self-contained, battle-specific — team selection on send)
// ---------------------------------------------------------------------------
function BattleDrawingPad({ onCommit, isPlayer, playerSlot }) {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const committedRef = useRef(null);
  const draftRef = useRef([]);
  const submittedRef = useRef([]);
  const drawingRef = useRef(false);
  const colorRef = useRef(DEFAULT_COLOR);
  const sizeRef = useRef(4);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [strokeCount, setStrokeCount] = useState(0);
  const [sent, setSent] = useState(false);

  useEffect(() => { colorRef.current = color; }, [color]);

  const rebakeAndBlit = () => {
    const canvas = canvasRef.current; const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr; const h = canvas.height / dpr;
    if (!committedRef.current) committedRef.current = document.createElement('canvas');
    const oc = committedRef.current;
    oc.width = canvas.width; oc.height = canvas.height;
    const ocCtx = oc.getContext('2d');
    ocCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ocCtx.fillStyle = '#0a1628'; ocCtx.fillRect(0, 0, w, h);
    for (const path of submittedRef.current) {
      ocCtx.save();
      drawPath(ocCtx, path.points.map((p) => ({ x: p.x * w, y: p.y * h })), path.color, path.size);
      ocCtx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(oc, 0, 0, w, h);
  };

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr; canvas.height = canvas.offsetHeight * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0a1628'; ctx.fillRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
    ctxRef.current = ctx; rebakeAndBlit();
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end, { passive: false });
    return () => { canvas.removeEventListener('touchstart', start); canvas.removeEventListener('touchmove', move); canvas.removeEventListener('touchend', end); };
  }, []);

  const getPoint = (event) => {
    const canvas = canvasRef.current; const rect = canvas.getBoundingClientRect();
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    const clientX = touch ? touch.clientX : event.clientX; const clientY = touch ? touch.clientY : event.clientY;
    return normalizePoint({ x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height });
  };

  const start = (event) => { event.preventDefault(); drawingRef.current = true; draftRef.current = [getPoint(event)]; rebakeAndBlit(); };
  const move = (event) => {
    if (!drawingRef.current) return; event.preventDefault();
    const pt = getPoint(event); const prev = draftRef.current[draftRef.current.length - 1];
    draftRef.current.push(pt);
    const ctx = ctxRef.current; const canvas = canvasRef.current;
    if (!ctx || !canvas || !prev) return;
    const w = canvas.offsetWidth; const h = canvas.offsetHeight;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = colorRef.current; ctx.lineWidth = sizeRef.current;
    ctx.beginPath(); ctx.moveTo(prev.x * w, prev.y * h); ctx.lineTo(pt.x * w, pt.y * h); ctx.stroke();
  };
  const end = (event) => {
    if (!drawingRef.current) return; event.preventDefault(); drawingRef.current = false;
    if (draftRef.current.length > 1) {
      submittedRef.current = [...submittedRef.current, { color: colorRef.current, size: sizeRef.current, points: [...draftRef.current] }];
      setStrokeCount((c) => c + 1);
    }
    draftRef.current = []; rebakeAndBlit();
  };

  const clearPad = () => { submittedRef.current = []; draftRef.current = []; setStrokeCount(0); rebakeAndBlit(); };

  const send = (team) => {
    const allPaths = [...submittedRef.current];
    if (draftRef.current.length > 1) allPaths.push({ color: colorRef.current, size: sizeRef.current, points: [...draftRef.current] });
    if (allPaths.length === 0) return;
    onCommit({ id: crypto.randomUUID(), paths: allPaths }, team);
    submittedRef.current = []; draftRef.current = []; setStrokeCount(0); rebakeAndBlit();
    if (isPlayer) setSent(true);
  };

  if (sent) {
    return (
      <div className="battle-pad-sent">
        <div className="battle-sent-icon">⚔️</div>
        <div className="battle-sent-title">You're in the arena!</div>
        <div className="battle-sent-sub">Watch the big screen</div>
      </div>
    );
  }

  return (
    <div className="pad-layout">
      <canvas ref={canvasRef} className="drawing-pad" onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} />
      <div className="pad-controls">
        <div className="swatches-inline">
          {COLORS.map((swatch) => (
            <button key={swatch} type="button" onClick={() => setColor(swatch)}
              className={`swatch-sm ${color === swatch ? 'is-active' : ''}`}
              style={{ backgroundColor: swatch }} aria-label={`Choose ${swatch}`} />
          ))}
        </div>
        <div className="pad-actions">
          <button type="button" className="button button-secondary" onClick={clearPad} disabled={strokeCount === 0}>Clear</button>
          {isPlayer ? (
            <button type="button" className="button" style={{ background: playerSlot === 'p1' ? P1_COLOR : P2_COLOR }}
              onClick={() => send(playerSlot)} disabled={strokeCount === 0}>
              Join as {playerSlot === 'p1' ? '🔴 P1' : '🔵 P2'}
            </button>
          ) : (
            <div className="battle-team-row">
              <button type="button" className="button battle-p1-btn" onClick={() => send('p1')} disabled={strokeCount === 0}>Give to 🔴</button>
              <button type="button" className="button battle-p2-btn" onClick={() => send('p2')} disabled={strokeCount === 0}>Give to 🔵</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GameArena canvas — renders everything each RAF frame
// ---------------------------------------------------------------------------
function GameArena({ bgRef, p1Ref, p2Ref, foodRef, projectilesRef }) {
  const canvasRef = useRef(null);
  const staticLayerRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    let rafId;

    const resize = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth;
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight;
      // Re-bake static BG whenever canvas resizes
      if (bgRef?.current) staticLayerRef.current = renderStaticBg(bgRef.current, canvas.width, canvas.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement || document.body);

    const draw = (ts) => {
      rafId = requestAnimationFrame(draw);
      const W = canvas.width; const H = canvas.height;
      const ctx = canvas.getContext('2d');

      ctx.clearRect(0, 0, W, H);

      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#0a1628'); grad.addColorStop(1, '#051020');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      // Static scenery
      if (staticLayerRef.current) ctx.drawImage(staticLayerRef.current, 0, 0);
      if (bgRef?.current) drawAnimatedPlants(ctx, bgRef.current, ts * 0.001, W, H);

      // Food items
      const food = foodRef?.current || [];
      for (const f of food) {
        const fx = f.x * W; const fy = f.y * H;
        const radius = FOOD_RADIUS * Math.min(W, H);
        ctx.save();
        ctx.shadowColor = f.team === 'p1' ? P1_COLOR : P2_COLOR;
        ctx.shadowBlur = 18;
        // Faint team-coloured halo ring
        ctx.strokeStyle = f.team === 'p1' ? P1_COLOR : P2_COLOR;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.arc(fx, fy, radius + 6, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        drawCharacterAt(ctx, f, fx, fy, radius * 2, 0);
        ctx.restore();
      }

      // Projectiles
      const projectiles = projectilesRef?.current || [];
      for (const proj of projectiles) {
        const px = proj.x * W; const py = proj.y * H;
        const col = proj.owner === 'p1' ? P1_COLOR : P2_COLOR;
        ctx.save();
        ctx.shadowColor = col; ctx.shadowBlur = 24;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // Player creatures
      for (const [player, col] of [['p1', P1_COLOR], ['p2', P2_COLOR]]) {
        const pRef = player === 'p1' ? p1Ref : p2Ref;
        const state = pRef?.current;
        if (!state?.creature) continue;
        const cx = state.x * W; const cy = state.y * H;
        const size = state.size * Math.min(W, H);
        ctx.save();
        ctx.shadowColor = col; ctx.shadowBlur = 30;
        drawCharacterAt(ctx, state.creature, cx, cy, size, 0);
        // Player label ring
        ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(cx, cy, size / 2 + 8, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      // HUD — size bars
      drawSizeBars(ctx, p1Ref?.current?.size, p2Ref?.current?.size, W, H);

      lastTime = ts;
    };
    rafId = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafId); ro.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />;
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  else {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }
}

function drawSizeBars(ctx, p1Size, p2Size, W, H) {
  if (!p1Size && !p2Size) return;
  const barW = Math.min(220, W * 0.28);
  const barH = 14;
  const y = 18;

  const drawBar = (x, size, color, label, alignRight) => {
    const ratio = Math.max(0, Math.min(1, (size - MIN_SIZE) / (MAX_SIZE - MIN_SIZE)));
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(ctx, x, y, barW, barH, 7); ctx.fill();
    ctx.fillStyle = color;
    roundRect(ctx, x, y, barW * ratio, barH, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = alignRight ? 'right' : 'left';
    ctx.fillText(label, alignRight ? x - 8 : x + barW + 8, y + barH / 2);
    ctx.restore();
  };

  const margin = 24;
  if (p1Size != null) drawBar(margin, p1Size, P1_COLOR, 'P1', false);
  if (p2Size != null) drawBar(W - margin - barW, p2Size, P2_COLOR, 'P2 ', true);
}

// ---------------------------------------------------------------------------
// PhoneController — runs on the player's phone after they've drawn their
// creature. Uses the phone's front camera + MediaPipe to detect the
// fingertip and sends normalised {x, y, pinch} to Firebase ~15 fps.
// ---------------------------------------------------------------------------
function PhoneController({ transport, slot }) {
  const [tracking, setTracking] = useState(false);
  const [fingertipPos, setFingertipPos] = useState(null);
  const [pinching, setPinching] = useState(false);
  const lastSendRef = useRef(0);

  useEffect(() => {
    let active = true;

    async function init() {
      try {
        await loadMediaPipeHands();
        if (!active) return;

        const hands = new window.Hands({
          locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`,
        });
        hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });

        const smoothRef = { x: null, y: null };
        const CAM_PAD_X = 0.22; const CAM_PAD_Y = 0.15; const SMOOTH = 0.5;

        hands.onResults((results) => {
          if (!active) return;
          if (!results.multiHandLandmarks?.length) {
            setFingertipPos(null);
            smoothRef.x = null; smoothRef.y = null;
            return;
          }
          const lm = results.multiHandLandmarks[0];
          const tip = lm[8]; const thumb = lm[4];
          const normX = Math.max(0, Math.min(1, ((1 - tip.x) - CAM_PAD_X) / (1 - 2 * CAM_PAD_X)));
          const normY = Math.max(0, Math.min(1, (tip.y - CAM_PAD_Y) / (1 - 2 * CAM_PAD_Y)));
          if (smoothRef.x === null) { smoothRef.x = normX; smoothRef.y = normY; }
          else { smoothRef.x += (normX - smoothRef.x) * SMOOTH; smoothRef.y += (normY - smoothRef.y) * SMOOTH; }

          const dx = (tip.x - thumb.x) * window.innerWidth;
          const dy = (tip.y - thumb.y) * window.innerHeight;
          const isPinching = Math.sqrt(dx * dx + dy * dy) < 55;

          setFingertipPos({ x: smoothRef.x, y: smoothRef.y });
          setPinching(isPinching);

          // Throttle Firebase writes to ~15 fps
          const now = Date.now();
          if (now - lastSendRef.current >= 66) {
            lastSendRef.current = now;
            transport.sendControl(slot, { x: smoothRef.x, y: smoothRef.y, pinch: isPinching });
          }
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
        });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }

        const video = document.createElement('video');
        video.srcObject = stream; video.playsInline = true;
        await video.play();
        setTracking(true);

        let rafId;
        const loop = async () => {
          if (!active) return;
          if (video.readyState >= 2) await hands.send({ image: video });
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);

        return () => { active = false; cancelAnimationFrame(rafId); stream.getTracks().forEach((t) => t.stop()); };
      } catch (err) { console.warn('PhoneController error:', err); }
    }

    const cleanupPromise = init();
    return () => { active = false; cleanupPromise.then((c) => c?.()); };
  }, [transport, slot]);

  const col = slot === 'p1' ? P1_COLOR : P2_COLOR;
  const label = slot === 'p1' ? '🔴 Player 1' : '🔵 Player 2';

  return (
    <div className="phone-controller">
      <div className="phone-ctrl-badge" style={{ color: col }}>{label}</div>
      {!tracking && <div className="phone-ctrl-loading">Starting camera…</div>}
      {tracking && (
        <>
          <div className={`phone-ctrl-status ${pinching ? 'is-pinching' : ''}`} style={{ borderColor: col }}>
            {fingertipPos ? (
              <div className="phone-ctrl-dot" style={{
                left: `${fingertipPos.x * 100}%`,
                top: `${fingertipPos.y * 100}%`,
                background: col,
                boxShadow: `0 0 16px ${col}`,
              }} />
            ) : (
              <span className="phone-ctrl-no-hand">Hold up your hand ✋</span>
            )}
          </div>
          <p className="phone-ctrl-hint">Move your index finger to steer.<br />Pinch to shoot.</p>
          {pinching && <div className="phone-ctrl-shoot-flash" style={{ background: col }}>💥 SHOOT</div>}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BattleHostView — lobby + game loop + win screen
// Players use their phones as controllers — positions arrive via Firebase.
// ---------------------------------------------------------------------------
export function BattleHostView({ room, clientId, onResetRoom }) {
  const transport = useMemo(() => createBattleTransport(room), [room]);

  const [players, setPlayers] = useState({ p1: null, p2: null });
  const [food, setFood] = useState([]);
  const [gamePhase, setGamePhase] = useState('lobby');
  const [winner, setWinner] = useState(null);
  // Live cursor dots for each player (normalised 0-1)
  const [p1Cursor, setP1Cursor] = useState(null);
  const [p2Cursor, setP2Cursor] = useState(null);

  const p1Ref = useRef({ creature: null, x: 0.25, y: 0.5, size: BASE_SIZE });
  const p2Ref = useRef({ creature: null, x: 0.75, y: 0.5, size: BASE_SIZE });
  const foodRef = useRef([]);
  const projectilesRef = useRef([]);
  const bgRef = useRef(generateBg());
  const lastShot = useRef({ p1: 0, p2: 0 });
  const prevPinch = useRef({ p1: false, p2: false });

  // Firebase subscriptions
  useEffect(() => {
    transport.onPlayers((val) => {
      if (!val) return;
      setPlayers(val);
      if (val.p1?.creature) p1Ref.current.creature = val.p1.creature;
      if (val.p2?.creature) p2Ref.current.creature = val.p2.creature;
    });
    transport.onFood((items) => { setFood(items); foodRef.current = items; });
    transport.onGameState((state) => {
      if (!state) return;
      if (state.phase) setGamePhase(state.phase);
      if (state.winner) { setWinner(state.winner); setGamePhase('ended'); }
    });
    // Phone controller positions
    transport.onControl((ctrl) => {
      for (const slot of ['p1', 'p2']) {
        const data = ctrl[slot];
        if (!data) continue;
        const pRef = slot === 'p1' ? p1Ref : p2Ref;
        pRef.current.x = Math.max(0.02, Math.min(0.98, data.x ?? pRef.current.x));
        pRef.current.y = Math.max(0.02, Math.min(0.98, data.y ?? pRef.current.y));
        if (slot === 'p1') setP1Cursor({ x: data.x, y: data.y });
        else setP2Cursor({ x: data.x, y: data.y });

        // Pinch → shoot (detect rising edge)
        if (data.pinch && !prevPinch.current[slot] && gamePhase === 'playing') {
          const now = Date.now();
          if (now - lastShot.current[slot] >= SHOOT_COOLDOWN) {
            lastShot.current[slot] = now;
            const src = slot === 'p1' ? p1Ref.current : p2Ref.current;
            const tgt = slot === 'p1' ? p2Ref.current : p1Ref.current;
            const dx = tgt.x - src.x; const dy = tgt.y - src.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            projectilesRef.current = [...projectilesRef.current, {
              id: crypto.randomUUID(), x: src.x, y: src.y,
              vx: (dx / len) * PROJECTILE_SPEED, vy: (dy / len) * PROJECTILE_SPEED,
              owner: slot,
            }];
          }
        }
        prevPinch.current[slot] = data.pinch;
      }
    });
    return () => transport.destroy();
  }, [transport]);

  // Note: gamePhase is captured at subscription time; use a ref to keep it fresh
  const gamePhaseRef = useRef(gamePhase);
  useEffect(() => { gamePhaseRef.current = gamePhase; }, [gamePhase]);

  useEffect(() => { foodRef.current = food; }, [food]);

  // Game loop
  useEffect(() => {
    if (gamePhase !== 'playing') return;
    let rafId; let foodPhase = 0;

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      foodPhase += 0.01;

      foodRef.current = foodRef.current.map((f, i) => ({
        ...f,
        x: f.x + Math.sin(foodPhase + i * 1.3) * FOOD_DRIFT,
        y: f.y + Math.cos(foodPhase * 0.7 + i * 0.9) * FOOD_DRIFT * 0.6,
      }));

      projectilesRef.current = projectilesRef.current
        .map((p) => ({ ...p, x: p.x + p.vx, y: p.y + p.vy }))
        .filter((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1);

      const surviving = [];
      for (const proj of projectilesRef.current) {
        const target = proj.owner === 'p1' ? p2Ref.current : p1Ref.current;
        const dx = proj.x - target.x; const dy = proj.y - target.y;
        if (Math.sqrt(dx * dx + dy * dy) < target.size * 0.6) {
          target.size = Math.max(MIN_SIZE, target.size - HIT_SHRINK);
        } else { surviving.push(proj); }
      }
      projectilesRef.current = surviving;

      const remainingFood = [];
      for (const f of foodRef.current) {
        const player = f.team === 'p1' ? p1Ref.current : p2Ref.current;
        const dx = f.x - player.x; const dy = f.y - player.y;
        if (Math.sqrt(dx * dx + dy * dy) < player.size * 0.7 + FOOD_RADIUS) {
          player.size = Math.min(MAX_SIZE, player.size + FOOD_GROW);
          transport.removeFood(f.id);
        } else { remainingFood.push(f); }
      }
      foodRef.current = remainingFood;

      if (p1Ref.current.size <= MIN_SIZE) {
        transport.setGameState({ phase: 'ended', winner: 'p2' });
        setWinner('p2'); setGamePhase('ended');
      } else if (p2Ref.current.size <= MIN_SIZE) {
        transport.setGameState({ phase: 'ended', winner: 'p1' });
        setWinner('p1'); setGamePhase('ended');
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [gamePhase, transport]);

  const startGame = () => {
    p1Ref.current = { ...p1Ref.current, x: 0.22, y: 0.5, size: BASE_SIZE };
    p2Ref.current = { ...p2Ref.current, x: 0.78, y: 0.5, size: BASE_SIZE };
    projectilesRef.current = [];
    transport.setGameState({ phase: 'playing', winner: null });
    setGamePhase('playing');
  };

  const resetGame = () => {
    transport.resetRoom();
    setPlayers({ p1: null, p2: null }); setFood([]); setGamePhase('lobby'); setWinner(null);
    projectilesRef.current = [];
    p1Ref.current = { creature: null, x: 0.25, y: 0.5, size: BASE_SIZE };
    p2Ref.current = { creature: null, x: 0.75, y: 0.5, size: BASE_SIZE };
    onResetRoom?.();
  };

  const bothReady = players?.p1?.ready && players?.p2?.ready;
  const foodJoinUrl = getJoinUrl(room);
  const p1JoinUrl = getJoinUrl(room, '&team=p1');
  const p2JoinUrl = getJoinUrl(room, '&team=p2');

  return (
    <div className="battle-host-shell">
      <div className="battle-arena-wrap">
        <GameArena bgRef={bgRef} p1Ref={p1Ref} p2Ref={p2Ref} foodRef={foodRef} projectilesRef={projectilesRef} />
      </div>

      {gamePhase === 'lobby' && (
        <div className="battle-lobby-overlay">
          <div className="battle-lobby-card">
            <h2 className="battle-lobby-title">Battle Arena — Room {room}</h2>
            <div className="battle-qr-row">
              <div className="battle-qr-item">
                <div className="battle-qr-label" style={{ color: P1_COLOR }}>🔴 Player 1</div>
                <QRCodeSVG value={p1JoinUrl} size={120} bgColor="transparent" fgColor={P1_COLOR} />
                <div className="battle-qr-sub">{players?.p1?.ready ? '✓ Ready' : 'Scan · draw · control'}</div>
              </div>
              <div className="battle-qr-item">
                <div className="battle-qr-label" style={{ color: P2_COLOR }}>🔵 Player 2</div>
                <QRCodeSVG value={p2JoinUrl} size={120} bgColor="transparent" fgColor={P2_COLOR} />
                <div className="battle-qr-sub">{players?.p2?.ready ? '✓ Ready' : 'Scan · draw · control'}</div>
              </div>
              <div className="battle-qr-item">
                <div className="battle-qr-label" style={{ color: '#fff' }}>🍖 Send food</div>
                <QRCodeSVG value={foodJoinUrl} size={120} bgColor="transparent" fgColor="#ffffff" />
                <div className="battle-qr-sub">Draw food, pick a side</div>
              </div>
            </div>
            <button type="button" className="button battle-start-btn" onClick={startGame}
              disabled={!bothReady} title={bothReady ? '' : 'Waiting for both players'}>
              {bothReady ? '⚔️ Start Battle' : 'Waiting for players…'}
            </button>
          </div>
        </div>
      )}

      {gamePhase === 'ended' && (
        <div className="battle-win-overlay">
          <div className="battle-win-card">
            <div className="battle-win-emoji">🏆</div>
            <h2 className="battle-win-title" style={{ color: winner === 'p1' ? P1_COLOR : P2_COLOR }}>
              {winner === 'p1' ? '🔴 Player 1 Wins!' : '🔵 Player 2 Wins!'}
            </h2>
            <button type="button" className="button battle-start-btn" onClick={resetGame}>Play again</button>
          </div>
        </div>
      )}

      {/* Live cursor dots driven by phone positions */}
      {p1Cursor && gamePhase === 'playing' && (
        <div className="fingertip-cursor battle-p1-cursor" style={{ transform: `translate(calc(${p1Cursor.x * 100}vw - 50%), calc(${p1Cursor.y * 100}vh - 50%))` }} />
      )}
      {p2Cursor && gamePhase === 'playing' && (
        <div className="fingertip-cursor battle-p2-cursor" style={{ transform: `translate(calc(${p2Cursor.x * 100}vw - 50%), calc(${p2Cursor.y * 100}vh - 50%))` }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BattleParticipantView — draw creature or food, then control via camera
// ---------------------------------------------------------------------------
export function BattleParticipantView({ room, clientId, team }) {
  const transport = useMemo(() => createBattleTransport(room), [room]);
  const isPlayer = team === 'p1' || team === 'p2';
  const [controlling, setControlling] = useState(false);

  const handleCommit = (character, assignedTeam) => {
    if (isPlayer) {
      transport.setPlayerCreature(team, character);
      setControlling(true); // switch to camera controller mode
    } else {
      transport.submitFood({
        ...character,
        team: assignedTeam,
        x: 0.3 + Math.random() * 0.4,
        y: 0.2 + Math.random() * 0.6,
      });
    }
  };

  if (isPlayer && controlling) {
    return <PhoneController transport={transport} slot={team} />;
  }

  return (
    <div className="participant-shell">
      <div className="participant-header">
        <span className="pill">Room {room}</span>
        <span className="muted-text" style={{ fontSize: '0.8125rem' }}>
          {isPlayer
            ? `You are ${team === 'p1' ? '🔴 Player 1' : '🔵 Player 2'} — draw your creature`
            : 'Draw food — pick a side to give it to'}
        </span>
      </div>
      <BattleDrawingPad onCommit={handleCommit} isPlayer={isPlayer} playerSlot={team} />
    </div>
  );
}
