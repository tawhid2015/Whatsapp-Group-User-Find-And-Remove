const express = require('express');
const path = require('path');
const fs = require('fs');
const wa = require('./lib/wa');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
}));

// --- QR PNG endpoint (raw PNG, cache-buster ready) ---
app.get('/api/wa/qr.png', (req, res) => {
  const status = wa.getStatus();
  if (status.connected) {
    return res.status(410).send('Gone — already connected');
  }
  if (!status.qrReady || !fs.existsSync(wa.QR_CACHE)) {
    return res.status(404).send('No QR available');
  }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(wa.QR_CACHE);
});

// --- Status ---
app.get('/api/wa/status', (req, res) => {
  res.json(wa.getStatus());
});

// --- Clear session ---
app.post('/api/wa/clear', async (req, res) => {
  await wa.clearSessionAndRestart();
  res.json({ success: true, message: 'Session cleared. Fresh QR will appear shortly.' });
});

// --- Groups list ---
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await wa.getGroups();
    res.json(groups);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Group members ---
app.get('/api/groups/:id/members', async (req, res) => {
  try {
    const result = await wa.getGroupMembers(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Search members ---
app.get('/api/groups/:id/members/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    const qDigits = q.replace(/\D/g, '');
    const qNoLeadZero = qDigits.replace(/^0+/, '');
    const result = await wa.getGroupMembers(req.params.id);
    if (!q) return res.json(result);
    result.members = result.members.filter(m => {
      const nameMatch = (m.name || '').toLowerCase().includes(q);
      const phoneDigits = (m.phone || '').replace(/\D/g, '');
      const phoneMatch = phoneDigits.includes(qDigits) || phoneDigits.includes(qNoLeadZero);
      return nameMatch || phoneMatch;
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Remove member ---
app.post('/api/groups/:id/members/:jid/remove', async (req, res) => {
  try {
    const result = await wa.removeMember(req.params.id, req.params.jid);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Bulk find members by number list ---
app.post('/api/groups/:id/members/bulk-find', async (req, res) => {
  try {
    const numbers = req.body.numbers || [];
    const result = await wa.getGroupMembers(req.params.id);
    const members = result.members || [];

    // Normalize input numbers: strip non-digits, remove leading zeros
    const queries = numbers.map(n => String(n).replace(/\D/g, '')).filter(Boolean);

    const found = [];
    const notFound = [];

    for (const q of queries) {
      const qNoZero = q.replace(/^0+/, '');
      const match = members.find(m => {
        const mDigits = (m.phone || '').replace(/\D/g, '');
        // Match if one is suffix of the other (handles missing country code)
        return mDigits === q || mDigits.endsWith(q) || mDigits.endsWith(qNoZero) ||
               q.endsWith(mDigits) || qNoZero.endsWith(mDigits);
      });
      if (match) {
        found.push({ query: q, member: match });
      } else {
        notFound.push(q);
      }
    }

    res.json({ found, notFound, groupName: result.groupName, isAdmin: result.isAdmin });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- IB Client Match (inverse of bulk-find) ---
app.post('/api/groups/:id/members/ib-match', async (req, res) => {
  try {
    const clientNumbers = req.body.numbers || [];
    const result = await wa.getGroupMembers(req.params.id);
    const members = result.members || [];

    // Normalize IB client numbers: strip non-digits, remove leading zeros
    const clientDigits = clientNumbers
      .map(n => String(n).replace(/\D/g, ''))
      .filter(Boolean);

    const ibClients = [];
    const nonIbMembers = [];

    for (const m of members) {
      const mDigits = (m.phone || '').replace(/\D/g, '');
      const match = clientDigits.some(cd => {
        const cdNoZero = cd.replace(/^0+/, '');
        return mDigits === cd || mDigits.endsWith(cd) || mDigits.endsWith(cdNoZero) ||
               cd.endsWith(mDigits) || cdNoZero.endsWith(mDigits);
      });
      if (match) {
        ibClients.push(m);
      } else {
        nonIbMembers.push(m);
      }
    }

    res.json({
      ibClients,
      nonIbMembers,
      ibCount: ibClients.length,
      nonIbCount: nonIbMembers.length,
      groupName: result.groupName,
      isAdmin: result.isAdmin
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Bulk remove members ---
app.post('/api/groups/:id/members/bulk-remove', async (req, res) => {
  try {
    const jids = req.body.jids || [];
    const results = [];
    for (const jid of jids) {
      try {
        await wa.removeMember(req.params.id, jid);
        results.push({ jid, success: true });
      } catch (err) {
        results.push({ jid, success: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Fallback SPA routing ---
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`WhatsApp Admin server running on port ${PORT}`);
});
