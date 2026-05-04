/**
 * Property Viewing Request & Confirmation System
 * Estate agent tool — request → approve workflow
 * Single file, easy to read, easy to deploy.
 */

require('dotenv').config();
const express = require('express');
const path    = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron   = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ─────────────────────────────────────────────
//  CONFIG  (all values come from .env)
// ─────────────────────────────────────────────
const CFG = {
  agencyName:    process.env.AGENCY_NAME    || 'Property Agency',
  agencyEmail:   process.env.AGENCY_EMAIL   || '',
  agencyPhone:   process.env.AGENCY_PHONE   || '',
  agencyTagline: process.env.AGENCY_TAGLINE || 'Request a property viewing',
  propertyTitle: process.env.PROPERTY_TITLE || 'Property For Sale',
  propertyDesc:  process.env.PROPERTY_DESCRIPTION || '',
  propertyAddr:  process.env.PROPERTY_ADDRESS || '',
  propertyPrice: process.env.PROPERTY_PRICE  || '',
  propertyImage: process.env.PROPERTY_IMAGE_URL || '',
  adminPassword: process.env.ADMIN_PASSWORD  || 'changeme123',
  viewingTimes:  (process.env.VIEWING_TIMES || '09:00,10:00,11:00,12:00,14:00,15:00,16:00').split(','),
  advanceDays:   parseInt(process.env.ADVANCE_BOOKING_DAYS || '30'),
  fromName:      process.env.SMTP_FROM_NAME  || process.env.AGENCY_NAME || 'Property Viewings',
  fromEmail:     process.env.SMTP_FROM_EMAIL || 'noreply@example.com',
};

// ─────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data', 'viewings.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS viewings (
    id            TEXT PRIMARY KEY,
    buyer_name    TEXT NOT NULL,
    buyer_phone   TEXT NOT NULL,
    buyer_email   TEXT,
    property_id   TEXT DEFAULT 'main',
    property_name TEXT,
    date          TEXT NOT NULL,
    time          TEXT NOT NULL,
    notes         TEXT,
    status        TEXT DEFAULT 'pending',
    reminder_sent INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_status   ON viewings(status);
  CREATE INDEX IF NOT EXISTS idx_date     ON viewings(date);
`);

// ─────────────────────────────────────────────
//  EMAIL
// ─────────────────────────────────────────────
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  mailer = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: parseInt(process.env.SMTP_PORT || '587') === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log('✓ Email configured');
} else {
  console.log('⚠  Email NOT configured — requests save but no emails will send.');
}

async function sendEmail(to, subject, html) {
  if (!mailer || !to) return false;
  try {
    await mailer.sendMail({ from: `"${CFG.fromName}" <${CFG.fromEmail}>`, to, subject, html });
    return true;
  } catch (e) {
    console.error('Email error:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function formatDate(s) {
  return new Date(s + 'T00:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}
function formatTime(t) {
  const [h, m] = t.split(':').map(Number);
  const p = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${p}`;
}

// ─────────────────────────────────────────────
//  EMAIL TEMPLATES
// ─────────────────────────────────────────────
function layout(body) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f5f5f2;">
  <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e5e0;">
    <div style="margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #e5e5e0;">
      <span style="font-size:18px;font-weight:600;color:#1a1a1a;">${CFG.agencyName}</span>
    </div>
    ${body}
    <div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e5e0;font-size:13px;color:#888;">
      ${CFG.agencyPhone ? `<div>${CFG.agencyPhone}</div>` : ''}
      ${CFG.agencyEmail ? `<div>${CFG.agencyEmail}</div>` : ''}
    </div>
  </div>
