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

// ── Helper: the current user's real per-program progress ─────────────────────
// The authoritative learner progress lives on LearningItemProgress (the program
// roll-up record the user owns), not on the program-owner rollups. Returns a map
// of programId -> { percent, status }.
async function fetchProgramProgress(conn, me, programIds) {
  const byProgram = {};
  if (!programIds.length) return byProgram;
  const idList = programIds.map((id) => `'${id}'`).join(',');
  const result = await conn.query(
    `SELECT LearningItem.EnablementProgramId, CompletedPercent, ProgressStatus, CompletedDate
     FROM LearningItemProgress
     WHERE OwnerId = '${me}'
       AND LearningItem.EnablementProgramId IN (${idList})`
  );
  for (const r of result.records) {
    const pid = r.LearningItem && r.LearningItem.EnablementProgramId;
    if (pid) byProgram[pid] = { percent: r.CompletedPercent, status: r.ProgressStatus, completedDate: r.CompletedDate || null };
  }
  return byProgram;
}

// ── Enablement "measure bridge" ─────────────────────────────────────────────
// Outcome milestones complete when their Enablement Measure (a SOQL aggregate
// over a CRM object) reaches target. We can't write completion, but we CAN write
// the CRM records the measure counts — so an action in the web app moves the real
// measure and the runtime engine credits the milestone on its next recompute.
//
// For each writable CRM object we know how to create a record that contributes,
// attributed to the enrolled learner (OwnerId). Objects not listed here can't be
// bridged from the web app (the exercise still needs the learner in Salesforce).
function isoDate() { return new Date().toISOString().slice(0, 10); }
const BRIDGE_TEMPLATES = {
  Task: {
    verb: 'Log a call',
    build: (me) => ({ OwnerId: me, Subject: 'Next-Gen Introductory Call', Status: 'Completed', Type: 'Call', ActivityDate: isoDate() }),
  },
  Event: {
    verb: 'Log a meeting',
    build: (me) => ({ OwnerId: me, Subject: 'Estate Plan Review', DurationInMinutes: 30, ActivityDateTime: new Date().toISOString() }),
  },
  Lead: {
    verb: 'Add a prospect',
    build: (me) => ({ OwnerId: me, LastName: 'Next-Gen Prospect', Company: 'Prospect Household', Status: 'Open - Not Contacted' }),
  },
  Opportunity: {
    verb: 'Record a won deal',
    build: (me) => ({ OwnerId: me, Name: 'Retained AUC', StageName: 'Closed Won', CloseDate: isoDate(), Amount: 1000000 }),
  },
};

// The Enablement Measure(s) behind each exercise in a program:
// taskId -> [{ defId, label, object, fn, field }].
async function fetchExerciseMeasures(conn, programId) {
  const byTask = {};
  const rows = await conn.query(
    `SELECT EnblProgramTaskDefinitionId, EnablementMeasureDefinitionId,
            EnablementMeasureDefinition.MasterLabel, EnablementMeasureDefinition.SourceObjectApiName,
            EnablementMeasureDefinition.AggregateFunction, EnablementMeasureDefinition.AggregateFieldApiName
     FROM EnblProgramTaskMeasure
     WHERE EnblProgramTaskDefinition.EnablementProgramId = '${programId}'
     ORDER BY SequenceNumber`
  );
  for (const r of rows.records) {
    const md = r.EnablementMeasureDefinition || {};
    (byTask[r.EnblProgramTaskDefinitionId] = byTask[r.EnblProgramTaskDefinitionId] || []).push({
      defId: r.EnablementMeasureDefinitionId,
      label: md.MasterLabel,
      object: md.SourceObjectApiName,
      fn: md.AggregateFunction,
      field: md.AggregateFieldApiName,
    });
  }
  return byTask;
}

