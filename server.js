require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Salesforce connection
let sfConn = null;
let sfConnectedAt = null;

async function getSFConnection() {
  // Re-use connection if less than 30 minutes old
  if (sfConn && sfConnectedAt && (Date.now() - sfConnectedAt < 30 * 60 * 1000)) {
    return sfConn;
  }
  const conn = new jsforce.Connection({
    loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
    clientId: process.env.SF_CONSUMER_KEY,
    clientSecret: process.env.SF_CONSUMER_SECRET,
  });
  await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);
  sfConn = conn;
  sfConnectedAt = Date.now();
  console.log('Salesforce connected:', conn.instanceUrl);
  return conn;
}

// ── API: Contacts (clients) ──────────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  try {
    const conn = await getSFConnection();
    const result = await conn.query(
      `SELECT Id, Name, Email, Birthdate, Phone, Title, AccountId, Account.Name,
              OwnerId, Owner.Name
       FROM Contact
       WHERE OwnerId = '${await getMyUserId(conn)}'
       ORDER BY LastModifiedDate DESC
       LIMIT 50`
    );
    res.json(result.records);
  } catch (err) {
    console.error('Contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Opportunities ───────────────────────────────────────────────────────
app.get('/api/opportunities', async (req, res) => {
  try {
    const conn = await getSFConnection();
    const result = await conn.query(
      `SELECT Id, Name, StageName, Amount, CloseDate, AccountId, Account.Name,
              Probability, OwnerId, Owner.Name
       FROM Opportunity
       WHERE OwnerId = '${await getMyUserId(conn)}'
       ORDER BY CloseDate ASC
       LIMIT 50`
    );
    res.json(result.records);
  } catch (err) {
    console.error('Opportunities error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Tasks ───────────────────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  try {
    const conn = await getSFConnection();
    const result = await conn.query(
      `SELECT Id, Subject, Status, Priority, ActivityDate, WhoId, Who.Name,
              Description, OwnerId
       FROM Task
       WHERE OwnerId = '${await getMyUserId(conn)}'
         AND IsClosed = false
       ORDER BY ActivityDate ASC
       LIMIT 50`
    );
    res.json(result.records);
  } catch (err) {
    console.error('Tasks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Events / Appointments ───────────────────────────────────────────────
app.get('/api/events', async (req, res) => {
  try {
    const conn = await getSFConnection();
    const today = new Date().toISOString().split('T')[0];
    const result = await conn.query(
      `SELECT Id, Subject, StartDateTime, EndDateTime, WhoId, Who.Name,
              Location, Description, OwnerId
       FROM Event
       WHERE OwnerId = '${await getMyUserId(conn)}'
         AND StartDateTime >= ${today}T00:00:00Z
       ORDER BY StartDateTime ASC
       LIMIT 20`
    );
    res.json(result.records);
  } catch (err) {
    console.error('Events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Accounts ────────────────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  try {
    const conn = await getSFConnection();
    const result = await conn.query(
      `SELECT Id, Name, Type, AnnualRevenue, NumberOfEmployees, OwnerId, Owner.Name,
              BillingCity, BillingState
       FROM Account
       WHERE OwnerId = '${await getMyUserId(conn)}'
       ORDER BY LastModifiedDate DESC
       LIMIT 50`
    );
    res.json(result.records);
  } catch (err) {
    console.error('Accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: Current User ────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  try {
    const conn = await getSFConnection();
    const identity = await conn.identity();
    res.json(identity);
  } catch (err) {
    console.error('Identity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: get current user's Id ───────────────────────────────────────────
let _myUserId = null;
async function getMyUserId(conn) {
  if (_myUserId) return _myUserId;
  const identity = await conn.identity();
  _myUserId = identity.user_id;
  return _myUserId;
}

// ── Serve the front end for all other routes ─────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EJ FA Desktop server running on port ${PORT}`);
});
