# Salesforce Re-Authoring Spec — Make Web-App Completions Count in Enablement

**Program:** Supporting Clients With Generational Wealth Transfer (`0QoHu000001DHssKAG`)
**Goal:** Let a learner complete every exercise *once, in the web app* and have Salesforce
Enablement credit it — **without the learner ever logging into Salesforce**.

---

## 1. Why this needs Salesforce-side work at all

Salesforce Enablement exercises complete through two different mechanisms:

| Completion path | Object | API-writable? | Bridgeable from web app today? |
|---|---|---|---|
| **Runtime engine** (video watched, text read, link opened) | `EnblProgramTaskProgress` | **No — read-only** | **No** |
| **Outcome measure** (CRM records rolled up by an Enablement Measure) | the measure's source CRM object | Yes, if that object is writable | **Yes** |

The task definitions (`EnblProgramTaskDefinition`) and the task↔measure links
(`EnblProgramTaskMeasure`) are `createable=false / updateable=false` over the API, so the
web app **cannot** convert a content exercise into a measure-based one, nor attach a measure.
That conversion is a **one-time authoring change inside Salesforce Setup**. After it's done,
the existing measure bridge in the app (`POST /api/exercises/:taskId/log`) covers those
exercises automatically — no further code deploy required for the standard cases.

---

## 2. Current state of the program (as of 2026-09-11)

### Exercises WITH a measure (already bridgeable)

| Day | Exercise | Measure | Source object | Web-app status |
|---|---|---|---|---|
| 10 | Add 20 Beneficiaries to "Next Gen Introduction" Campaign | Logged Calls | `Count of Task` | ✅ writable — **works now** |
| 70 | Complete 5 Estate Review Plans | Review Estate Plan | `Count of Event` | ✅ writable — **works now** |
| 45 | Complete 10 Next-Gen Introductory Calls | New To Wealth Prospects | `Count of Prospect` | ❌ **not writable** — see §4 |
| 90 | 30 Million in AUC Retained | Revenue from Deals Won | `Sum of Opportunity.Amount` | ✅ writable — **works now** |

### Content exercises with NO measure (NOT bridgeable until re-authored)

| Day | Exercise | Type |
|---|---|---|
| 1 | Review Your At Risk AUC | OtherExercise (Tableau link) |
| 3 | **Quality Next-Gen Introductory Calls** | **Video** |
| 15 | Everything You Need To Know – Estate Plan Review | TextLesson |
| 20 | Scheduling Next-Gen Introductory Calls | OtherExercise |
| 30 | Agentforce Sales Pitch | OtherExercise |

These 5 are the target of this spec.

> Note: only "30 Million in AUC Retained" has `IsMilestoneAnOutcome = true`. The other three
> measure-backed milestones are `IsMilestoneAnOutcome = false` yet still carry measures. When
> re-authoring, set **`IsMilestoneAnOutcome = true`** on every milestone you want the runtime
> engine to auto-credit from its measure — otherwise the measure is tracked but may not drive
> completion.

---

## 3. Recommended approach — one dedicated activity object + one measure per exercise

This is the cleanest pattern: it keeps web-app completions out of real CRM activity timelines,
and each exercise gets an unambiguous, independently-countable signal.

### 3a. Create a custom object `Enablement_Activity__c`

Setup → Object Manager → Create → Custom Object.

| Field | API name | Type | Notes |
|---|---|---|---|
| (standard) Owner | `OwnerId` | Lookup(User) | present automatically; the enrolled learner |
| Activity Key | `Activity_Key__c` | Text(40), **External ID, Unique** | stores the `EnblProgramTaskDefinition` Id (e.g. `0kkHu000001DI3IIAW`) |
| Completed Date | `Completed_Date__c` | Date/Time | when the web app logged it |
| (optional) Program | `Program_Id__c` | Text(18) | for reporting/scoping |

Keep the object simple (no required custom fields beyond the key) so the API create is a
single call. Give the integration user create access via profile/permission set.

### 3b. Create one Enablement Measure per content exercise

Setup → Enablement → Measures (Enablement Measure Definitions). For each of the 5 exercises:

- **Source object:** `Enablement_Activity__c`
- **Aggregate:** `Count`
- **Filter (EnblMeasureObjectDefinition.FilterLogic):** `Activity_Key__c = '<that exercise's task Id>'`
- **MasterLabel:** e.g. "Watched: Quality Next-Gen Introductory Calls"

Task Ids to filter on:

