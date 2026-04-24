import React, { useEffect, useMemo, useState } from 'react';
import { AquariumHostView, AquariumParticipantView } from './aquarium.jsx';
import { BattleHostView, BattleParticipantView } from './battle/index.jsx';
// ---------------------------------------------------------------------------
// URL helpers (shared by both games)
// ---------------------------------------------------------------------------
const COLORS = ['#FFFFFF', '#00D4FF', '#F43F5E', '#10B981', '#FBBF24', '#A78BFA'];

function makeId(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function getUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    room: params.get('room') || '',
    mode: params.get('mode') || '',
    team: params.get('team') || '',
  };
}

function setUrlState({ room, mode, team }) {
  const params = new URLSearchParams(window.location.search);
  if (room) params.set('room', room); else params.delete('room');
  if (mode) params.set('mode', mode); else params.delete('mode');
  if (team) params.set('team', team); else params.delete('team');
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Home screen — pick a game
// ---------------------------------------------------------------------------
function HomeView({ onCreateAquarium, onCreateBattle, roomInput, setRoomInput, onJoinRoom }) {
  return (
    <div className="home-shell">
      <div className="home-card">
        <div className="home-copy">
          <div className="eyebrow">Shared drawing</div>
          <h1>Phones as brushes, screen as canvas.</h1>
          <p>Pick a game mode, or paste a room code to join an existing session from your phone.</p>
        </div>

        <div className="home-actions">
          <section className="panel stack gap-12">
            <div>
              <div className="panel-title small">Drawing Aquarium</div>
              <p className="muted-text">Everyone draws a creature. They swim on the shared screen. Host can drag them around with a webcam.</p>
            </div>
            <button type="button" className="button full-width" onClick={onCreateAquarium}>
              Start Aquarium
            </button>
          </section>

          <section className="panel stack gap-12">
            <div>
              <div className="panel-title small">Battle Arena</div>
              <p className="muted-text">Two players battle via webcam. Audience draws food and picks a side. Collect food to grow, pinch to shoot.</p>
            </div>
            <button type="button" className="button full-width battle-btn" onClick={onCreateBattle}>
              Start Battle
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
              <button type="button" className="button" onClick={onJoinRoom} disabled={!roomInput.trim()}>
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
// Root router
// ---------------------------------------------------------------------------
export default function App() {
  const initial = getUrlState();
  const [room, setRoom] = useState(initial.room);
  const [mode, setMode] = useState(initial.mode);
  const [team, setTeam] = useState(initial.team);
  const [roomInput, setRoomInput] = useState(initial.room);
  const clientId = useMemo(() => crypto.randomUUID(), []);
  const clientColor = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

  useEffect(() => { setUrlState({ room, mode, team }); }, [room, mode, team]);

  const resetToHome = () => { setRoom(''); setMode(''); setTeam(''); setRoomInput(''); };

  const newAquariumRoom = () => {
    const next = makeId();
    setRoom(next); setRoomInput(next); setMode('host'); setTeam('');
  };

  const newBattleRoom = () => {
    const next = makeId();
    setRoom(next); setRoomInput(next); setMode('battle-host'); setTeam('');
  };

  // Home screen
  if (!room || !mode) {
    return (
      <HomeView
        roomInput={roomInput}
        setRoomInput={setRoomInput}
        onCreateAquarium={newAquariumRoom}
        onCreateBattle={newBattleRoom}
        onJoinRoom={() => {
          if (!roomInput.trim()) return;
          setRoom(roomInput.trim());
          // Default join mode — each game's participant view reads URL team param
          setMode(initial.mode || 'participant');
        }}
      />
    );
  }

  // ── Aquarium game ──────────────────────────────────────────────────────────
  if (mode === 'host') {
    return (
      <AquariumHostView
        room={room}
        clientId={clientId}
        clientColor={clientColor}
        onResetRoom={newAquariumRoom}
      />
    );
  }

  if (mode === 'participant') {
    return (
      <AquariumParticipantView
        room={room}
        clientId={clientId}
        clientColor={clientColor}
      />
    );
  }

  // ── Battle game ────────────────────────────────────────────────────────────
  if (mode === 'battle-host') {
    return (
      <BattleHostView
        room={room}
        clientId={clientId}
        onResetRoom={newBattleRoom}
      />
    );
  }

  if (mode === 'battle-join') {
    return (
      <BattleParticipantView
        room={room}
        clientId={clientId}
        team={team}
      />
    );
  }

  // Fallback — unknown mode, go home
  return <button onClick={resetToHome}>Go home</button>;
}
