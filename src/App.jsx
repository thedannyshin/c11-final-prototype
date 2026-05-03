import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  getDatabase,
  ref as dbRef,
  onValue,
  set,
  update,
  get,
  remove,
  serverTimestamp,
  runTransaction,
} from 'firebase/database';
import { firebaseApp } from './firebase.js';

const CANVAS_W = 1200;
const CANVAS_H = 700;
const DEFAULT_COLOR = '#00D4FF';
const COLORS = ['#FFFFFF', '#00D4FF', '#F43F5E', '#10B981', '#FBBF24', '#A78BFA'];
const SHOWCASE_WIDTH_FRAC = 0.3; // 70% main / 30% showcase

const GAME_ROUND_MS = 2 * 60 * 1000;
const GAME_POINTS_DRAW = 10;
const GAME_POINTS_MOVE = 10;

/** Firebase RTDB rooms/{id} deleted if meta.touchedAt missing (legacy) or older than this. */
const ROOM_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Bump meta.touchedAt while any client is connected (server timestamps). */
const ROOM_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const GAME_PHASES = [
  'splash',
  'countdown_team1',
  'team1',
  'results_team1',
  'countdown_team2',
  'team2',
  'results_team2',
  'final',
];

function defaultGameState() {
  return {
    phase: 'splash',
    team1Score: 0,
    team2Score: 0,
    roundEndAt: null,
    countdownStep: null,
  };
}

function normalizeGameState(raw) {
  if (!raw || typeof raw !== 'object') return defaultGameState();
  let phase = raw.phase;
  const legacyMap = { idle: 'splash', between: 'splash', done: 'final' };
  if (legacyMap[phase]) phase = legacyMap[phase];
  if (!GAME_PHASES.includes(phase)) phase = 'splash';
  let countdownStep = raw.countdownStep;
  if (countdownStep === '' || Number.isNaN(Number(countdownStep))) countdownStep = null;
  else countdownStep = Math.min(4, Math.max(0, Number(countdownStep)));
  return {
    phase,
    team1Score: Math.max(0, Number(raw.team1Score) || 0),
    team2Score: Math.max(0, Number(raw.team2Score) || 0),
    roundEndAt: raw.roundEndAt == null || raw.roundEndAt === '' ? null : Number(raw.roundEndAt),
    countdownStep,
  };
}

/** Big on-screen text during synced countdown (0 = Get Ready, 1–3 = numbers, 4 = Go). */
function getCountdownDisplay(game) {
  const step = game.countdownStep == null ? 0 : game.countdownStep;
  const teamLine =
    game.phase === 'countdown_team1' ? 'Get ready — Team 1' : 'Get ready — Team 2';
  if (step === 0) return { line1: teamLine, line2: null };
  if (step === 1) return { line1: '3', line2: null };
  if (step === 2) return { line1: '2', line2: null };
  if (step === 3) return { line1: '1', line2: null };
  return { line1: 'Go!', line2: null };
}

function getWinnerPhrase(team1Score, team2Score) {
  if (team1Score === team2Score) return "It's a tie!";
  return team1Score > team2Score ? 'Team 1 wins!' : 'Team 2 wins!';
}

const CLOCKIT_LOGO_PATH = '/clockit-logo.png';

/** Logo image — only width is scaled; height stays auto so aspect ratio is unchanged */
function ClockItLogo({ variant = 'default', className = '' }) {
  const mod =
    variant === 'small' ? 'clockit-logo--small' : variant === 'phone' ? 'clockit-logo--phone' : '';
  return (
    <img
      src={CLOCKIT_LOGO_PATH}
      alt="ClockIt"
      className={['clockit-logo', mod, className].filter(Boolean).join(' ')}
      decoding="async"
    />
  );
}

