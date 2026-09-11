require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// API version must be >= 60.0 to see the Enablement objects (EnablementProgram, etc.)
const SF_API_VERSION = process.env.SF_API_VERSION || '62.0';

// Objects the web app is allowed to create/update. Enablement objects are
// intentionally excluded — they are managed content and read-only via the API.
const WRITABLE_OBJECTS = new Set(['Contact', 'Opportunity', 'Task', 'Event', 'Account']);

// ── Salesforce connection (re-used, refreshed every 30 min) ──────────────────
let sfConn = null;
let sfConnectedAt = null;

async function getSFConnection() {
  if (sfConn && sfConnectedAt && (Date.now() - sfConnectedAt < 30 * 60 * 1000)) {
    return sfConn;
  }
  // Normalize the login URL to a valid SOAP-login origin. A wrong host/scheme
  // makes Salesforce redirect the SOAP login POST into a GET, which the endpoint
  // rejects ("405 Only POST allowed"). We: force https, keep only the origin
  // (drop any path/query), and rewrite a Lightning host to its My-Domain host
  // (…​.lightning.force.com → ….my.salesforce.com), which serves the SOAP API.
  let loginUrl = (process.env.SF_LOGIN_URL || 'https://login.salesforce.com').trim();
  if (!/^https?:\/\//i.test(loginUrl)) loginUrl = 'https://' + loginUrl;
  try {
    const u = new URL(loginUrl);
    u.protocol = 'https:';
    if (/\.lightning\.force\.com$/i.test(u.hostname)) {
      u.hostname = u.hostname.replace(/\.lightning\.force\.com$/i, '.my.salesforce.com');
    }
    loginUrl = u.origin; // scheme + host only, no path/slash
  } catch (_) {
    loginUrl = loginUrl.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
  }
  console.log('Salesforce login URL:', loginUrl);

  // Note: we intentionally do NOT pass clientId/clientSecret. jsforce switches
  // conn.login() to the OAuth2 password grant when both are present, and this
  // org does not permit that grant ("grant type not supported"). Omitting them
  // forces plain SOAP username/password login, which the org does allow.
  const conn = new jsforce.Connection({
    loginUrl: loginUrl,
    version: SF_API_VERSION,
  });
  // Password may need the security token appended if logging in from an
  // untrusted IP: set SF_PASSWORD = <password><securityToken>.
  await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);
  sfConn = conn;
  sfConnectedAt = Date.now();
  _myUserId = null;
  console.log('Salesforce connected:', conn.instanceUrl, '(v' + SF_API_VERSION + ')');
  return conn;
}

// ── Helper: current user's Id ────────────────────────────────────────────────
let _myUserId = null;
async function getMyUserId(conn) {
  if (_myUserId) return _myUserId;
  const identity = await conn.identity();
  _myUserId = identity.user_id;
  return _myUserId;
}

// Small wrapper so each route gets consistent error handling.
function handler(fn) {
  return async (req, res) => {
    try {
      const conn = await getSFConnection();
      await fn(conn, req, res);
    } catch (err) {
      console.error(`${req.method} ${req.path} error:`, err.message);
      res.status(err.statusCode || 500).json({ error: err.message, code: err.errorCode });
    }
  };
}

// ── READ: Contacts (clients) ─────────────────────────────────────────────────
app.get('/api/contacts', handler(async (conn, req, res) => {
  const result = await conn.query(
    `SELECT Id, Name, FirstName, LastName, Email, Birthdate, Phone, MobilePhone, Title,
            AccountId, Account.Name, OwnerId, Owner.Name
     FROM Contact
     ORDER BY LastModifiedDate DESC
     LIMIT 50`
  );
  res.json(result.records);
}));

// ── READ: Opportunities ──────────────────────────────────────────────────────
app.get('/api/opportunities', handler(async (conn, req, res) => {
  const result = await conn.query(
    `SELECT Id, Name, StageName, Amount, CloseDate, IsWon, IsClosed, AccountId, Account.Name,
            Probability, OwnerId, Owner.Name
     FROM Opportunity
     WHERE IsClosed = false
     ORDER BY CloseDate ASC
     LIMIT 50`
  );
  res.json(result.records);
}));

// ── READ: Tasks ──────────────────────────────────────────────────────────────
app.get('/api/tasks', handler(async (conn, req, res) => {
  const result = await conn.query(
    `SELECT Id, Subject, Status, Priority, ActivityDate, WhoId, Who.Name,
            Description, IsClosed, OwnerId
     FROM Task
     WHERE IsClosed = false
     ORDER BY ActivityDate ASC
     LIMIT 50`
  );
  res.json(result.records);
}));

// ── READ: Events / Appointments ──────────────────────────────────────────────
app.get('/api/events', handler(async (conn, req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const result = await conn.query(
    `SELECT Id, Subject, StartDateTime, EndDateTime, WhoId, Who.Name,
            Location, Description, OwnerId
     FROM Event
     WHERE StartDateTime >= ${today}T00:00:00Z
     ORDER BY StartDateTime ASC
     LIMIT 20`
  );
  res.json(result.records);
}));