</div>`;
}

function detailTable(v) {
  return `<table style="width:100%;border-collapse:collapse;background:#f5f5f2;border-radius:8px;margin:20px 0;">
    <tr>
      <td style="padding:12px 16px;font-size:13px;color:#888;width:110px;">Property</td>
      <td style="padding:12px 16px;font-size:15px;font-weight:500;">${v.property_name || CFG.propertyTitle}</td>
    </tr>
    <tr style="border-top:1px solid #e5e5e0;">
      <td style="padding:12px 16px;font-size:13px;color:#888;">Date</td>
      <td style="padding:12px 16px;font-size:15px;font-weight:500;">${formatDate(v.date)}</td>
    </tr>
    <tr style="border-top:1px solid #e5e5e0;">
      <td style="padding:12px 16px;font-size:13px;color:#888;">Time</td>
      <td style="padding:12px 16px;font-size:15px;font-weight:500;">${formatTime(v.time)}</td>
    </tr>
    ${CFG.propertyAddr ? `<tr style="border-top:1px solid #e5e5e0;"><td style="padding:12px 16px;font-size:13px;color:#888;">Address</td><td style="padding:12px 16px;font-size:14px;">${CFG.propertyAddr}</td></tr>` : ''}
  </table>`;
}

// Email to AGENT when new request comes in
function emailToAgent(v) {
  const dashUrl = `${PUBLIC_URL}/admin`;
  return layout(`
    <h2 style="font-size:22px;font-weight:500;margin:0 0 8px;letter-spacing:-0.01em;">New viewing request</h2>
    <p style="color:#555;margin:0 0 4px;">From: <strong>${v.buyer_name}</strong></p>
    <p style="color:#555;margin:0 0 20px;">Phone: <strong>${v.buyer_phone}</strong></p>
    ${detailTable(v)}
    ${v.notes ? `<p style="color:#555;font-size:14px;font-style:italic;margin:0 0 20px;">"${v.notes}"</p>` : ''}
    <a href="${dashUrl}" style="display:inline-block;background:#1a3a5c;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:500;font-size:15px;">
      Open Dashboard to Confirm or Decline →
    </a>
  `);
}

// Email to BUYER when confirmed
function emailBuyerConfirmed(v) {
  return layout(`
    <h2 style="font-size:24px;font-weight:500;margin:0 0 8px;letter-spacing:-0.02em;">Your viewing is confirmed ✓</h2>
    <p style="color:#555;margin:0 0 20px;">Hi ${v.buyer_name}, we look forward to seeing you!</p>
    ${detailTable(v)}
    <p style="color:#777;font-size:14px;margin:0;">
      If you can no longer make it, please call us: <strong>${CFG.agencyPhone || CFG.agencyEmail}</strong>
    </p>
  `);
}

// Email to BUYER when declined
function emailBuyerDeclined(v) {
  const requestUrl = PUBLIC_URL;
  return layout(`
    <h2 style="font-size:24px;font-weight:500;margin:0 0 8px;letter-spacing:-0.02em;">Viewing request update</h2>
    <p style="color:#555;margin:0 0 20px;">
      Hi ${v.buyer_name}, unfortunately we are unable to accommodate your requested viewing time.
    </p>
    ${detailTable(v)}
    <p style="color:#555;margin:0 0 20px;">Please request a different date and time.</p>
    <a href="${requestUrl}" style="display:inline-block;background:#1a3a5c;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:500;font-size:15px;">
      Request a New Time →
    </a>
  `);
}

// Reminder email to BUYER (24h before confirmed viewing)
function emailReminder(v) {
  return layout(`
    <h2 style="font-size:24px;font-weight:500;margin:0 0 8px;letter-spacing:-0.02em;">Viewing reminder</h2>
    <p style="color:#555;margin:0 0 20px;">Hi ${v.buyer_name}, your property viewing is tomorrow.</p>
    ${detailTable(v)}
    <p style="color:#777;font-size:14px;margin:0;">
      Need to cancel? Please contact us: <strong>${CFG.agencyPhone || CFG.agencyEmail}</strong>
    </p>
  `);
}

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== CFG.adminPassword) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─────────────────────────────────────────────
//  PUBLIC API
// ─────────────────────────────────────────────

// Property + config info for the public request page
app.get('/api/property', (req, res) => {
  res.json({
    agencyName:    CFG.agencyName,
    agencyTagline: CFG.agencyTagline,
    agencyPhone:   CFG.agencyPhone,
    title:         CFG.propertyTitle,
    description:   CFG.propertyDesc,
    address:       CFG.propertyAddr,
    price:         CFG.propertyPrice,
    image:         CFG.propertyImage,
    viewingTimes:  CFG.viewingTimes.map(t => ({ value: t, label: formatTime(t) })),
    advanceDays:   CFG.advanceDays,
  });
});

// Submit a viewing request
app.post('/api/request', async (req, res) => {
  const { buyer_name, buyer_phone, buyer_email, date, time, notes } = req.body;

  // Validate
  if (!buyer_name || !buyer_name.trim())  return res.status(400).json({ error: 'Please enter your name.' });
  if (!buyer_phone || !buyer_phone.trim()) return res.status(400).json({ error: 'Please enter your phone number.' });
  if (!date)  return res.status(400).json({ error: 'Please choose a date.' });
  if (!time)  return res.status(400).json({ error: 'Please choose a time.' });

  // Date must be in the future
  const today = new Date(); today.setHours(0,0,0,0);
  const chosen = new Date(date + 'T00:00:00');
  if (chosen < today) return res.status(400).json({ error: 'Please choose a future date.' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO viewings (id, buyer_name, buyer_phone, buyer_email, property_name, date, time, notes, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, buyer_name.trim(), buyer_phone.trim(), (buyer_email||'').trim().toLowerCase(),
         CFG.propertyTitle, date, time, (notes||'').trim());

  const viewing = db.prepare('SELECT * FROM viewings WHERE id = ?').get(id);

  // Notify agent
  if (CFG.agencyEmail) {
    sendEmail(
      CFG.agencyEmail,
      `New viewing request — ${buyer_name} — ${formatDate(date)}`,
      emailToAgent(viewing)
    );
  }

  res.json({ success: true });
});

// ─────────────────────────────────────────────
//  ADMIN API
// ─────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === CFG.adminPassword) {
    res.json({ success: true, token: CFG.adminPassword });
  } else {
    res.status(401).json({ error: 'Wrong password. Try again.' });
  }
});

// Get all viewings split by status + stats
app.get('/api/admin/viewings', requireAdmin, (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const pending   = db.prepare("SELECT * FROM viewings WHERE status='pending'   ORDER BY date ASC, time ASC").all();
  const confirmed = db.prepare("SELECT * FROM viewings WHERE status='confirmed' ORDER BY date ASC, time ASC").all();
  const declined  = db.prepare("SELECT * FROM viewings WHERE status='declined'  ORDER BY created_at DESC").all();

  const fmt = v => ({ ...v, dateFormatted: formatDate(v.date), timeFormatted: formatTime(v.time) });

  const stats = {
    pending:        pending.length,
    confirmedToday: db.prepare("SELECT COUNT(*) as c FROM viewings WHERE status='confirmed' AND date=?").get(today).c,
    confirmedTotal: confirmed.length,
    thisWeek:       db.prepare("SELECT COUNT(*) as c FROM viewings WHERE status='confirmed' AND date>=? AND date<=date(?,'+'||?||' days')").get(today, today, 7).c,
  };

  res.json({
    stats,
    pending:   pending.map(fmt),
    confirmed: confirmed.map(fmt),
    declined:  declined.map(fmt),
  });
});

// Confirm a request
app.post('/api/admin/confirm/:id', requireAdmin, async (req, res) => {
  const v = db.prepare('SELECT * FROM viewings WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (v.status !== 'pending') return res.status(400).json({ error: 'Already actioned' });

  db.prepare("UPDATE viewings SET status='confirmed' WHERE id=?").run(v.id);

  // Email buyer if they provided an email
  if (v.buyer_email) {
    sendEmail(
      v.buyer_email,
      `Your viewing is confirmed — ${formatDate(v.date)} at ${formatTime(v.time)}`,
      emailBuyerConfirmed(v)
    );
  }

  res.json({ success: true });
});

// Decline a request
app.post('/api/admin/decline/:id', requireAdmin, async (req, res) => {
  const v = db.prepare('SELECT * FROM viewings WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });
  if (v.status !== 'pending') return res.status(400).json({ error: 'Already actioned' });

  db.prepare("UPDATE viewings SET status='declined' WHERE id=?").run(v.id);

  if (v.buyer_email) {
    sendEmail(
      v.buyer_email,
      `Viewing request update — please choose another time`,
      emailBuyerDeclined(v)
    );
  }

  res.json({ success: true });
});

// Cancel a confirmed viewing
app.post('/api/admin/cancel/:id', requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE viewings SET status='cancelled' WHERE id=?").run(req.params.id);
  res.json({ success: result.changes > 0 });
});

// Export CSV
app.get('/api/admin/export', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM viewings ORDER BY date DESC, time DESC').all();
  const headers = ['Name','Phone','Email','Property','Date','Time','Status','Notes','Submitted'];
  const csv = [
    headers.join(','),
    ...rows.map(v => [
      v.buyer_name, v.buyer_phone, v.buyer_email||'',
      v.property_name||'', v.date, v.time, v.status,
      (v.notes||'').replace(/"/g,'""'), v.created_at,
    ].map(x => `"${String(x).replace(/"/g,'""')}"`).join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="viewings-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

