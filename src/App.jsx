import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { getDatabase, ref as dbRef, onValue, set, serverTimestamp } from 'firebase/database';
import { firebaseApp } from './firebase.js';

const CANVAS_W = 1200;
const CANVAS_H = 700;
const DEFAULT_COLOR = '#00D4FF';
const COLORS = ['#FFFFFF', '#00D4FF', '#F43F5E', '#10B981', '#FBBF24', '#A78BFA'];
const SHOWCASE_WIDTH_FRAC = 0.3; // 70% main / 30% showcase

function mainAquariumWidthPx() {
  return window.innerWidth * (1 - SHOWCASE_WIDTH_FRAC);
}

/** Host screen background art (see /public/bg-*.png). */
const HOST_BG_BY_SCENE = {
  water: '/bg-water.png',
  grass: '/bg-grass.png',
  stars: '/bg-starry.png',
};
/** Looping ambience per big-screen scene (files in /public). */
const HOST_MUSIC_BY_SCENE = {
  water: '/under-the-sea.mp3',
  grass: '/grass.mp3',
  stars: '/starry-sky.mp3',
};
const HOST_SCENE_OPTIONS = [
  { id: 'water', label: 'Aquarium' },
  { id: 'grass', label: 'Grass' },
  { id: 'stars', label: 'Starry sky' },
];

function normalizeRoomBackground(v) {
  if (v === 'grass' || v === 'stars' || v === 'water') return v;
  return 'water';
}

function getBrowserFullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

async function requestBrowserFullscreen(el) {
  if (!el) return;
  if (typeof el.requestFullscreen === 'function') await el.requestFullscreen();
  else if (typeof el.webkitRequestFullscreen === 'function') await el.webkitRequestFullscreen();
}

async function exitBrowserFullscreen() {
  if (typeof document.exitFullscreen === 'function') await document.exitFullscreen();
  else if (typeof document.webkitExitFullscreen === 'function') await document.webkitExitFullscreen();
}

