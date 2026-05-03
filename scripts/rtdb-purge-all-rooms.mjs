#!/usr/bin/env node
/**
 * One-shot: delete every Firebase Realtime Database document under `rooms/`.
 *
 * Requires a service account with permission to write the database:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccount.json
 * Optional override:
 *   FIREBASE_DATABASE_URL=https://YOUR-PROJECT-default-rtdb.firebaseio.com
 *
 * Run: npm run rtdb:purge-all
 */

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';

const databaseURL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://cca-final-prototype-default-rtdb.firebaseio.com';

const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credPath) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to your service account JSON path.');
  process.exit(1);
}

const credential = admin.credential.cert(JSON.parse(readFileSync(credPath, 'utf8')));
admin.initializeApp({ credential, databaseURL });

await admin.database().ref('rooms').remove();
console.log('Removed RTDB path: rooms/');