// ─────────────────────────────────────────────
//  PAGE ROUTES
// ─────────────────────────────────────────────
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ─────────────────────────────────────────────
//  REMINDER CRON — 24h before confirmed viewings
// ─────────────────────────────────────────────
cron.schedule('*/10 * * * *', async () => {
  if (!mailer) return;
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const due = db.prepare(`
    SELECT * FROM viewings
    WHERE status='confirmed' AND reminder_sent=0 AND date=? AND buyer_email != ''
  `).all(tomorrow);

  for (const v of due) {
    const apptTime  = new Date(`${v.date}T${v.time}:00`);
    const diffHours = (apptTime - now) / 3600000;
    if (diffHours <= 24 && diffHours >= 23) {
      const sent = await sendEmail(
        v.buyer_email,
        `Reminder: property viewing tomorrow at ${formatTime(v.time)}`,
        emailReminder(v)
      );
      if (sent) db.prepare('UPDATE viewings SET reminder_sent=1 WHERE id=?').run(v.id);
    }
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ✓ ${CFG.agencyName} — Property Viewing System`);
  console.log(`  ✓ Buyer page:   ${PUBLIC_URL}`);
  console.log(`  ✓ Agent login:  ${PUBLIC_URL}/admin`);
  console.log(`  ✓ Email:        ${mailer ? 'configured' : 'NOT configured'}\n`);
});
