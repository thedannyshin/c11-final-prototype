// Battle game — Firebase transport
// Firebase paths used:
//   battle/{roomId}/players/p1  { creature, ready }
//   battle/{roomId}/players/p2  { creature, ready }
//   battle/{roomId}/food/{id}   { ...creatureData, team, x, y }
//   battle/{roomId}/gameState   { phase: 'lobby'|'playing'|'ended', winner: null|'p1'|'p2' }
//
// To delete the battle game: delete src/battle/ and remove its import from App.jsx.

import { getDatabase, ref, onValue, set, remove, update } from 'firebase/database';
import { firebaseApp } from '../firebase.js';

export function createBattleTransport(roomId) {
  const db = getDatabase(firebaseApp);
  const base = `battle/${roomId}`;

  const listeners = {};

  function watchPath(path, key, cb) {
    listeners[key] = onValue(ref(db, path), (snap) => cb(snap.val()));
  }

  return {
    // ── subscribe to real-time updates ──────────────────────────────────────
    onPlayers(cb) { watchPath(`${base}/players`, 'players', cb); },
    onFood(cb) {
      watchPath(`${base}/food`, 'food', (val) => {
        const items = val ? Object.entries(val).map(([id, v]) => ({ ...v, id })) : [];
        cb(items);
      });
    },
    onGameState(cb) { watchPath(`${base}/gameState`, 'gameState', cb); },

    // ── writes ──────────────────────────────────────────────────────────────
    setPlayerCreature(slot, creature) {
      set(ref(db, `${base}/players/${slot}`), { creature, ready: true });
    },
    submitFood(foodItem) {
      set(ref(db, `${base}/food/${foodItem.id}`), foodItem);
    },
    removeFood(id) {
      remove(ref(db, `${base}/food/${id}`));
    },
    setGameState(state) {
      update(ref(db, `${base}/gameState`), state);
    },
    resetRoom() {
      set(ref(db, base), null);
    },

    destroy() {
      Object.values(listeners).forEach((unsub) => unsub?.());
    },
  };
}
