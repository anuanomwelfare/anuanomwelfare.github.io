// Checks every member for newly-paid months (since the last time this
// script ran) and sends a payment confirmation text via mNotify for each.
// Runs on a schedule via GitHub Actions instead of a Firebase Cloud
// Function — this needs no Firebase plan upgrade at all, since it only
// uses Firestore (free on the Spark plan), not Cloud Functions.

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY;

// Ghana sender IDs are capped at 11 characters and must be pre-approved by
// mNotify. Until yours is registered, you may need mNotify's shared default
// sender instead — ask your friend which applies to their account.
const SMS_SENDER_ID = 'Anuanom';

async function main() {
  const snapshot = await db.collection('members').get();
  console.log(`Checking ${snapshot.size} member(s) for new payments...`);

  for (const doc of snapshot.docs) {
    const member = doc.data();
    const paidMonths = member.paidMonths || [];
    const notifiedMonths = member.smsNotifiedMonths || [];

    // Months paid now but not yet texted about. Comparing against a field
    // stored on the member (rather than "since last run") also means that
    // if a payment is ever reversed and later re-recorded, it correctly
    // counts as newly paid again and triggers a fresh text.
    const newlyPaid = paidMonths.filter(m => !notifiedMonths.includes(m));
    if (newlyPaid.length === 0) continue;

    const phone = normalizeGhanaPhone(member.phone) || normalizeGhanaPhone(member.phone2);
    if (!phone) {
      console.warn(`No usable phone for ${member.name} (${doc.id}) — will retry next run.`);
      continue; // don't mark as notified, so this retries automatically once the number's fixed
    }

    const monthsText = newlyPaid.length === 1
      ? newlyPaid[0]
      : `${newlyPaid.slice(0, -1).join(', ')} and ${newlyPaid[newlyPaid.length - 1]}`;
    const message = `Hi ${member.name}, your Anuanom 2016 Welfare payment for ${monthsText} has been recorded. Thank you!`;

    try {
      const response = await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: [phone],
          sender: SMS_SENDER_ID,
          message,
          is_schedule: false,
          schedule_date: ''
        })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        console.error(`mNotify send failed for ${member.name}: ${JSON.stringify(result)}`);
        continue; // don't mark as notified — will retry next run
      }

      // Sync notified state to exactly match current paidMonths.
      await doc.ref.update({ smsNotifiedMonths: paidMonths });

      await db.collection('auditLogs').add({
        time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Accra' }),
        action: `Payment confirmation SMS sent to ${member.name} for ${monthsText}.`,
        createdAt: new Date().toISOString()
      });

      console.log(`Sent SMS to ${member.name} for ${monthsText}.`);
    } catch (err) {
      console.error(`Error sending SMS to ${member.name}: ${err.message}`);
    }
  }
}

// Members' phone numbers may have been typed as 0XXXXXXXXX, +233XXXXXXXXX,
// or 233XXXXXXXXX depending on who entered them — this normalizes all three
// to the local 0XXXXXXXXX format mNotify's API expects, and returns null for
// anything that still doesn't look like a valid Ghana number.
function normalizeGhanaPhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[\s-]/g, '');
  if (p.startsWith('+233')) p = '0' + p.slice(4);
  else if (p.startsWith('233')) p = '0' + p.slice(3);
  return /^0\d{9}$/.test(p) ? p : null;
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal error:', err); process.exit(1); });
