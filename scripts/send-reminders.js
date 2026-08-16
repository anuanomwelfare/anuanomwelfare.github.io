// Texts every member their current payment status: a reminder with the
// amount owed for anyone behind, or a thank-you for anyone fully paid up.
// Runs on GitHub Actions — same mNotify connection as the payment
// confirmation script, but this one calculates each member's actual
// standing rather than reacting to a single payment.
//
// The month/rate/arrears math below is deliberately copied to match
// index.html's getCurrentMonthIndex() / getMemberFinancials() exactly —
// if those ever change in the app, mirror the change here too.

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY;
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

function getMemberArrears(member, welfareMonths, currIdx, ratesByYear, activeYear) {
  const paidMonths = member.paidMonths || [];
  const joinIdx = member.joinMonth ? welfareMonths.indexOf(member.joinMonth) : 0;
  const startIdx = joinIdx === -1 ? 0 : joinIdx;

  let owedMonths = [];
  let duesOwed = 0;

  welfareMonths.forEach((m, idx) => {
    if (idx < startIdx) return; // not a member yet during this month
    if (idx > currIdx) return;  // future month, not owed yet
    const rate = getRateForYear(m.split(' ')[1], ratesByYear, activeYear);
    if (!paidMonths.includes(m)) {
      owedMonths.push(m);
      duesOwed += rate;
    }
  });

  return { owedMonths, duesOwed };
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

async function sendSms(phone, message) {
  const response = await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: [phone], sender: SMS_SENDER_ID, message, is_schedule: false, schedule_date: '' })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
}

async function main() {
  // Safety check: a manual run requires typing SEND to confirm, since this
  // texts every member at once. Scheduled runs skip this automatically.
  if (process.env.TRIGGER_EVENT === 'workflow_dispatch' && process.env.CONFIRM_INPUT !== 'SEND') {
    console.error('Confirmation not provided — type SEND in the "confirm" field to proceed. Nothing was sent.');
    process.exit(1);
  }

  const settingsSnap = await db.collection('settings').doc('association').get();
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const calendarEndYear = settings.calendarEndYear || 2028;
  const ratesByYear = settings.ratesByYear || { '2026': 20.00 };
  const activeYear = settings.activeYear || '2026';

  const welfareMonths = generateWelfareMonths(CALENDAR_START_YEAR, calendarEndYear);
  const currIdx = getCurrentMonthIndex(welfareMonths, calendarEndYear);

  const AUDIENCE = process.env.AUDIENCE === 'owing-only' ? 'owing-only' : 'everyone';

  const snapshot = await db.collection('members').get();
  console.log(`Sending status texts to ${snapshot.size} member(s)... (audience: ${AUDIENCE})`);

  let sent = 0, skipped = 0, failed = 0, notInAudience = 0;

  for (const doc of snapshot.docs) {
    const member = doc.data();
    const { owedMonths, duesOwed } = getMemberArrears(member, welfareMonths, currIdx, ratesByYear, activeYear);

    if (AUDIENCE === 'owing-only' && owedMonths.length === 0) {
      notInAudience++; // fully paid up, and this run is only for people who owe
      continue;
    }

    const phone = normalizeGhanaPhone(member.phone) || normalizeGhanaPhone(member.phone2);
    if (!phone) {
      console.warn(`No usable phone for ${member.name} (${doc.id}) — skipped.`);
      skipped++;
      continue;
    }

    const message = owedMonths.length > 0
      ? `Hi ${member.name}, you currently owe ${formatCurrency(duesOwed)} for ${owedMonths.length} month${owedMonths.length === 1 ? '' : 's'} (from ${owedMonths[0]}) in Anuanom 2016 Welfare dues. Please settle when you can. Thank you!`
      : `Hi ${member.name}, you're fully up to date on your Anuanom 2016 Welfare dues. Thank you for your support!`;

    try {
      await sendSms(phone, message);
      console.log(`Sent to ${member.name} (${owedMonths.length > 0 ? 'reminder' : 'thank-you'}).`);
      sent++;
    } catch (err) {
      console.error(`Failed to send to ${member.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`Done. Sent: ${sent}, skipped (no phone): ${skipped}, not in audience: ${notInAudience}, failed: ${failed}.`);

  await db.collection('auditLogs').add({
    time: new Date().toLocaleString('en-GB', { timeZone: 'Africa/Accra' }),
    action: `Payment status texts sent (audience: ${AUDIENCE}) — ${sent} sent, ${skipped} skipped, ${notInAudience} not in audience, ${failed} failed.`,
    createdAt: new Date().toISOString()
  });
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('Fatal error:', err); process.exit(1); });