// ── READ: Accounts ───────────────────────────────────────────────────────────
app.get('/api/accounts', handler(async (conn, req, res) => {
  const result = await conn.query(
    `SELECT Id, Name, Type, AnnualRevenue, NumberOfEmployees, OwnerId, Owner.Name,
            BillingCity, BillingState
     FROM Account
     ORDER BY LastModifiedDate DESC
     LIMIT 50`
  );
  res.json(result.records);
}));

// ── READ: Enablement Programs the current user is ENROLLED in ────────────────
// Enrollment = LearningItemAssignment (AssigneeId = current user) whose
// LearningItem rolls up to an EnablementProgram. We surface the enrolled
// user's programs, not the programs they own.
app.get('/api/programs', handler(async (conn, req, res) => {
  const me = await getMyUserId(conn);

  const assignments = await conn.query(
    `SELECT LearningItem.EnablementProgramId, AssignmentStatus
     FROM LearningItemAssignment
     WHERE AssigneeId = '${me}' AND LearningItem.EnablementProgramId != null`
  );

  // Map programId -> enrollment status for the current user.
  const statusByProgram = {};
  for (const a of assignments.records) {
    const pid = a.LearningItem && a.LearningItem.EnablementProgramId;
    if (pid) statusByProgram[pid] = a.AssignmentStatus;
  }
  const programIds = Object.keys(statusByProgram);
  if (programIds.length === 0) return res.json([]);

  const idList = programIds.map((id) => `'${id}'`).join(',');
  const programs = await conn.query(
    `SELECT Id, Name, Status, Type, Description, TotalDays, IsOutcomeBased,
            TotalAssigned, TotalCompleted, TotalBehind, PublishedDateTime,
            OwnerId, Owner.Name
     FROM EnablementProgram
     WHERE Id IN (${idList})
     ORDER BY PublishedDateTime DESC NULLS LAST`
  );

  const withEnrollment = programs.records.map((p) => ({
    ...p,
    MyEnrollmentStatus: statusByProgram[p.Id] || null,
  }));
  res.json(withEnrollment);
}));

// ── READ: a single Enablement Program with its milestones (sections) and
//         exercises (task definitions), for the Guidance Center drill-down ────
app.get('/api/programs/:id', handler(async (conn, req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid program Id.' });
  }

  const progResult = await conn.query(
    `SELECT Id, Name, Status, Type, Description, TotalDays, IsOutcomeBased,
            TotalAssigned, TotalCompleted, TotalBehind, PublishedDateTime,
            OwnerId, Owner.Name
     FROM EnablementProgram
     WHERE Id = '${id}'`
  );
  if (!progResult.records.length) {
    return res.status(404).json({ error: 'Program not found.' });
  }
  const program = progResult.records[0];

  const sectionResult = await conn.query(
    `SELECT Id, Name, SequenceNumber
     FROM EnblProgramSection
     WHERE EnablementProgramId = '${id}'
     ORDER BY SequenceNumber`
  );
  const taskResult = await conn.query(
    `SELECT Id, Name, EnblProgramSectionId, Day, TaskCategory, TaskSubCategory,
            SequenceNumber, Description
     FROM EnblProgramTaskDefinition
     WHERE EnablementProgramId = '${id}'
     ORDER BY EnblProgramSectionId, SequenceNumber`
  );

  // Attach launchable video content to the program's video exercises. The
  // Enablement objects don't expose a per-exercise content URL via the API, so
  // for the demo we surface real videos from the Product_Video__c catalog and
  // link them to the exercises whose content is meant to be watched. Videos are
  // assigned round-robin so multiple video exercises get distinct clips.
  let videoPool = [];
  try { videoPool = await fetchPlayableVideos(conn); } catch (_) { videoPool = []; }
  let vIdx = 0;
  const tasks = taskResult.records.map((t) => {
    if (videoPool.length && isVideoExercise(t)) {
      const video = videoPool[vIdx % videoPool.length];
      vIdx += 1;
      return { ...t, video };
    }
    return t;
  });

  // Group tasks (exercises) under their section (milestone).
  const tasksBySection = {};
  for (const t of tasks) {
    (tasksBySection[t.EnblProgramSectionId] = tasksBySection[t.EnblProgramSectionId] || []).push(t);
  }
  const sections = sectionResult.records.map((s) => ({
    Id: s.Id,
    Name: s.Name,
    SequenceNumber: s.SequenceNumber,
    tasks: tasksBySection[s.Id] || [],
  }));

  res.json({ program, sections, taskCount: taskResult.records.length });
}));

// ── Video content (Product_Video__c) ────────────────────────────────────────
// The org stores launchable video content on Product_Video__c: a YouTube video
// id or an MP4 URI, with a title/type. We normalize each into a small shape the
// front end can play directly (embedUrl for YouTube, url for MP4) in a modal.
function normalizeVideo(v) {
  const type = v.Type__c || (v.YouTube_Video_Id__c ? 'YouTube' : 'MP4');
  const yt = v.YouTube_Video_Id__c || null;
  const uri = v.Video_URI__c || null;
  return {
    Id: v.Id,
    Title: v.Title__c || v.Name || 'Video',
    Type: type,
    YouTubeId: yt,
    Url: uri,
    Description: v.Description__c || null,
    embedUrl: yt ? `https://www.youtube.com/embed/${yt}` : null,
    thumbUrl: yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : null,
  };
}