function formatRoundClock(roundEndAt) {
  if (roundEndAt == null) return '—';
  const sec = Math.max(0, Math.ceil((roundEndAt - Date.now()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function mainAquariumWidthPx() {
  return window.innerWidth * (1 - SHOWCASE_WIDTH_FRAC);
}

/** Host screen background art in /public — all scenes are 1920×1240 (~1.55:1) for consistent sizing. */
const HOST_BG_BY_SCENE = {
  water: '/bg-water.png',
  grass: '/bg-grass.png',
  stars: '/bg-starry.jpg',
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

/** Crossfade / zoom / rotate timing — host AquariumCanvas splash + phone splash backdrop */
const SPLASH_CROSSFADE_MS = 1100;
const SPLASH_ZOOM_CYCLE_MS = 4500;
const SPLASH_ZOOM_AMOUNT = 0.07;

function normalizeRoomBackground(v) {
  if (v === 'grass' || v === 'stars' || v === 'water') return v;
  return 'water';
}

/** Load + decode all scene images so participant/host switches hit cache (important on mobile). */
function preloadSceneBackgroundArt() {
  Object.values(HOST_BG_BY_SCENE).forEach((src) => {
    const img = new Image();
    img.onload = () => {
      img.decode?.().catch(() => {});
    };
    img.onerror = () => {};
    img.src = src;
  });
  const logo = new Image();
  logo.src = CLOCKIT_LOGO_PATH;
}

/** Phone splash: cycles scene art + crossfade + zoom until host locks a background in Firebase. */
function ParticipantSplashBackdrop({ active, lockedSceneId }) {
  const [idx, setIdx] = useState(0);
  const [blend, setBlend] = useState(0);

  const slideshow = active && lockedSceneId == null;

  useEffect(() => {
    if (!slideshow) {
      setIdx(0);
      setBlend(0);
      return undefined;
    }
    setIdx(0);
    setBlend(0);
    const id = window.setInterval(() => {
      setBlend(1);
      window.setTimeout(() => {
        setIdx((i) => (i + 1) % HOST_SCENE_OPTIONS.length);
        setBlend(0);
      }, SPLASH_CROSSFADE_MS);
    }, SPLASH_ZOOM_CYCLE_MS);
    return () => window.clearInterval(id);
  }, [slideshow]);

  if (!active) return null;

  const tf = `opacity ${SPLASH_CROSSFADE_MS}ms cubic-bezier(0.65, 0, 0.35, 1)`;

  if (lockedSceneId != null) {
    const id = normalizeRoomBackground(lockedSceneId);
    return (
      <div className="participant-splash-bg" aria-hidden>
        <div className="participant-splash-bg-zoom">
          <div
            className="participant-splash-bg-layer"
            data-scene={id}
            style={{
              opacity: 1,
              backgroundImage: `url('${HOST_BG_BY_SCENE[id]}')`,
            }}
          />
        </div>
      </div>
    );
  }

  const n = HOST_SCENE_OPTIONS.length;
  const sceneBottom = HOST_SCENE_OPTIONS[idx].id;
  const sceneTop = HOST_SCENE_OPTIONS[(idx + 1) % n].id;
  const urlBottom = HOST_BG_BY_SCENE[sceneBottom];
  const urlTop = HOST_BG_BY_SCENE[sceneTop];

  return (
    <div className="participant-splash-bg" aria-hidden>
      <div className="participant-splash-bg-zoom">
        <div
          className="participant-splash-bg-layer"
          data-scene={sceneBottom}
          style={{
            opacity: 1 - blend,
            backgroundImage: `url('${urlBottom}')`,
            transition: tf,
          }}
        />
        <div
          className="participant-splash-bg-layer"
          data-scene={sceneTop}
          style={{
            opacity: blend,
            backgroundImage: `url('${urlTop}')`,
            transition: tf,
          }}
        />
      </div>
    </div>
  );
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

function HudIconMusicOff() {
  return (
    <svg className="hud-icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" fill="currentColor" stroke="none" />
      <circle cx="18" cy="16" r="3" fill="currentColor" stroke="none" />
      {/* Inset diagonal so the slash “floats” with clear space from the notes and frame */}
      <line
        x1="6.5"
        y1="17.5"
        x2="17.5"
        y2="6.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
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

/** Cover-fit like drawCoverImage with extra zoom (>1 = Ken Burns–style push-in). */
function drawCoverImageZoomed(ctx, img, destW, destH, zoom = 1) {
  if (!img?.naturalWidth) return false;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const base = Math.max(destW / iw, destH / ih);
  const scale = base * zoom;
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

/** Roster: sorted participant clientIds → first = Team 1, second = Team 2; max one phone per team (2 total). */
function computeAutoParticipantTeam(clientId, participants) {
  const ids = Object.keys(participants || {})
    .filter((id) => (participants[id]?.role || '') === 'participant')
    .sort();
  const idx = ids.indexOf(clientId);
  if (idx < 0) return null;
  if (idx >= 2) return null;
  return idx === 0 ? 1 : 2;
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
// rooms/{roomId}/meta/touchedAt — session TTL (see ROOM_SESSION_TTL_MS).
// onValue listeners fire immediately with current data (catch-up) and then
// on every subsequent change, so no separate readState/writeState is needed.
// ---------------------------------------------------------------------------
function coerceFirebaseMillis(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  return null;
}

async function pruneExpiredRoom(db, roomId) {
  const roomRoot = dbRef(db, `rooms/${roomId}`);
  const metaRef = dbRef(db, `rooms/${roomId}/meta`);

  let metaSnap;
  try {
    metaSnap = await get(metaRef);
  } catch (err) {
    console.warn('Room session read:', err?.message || err);
    return;
  }

  if (metaSnap.exists()) {
    const touchedAt = coerceFirebaseMillis(metaSnap.val()?.touchedAt);
    if (touchedAt == null) {
      await remove(roomRoot);
      return;
    }
    if (Date.now() - touchedAt > ROOM_SESSION_TTL_MS) {
      await remove(roomRoot);
    }
    return;
  }

  let rootSnap;
  try {
    rootSnap = await get(roomRoot);
  } catch (err) {
    console.warn('Room session read:', err?.message || err);
    return;
  }
  if (!rootSnap.exists()) return;

  await remove(roomRoot);
}

function createTransport(roomId) {
  const db = getDatabase(firebaseApp);
  const strokesRef = dbRef(db, `rooms/${roomId}/strokes`);
  const presenceRef = dbRef(db, `rooms/${roomId}/presence`);
  const settingsBgRef = dbRef(db, `rooms/${roomId}/settings/background`);
  const gameRef = dbRef(db, `rooms/${roomId}/game`);
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
    const raw = snapshot.val();
    handle({
      type: 'room:state',
      payload: {
        roomBackground: normalizeRoomBackground(raw),
        /** False until host writes a scene — distinguishes “not chosen yet” from explicit water */
        roomBackgroundExplicit: raw != null,
      },
    });
  });

  const unsubGame = onValue(gameRef, (snapshot) => {
    handle({
      type: 'room:state',
      payload: { game: normalizeGameState(snapshot.val()) },
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
      } else if (message.type === 'game:increment') {
        const { team, delta } = message.payload;
        runTransaction(gameRef, (curr) => {
          const g = normalizeGameState(curr);
          if (team === 1) g.team1Score = (g.team1Score || 0) + delta;
          else if (team === 2) g.team2Score = (g.team2Score || 0) + delta;
          return g;
        });
      } else if (message.type === 'game:update') {
        update(gameRef, message.payload);
      } else if (message.type === 'game:set') {
        set(gameRef, message.payload);
      } else if (message.type === 'room:touch') {
        update(dbRef(db, `rooms/${roomId}/meta`), { touchedAt: serverTimestamp() });
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
      unsubGame();
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
  const [roomBackgroundExplicit, setRoomBackgroundExplicit] = useState(false);
  const [game, setGame] = useState(defaultGameState);
  const transportRef = useRef(null);
  const gameRef = useRef(game);
  gameRef.current = game;
  const presencePayloadRef = useRef({
    name: client.name,
    role: client.role,
    color: client.color,
  });
  presencePayloadRef.current = {
    name: client.name,
    role: client.role,
    color: client.color,
  };

  function sendPresencePayload(transport) {
    const p = presencePayloadRef.current;
    transport.send({
      type: 'presence:update',
      clientId: client.clientId,
      payload: { name: p.name, role: p.role, color: p.color },
    });
  }

  useEffect(() => {
    if (!roomId) return undefined;

    // Clear stale state from the previous room before loading the new one.
    setStrokes([]);
    setParticipants({});
    setRoomBackgroundState('water');
    setRoomBackgroundExplicit(false);
    setGame(defaultGameState());

    transportRef.current = null;

    let cancelled = false;
    let transport = null;
    let unsub = null;
    let heartbeat = null;
    let touchClock = null;

    const attachRoom = () => {
      if (cancelled) return;
      transport = createTransport(roomId);
      transportRef.current = transport;
      transport.send({ type: 'room:touch', clientId: client.clientId });

      const initial = transport.readState();
      if (initial?.payload?.strokes) setStrokes(initial.payload.strokes);
      if (initial?.payload?.participants) setParticipants(initial.payload.participants);

      unsub = transport.subscribe((message) => {
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
          if (message.payload.roomBackgroundExplicit !== undefined) {
            setRoomBackgroundExplicit(!!message.payload.roomBackgroundExplicit);
          }
          if (message.payload.game !== undefined) {
            setGame(normalizeGameState(message.payload.game));
          }
        }
      });

      heartbeat = setInterval(() => {
        sendPresencePayload(transport);
      }, 2000);

      touchClock = setInterval(() => {
        transport.send({ type: 'room:touch', clientId: client.clientId });
      }, ROOM_TOUCH_INTERVAL_MS);
    };

    const db = getDatabase(firebaseApp);
    (async () => {
      try {
        await pruneExpiredRoom(db, roomId);
      } catch (err) {
        console.warn('Room session prune:', err?.message || err);
      }
      if (cancelled) return;
      attachRoom();
    })();

    return () => {
      cancelled = true;
      if (heartbeat != null) clearInterval(heartbeat);
      if (touchClock != null) clearInterval(touchClock);
      unsub?.();
      transport?.destroy();
      transportRef.current = null;
    };
  }, [roomId, client.clientId]);

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

  const sendCanvasClear = useCallback(() => {
    setStrokes([]);
    transportRef.current?.send({ type: 'canvas:clear', clientId: client.clientId, payload: null });
  }, [client.clientId]);

  return useMemo(() => ({
    strokes,
    participants,
    roomBackground,
    roomBackgroundExplicit,
    game,
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
      const g = gameRef.current;
      if (g.phase === 'team1') {
        transportRef.current?.send({
          type: 'game:increment',
          payload: { team: 1, delta: GAME_POINTS_DRAW },
        });
      } else if (g.phase === 'team2') {
        transportRef.current?.send({
          type: 'game:increment',
          payload: { team: 2, delta: GAME_POINTS_DRAW },
        });
      }
    },
    clearCanvas: sendCanvasClear,
    awardRelocatePoints() {
      const g = gameRef.current;
      if (g.phase === 'team1') {
        transportRef.current?.send({
          type: 'game:increment',
          payload: { team: 1, delta: GAME_POINTS_MOVE },
        });
      } else if (g.phase === 'team2') {
        transportRef.current?.send({
          type: 'game:increment',
          payload: { team: 2, delta: GAME_POINTS_MOVE },
        });
      }
    },
    gameSetCountdownStep(step) {
      transportRef.current?.send({
        type: 'game:update',
        payload: { countdownStep: Math.min(4, Math.max(0, step)) },
      });
    },
    /** Splash → countdown Team 1 (scores reset). Clears all drawings. */
    gamePlayFromSplash() {
      sendCanvasClear();
      transportRef.current?.send({
        type: 'game:set',
        payload: {
          phase: 'countdown_team1',
          team1Score: 0,
          team2Score: 0,
          countdownStep: 0,
          roundEndAt: null,
        },
      });
    },
    /** After 3–2–1–Go — start the 2:00 round (canvas cleared). */
    gameStartPlayRound(teamNum) {
      sendCanvasClear();
      transportRef.current?.send({
        type: 'game:update',
        payload: {
          phase: teamNum === 1 ? 'team1' : 'team2',
          roundEndAt: Date.now() + GAME_ROUND_MS,
          countdownStep: null,
        },
      });
    },
    gameEndActiveRound() {
      const g = gameRef.current;
      if (g.phase === 'team1') {
        sendCanvasClear();
        transportRef.current?.send({
          type: 'game:update',
          payload: { phase: 'results_team1', roundEndAt: null, countdownStep: null },
        });
      } else if (g.phase === 'team2') {
        sendCanvasClear();
        transportRef.current?.send({
          type: 'game:update',
          payload: { phase: 'results_team2', roundEndAt: null, countdownStep: null },
        });
      }
    },
    /** Results team 1 → countdown team 2. Clears drawings between teams. */
    gameContinueToTeam2() {
      sendCanvasClear();
      transportRef.current?.send({
        type: 'game:update',
        payload: { phase: 'countdown_team2', countdownStep: 0, roundEndAt: null },
      });
    },
    /** Results team 2 → final scoreboard. */
    gameContinueToFinal() {
      transportRef.current?.send({
        type: 'game:update',
        payload: { phase: 'final', roundEndAt: null, countdownStep: null },
      });
    },
    gameBackToSplash() {
      sendCanvasClear();
      transportRef.current?.send({
        type: 'game:set',
        payload: defaultGameState(),
      });
    },
    gameResetMatch() {
      sendCanvasClear();
      transportRef.current?.send({
        type: 'game:set',
        payload: defaultGameState(),
      });
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
  }), [strokes, participants, roomBackground, roomBackgroundExplicit, game, client.clientId, sendCanvasClear]);
}


// ---------------------------------------------------------------------------
// Aquarium canvas — animated host display.
// heldIdRef   — ref to the id of a creature being dragged (skip its physics)
// heldPosRef  — ref to {x,y} normalised position of that creature
// positionsRef — ref that this component fills each frame with [{id,x,y}]
// teleportRef — ref set by HostView when a creature is dropped: {id, x, y}
//               normalised; AquariumCanvas consumes it and moves the creature
// scene            — key in HOST_BG_BY_SCENE (full-bleed art + vignette).
// splashBgEffects  — when true, crossfade + slow zoom while splash preview rotates.
// ---------------------------------------------------------------------------
function AquariumCanvas({
  strokes,
  heldIdRef = null,
  heldPosRef = null,
  positionsRef = null,
  teleportRef = null,
  scene = 'water',
  splashBgEffects = false,
}) {
  const canvasRef = useRef(null);
  const charactersRef = useRef([]);
  const animRef = useRef(null);
  const knownIdsRef = useRef(new Set());
  const sceneRef = useRef(scene);
  const splashFxRef = useRef(splashBgEffects);
  const bgImgBySceneRef = useRef({}); // hydrated as each Image loads

  useEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  useEffect(() => {
    splashFxRef.current = splashBgEffects;
  }, [splashBgEffects]);

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

    let committedScene = sceneRef.current;
    let fade = null; // { from, to, startTs, zoomOut }
    let segmentStart = performance.now();

    const frame = (ts) => {
      if (!startTime) startTime = ts;
      const t = (ts - startTime) / 1000;
      const W = canvas.width;
      const H = canvas.height;

      const target = sceneRef.current;
      const splashFx = splashFxRef.current;

      let drewBg = false;
      let vignetteScene = target;

      if (splashFx) {
        if (!fade && target !== committedScene) {
          const zNow = 1 + SPLASH_ZOOM_AMOUNT * Math.min(1, (ts - segmentStart) / SPLASH_ZOOM_CYCLE_MS);
          fade = { from: committedScene, to: target, startTs: ts, zoomOut: zNow };
        }

        if (fade) {
          const raw = Math.min(1, (ts - fade.startTs) / SPLASH_CROSSFADE_MS);
          const u = raw * raw * (3 - 2 * raw);
          const imgOut = bgImgBySceneRef.current[fade.from];
          const imgIn = bgImgBySceneRef.current[fade.to];
          const zoomIn = 1 + SPLASH_ZOOM_AMOUNT * Math.min(1, (ts - fade.startTs) / SPLASH_ZOOM_CYCLE_MS);

          ctx.save();
          ctx.globalAlpha = 1 - u;
          drewBg = (imgOut && drawCoverImageZoomed(ctx, imgOut, W, H, fade.zoomOut)) || drewBg;
          ctx.restore();
          ctx.save();
          ctx.globalAlpha = u;
          drewBg = (imgIn && drawCoverImageZoomed(ctx, imgIn, W, H, zoomIn)) || drewBg;
          ctx.restore();
          ctx.globalAlpha = 1;

          if (u >= 1) {
            committedScene = fade.to;
            // Keep zoom continuous: without this, zoom snaps back to 1 because segmentStart
            // would equal `ts` while the incoming layer ended the fade partly zoomed-in.
            const elapsedInFade = Math.max(0, Math.min(SPLASH_CROSSFADE_MS, ts - fade.startTs));
            const zoomProgress = Math.min(1, elapsedInFade / SPLASH_ZOOM_CYCLE_MS);
            segmentStart = ts - zoomProgress * SPLASH_ZOOM_CYCLE_MS;
            fade = null;
          }
          vignetteScene = fade ? fade.to : committedScene;
        } else {
          const zoom = 1 + SPLASH_ZOOM_AMOUNT * Math.min(1, (ts - segmentStart) / SPLASH_ZOOM_CYCLE_MS);
          const bgImg = bgImgBySceneRef.current[committedScene];
          drewBg = drawCoverImageZoomed(ctx, bgImg, W, H, zoom);
          vignetteScene = committedScene;
        }
      } else {
        fade = null;
        committedScene = target;
        const bgImg = bgImgBySceneRef.current[target];
        drewBg = drawCoverImage(ctx, bgImg, W, H);
        vignetteScene = target;
      }

      if (!drewBg) {
        const fall = ctx.createLinearGradient(0, 0, 0, H);
        fall.addColorStop(0, '#142238');
        fall.addColorStop(1, '#080c14');
        ctx.fillStyle = fall;
        ctx.fillRect(0, 0, W, H);
      }

      if (!(vignetteScene === 'water' && drewBg)) {
        const vign = ctx.createLinearGradient(0, H * 0.5, 0, H);
        vign.addColorStop(0, 'rgba(0,0,0,0)');
        vign.addColorStop(1, 'rgba(5,10,22,0.45)');
        ctx.fillStyle = vign;
        ctx.fillRect(0, H * 0.52, W, H * 0.48);
      }

      // Extra water washes were for empty gradient only; skip when art is showing.
      if (vignetteScene === 'water' && !drewBg) {
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
  }, [splashBgEffects]);

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
function SideAquarium({ creatures, scene = 'water' }) {
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
function DrawingPad({ onCommit, overlay = null }) {
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
    ocCtx.clearRect(0, 0, w, h);
    for (const path of submittedRef.current) {
      ocCtx.save();
      drawPath(ocCtx, path.points.map((p) => ({ x: p.x * w, y: p.y * h })), path.color, path.size);
      ocCtx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
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
    ctx.clearRect(0, 0, w, h);
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
      <div className="drawing-pad-frame">
        {overlay ? <div className="drawing-pad-overlay">{overlay}</div> : null}
        <div className="drawing-pad-bg" aria-hidden />
        <canvas
          ref={canvasRef}
          className="drawing-pad"
          onMouseDown={start}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={end}
        />
      </div>
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
  const sharedRef = useRef(shared);
  useEffect(() => {
    sharedRef.current = shared;
  }, [shared]);

  const [, forceClockTick] = useState(0);
  useEffect(() => {
    if (shared.game.phase !== 'team1' && shared.game.phase !== 'team2') return undefined;
    if (!shared.game.roundEndAt) return undefined;
    const id = window.setInterval(() => forceClockTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [shared.game.phase, shared.game.roundEndAt]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const { game } = sharedRef.current;
      if (game.phase !== 'team1' && game.phase !== 'team2') return;
      if (!game.roundEndAt || Date.now() < game.roundEndAt) return;
      sharedRef.current.gameEndActiveRound();
    }, 400);
    return () => window.clearInterval(id);
  }, []);

  const countdownRunIdRef = useRef(0);
  useEffect(() => {
    const p = shared.game.phase;
    if (p !== 'countdown_team1' && p !== 'countdown_team2') return undefined;

    const runId = ++countdownRunIdRef.current;
    const timers = [];
    const safe = (fn) => {
      if (countdownRunIdRef.current !== runId) return;
      fn();
    };

    timers.push(window.setTimeout(() => safe(() => sharedRef.current.gameSetCountdownStep(1)), 1000));
    timers.push(window.setTimeout(() => safe(() => sharedRef.current.gameSetCountdownStep(2)), 2000));
    timers.push(window.setTimeout(() => safe(() => sharedRef.current.gameSetCountdownStep(3)), 3000));
    timers.push(window.setTimeout(() => safe(() => sharedRef.current.gameSetCountdownStep(4)), 4000));
    timers.push(
      window.setTimeout(
        () =>
          safe(() => {
            const team = p === 'countdown_team1' ? 1 : 2;
            sharedRef.current.gameStartPlayRound(team);
          }),
        5000,
      ),
    );

    return () => {
      countdownRunIdRef.current++;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [shared.game.phase]);

  const [playing, setPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(() => {
    try {
      const raw = sessionStorage.getItem('hostMusicVolume');
      if (raw == null) return 1;
      const v = parseFloat(raw);
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch (_) {
      return 1;
    }
  });
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
  const musicVolumeRef = useRef(musicVolume);
  const cameraSelectRef = useRef(null);
  const hostRootRef = useRef(null);
  const [hostFullscreen, setHostFullscreen] = useState(false);
  const [hudIdleHidden, setHudIdleHidden] = useState(false);
  const [splashBgChosen, setSplashBgChosen] = useState(false);
  /** While on splash with no background yet: play each scene’s music file to completion, then the next */
  const [splashPreSelectMusicIdx, setSplashPreSelectMusicIdx] = useState(0);
  const [relocatePointsPop, setRelocatePointsPop] = useState(0);
  const [splashRotateIdx, setSplashRotateIdx] = useState(0);
  const prevPhaseForSplashRef = useRef(shared.game.phase);
  const hudIdleTimerRef = useRef(null);
  const bumpRelocatePointsPopRef = useRef(() => {});
  bumpRelocatePointsPopRef.current = () => setRelocatePointsPop((n) => n + 1);

  musicVolumeRef.current = musicVolume;

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
      sessionStorage.setItem('hostMusicVolume', String(musicVolume));
    } catch (_) { /* noop */ }
  }, [musicVolume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // When paused, output is silent but `musicVolume` keeps the user's preferred level for next play.
    audio.volume = playing ? musicVolume : 0;
  }, [musicVolume, playing]);

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

  useEffect(() => {
    if (shared.strokes.length > 0) return;
    hiddenIdsRef.current = new Set();
    setHiddenIds(new Set());
    setSideCreatures([]);
  }, [shared.strokes.length]);

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
          sharedRef.current.awardRelocatePoints();
          bumpRelocatePointsPopRef.current();
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

  const gPhase = shared.game.phase;

  useEffect(() => {
    if (gPhase === 'splash' && prevPhaseForSplashRef.current !== 'splash') {
      setSplashBgChosen(false);
      setSplashRotateIdx(0);
      setSplashPreSelectMusicIdx(0);
    }
    prevPhaseForSplashRef.current = gPhase;
  }, [gPhase]);

  useEffect(() => {
    if (gPhase !== 'splash' || splashBgChosen) return undefined;
    const t = window.setInterval(() => {
      setSplashRotateIdx((i) => (i + 1) % HOST_SCENE_OPTIONS.length);
    }, 4500);
    return () => window.clearInterval(t);
  }, [gPhase, splashBgChosen]);

  const displayScene =
    gPhase === 'splash' && !splashBgChosen
      ? HOST_SCENE_OPTIONS[splashRotateIdx].id
      : normalizeRoomBackground(shared.roomBackground);

  const splashMusicPlaylistMode = gPhase === 'splash' && !splashBgChosen;
  const musicSceneForAudio = splashMusicPlaylistMode
    ? HOST_SCENE_OPTIONS[splashPreSelectMusicIdx % HOST_SCENE_OPTIONS.length].id
    : displayScene;
  const musicSrc = HOST_MUSIC_BY_SCENE[musicSceneForAudio] ?? HOST_MUSIC_BY_SCENE.water;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = musicSrc;
    audio.load();
    if (playing) {
      audio.volume = musicVolumeRef.current;
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
      audio.volume = 0;
    }
  }, [musicSrc, playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !splashMusicPlaylistMode) return undefined;
    const onEnded = () => {
      setSplashPreSelectMusicIdx((i) => (i + 1) % HOST_SCENE_OPTIONS.length);
    };
    audio.addEventListener('ended', onEnded);
    return () => audio.removeEventListener('ended', onEnded);
  }, [splashMusicPlaylistMode]);

  const toggleMusic = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      audio.volume = 0;
      setPlaying(false);
    } else {
      audio.volume = musicVolume;
      audio.play().catch(() => {});
      setPlaying(true);
    }
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

  const g = shared.game;
  const cd = getCountdownDisplay(g);
  const showPlayHud = g.phase === 'team1' || g.phase === 'team2';

  return (
    <div
      className={`host-fullscreen${hudIdleHidden && g.phase !== 'splash' ? ' host-fullscreen--ui-idle' : ''}${
        g.phase === 'splash' ? ' host-fullscreen--splash' : ''
      }`}
      ref={hostRootRef}
    >
      <audio ref={audioRef} loop={!splashMusicPlaylistMode} preload="metadata" />

      {g.phase === 'splash' ? (
        <div
          className="host-flow-overlay host-flow-overlay--splash"
          aria-label="ClockIt — roles and QR for artists"
        >
          <div className="host-flow-inner host-flow-inner--splash-card">
            <ClockItLogo />
            <div className="host-flow-splash-copy">
              <p className="host-flow-splash-lead host-flow-splash-lead--head">2 teams · 2 players each</p>
              <p className="host-flow-splash-lead">Clocker → point to move, pinch to grab</p>
              <p className="host-flow-splash-lead">Artist → scan the QR code below</p>
            </div>
            <QRCodeSVG value={joinUrl} size={140} bgColor="transparent" fgColor="#ffffff" />
            <div className="host-flow-scene">
              <p className="host-flow-scene-heading" id="host-splash-scene-label">
                Pick your stage
              </p>
              <div
                className="host-flow-scene-picker"
                role="group"
                aria-labelledby="host-splash-scene-label"
              >
                {HOST_SCENE_OPTIONS.map(({ id, label }) => {
                  const chosen =
                    splashBgChosen && normalizeRoomBackground(shared.roomBackground) === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`host-flow-scene-thumb${chosen ? ' host-flow-scene-thumb--selected' : ''}`}
                      aria-pressed={chosen}
                      onClick={() => {
                        shared.setRoomBackground(id);
                        setSplashBgChosen(true);
                        setPlaying(true);
                      }}
                    >
                      <span
                        className="host-flow-scene-thumb-visual"
                        style={{ backgroundImage: `url('${HOST_BG_BY_SCENE[id]}')` }}
                        aria-hidden
                      />
                      <span className="host-flow-scene-thumb-caption">{label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="host-flow-actions host-flow-actions--single">
              <button
                type="button"
                className="host-flow-action-btn"
                disabled={!splashBgChosen}
                title={splashBgChosen ? undefined : 'Pick a stage first'}
                onClick={() => {
                  setHandEnabled(true);
                  shared.gamePlayFromSplash();
                }}
              >
                Play
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {(g.phase === 'countdown_team1' || g.phase === 'countdown_team2') ? (
        <div className="host-flow-overlay host-flow-overlay--countdown" aria-live="assertive">
          <div className="host-flow-countdown-display">
            <span key={`${g.phase}-${g.countdownStep ?? 0}`} className="host-flow-countdown-line">
              {cd.line1}
            </span>
          </div>
        </div>
      ) : null}

      {g.phase === 'results_team1' ? (
        <div className="host-flow-overlay host-flow-overlay--results">
          <ClockItLogo />
          <p className="host-flow-results-hero">Time&apos;s Up!</p>
          <p className="host-flow-results-score">Team 1 — {g.team1Score} pts</p>
          <button type="button" className="host-flow-continue" onClick={() => shared.gameContinueToTeam2()}>
            Continue
          </button>
        </div>
      ) : null}

      {g.phase === 'results_team2' ? (
        <div className="host-flow-overlay host-flow-overlay--results">
          <ClockItLogo />
          <p className="host-flow-results-hero">Time&apos;s Up!</p>
          <p className="host-flow-results-score">Team 2 — {g.team2Score} pts</p>
          <button type="button" className="host-flow-continue" onClick={() => shared.gameContinueToFinal()}>
            See the Winner
          </button>
        </div>
      ) : null}

      {g.phase === 'final' ? (
        <div className="host-flow-overlay host-flow-overlay--final">
          <ClockItLogo />
          <div className="host-flow-final-grid">
            <div className="host-flow-final-box">
              <span className="host-flow-final-label">Team 1</span>
              <span className="host-flow-final-num">{g.team1Score}</span>
            </div>
            <div className="host-flow-final-box">
              <span className="host-flow-final-label">Team 2</span>
              <span className="host-flow-final-num">{g.team2Score}</span>
            </div>
          </div>
          <p className="host-flow-final-winner">{getWinnerPhrase(g.team1Score, g.team2Score)}</p>
          <div className="host-flow-final-actions">
            <button type="button" className="host-flow-play" onClick={() => shared.gameBackToSplash()}>
              Play again
            </button>
            <button
              type="button"
              className="host-flow-play host-flow-play--secondary"
              onClick={onResetRoom}
              title="New room code — share the new QR for a fresh game"
            >
              New game
            </button>
          </div>
        </div>
      ) : null}

      {showPlayHud ? (
        <div className="host-play-overlay" aria-live="polite">
          <div className="host-play-overlay-row">
            <p className="host-play-active">
              {g.phase === 'team1' ? 'Team 1' : 'Team 2'}
            </p>
            <div className="host-play-scores">
              <div className="host-play-score-block is-active">
                <span className="host-play-score-num">
                  {g.phase === 'team1' ? g.team1Score : g.team2Score}
                </span>
              </div>
            </div>
            {g.roundEndAt ? <p className="host-play-timer">{formatRoundClock(g.roundEndAt)}</p> : null}
          </div>
          <p key={`host-pinch-hint-${g.phase}`} className="host-play-hint">
            Pinch to grab creatures and
            <br />
            move them to the right side.
          </p>
        </div>
      ) : null}

      {relocatePointsPop > 0 ? (
        <span key={relocatePointsPop} className="points-pop points-pop--host" aria-hidden>
          +{GAME_POINTS_MOVE}
        </span>
      ) : null}

      <div className={`host-layout${g.phase === 'splash' ? ' host-layout--splash' : ''}`}>
        <div className="aquarium-wrapper">
          <AquariumCanvas
            key={room}
            strokes={visibleStrokes}
            heldIdRef={heldIdRef}
            heldPosRef={heldPosRef}
            positionsRef={creaturePositionsRef}
            teleportRef={teleportRef}
            scene={displayScene}
            splashBgEffects={g.phase === 'splash' && !splashBgChosen}
          />
        </div>
        {g.phase !== 'splash' ? (
          <SideAquarium creatures={sideCreatures} scene={displayScene} />
        ) : null}
      </div>

      {g.phase === 'splash' ? (
      <div className="host-hud host-hud--start-screen">
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
        <div className="hud-music-wrap">
          <button
            type="button"
            className={`hud-btn hud-btn--icon${playing ? ' hud-btn-active' : ''}`}
            onClick={toggleMusic}
            aria-label={playing ? 'Pause music' : 'Play music'}
            title={playing ? 'Pause music' : 'Play music'}
          >
            {playing ? <HudIconMusic /> : <HudIconMusicOff />}
          </button>
          <div
            className="hud-volume-rail"
            aria-label="Music volume"
            title={playing ? undefined : `Paused — will play at ${Math.round(musicVolume * 100)}%`}
          >
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={playing ? musicVolume : 0}
              disabled={!playing}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setMusicVolume(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
              }}
            />
            <span className="hud-volume-rail-value">
              {playing ? `${Math.round(musicVolume * 100)}%` : '0%'}
            </span>
          </div>
        </div>
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
      ) : null}

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

function ParticipantView({ shared, clientName, setClientName, clientColor, clientId }) {
  const [, forceClockTick] = useState(0);
  const [sendPointsPop, setSendPointsPop] = useState(0);
  const scene = normalizeRoomBackground(shared.roomBackground);
  const bgUrl = HOST_BG_BY_SCENE[scene] ?? HOST_BG_BY_SCENE.water;
  const gm = shared.game;
  const inDrawRound = gm.phase === 'team1' || gm.phase === 'team2';
  const assignedTeam = useMemo(
    () => computeAutoParticipantTeam(clientId, shared.participants),
    [clientId, shared.participants],
  );
  const myTurnToDraw =
    inDrawRound &&
    ((gm.phase === 'team1' && assignedTeam === 1) || (gm.phase === 'team2' && assignedTeam === 2));
  const countdownActiveTeam =
    gm.phase === 'countdown_team1' ? 1 : gm.phase === 'countdown_team2' ? 2 : null;
  const participantCountsDown =
    countdownActiveTeam != null && assignedTeam === countdownActiveTeam;
  const cdPhone = getCountdownDisplay(gm);

  useEffect(() => {
    if (gm.phase !== 'team1' && gm.phase !== 'team2') return undefined;
    if (!gm.roundEndAt) return undefined;
    const id = window.setInterval(() => forceClockTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [gm.phase, gm.roundEndAt]);

  return (
    <div
      className={`participant-shell${gm.phase === 'splash' ? ' participant-shell--splash-mode' : ''}`}
      data-scene={scene}
      data-my-team={assignedTeam == null ? 'none' : String(assignedTeam)}
      style={{ '--participant-shell-bg': `url('${bgUrl}')` }}
    >
      {gm.phase === 'splash' ? (
        <ParticipantSplashBackdrop
          active
          lockedSceneId={shared.roomBackgroundExplicit ? scene : null}
        />
      ) : null}

      {gm.phase === 'splash' ? (
        <div className="participant-flow-overlay participant-flow-overlay--splash">
          <div className="participant-flow-inner participant-flow-inner--splash-card">
            <ClockItLogo variant="phone" />
            <p className="participant-assigned-team" role="status" aria-live="polite">
              {assignedTeam === 1 || assignedTeam === 2 ? (
                <>
                  You&apos;re on <strong>Team {assignedTeam}</strong>
                </>
              ) : shared.participants?.[clientId] ? (
                <>
                  This room already has <strong>two players</strong> (one per team). Watch the main screen — you
                  won&apos;t draw from this phone.
                </>
              ) : (
                <>Joining room…</>
              )}
            </p>
          </div>
        </div>
      ) : null}

      {(gm.phase === 'countdown_team1' || gm.phase === 'countdown_team2') ? (
        participantCountsDown ? (
          <div className="participant-flow-overlay participant-flow-overlay--countdown" aria-live="assertive">
            <span className="participant-flow-countdown-line" key={`${gm.phase}-${gm.countdownStep ?? 0}`}>
              {cdPhone.line1}
            </span>
          </div>
        ) : (
          <div className="participant-flow-overlay participant-flow-overlay--results" aria-live="polite">
            <ClockItLogo variant="phone" />
            <p className="participant-flow-results-title">
              Team {countdownActiveTeam}&apos;s turn
            </p>
          </div>
        )
      ) : null}

      {gm.phase === 'results_team1' ? (
        <div className="participant-flow-overlay participant-flow-overlay--results" aria-live="polite">
          <ClockItLogo variant="phone" />
          <p className="participant-flow-results-title">Time&apos;s up</p>
          <p className="participant-flow-results-score">Team 1 — {gm.team1Score} pts</p>
        </div>
      ) : null}

      {gm.phase === 'results_team2' ? (
        <div className="participant-flow-overlay participant-flow-overlay--results" aria-live="polite">
          <ClockItLogo variant="phone" />
          <p className="participant-flow-results-title">Time&apos;s up</p>
          <p className="participant-flow-results-score">Team 2 — {gm.team2Score} pts</p>
        </div>
      ) : null}

      {gm.phase === 'final' ? (
        <div className="participant-flow-overlay participant-flow-overlay--final">
          <ClockItLogo variant="phone" />
          <div className="participant-flow-final-grid">
            <div className="participant-flow-final-box">
              <span>Team 1</span>
              <strong>{gm.team1Score}</strong>
            </div>
            <div className="participant-flow-final-box">
              <span>Team 2</span>
              <strong>{gm.team2Score}</strong>
            </div>
          </div>
          <p className="participant-flow-winner">{getWinnerPhrase(gm.team1Score, gm.team2Score)}</p>
        </div>
      ) : null}

      {inDrawRound ? (
        <>
          <div className="participant-play-hud">
            <div className="participant-play-hud-row">
              <p className="participant-play-team">
                {gm.phase === 'team1' ? 'Team 1' : 'Team 2'}
              </p>
              <div className="participant-play-score-wrap">
                <span className="participant-play-score-num">
                  {gm.phase === 'team1' ? gm.team1Score : gm.team2Score}
                </span>
              </div>
              {gm.roundEndAt ? (
                <p className="participant-play-timer" aria-live="polite">
                  {formatRoundClock(gm.roundEndAt)}
                </p>
              ) : (
                <p className="participant-play-timer" aria-live="polite">
                  —
                </p>
              )}
            </div>
          </div>
          {!myTurnToDraw ? (
            assignedTeam === 1 || assignedTeam === 2 ? (
              <div className="participant-flow-overlay participant-flow-overlay--results" aria-live="polite">
                <ClockItLogo variant="phone" />
                <p className="participant-flow-results-title">
                  Team {gm.phase === 'team1' ? 1 : 2}&apos;s turn
                </p>
              </div>
            ) : (
              <div className="participant-flow-overlay participant-flow-overlay--results" aria-live="polite">
                <ClockItLogo variant="phone" />
                <p className="participant-flow-results-title">Room is full</p>
              </div>
            )
          ) : (
            <DrawingPad
              onCommit={(character) => {
                shared.addCharacter(character);
                setSendPointsPop((n) => n + 1);
              }}
              overlay={
                <p key={`participant-draw-hint-${gm.phase}`} className="participant-draw-hint">
                  Draw as fast as you can—send as many creatures as you can before time runs out.
                </p>
              }
            />
          )}
          {myTurnToDraw && sendPointsPop > 0 ? (
            <span key={sendPointsPop} className="points-pop points-pop--participant" aria-hidden>
              +{GAME_POINTS_DRAW}
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Shown when there is no room in the URL (typical phone open). Match participant splash; join only via QR link. */
function JoinLandingView() {
  return (
    <div
      className="participant-shell participant-shell--splash-mode"
      data-scene="water"
      style={{ '--participant-shell-bg': `url('${HOST_BG_BY_SCENE.water}')` }}
    >
      <ParticipantSplashBackdrop active lockedSceneId={null} />
      <div className="participant-flow-overlay participant-flow-overlay--splash">
        <div className="participant-flow-inner participant-flow-inner--splash-card">
          <ClockItLogo variant="phone" />
          <p className="participant-assigned-team" role="status">
            Scan the QR code on the host screen to join.
          </p>
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

  useEffect(() => {
    preloadSceneBackgroundArt();
  }, []);

  const shared = useSharedRoom(room, {
    clientId,
    name: clientName || (mode === 'host' ? 'Host' : 'Anonymous'),
    role: mode || 'participant',
    color: clientColor,
  });

  if (!room || !mode) {
    return <JoinLandingView />;
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
      shared={shared}
      clientName={clientName}
      setClientName={setClientName}
      clientColor={clientColor}
      clientId={clientId}
    />
  );
}
