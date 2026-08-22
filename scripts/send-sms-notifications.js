// Checks every member for newly-paid months (since the last time this
// script ran) and sends a payment confirmation text via mNotify for each,
// including a snapshot of the association's overall financial standing.
// Runs on a schedule via GitHub Actions instead of a Firebase Cloud
// Function — this needs no Firebase plan upgrade at all, since it only
// uses Firestore (free on the Spark plan), not Cloud Functions.
//
// The month/rate/arrears math below is deliberately copied to match
// index.html's getMemberFinancials() / getFinancialTotals() exactly — if
// those ever change in the app, mirror the change here too.

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

const CALENDAR_START_YEAR = 2026;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function generateWelfareMonths(startYear, endYear) {
  const months = [];
  for (let year = startYear; year <= endYear; year++) {
    const fromMonth = (year === startYear) ? 6 : 0; // association's cycle starts in July
    for (let m = fromMonth; m < 12; m++) {
      months.push(`${MONTH_NAMES[m]} ${year}`);
    }
  }
  return months;
}

function getCurrentMonthIndex(welfareMonths, calendarEndYear) {
  const now = new Date();
  const currentStr = `${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  let currIdx = welfareMonths.indexOf(currentStr);
  if (currIdx === -1) {
    currIdx = (now.getFullYear() > calendarEndYear || (now.getFullYear() === calendarEndYear && now.getMonth() > 11)) ? welfareMonths.length - 1 : 0;
  }
  return currIdx;
}

function getRateForYear(year, ratesByYear, activeYear) {
  if (ratesByYear[year] !== undefined) return ratesByYear[year];
  if (ratesByYear[activeYear] !== undefined) return ratesByYear[activeYear];
  return 20.00;
}

// Mirrors getMemberFinancials() in index.html: total paid (incl. advance)
// and total owed so far, for one member.
function getMemberFinancials(member, welfareMonths, currIdx, ratesByYear, activeYear) {
  const paidMonths = member.paidMonths || [];
  const joinIdx = member.joinMonth ? welfareMonths.indexOf(member.joinMonth) : 0;
  const startIdx = joinIdx === -1 ? 0 : joinIdx;

  let duesPaid = 0;
  let duesOwed = 0;

  welfareMonths.forEach((m, idx) => {
    if (idx < startIdx) return; // not a member yet during this month
    const rate = getRateForYear(m.split(' ')[1], ratesByYear, activeYear);
    if (paidMonths.includes(m)) {
      duesPaid += rate;
    } else if (idx <= currIdx) {
      duesOwed += rate;
    }
  });

  return { duesPaid, duesOwed };
}

function formatCurrency(amount) {
  return `GH¢ ${(amount || 0).toFixed(2)}`;
}

function normalizeGhanaPhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/[\s-]/g, '');
  if (p.startsWith('+233')) p = '0' + p.slice(4);
  else if (p.startsWith('233')) p = '0' + p.slice(3);
  return /^0\d{9}$/.test(p) ? p : null;
}

async function main() {
  const settingsSnap = await db.collection('settings').doc('association').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const calendarEndYear = settings.calendarEndYear || 2028;
  const ratesByYear = settings.ratesByYear || { '2026': 20.00 };
  const activeYear = settings.activeYear || '2026';

  const welfareMonths = generateWelfareMonths(CALENDAR_START_YEAR, calendarEndYear);
  const currIdx = getCurrentMonthIndex(welfareMonths, calendarEndYear);

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

    // This member's own standing — not the association-wide totals.
    const fin = getMemberFinancials(member, welfareMonths, currIdx, ratesByYear, activeYear);
    const breakdownText = `\n\nHere's a breakdown:\nTotal dues paid: ${formatCurrency(fin.duesPaid)}\nTotal arrears: ${formatCurrency(fin.duesOwed)}`;

    const message = `Hi ${member.name}, your Anuanom 2016 Welfare payment for ${monthsText} has been recorded. Thank you!${breakdownText}`;

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

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal error:', err); process.exit(1); });
