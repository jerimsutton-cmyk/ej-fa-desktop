# Salesforce Enablement — Web-App Completion Bridge (Implemented)

**Goal:** Let a learner complete every exercise *once, in the web app* and have Salesforce
Enablement credit it — **without the learner ever logging into Salesforce**.

This documents what was built (2026-09-11) and the one manual step that remains.

---

## 1. How completion works in Salesforce Enablement

| Completion path | Object | Data API writable? | Metadata API? |
|---|---|---|---|
| **Runtime engine** (video watched, text read, link opened) | `EnblProgramTaskProgress` | No — read-only | No |
| **Outcome measure** (CRM records rolled up by an Enablement Measure) | the measure's CRM object | only the CRM records | — |
| **Program authoring** (tasks, milestones, measure links) | `EnblProgramTaskDefinition`, `EnblProgramTaskMeasure` | **No** (`createable=false`) | **Yes** (`EnablementProgramDefinition`) |

Key facts discovered:
- Content exercises can't be completed via any API through the runtime engine.
- The task↔measure links and milestone flags are `createable=false` over the data API, **but the
  whole program deploys via the Metadata API type `EnablementProgramDefinition`** — which is how
  the wiring below was created.
- **A published program cannot be overwritten** by a Metadata deploy ("a program with the same
  developer name is already published"). So re-authoring the *existing* program in place is not
  possible via API — you must either edit it in the builder or deploy a **new** program. We did
  the latter.
- `EnablementMeasureDefinition` deploys via Metadata API **with its filters** — no custom object
  is needed. A measure's `Status` is **not** writable via the data API, and a Metadata *update*
  won't flip Draft→Published; only a fresh Metadata *create* reliably lands as Published.

---

## 2. What was built

### 2a. Five filtered measures (Published)

Each counts `Task` where `Subject = <marker>` **and** `Status = Completed`, owner-scoped
(`userFieldApiName = OwnerId`, `filterLogic = "1 AND 2"`) — mirroring the org's stock
`salesforceTemplate_CompletedCalls` measure.

| Measure `developerName` | Task `Subject` marker | For exercise |
|---|---|---|
| `Enbl_Completed_AtRiskAUC` | `ENBL_AtRiskAUC` | Review Your At Risk AUC (Day 1) |
| `Enbl_Completed_NextGenVideo` | `ENBL_NextGenVideo` | Quality Next-Gen Introductory Calls — video (Day 3) |
| `Enbl_Completed_EstateLesson` | `ENBL_EstateLesson` | Everything You Need To Know – Estate Plan Review (Day 15) |
| `Enbl_Completed_Scheduling` | `ENBL_Scheduling` | Scheduling Next-Gen Introductory Calls (Day 20) |
| `Enbl_Completed_AgentforcePitch` | `ENBL_AgentforcePitch` | Agentforce Sales Pitch (Day 30) |

### 2b. New wired program

**`Generational Wealth Transfer (Web App)`** — Id `0QoHu000001DODNKA4`
(metadata `developerName program_d00132f3_c234_4e40_b5ac_031d4c165b52`).

A copy of the original program in which the **five content exercises are now outcome milestones**
bound to the measures above (target 1, `isMilestoneAnOutcome=false`, matching how the stock
milestones track measures). The four original milestones are preserved:

| Day | Milestone | Measure | Bridge-writable from web app |
|---|---|---|---|
| 1 | Review Your At Risk AUC | `Enbl_Completed_AtRiskAUC` | ✅ marker Task |
| 3 | Quality Next-Gen Introductory Calls | `Enbl_Completed_NextGenVideo` | ✅ marker Task |
| 10 | Add 20 Beneficiaries… | `salesforceTemplate_CompletedCalls` (Task) | ✅ |
| 15 | Estate Plan Review lesson | `Enbl_Completed_EstateLesson` | ✅ marker Task |
| 20 | Scheduling Next-Gen Calls | `Enbl_Completed_Scheduling` | ✅ marker Task |
| 30 | Agentforce Sales Pitch | `Enbl_Completed_AgentforcePitch` | ✅ marker Task |
| 45 | Complete 10 Next-Gen Calls | `New_To_Wealth_Prospects` (Prospect DMO) | ❌ Data Cloud object, read-only |
| 70 | Complete 5 Estate Review Plans | `Review_Estate_Plan` (Event) | ✅ |
| 90 | 30 Million in AUC Retained | `salesforceTemplate_DealsWonAmount` (Opportunity) | ✅ |

### 2c. Web-app bridge (server.js)

`CONTENT_MARKERS` maps each content measure's `developerName` → its `Subject` marker + button
verb. When a content milestone is completed, `POST /api/exercises/:taskId/log` writes
`Task { OwnerId: learner, Subject: marker, Status: 'Completed', Type: 'Other' }`. `measureLiveValue`
applies the same `Subject`/`Status` filter so the UI reflects the movement instantly. Verified
end-to-end: logging the video milestone moved its measure 0→1 (test record cleaned up).

---

## 3. The one remaining manual step

The new program is **Draft**. `EnablementProgram.Status` is not writable via the data API, and
publishing also drives enrollment/versioning, so it must be done in the builder:

1. Setup → Enablement → Programs → **Generational Wealth Transfer (Web App)** → **Publish**.
2. Assign/enroll the learners (Learning Item Assignments).
3. Point the web app's Guidance Center at program `0QoHu000001DODNKA4` (or add it to the list).

After publishing, every content exercise completes with one click in the web app — no learner
ever enters Salesforce.

### Day-45 caveat (unchanged)
`Complete 10 Next-Gen Introductory Calls` still counts the Data Cloud object `ssot__Prospect__dlm`
(`createable=false`), so it can't be bridged. To make it one-click, re-point its measure
(`New_To_Wealth_Prospects`) to a writable object (e.g. `Lead`, or a marker Task like the others).