| Exercise | Task Id |
|---|---|
| Review Your At Risk AUC | `0kkHu000001DI3QIAW` |
| Quality Next-Gen Introductory Calls (video) | `0kkHu000001DI3IIAW` |
| Everything You Need To Know – Estate Plan Review | `0kkHu000001DI7iIAG` |
| Scheduling Next-Gen Introductory Calls | *(query section "AI Powered Meeting Prep", Day 20)* |
| Agentforce Sales Pitch | *(query section "AI Powered Meeting Prep", Day 30)* |

### 3c. Re-author each content exercise as an outcome milestone

In the program editor (Enablement → Programs → this program → Edit):
1. Change the exercise's type to a **Milestone** bound to the measure from 3b (or add a new
   outcome milestone and retire the pure-content version — Enablement won't let you flip type
   via API, so do it in the builder).
2. Set **`IsMilestoneAnOutcome = true`**.
3. Set the measure **target = 1** (a single activity record completes it).
4. Re-publish the program.

### 3d. Web-app change (small, one-time)

The bridge currently keys templates by object name only. Add a keyed template so the activity
object create stamps the task Id:

```js
// server.js — BRIDGE_TEMPLATES
Enablement_Activity__c: {
  verb: 'Mark complete',
  // taskId is passed through from the /log route so the measure filter matches
  build: (me, taskId) => ({
    OwnerId: me,
    Activity_Key__c: taskId,
    Completed_Date__c: new Date().toISOString(),
  }),
},
```

…and pass `req.params.taskId` into `build(me, taskId)` in `POST /api/exercises/:taskId/log`,
and add `Enablement_Activity__c` to `WRITABLE_OBJECTS` and (optionally) `OWNER_SCOPED_OBJECTS`
so the live-value read is owner-scoped. Because the measure filter already pins `Activity_Key__c`,
the app should read the live value as `Count of Enablement_Activity__c WHERE OwnerId = me AND
Activity_Key__c = '<taskId>'` (add the key clause to `measureLiveValue` when the object is the
activity object). After this, all 5 content exercises light up as one-click bridges.

---

## 4. Fixing the "Complete 10 Next-Gen Introductory Calls" milestone (Day 45)

Its measure `New To Wealth Prospects` counts source object **`Prospect`**, which resolves in
this org only to **`ssot__Prospect__dlm`** — a **Data Cloud model object (`createable=false`)**.
Data Cloud DMOs are read-only projections of ingested data, so **no standard API can create a
record there**, and the web app correctly shows this milestone as non-writable.

Two ways to fix, pick one:

- **(Recommended) Re-point the measure** to a writable object. Either:
  - `Count of Lead` (or `Contact`) filtered to the "new-to-wealth" segment, or
  - `Count of Enablement_Activity__c` with `Activity_Key__c = '<this milestone's task Id>'`
    if you want it to behave like the §3 one-click bridges.
  Then it works through the existing bridge with no further code change (Lead is already
  handled by `BRIDGE_TEMPLATES`; `Contact`/custom object need a template entry).
- **(Only if you truly need Data Cloud)** Set up a Data Cloud ingestion / streaming insert so
  learner actions flow into `ssot__Prospect__dlm`. This is heavier and still not a direct
  `sobject.create`, so it doesn't fit the "one click in the web app" goal well.

---

## 5. Alternative to §3 — no new object (Task-filter pattern)

If creating a custom object is undesirable, reuse **`Task`** with a per-exercise `Subject` and a
measure `Count of Task` filtered by `Subject = 'ENBL:<taskId>'`. Pros: zero new metadata. Cons:
pollutes activity timelines and reporting; higher collision risk. Prefer §3 for anything beyond
a quick demo.

---

## 6. What ships automatically vs. needs a redeploy

| Change | Where | Redeploy the web app? |
|---|---|---|
| Re-point Day-45 measure to `Lead` | Salesforce Setup only | **No** (Lead already supported) |
| Re-point a measure to `Contact` | Setup + add `Contact` template | Yes (one template entry) |
| §3 custom-object bridges for the 5 content exercises | Setup + §3d changes | Yes (keyed template + live-value key clause) |

---

## 7. Verification (already proven for the writable cases)

The measure bridge was tested end-to-end against the org on 2026-09-11:
`POST /api/exercises/:taskId/log` created the backing record, the owner-scoped SOQL aggregate
incremented immediately, and the test record was deleted afterward (no residue). The same path
covers every exercise once §3/§4 land.
