// ONE-TIME cleanup script. Removes the "homecoming" field entirely from
// every member document in Firestore, now that the Homecoming Fund
// feature has been removed from the app.
//
// This is destructive and irreversible — it permanently deletes each
// member's homecoming contribution amount from the live database. Run
// this once, confirm it worked, then delete this script and its workflow
// file from the repo; there's no reason to keep it around afterward.

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  if (process.env.CONFIRM_INPUT !== 'DELETE') {
    console.error('Confirmation not provided — type DELETE (all caps) in the "confirm" field to proceed. Nothing was changed.');
    process.exit(1);
  }

  const snapshot = await db.collection('members').get();
  console.log(`Found ${snapshot.size} member(s). Removing the "homecoming" field from each...`);

  let updated = 0;
  let alreadyClean = 0;

  const batch = db.batch();
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    if (data.homecoming === undefined) {
      alreadyClean++;
      return;
    }
    batch.update(doc.ref, { homecoming: FieldValue.delete() });
    updated++;
  });

  if (updated === 0) {
    console.log('Nothing to do — no member documents have a homecoming field.');
    return;
  }

  await batch.commit();
  console.log(`Done. Removed the homecoming field from ${updated} member(s). ${alreadyClean} already had none.`);

  await db.collection('auditLogs').add({
    time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Accra' }),
    action: `Homecoming Fund removed permanently — cleared the homecoming field from ${updated} member record(s).`,
    createdAt: new Date().toISOString()
  });
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal error:', err); process.exit(1); });
