const admin = require('firebase-admin');

let app;
function initFirebase() {
  if (app) return admin;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[firebase] Missing Firebase Admin env vars. Firestore will be unavailable.');
    return null;
  }
  // Allow escaped newlines in env
  privateKey = privateKey.replace(/\\n/g, '\n');
  try {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  } catch (e) {
    if (!/already exists/i.test(e.message)) throw e;
  }
  return admin;
}

function getDb() {
  const adm = initFirebase();
  return adm ? adm.firestore() : null;
}

module.exports = { initFirebase, getDb };