// A video is "playable" only if it actually has a source we can render.
function isPlayableVideo(v) {
  return Boolean(v.YouTubeId || v.Url);
}

// Fetch active, playable videos from the catalog (used both for the catalog
// endpoint and to attach demo content to video-type program exercises).
async function fetchPlayableVideos(conn, limit) {
  const result = await conn.query(
    `SELECT Id, Name, Title__c, Type__c, YouTube_Video_Id__c, Video_URI__c, Description__c
     FROM Product_Video__c
     WHERE Active__c = true
     ORDER BY Sequence__c NULLS LAST, Title__c
     ${limit ? 'LIMIT ' + limit : ''}`
  );
  // Dedupe by playable source so distinct videos surface (the catalog has many
  // duplicate rows pointing at the same YouTube id / URL).
  const seen = new Set();
  const out = [];
  for (const v of result.records.map(normalizeVideo)) {
    if (!isPlayableVideo(v)) continue;
    const key = v.YouTubeId || v.Url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

// A program exercise is a "video" exercise if its content is meant to be watched.
function isVideoExercise(task) {
  const name = (task.Name || '').toLowerCase();
  const desc = (task.Description || '').toLowerCase();
  return /\bvideo\b|\bwatch\b/.test(name) || /\bvideo\b/.test(desc);
}

app.get('/api/videos', handler(async (conn, req, res) => {
  res.json(await fetchPlayableVideos(conn));
}));

// ── READ: Enablement Measures (with a live, owner-scoped value) ──────────────
app.get('/api/measures', handler(async (conn, req, res) => {
  const me = await getMyUserId(conn);
  const defs = await conn.query(
    `SELECT Id, MasterLabel, DeveloperName, Status, SourceObjectApiName,
            AggregateFunction, AggregateFieldApiName, Description
     FROM EnablementMeasureDefinition
     WHERE Status = 'Published'
     ORDER BY MasterLabel`
  );

  // Objects that carry an OwnerId we can scope the live value to.
  const OWNER_SCOPED = new Set(['Opportunity', 'Task', 'Event', 'Case', 'Account', 'Lead']);

  const measures = await Promise.all(defs.records.map(async (m) => {
    let value = null;
    let valueError = null;
    try {
      const obj = m.SourceObjectApiName;
      const fn = (m.AggregateFunction || '').toLowerCase();
      const field = m.AggregateFieldApiName;
      if (obj) {
        let selectExpr;
        if (fn === 'count' || !field) selectExpr = 'COUNT(Id) v';
        else if (fn === 'sum') selectExpr = `SUM(${field}) v`;
        else if (fn === 'average') selectExpr = `AVG(${field}) v`;
        else if (fn === 'max') selectExpr = `MAX(${field}) v`;
        else if (fn === 'min') selectExpr = `MIN(${field}) v`;
        else selectExpr = 'COUNT(Id) v';
        const where = OWNER_SCOPED.has(obj) ? ` WHERE OwnerId = '${me}'` : '';
        const agg = await conn.query(`SELECT ${selectExpr} FROM ${obj}${where}`);
        value = agg.records && agg.records[0] ? agg.records[0].v : null;
      }
    } catch (e) {
      valueError = e.errorCode || e.message;
    }
    return {
      Id: m.Id,
      Label: m.MasterLabel,
      Status: m.Status,
      SourceObject: m.SourceObjectApiName,
      Aggregate: m.AggregateFunction,
      Field: m.AggregateFieldApiName,
      Description: m.Description,
      value,
      valueError,
    };
  }));
  res.json(measures);
}));

// ── READ: current user ───────────────────────────────────────────────────────
app.get('/api/me', handler(async (conn, req, res) => {
  res.json(await conn.identity());
}));

// ── WRITE: create a record ───────────────────────────────────────────────────
app.post('/api/records/:object', handler(async (conn, req, res) => {
  const { object } = req.params;
  if (!WRITABLE_OBJECTS.has(object)) {
    return res.status(403).json({ error: `Creating '${object}' records is not permitted.` });
  }
  const result = await conn.sobject(object).create(req.body || {});
  if (!result.success) {
    return res.status(400).json({ error: 'Create failed', details: result.errors });
  }
  res.json({ success: true, id: result.id });
}));

// ── WRITE: update a record ───────────────────────────────────────────────────
app.patch('/api/records/:object/:id', handler(async (conn, req, res) => {
  const { object, id } = req.params;
  if (!WRITABLE_OBJECTS.has(object)) {
    return res.status(403).json({ error: `Updating '${object}' records is not permitted.` });
  }
  if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid record Id.' });
  }
  const result = await conn.sobject(object).update({ ...(req.body || {}), Id: id });
  if (!result.success) {
    return res.status(400).json({ error: 'Update failed', details: result.errors });
  }
  res.json({ success: true, id: result.id });
}));

// ── Serve the front end for all other routes ─────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EJ FA Desktop server running on port ${PORT}`);
});