function HudIconNewRoom() {
  return (
    <svg className="hud-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function HudIconFullscreenEnter() {
  return (
    <svg className="hud-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

function HudIconFullscreenExit() {
  return (
    <svg className="hud-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="M14 10l7-7" />
      <path d="M10 14l-7 7" />
    </svg>
  );
}

function HudIconMusic() {
  return (
    <svg className="hud-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="16" r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HudIconWebcam() {
  return (
    <svg className="hud-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function HudIconReleaseAll() {
  return (
    <svg className="hud-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

function drawCoverImage(ctx, img, destW, destH) {
  if (!img?.naturalWidth) return false;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const scale = Math.max(destW / iw, destH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (destW - dw) / 2;
  const dy = (destH - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
  return true;
}

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

/** True for phone / tablet widths; wide screens default to host, narrow to participant when URL does not specify. */
function isMobileViewport() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 1024px)').matches;
}

let cachedInitialAppState = null;
function getInitialAppStateOnce() {
  if (cachedInitialAppState === null) {
    const { room: urlRoom, mode: urlMode } = getUrlState();
    const modePinned = urlMode === 'host' || urlMode === 'participant';
    const mobile = isMobileViewport();

    if (modePinned) {
      let mode = urlMode;
      // Normalize share links to the intended device: host dashboard on wide screens, draw UI on phones.
      if (urlMode === 'host' && mobile) {
        mode = 'participant';
      } else if (urlMode === 'participant' && !mobile) {
        mode = 'host';
      }
      cachedInitialAppState = {
        room: urlRoom,
        mode,
        roomInput: urlRoom || '',
      };
    } else if (urlRoom) {
      cachedInitialAppState = {
        room: urlRoom,
        mode: 'participant',
        roomInput: urlRoom,
      };
    } else if (isMobileViewport()) {
      cachedInitialAppState = {
        room: '',
        mode: 'participant',
        roomInput: '',
      };
    } else {
      const next = makeId();
      cachedInitialAppState = {
        room: next,
        mode: 'host',
        roomInput: next,
      };
    }
  }
  return cachedInitialAppState;
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
// rooms/{roomId}/settings/background — big-screen scene (water | grass | stars).
// onValue listeners fire immediately with current data (catch-up) and then
// on every subsequent change, so no separate readState/writeState is needed.
// ---------------------------------------------------------------------------
function createTransport(roomId) {
  const db = getDatabase(firebaseApp);
  const strokesRef = dbRef(db, `rooms/${roomId}/strokes`);
  const presenceRef = dbRef(db, `rooms/${roomId}/presence`);
  const settingsBgRef = dbRef(db, `rooms/${roomId}/settings/background`);
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

  const unsubSettingsBg = onValue(settingsBgRef, (snapshot) => {
    handle({
      type: 'room:state',
      payload: { roomBackground: normalizeRoomBackground(snapshot.val()) },
    });
  });

  return {
    send(message) {
      if (message.type === 'character:add' || message.type === 'stroke:add') {
        const stroke = message.payload;
        set(dbRef(db, `rooms/${roomId}/strokes/${stroke.id}`), stroke);
      } else if (message.type === 'canvas:clear') {
        set(strokesRef, null);
      } else if (message.type === 'room:setBackground') {
        set(settingsBgRef, message.payload);
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
      unsubSettingsBg();
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
// cameraDeviceId — empty string = browser default (facingMode user when applicable).
// ---------------------------------------------------------------------------
function useHandTracking(enabled, cameraDeviceId = '') {
  const [fingertipPos, setFingertipPos] = useState(null);
  /** Bumping this tears down MediaPipe + camera and rebuilds (recover from stalled WASM / hung sends). */
  const [recoveryTick, setRecoveryTick] = useState(0);
  const pinchCbRef = useRef({ onStart: null, onEnd: null });
  const prevPinchRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setFingertipPos(null);
      return;
    }
    let active = true;
    const lastResultAtRef = { t: Date.now() };
    let sawResult = false;

    async function init() {
      try {
        prevPinchRef.current = false;
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
          sawResult = true;
          lastResultAtRef.t = Date.now();
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
          // Mirror x so it matches the user's perspective.
          // Remap a centred 55% band of the camera frame to the full screen so
          // the user doesn't have to move their hand to the very edge of frame.
          const CAM_PAD_X = 0.22;  // ignore outer 22% on each side horizontally
          const CAM_PAD_Y = 0.15;  // ignore outer 15% on each side vertically
          const normX = Math.max(0, Math.min(1, ((1 - tip.x) - CAM_PAD_X) / (1 - 2 * CAM_PAD_X)));
          const normY = Math.max(0, Math.min(1, (tip.y - CAM_PAD_Y) / (1 - 2 * CAM_PAD_Y)));
          const rawX = normX * window.innerWidth;
          const rawY = normY * window.innerHeight;
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

        const videoConstraints = cameraDeviceId
          ? {
              deviceId: { exact: cameraDeviceId },
              width: { ideal: 640 },
              height: { ideal: 480 },
            }
          : {
              width: { ideal: 640 },
              height: { ideal: 480 },
              facingMode: 'user',
            };

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
        });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }

        const video = document.createElement('video');
        video.srcObject = stream;
        video.playsInline = true;
        await video.play();

        const sendWithTimeout = (ms) => {
          const p = hands.send({ image: video });
          return Promise.race([
            p,
            new Promise((_, rej) => {
              setTimeout(() => rej(new Error('MediaPipe Hands send timed out')), ms);
            }),
          ]);
        };

        let rafId = 0;
        const STALL_MS = 4000;
        let recovering = false;
        let restartPending = false;

        const onVis = () => {
          if (document.visibilityState === 'visible') {
            lastResultAtRef.t = Date.now();
          }
        };
        document.addEventListener('visibilitychange', onVis);

        const bumpRecovery = () => {
          if (!active || recovering) return;
          recovering = true;
          restartPending = true;
          setRecoveryTick((n) => n + 1);
        };

        const onTrackEnded = () => bumpRecovery();
        stream.getVideoTracks()[0]?.addEventListener?.('ended', onTrackEnded);

        const loop = async () => {
          if (!active) return;
          try {
            const now = Date.now();
            if (
              document.visibilityState === 'visible'
              && sawResult
              && video.readyState >= 2
              && now - lastResultAtRef.t > STALL_MS
            ) {
              console.warn('Hand tracking: no results; restarting pipeline');
              bumpRecovery();
              return;
            }
            if (document.visibilityState !== 'hidden' && video.readyState >= 2) {
              await sendWithTimeout(2000);
            }
          } catch (e) {
            console.warn('hands.send:', e?.message || e);
          } finally {
            if (active && !restartPending) {
              rafId = requestAnimationFrame(() => { loop(); });
            }
          }
        };
        rafId = requestAnimationFrame(() => { loop(); });

        return () => {
          active = false;
          document.removeEventListener('visibilitychange', onVis);
          stream.getVideoTracks()[0]?.removeEventListener?.('ended', onTrackEnded);
          cancelAnimationFrame(rafId);
          try { hands.close(); } catch (_) { /* noop */ }
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
  }, [enabled, cameraDeviceId, recoveryTick]);

  return { fingertipPos, pinchCbRef };
}

// ---------------------------------------------------------------------------
// Shared room hook — manages strokes (now characters) + participants.
// ---------------------------------------------------------------------------
function useSharedRoom(roomId, client) {
  const [strokes, setStrokes] = useState([]);
  const [participants, setParticipants] = useState({});
  const [roomBackground, setRoomBackgroundState] = useState('water');
  const transportRef = useRef(null);

  useEffect(() => {
    if (!roomId) return undefined;

    // Clear stale state from the previous room before loading the new one.
    setStrokes([]);
    setParticipants({});
    setRoomBackgroundState('water');

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
        if (message.payload.roomBackground !== undefined) {
          setRoomBackgroundState(normalizeRoomBackground(message.payload.roomBackground));
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
    roomBackground,
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
    setRoomBackground(bg) {
      const b = normalizeRoomBackground(bg);
      setRoomBackgroundState(b);
      transportRef.current?.send({
        type: 'room:setBackground',
        clientId: client.clientId,
        payload: b,
      });
    },
  }), [strokes, participants, roomBackground, client.clientId]);
}


// ---------------------------------------------------------------------------
// Aquarium canvas — animated host display.
// heldIdRef   — ref to the id of a creature being dragged (skip its physics)
// heldPosRef  — ref to {x,y} normalised position of that creature
// positionsRef — ref that this component fills each frame with [{id,x,y}]
// teleportRef — ref set by HostView when a creature is dropped: {id, x, y}
//               normalised; AquariumCanvas consumes it and moves the creature
// scene      — key in HOST_BG_BY_SCENE (full-bleed art + vignette).
// ---------------------------------------------------------------------------
function AquariumCanvas({
  strokes,
  heldIdRef = null,
  heldPosRef = null,
  positionsRef = null,
  teleportRef = null,
  scene = 'water',
}) {
  const canvasRef = useRef(null);
  const charactersRef = useRef([]);
  const animRef = useRef(null);
  const knownIdsRef = useRef(new Set());
  const sceneRef = useRef(scene);
  const bgImgBySceneRef = useRef({}); // hydrated as each Image loads

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    Object.entries(HOST_BG_BY_SCENE).forEach(([id, src]) => {
      if (bgImgBySceneRef.current[id]?.complete) return;
      const img = new Image();
      img.src = src;
      bgImgBySceneRef.current[id] = img;
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fit = () => {
      canvas.width = canvas.parentElement?.offsetWidth || window.innerWidth;
      canvas.height = canvas.parentElement?.offsetHeight || window.innerHeight;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Sync incoming strokes → animated character entries.
  // Also removes creatures that have been taken out of strokes (e.g. dragged
  // to the side panel) so they don't linger in the animation loop.
  useEffect(() => {
    if (strokes.length === 0) {
      charactersRef.current = [];
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
          baseY: 0,
          waveFreq: 0.5 + Math.random() * 0.8,
          wavePhase: Math.random() * Math.PI * 2,
          waveAmp: 0.010 + Math.random() * 0.016,
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

      const scene = sceneRef.current;
      const bgImg = bgImgBySceneRef.current[scene];
      const drewBg = drawCoverImage(ctx, bgImg, W, H);

      if (!drewBg) {
        const fall = ctx.createLinearGradient(0, 0, 0, H);
        fall.addColorStop(0, '#142238');
        fall.addColorStop(1, '#080c14');
        ctx.fillStyle = fall;
        ctx.fillRect(0, 0, W, H);
      }

      if (!(scene === 'water' && drewBg)) {
        const vign = ctx.createLinearGradient(0, H * 0.5, 0, H);
        vign.addColorStop(0, 'rgba(0,0,0,0)');
        vign.addColorStop(1, 'rgba(5,10,22,0.45)');
        ctx.fillStyle = vign;
        ctx.fillRect(0, H * 0.52, W, H * 0.48);
      }

      // Extra water washes were for empty gradient only; skip when art is showing.
      if (scene === 'water' && !drewBg) {
        const floor = ctx.createLinearGradient(0, H * 0.82, 0, H);
        floor.addColorStop(0, 'rgba(5, 14, 24, 0)');
        floor.addColorStop(1, 'rgba(5, 14, 24, 0.5)');
        ctx.fillStyle = floor;
        ctx.fillRect(0, H * 0.82, W, H * 0.18);

        const surf = ctx.createLinearGradient(0, 0, 0, H * 0.28);
        surf.addColorStop(0, 'rgba(30, 110, 190, 0.12)');
        surf.addColorStop(1, 'rgba(30, 110, 190, 0)');
        ctx.fillStyle = surf;
        ctx.fillRect(0, 0, W, H * 0.28);
      }

      // Consume any pending teleport (creature dropped at a specific position).
      if (teleportRef?.current) {
        const { id, x, y } = teleportRef.current;
        teleportRef.current = null;
        const tc = charactersRef.current.find((c) => c.id === id);
        if (tc) { tc.x = x; tc.y = y; tc.baseY = y; tc.phase = 'swim'; }
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
          }
          drawCharacterAt(ctx, c.character, c.x * W, c.y * H, charSize, 0);
        } else {
          c.x += c.dir * c.speed;
          if (c.x <= 0.04) { c.x = 0.04; c.dir = 1; }
          if (c.x >= 0.96) { c.x = 0.96; c.dir = -1; }

          // Vertical undulation via sine wave — each creature has its own
          // frequency, amplitude and phase so nothing moves in sync.
          c.y = c.baseY + Math.sin(t * c.waveFreq * Math.PI * 2 + c.wavePhase) * c.waveAmp;

          // Facing direction: mirror horizontally when going left, no tilt.
          drawCharacterAt(ctx, c.character, c.x * W, c.y * H, charSize, c.dir === -1 ? Math.PI : 0);
        }
      }

      // Export normalised creature positions for drag hit-testing.
      if (positionsRef) {
        positionsRef.current = charactersRef.current.map((c) => ({ id: c.id, x: c.x, y: c.y }));
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
function SideAquarium({ creatures, onReleaseAll, scene = 'water', joinUrl, room }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const src = HOST_BG_BY_SCENE[scene] || HOST_BG_BY_SCENE.water;

    const paint = (img) => {
      if (img && drawCoverImage(ctx, img, W, H)) {
        if (scene === 'water') {
          const v = ctx.createLinearGradient(0, H * 0.5, 0, H);
          v.addColorStop(0, 'rgba(0,0,0,0)');
          v.addColorStop(1, 'rgba(5,10,22,0.22)');
          ctx.fillStyle = v;
          ctx.fillRect(0, H * 0.45, W, H * 0.55);
        } else {
          const v = ctx.createLinearGradient(0, H * 0.45, 0, H);
          v.addColorStop(0, 'rgba(0,0,0,0)');
          v.addColorStop(1, 'rgba(5,10,22,0.55)');
          ctx.fillStyle = v;
          ctx.fillRect(0, H * 0.4, W, H * 0.6);
        }
      } else {
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#0a1a30');
        bg.addColorStop(1, '#050e18');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
      }

      if (!creatures.length) {
        return;
      }

      const size = Math.min(W * 0.6, 72);
      creatures.forEach((creature) => {
        const cx = Math.max(size / 2, Math.min(W - size / 2, creature.dropX ?? W / 2));
        const cy = Math.max(size / 2, Math.min(H - size / 2, creature.dropY ?? H / 2));
        ctx.save();
        ctx.shadowColor = 'rgba(0, 212, 255, 0.45)';
        ctx.shadowBlur = 22;
        drawCharacterAt(ctx, creature, cx, cy, size, 0);
        ctx.restore();
      });
    };

    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (!cancelled) paint(img);
    };
    img.src = src;
    if (img.complete && img.naturalWidth) paint(img);
    return () => {
      cancelled = true;
    };
  }, [creatures, scene]);

  return (
    <div className="side-panel">
      <div className="side-panel-body">
        <div className="side-panel-stage">
          {creatures.length > 0 && (
            <button
              type="button"
              className="side-panel-release"
              onClick={onReleaseAll}
              aria-label="Release all creatures to main screen"
              title="Release all"
            >
              <HudIconReleaseAll />
            </button>
          )}
          <canvas ref={canvasRef} className="side-canvas" />
        </div>
        {joinUrl && room ? (
          <div className="side-panel-qr" aria-label="Room QR code">
            <div className="qr-corner qr-corner--embedded">
              <div className="qr-label">Scan to join</div>
              <QRCodeSVG value={joinUrl} size={96} bgColor="transparent" fgColor="#ffffff" />
              <div className="qr-room">{room}</div>
            </div>
          </div>
        ) : null}
      </div>
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
  const [cameraDeviceId, setCameraDeviceId] = useState(() => {
    try {
      return sessionStorage.getItem('hostVideoDeviceId') || '';
    } catch (_) {
      return '';
    }
  });
  const [videoInputs, setVideoInputs] = useState([]);
  const audioRef = useRef(null);
  const cameraSelectRef = useRef(null);
  const hostRootRef = useRef(null);
  const [hostFullscreen, setHostFullscreen] = useState(false);
  const [hudIdleHidden, setHudIdleHidden] = useState(false);
  const hudIdleTimerRef = useRef(null);

  useEffect(() => {
    const sync = () => {
      const el = getBrowserFullscreenElement();
      setHostFullscreen(!!hostRootRef.current && el === hostRootRef.current);
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
    };
  }, []);

  const clearHudIdleTimer = useCallback(() => {
    if (hudIdleTimerRef.current != null) {
      clearTimeout(hudIdleTimerRef.current);
      hudIdleTimerRef.current = null;
    }
  }, []);

  const bumpHudActivity = useCallback(() => {
    setHudIdleHidden(false);
    if (hudIdleTimerRef.current != null) clearTimeout(hudIdleTimerRef.current);
    hudIdleTimerRef.current = window.setTimeout(() => {
      hudIdleTimerRef.current = null;
      setHudIdleHidden(true);
    }, 2800);
  }, []);

  useEffect(() => {
    bumpHudActivity();
    const onActivity = () => bumpHudActivity();
    const opts = { passive: true };
    window.addEventListener('mousemove', onActivity, opts);
    window.addEventListener('mousedown', onActivity, opts);
    window.addEventListener('wheel', onActivity, opts);
    window.addEventListener('keydown', onActivity);
    window.addEventListener('touchstart', onActivity, opts);
    return () => {
      clearHudIdleTimer();
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('mousedown', onActivity);
      window.removeEventListener('wheel', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('touchstart', onActivity);
    };
  }, [bumpHudActivity, clearHudIdleTimer]);

  useEffect(() => {
    try {
      sessionStorage.setItem('hostVideoDeviceId', cameraDeviceId || '');
    } catch (_) { /* noop */ }
  }, [cameraDeviceId]);

  const refreshVideoDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setVideoInputs(list.filter((d) => d.kind === 'videoinput'));
    } catch (_) { /* noop */ }
  }, []);

  useEffect(() => {
    refreshVideoDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refreshVideoDevices);
    return () => md?.removeEventListener?.('devicechange', refreshVideoDevices);
  }, [refreshVideoDevices]);

  useEffect(() => {
    if (!handEnabled) return;
    const t = window.setTimeout(refreshVideoDevices, 400);
    return () => clearTimeout(t);
  }, [handEnabled, refreshVideoDevices]);

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

  useEffect(() => {
    heldIdRef.current = null;
    heldPosRef.current = null;
    teleportRef.current = null;
    setHeldCreature(null);
    hiddenIdsRef.current = new Set();
    setHiddenIds(new Set());
    setSideCreatures([]);
  }, [room]);

  // ── Hand tracking ─────────────────────────────────────────────────────────
  const { fingertipPos, pinchCbRef } = useHandTracking(handEnabled, cameraDeviceId);

  // Keep heldPos in sync with the fingertip while dragging.
  useEffect(() => {
    if (!heldIdRef.current || !fingertipPos) return;
    const canvasW = mainAquariumWidthPx();
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
      const canvasW = mainAquariumWidthPx();
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
      const canvasW = mainAquariumWidthPx();

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

  const musicSrc =
    HOST_MUSIC_BY_SCENE[normalizeRoomBackground(shared.roomBackground)] ?? HOST_MUSIC_BY_SCENE.water;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const wasPlaying = !audio.paused;
    audio.src = musicSrc;
    audio.load();
    if (wasPlaying) {
      audio.volume = 0.4;
      audio.play().catch(() => setPlaying(false));
    }
  }, [musicSrc]);

  const toggleMusic = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else { audio.volume = 0.4; audio.play().catch(() => {}); setPlaying(true); }
  };

  const toggleHostFullscreen = useCallback(async () => {
    const root = hostRootRef.current;
    if (!root) return;
    try {
      if (getBrowserFullscreenElement() === root) await exitBrowserFullscreen();
      else await requestBrowserFullscreen(root);
    } catch (err) {
      console.warn('Fullscreen:', err);
    }
  }, []);

  const visibleStrokes = shared.strokes.filter((s) => !hiddenIds.has(s.id));

  return (
    <div
      className={`host-fullscreen${hudIdleHidden ? ' host-fullscreen--ui-idle' : ''}`}
      ref={hostRootRef}
    >
      <audio ref={audioRef} loop preload="metadata" />

      <div className="host-layout">
        <div className="aquarium-wrapper">
          <AquariumCanvas
            key={room}
            strokes={visibleStrokes}
            heldIdRef={heldIdRef}
            heldPosRef={heldPosRef}
            positionsRef={creaturePositionsRef}
            teleportRef={teleportRef}
            scene={shared.roomBackground}
          />
        </div>
        <SideAquarium
          creatures={sideCreatures}
          scene={shared.roomBackground}
          joinUrl={joinUrl}
          room={room}
          onReleaseAll={() => {
            setSideCreatures([]);
            hiddenIdsRef.current = new Set();
            setHiddenIds(new Set());
          }}
        />
      </div>

      <div
        className={`host-hud${hudIdleHidden ? ' host-hud--idle-hidden' : ''}`}
        aria-hidden={hudIdleHidden}
      >
        <button
          type="button"
          className="hud-btn hud-btn--icon"
          onClick={onResetRoom}
          aria-label="New room"
          title="New room"
        >
          <HudIconNewRoom />
        </button>
        <span className="hud-divider" />
        <button
          type="button"
          className="hud-btn hud-btn--icon"
          onClick={toggleHostFullscreen}
          aria-label={hostFullscreen ? 'Exit full screen' : 'Full screen'}
          title={hostFullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {hostFullscreen ? <HudIconFullscreenExit /> : <HudIconFullscreenEnter />}
        </button>
        <span className="hud-divider" />
        <button
          type="button"
          className={`hud-btn hud-btn--icon${playing ? ' hud-btn-active' : ''}`}
          onClick={toggleMusic}
          aria-label={playing ? 'Pause music' : 'Play music'}
          title={playing ? 'Pause music' : 'Play music'}
        >
          <HudIconMusic />
        </button>
        <span className="hud-divider" />
        <div className="hud-camera-control">
          <button
            type="button"
            className={`hud-btn hud-btn--icon${handEnabled ? ' hud-btn-active' : ''}`}
            onClick={() => setHandEnabled((v) => !v)}
            onContextMenu={(e) => {
              e.preventDefault();
              const sel = cameraSelectRef.current;
              if (!sel) return;
              Promise.resolve(refreshVideoDevices()).then(() => {
                if (typeof sel.showPicker === 'function') {
                  sel.showPicker().catch(() => { try { sel.click(); } catch (_) { /* noop */ } });
                } else {
                  try { sel.click(); } catch (_) { /* noop */ }
                }
              });
            }}
            title="Tap: hand tracking on/off · Right-click: choose webcam"
            aria-label="Hand tracking and webcam. Toggle on click. Right-click to choose camera."
            aria-pressed={handEnabled}
          >
            <HudIconWebcam />
          </button>
          <select
            ref={cameraSelectRef}
            className="hud-select hud-select--camera-hidden"
            value={cameraDeviceId}
            onChange={(e) => setCameraDeviceId(e.target.value)}
            aria-hidden
            tabIndex={-1}
            title="Choose webcam"
          >
            <option value="">Default camera</option>
            {videoInputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label?.trim() ? d.label : `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
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
        <div className="participant-scene-wrap">
          <select
            className="participant-scene-select"
            value={shared.roomBackground}
            onChange={(e) => shared.setRoomBackground(e.target.value)}
            aria-label="Big screen background"
            title="Change the big screen background"
          >
            {HOST_SCENE_OPTIONS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
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
  const initial = getInitialAppStateOnce();
  const [room, setRoom] = useState(initial.room);
  const [mode, setMode] = useState(initial.mode);
  const [roomInput, setRoomInput] = useState(initial.roomInput);
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