// A single measure's live value for the current user (owner-scoped where the
// object carries an OwnerId). Mirrors /api/measures, so the web app can show the
// value move the instant a bridge record is written.
const OWNER_SCOPED_OBJECTS = new Set(['Opportunity', 'Task', 'Event', 'Case', 'Account', 'Lead']);
async function measureLiveValue(conn, me, m) {
  const obj = m.object;
  if (!obj) return null;
  const fn = (m.fn || '').toLowerCase();
  const field = m.field;
  let selectExpr;
  if (fn === 'count' || !field) selectExpr = 'COUNT(Id) v';
  else if (fn === 'sum') selectExpr = `SUM(${field}) v`;
  else if (fn === 'average') selectExpr = `AVG(${field}) v`;
  else if (fn === 'max') selectExpr = `MAX(${field}) v`;
  else if (fn === 'min') selectExpr = `MIN(${field}) v`;
  else selectExpr = 'COUNT(Id) v';
  const where = OWNER_SCOPED_OBJECTS.has(obj) ? ` WHERE OwnerId = '${me}'` : '';
  const agg = await conn.query(`SELECT ${selectExpr} FROM ${obj}${where}`);
  return agg.records && agg.records[0] ? agg.records[0].v : null;
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

  // Real learner progress (percent + status) for the status bar.
  let progressByProgram = {};
  try { progressByProgram = await fetchProgramProgress(conn, me, programIds); } catch (_) {}

  const withEnrollment = programs.records.map((p) => {
    const prog = progressByProgram[p.Id] || {};
    return {
      ...p,
      MyEnrollmentStatus: statusByProgram[p.Id] || null,
      MyProgressPercent: (prog.percent != null ? prog.percent : null),
      MyProgressStatus: prog.status || null,
    };
  });
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

  // Real per-exercise progress for the current user (status + completion).
  const me = await getMyUserId(conn);
  const progByTask = {};
  try {
    const tp = await conn.query(
      `SELECT EnblProgramTaskDefinitionId, IsCompleted, CompletedPercent, ProgressStatus,
              DueDate, CompletedDateTime
       FROM EnblProgramTaskProgress
       WHERE EnblProgramTaskDefinition.EnablementProgramId = '${id}'
         AND LearningItemProgress.OwnerId = '${me}'`
    );
    for (const r of tp.records) {
      progByTask[r.EnblProgramTaskDefinitionId] = {
        isCompleted: r.IsCompleted,
        percent: r.CompletedPercent,
        status: r.ProgressStatus,
        dueDate: r.DueDate || null,
        completedDate: r.CompletedDateTime || null,
      };
    }
  } catch (_) {}

  // Program-level progress (percent + status + completion date) plus the
  // learner's due date (from their assignment) for the "Past due …" header.
  let programProgress = null;
  try {
    const pp = await fetchProgramProgress(conn, me, [id]);
    programProgress = pp[id] || null;
  } catch (_) {}
  try {
    const asg = await conn.query(
      `SELECT DueDate, StartDate FROM LearningItemAssignment
       WHERE AssigneeId = '${me}' AND LearningItem.EnablementProgramId = '${id}'
       LIMIT 1`
    );
    if (asg.records.length) {
      programProgress = programProgress || {};
      programProgress.dueDate = asg.records[0].DueDate || null;
      programProgress.startDate = asg.records[0].StartDate || null;
    }
  } catch (_) {}

  // Attach launchable video content to the program's video exercises. Preferred
  // source is the exercise's mapped content URL (EXERCISE_CONTENT_URLS); the
  // Enablement content URL isn't exposed via the API. Any remaining video
  // exercises fall back to the Product_Video__c catalog (round-robin so distinct
  // exercises get distinct clips) to demonstrate the launch capability.
  let videoPool = [];
  try { videoPool = await fetchPlayableVideos(conn); } catch (_) { videoPool = []; }

  // Enablement Measures behind each exercise, and their current live value, so
  // outcome milestones can be completed from the web app via the bridge.
  let measuresByTask = {};
  try { measuresByTask = await fetchExerciseMeasures(conn, id); } catch (_) { measuresByTask = {}; }
  const liveCache = {};
  async function bridgeFor(t) {
    const ms = measuresByTask[t.Id];
    if (!ms || !ms.length) return null;
    const m = ms[0];
    const tmpl = BRIDGE_TEMPLATES[m.object];
    let liveValue = null;
    try {
      if (!(m.object in liveCache)) liveCache[m.object] = await measureLiveValue(conn, me, m);
      liveValue = liveCache[m.object];
    } catch (_) {}
    return {
      measure: m.label,
      object: m.object,
      fn: m.fn,
      field: m.field,
      liveValue,
      writable: Boolean(tmpl),
      verb: tmpl ? tmpl.verb : null,
    };
  }

  let vIdx = 0;
  const tasks = await Promise.all(taskResult.records.map(async (t) => {
    let out = { ...t, progress: progByTask[t.Id] || null };
    const bridge = await bridgeFor(t);
    if (bridge) out = { ...out, bridge };
    if (isVideoExercise(t)) {
      if (EXERCISE_CONTENT_URLS[t.Id]) {
        out = { ...out, video: videoFromUrl(EXERCISE_CONTENT_URLS[t.Id], t.Name) };
      } else if (videoPool.length) {
        out = { ...out, video: videoPool[vIdx % videoPool.length] };
        vIdx += 1;
      }
    }
    return out;
  }));

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

  // The org's Lightning base URL, so the front end can build a "complete this in
  // Salesforce" link-out (the only path where the runtime engine records
  // completion — it must happen in the learner's own authenticated session; the
  // content cannot be framed, as Salesforce sends X-Frame-Options: DENY).
  let instanceUrl = null;
  try { instanceUrl = conn.instanceUrl || null; } catch (_) {}

  res.json({ program, sections, taskCount: taskResult.records.length, myProgress: programProgress, instanceUrl });
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

// A program exercise is a "video" exercise if Salesforce marks it as a Video
// exercise (TaskSubCategory) or its content is clearly meant to be watched.
function isVideoExercise(task) {
  if ((task.TaskSubCategory || '') === 'Video') return true;
  const name = (task.Name || '').toLowerCase();
  const desc = (task.Description || '').toLowerCase();
  return /\bvideo\b|\bwatch\b/.test(name) || /\bvideo\b/.test(desc);
}

// Per-exercise content URLs. Salesforce Enablement serves an exercise's video
// through LearningContent, which in this org is an EXTERNAL (Trailhead-backed)
// object that is not queryable via the API — so the real content URL cannot be
// read off the exercise record. Map an exercise Id to the URL that opens its
// content here. Replace the value with the actual Salesforce content URL.
const EXERCISE_CONTENT_URLS = {
  // "Quality Next-Gen Introductory Calls" (Supporting Clients With Generational
  // Wealth Transfer). This is the exercise's real Salesforce content — the
  // "Video Embed URL" configured on the exercise (a Vidyard clip, "Watch A
  // Successful Next-Gen Discovery Call") — so the app plays what Salesforce plays.
  '0kkHu000001DI3IIAW': 'https://play.vidyard.com/dYBe3SBNaAGKsUwrjiVxT5',
};

// Extract a Vidyard video id from a play.vidyard.com/share URL.
function parseVidyardId(url) {
  const m = String(url).match(/(?:play\.vidyard\.com|share\.vidyard\.com\/watch)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Extract a YouTube video id from any common YouTube URL form.
function parseYouTubeId(url) {
  const m = String(url).match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

// Build the normalized video shape from a plain content URL. YouTube URLs get an
// embed url so they play inline; other URLs are returned as a link-out target.
function videoFromUrl(url, title) {
  const yt = parseYouTubeId(url);
  const vy = yt ? null : parseVidyardId(url);
  const isMp4 = /\.mp4($|\?)/i.test(url);
  let type = 'Link';
  if (yt) type = 'YouTube';
  else if (vy) type = 'Vidyard';
  else if (isMp4) type = 'MP4';
  return {
    Id: null,
    Title: title || 'Video',
    Type: type,
    YouTubeId: yt,
    VidyardId: vy,
    Url: (yt || vy) ? null : url,
    ContentUrl: url,
    Description: null,
    // embedUrl renders inline in an iframe: YouTube's /embed, or Vidyard's inline
    // player (.html), which play.vidyard.com serves frame-embeddable.
    embedUrl: yt ? `https://www.youtube.com/embed/${yt}`
                 : (vy ? `https://play.vidyard.com/${vy}.html?disable_popouts=1&type=inline&autoplay=1` : null),
    thumbUrl: yt ? `https://img.youtube.com/vi/${yt}/hqdefault.jpg` : null,
  };
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

// ── BRIDGE: log a real CRM record that contributes to an exercise's measure ──
// This is the only supported way to advance Enablement completion from outside
// Salesforce: we create the record the exercise's Enablement Measure counts,
// owned by the enrolled learner. The runtime engine credits the milestone on its
// next measure recompute (not instant). We do NOT (cannot) write completion.
app.post('/api/exercises/:taskId/log', handler(async (conn, req, res) => {
  const { taskId } = req.params;
  if (!/^[a-zA-Z0-9]{15,18}$/.test(taskId)) {
    return res.status(400).json({ error: 'Invalid exercise Id.' });
  }
  const me = await getMyUserId(conn);

  // Resolve the exercise's Enablement Measure -> the CRM object it counts.
  const rows = await conn.query(
    `SELECT EnablementMeasureDefinition.MasterLabel, EnablementMeasureDefinition.SourceObjectApiName,
            EnablementMeasureDefinition.AggregateFunction, EnablementMeasureDefinition.AggregateFieldApiName
     FROM EnblProgramTaskMeasure
     WHERE EnblProgramTaskDefinitionId = '${taskId}'
     ORDER BY SequenceNumber LIMIT 1`
  );
  if (!rows.records.length) {
    return res.status(400).json({ error: 'This exercise is not measure-based, so it cannot be completed from here. It must be done in Salesforce.' });
  }
  const md = rows.records[0].EnablementMeasureDefinition || {};
  const object = md.SourceObjectApiName;
  const tmpl = BRIDGE_TEMPLATES[object];
  if (!tmpl) {
    return res.status(422).json({ error: `The measure behind this exercise counts ${object || 'an object'}, which the web app can't create. Complete it in Salesforce.`, object });
  }

  const record = tmpl.build(me);
  const result = await conn.sobject(object).create(record);
  if (!result.success) {
    return res.status(400).json({ error: 'Could not create the Salesforce record.', details: result.errors });
  }

  // Report the new live measure value so the UI can reflect the movement.
  let liveValue = null;
  try {
    liveValue = await measureLiveValue(conn, me, { object, fn: md.AggregateFunction, field: md.AggregateFieldApiName });
  } catch (_) {}

  res.json({
    success: true,
    recordId: result.id,
    object,
    measure: md.MasterLabel,
    liveValue,
    note: 'Salesforce Enablement credits the milestone on its next measure recompute.',
  });
}));

// ── Serve the front end for all other routes ─────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EJ FA Desktop server running on port ${PORT}`);
});
