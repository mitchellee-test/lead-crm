/* Lead CRM — plain JS, no build step.
   Modes:
   - Supabase mode: config.js has a real SUPABASE_URL + SUPABASE_ANON_KEY.
     All reads/writes go to Supabase, realtime subscription + 5-second
     polling keep teammates in sync. Last write wins.
   - Local Demo mode: no Supabase config. Data lives in localStorage
     in THIS browser only and is NOT shared with teammates.
   Switching modes is just editing config.js — no code change needed.
*/
const STAGES = ["New","Contacted","Replied","Requirement","Proposal","Negotiation","Won","Lost"];
const SOURCES = ["Email","WhatsApp","Call","LinkedIn","Upwork","Marketplace"];
const CHANNELS = ["Email","WhatsApp","Call","LinkedIn","Upwork","Marketplace"];

const cfg = (window.LEAD_CRM_CONFIG || {});
const hasSupabase = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
  && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") && !cfg.SUPABASE_ANON_KEY.includes("YOUR-ANON"));
let supabaseClient = null;
let mode = "demo";
let leads = [];
let activities = [];
let currentView = "dashboard";
let editingId = null;
let detailId = null;

function todayISO(){
  const d = new Date(); return d.toISOString().slice(0,10);
}
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function stageIndex(s){ return STAGES.indexOf(s); }
function isRepliedOrLater(lead){ return stageIndex(lead.stage) >= stageIndex("Replied"); }
function canHandOver(lead){ return isRepliedOrLater(lead) && !lead.handed_over; }
// Handoff lock rule (the 100 -> 5 rule): New and Contacted leads can
// NEVER be handed over. Only Replied through Negotiation may be handed
// over; Won/Lost are closed and are also locked out of handoff.
function handoffLocked(lead){
  if(lead.stage === "Won" || lead.stage === "Lost") return true;
  return stageIndex(lead.stage) < stageIndex("Replied");
}
function handoffLockReason(lead){
  if(lead.stage === "Won" || lead.stage === "Lost") return "Closed — cannot be handed over";
  return "Handoff locked — must reach Replied first";
}
function dueClass(lead){
  if(!lead.follow_up_date || lead.stage === "Won" || lead.stage === "Lost") return "";
  if(lead.follow_up_date < todayISO()) return "overdue";
  if(lead.follow_up_date === todayISO()) return "today";
  return "";
}
function dueLabel(lead){
  if(!lead.follow_up_date) return "No follow-up set";
  const cls = dueClass(lead);
  if(cls === "overdue") return "Overdue: " + lead.follow_up_date;
  if(cls === "today") return "Due today: " + lead.follow_up_date;
  return lead.follow_up_date;
}

/* Quick Add helpers — no schema or column changes. Notes = remark.
   Done is displayed for the stored Won stage; Lost is stored as Lost. */
let quickChannel = "Email";
let quickStatus = "Contacted";
let addedTodayCount = 0;
// Bug fix 2026-10-30: Who auto-parse used to fill Name only while it was
// empty, so after the first letter ("A") it froze and never updated to the
// full name. Track manual edits instead: auto-parse updates Name/Company
// on every Who keystroke UNLESS the user has typed in that field directly,
// in which case manual input always wins.
let nameManuallyEdited = false;
let companyManuallyEdited = false;
let websiteManuallyEdited = false;
// Website / lead_code / outcome (2026-10-30):
// - website: visible field, auto-filled from email domain, never overwrites
//   a manually typed website.
// - lead_code: memorable display ID, e.g. ACM-001. The Supabase uuid id
//   stays the primary key; lead_code is display-only and is sent on save
//   once the leads.lead_code column exists.
// - outcome: visible Won/Lost dropdown, mapped to stage Won/Lost.
// - handed_over / handoff_note / handoff_date are INTERNAL ONLY (see
//   applyAutoHandoff): they drive the team queue in the background and
//   are never shown as editable fields in the CRM or in the Sheet layout.
const PERSONAL_DOMAINS = ["gmail","yahoo","outlook","hotmail","icloud","protonmail","example"];
function websiteFromEmail(email){
  const domain = String(email || "").trim().split("@")[1] || "";
  if(!domain) return "";
  const first = domain.split(".")[0].toLowerCase();
  if(PERSONAL_DOMAINS.includes(first)) return "";
  return "https://" + domain.toLowerCase();
}
function normalizeWebsite(v){
  const t = String(v || "").trim();
  if(!t) return "";
  if(/^https?:\/\//i.test(t)) return t;
  return "https://" + t;
}
function websiteDisplay(v){
  return String(v || "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
}
function leadCodePrefix(sourceStr){
  const words = String(sourceStr || "").replace(/[^A-Za-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if(!words.length) return "LEAD";
  let letters = words[0].toUpperCase().slice(0, 3);
  let i = 1;
  while(letters.length < 3 && i < words.length){ letters += words[i].charAt(0).toUpperCase(); i++; }
  return letters || "LEAD";
}
function nextLeadCode(company, name){
  // Global sequence: next number after the highest numeric suffix among
  // ALL existing lead_codes, so codes stay unique even for a repeat company.
  let max = 0;
  leads.forEach(l => {
    const m = String(l.lead_code || "").match(/-(\d+)$/);
    if(m) max = Math.max(max, parseInt(m[1], 10));
  });
  return leadCodePrefix(company || name) + "-" + String(max + 1).padStart(3, "0");
}
function ensureLeadCode(lead){
  if(lead.lead_code) return lead.lead_code;
  lead.lead_code = nextLeadCode(lead.company, lead.name);
  return lead.lead_code;
}
function displayLeadCode(lead){
  if(lead.lead_code) return lead.lead_code;
  // Temporary fallback only for old leads with no lead_code: first 8 chars
  // of the uuid. A proper lead_code is generated on the next save of that lead.
  return "#" + String(lead.id || "").slice(0, 8);
}
function outcomeFromStage(stage){ return stage === "Won" ? "Won" : stage === "Lost" ? "Lost" : ""; }
function outcomeFromLead(lead){ return lead.outcome || outcomeFromStage(lead.stage); }
const REMARK_CHIPS = ["Interested","Asked for pricing","Call back later","Meeting booked","No reply yet","Not interested"];
function displayStage(stage){ return stage === "Won" ? "Done" : stage; }
function quickStatusToStage(s){ return s === "Done" ? "Won" : s; }
function stageToQuickStatus(s){ return s === "Won" ? "Done" : (["New","Contacted","Replied","Lost"].includes(s) ? s : "Contacted"); }
function digitsOnly(v){ return String(v || "").replace(/\D/g, ""); }
function titleCase(s){ return String(s || "").split(/[\s._-]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "); }
function parseWho(raw){
  const text = String(raw || "").trim();
  if(!text) return { name:"", company:"", email:"", phone:"" };
  const emailMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const email = emailMatch ? emailMatch[0] : "";
  const phoneMatch = text.match(/\+?\d[\d\s\-()]{6,}\d/);
  let phone = "";
  if(!email && phoneMatch && digitsOnly(text).length >= 7 && digitsOnly(text).length >= text.replace(/[\s\-()+]/g,"").length * 0.7) phone = phoneMatch[0].trim();
  else if(phoneMatch && email) phone = phoneMatch[0].trim();
  let rest = text;
  if(email) rest = rest.replace(email, " ");
  if(phone) rest = rest.replace(phone, " ");
  rest = rest.replace(/[,;|]+/g, " ").replace(/\s+/g, " ").trim();
  let name = "", company = "";
  if(rest){
    const atParts = rest.split(/\s+at\s+/i);
    if(atParts.length === 2){ name = atParts[0].trim(); company = atParts[1].trim(); }
    else if(/inc\.?|ltd\.?|llc|company|co\./i.test(rest) && rest.split(" ").length <= 4){ company = rest; }
    else name = rest;
  }
  if(email && !company){
    const domain = email.split("@")[1] || "";
    const first = domain.split(".")[0] || "";
    if(!["gmail","yahoo","outlook","hotmail","icloud","protonmail","example"].includes(first.toLowerCase())) company = titleCase(first);
  }
  if(email && !name){
    const local = email.split("@")[0] || "";
    name = titleCase(local);
  }
  if(!name && company) name = company;
  return { name, company, email, phone };
}
function updateWhoParsed(){
  const whoEl = document.getElementById("f_who"); if(!whoEl) return;
  const p = parseWho(whoEl.value);
  const nameEl = document.getElementById("f_name"), compEl = document.getElementById("f_company");
  if(p.name && nameEl && !nameManuallyEdited) nameEl.value = p.name;
  if(p.company && compEl && !companyManuallyEdited) compEl.value = p.company;
  if(p.email) document.getElementById("f_email").value = p.email;
  if(p.phone) document.getElementById("f_phone").value = p.phone;
  // Auto-fill website from the email domain, unless the user typed one manually.
  const webEl = document.getElementById("f_website");
  if(webEl && !websiteManuallyEdited){
    const auto = websiteFromEmail(p.email);
    if(auto) webEl.value = auto;
  }
  const out = document.getElementById("whoParsed");
  if(out) out.textContent = (p.name || p.email || p.phone) ? [p.name, p.company, p.email, p.phone].filter(Boolean).join(" · ") : "";
}
function selectChannel(ch){
  quickChannel = ch;
  const src = document.getElementById("f_source"); if(src) src.value = ch;
  document.querySelectorAll(".channel-btn").forEach(b => b.classList.toggle("active", b.dataset.channel === ch));
}
function selectQuickStatus(s){
  quickStatus = s;
  const st = document.getElementById("f_stage"); if(st) st.value = quickStatusToStage(s);
  const full = document.getElementById("f_status_full"); if(full) full.value = quickStatusToStage(s);
  document.querySelectorAll(".status-btn").forEach(b => b.classList.toggle("active", b.dataset.status === s));
}
// Full status changer (2026-10-30): the quick chips only cover New /
// Contacted / Replied / Done / Lost, so a lead that moves on to
// Requirement, Proposal or Negotiation had no visible way to change
// status except the hidden More details stage. This dropdown is the
// visible, always-on status control in Quick Add / Edit lead.
function selectFullStatus(s){
  const st = document.getElementById("f_stage"); if(st) st.value = s;
  const full = document.getElementById("f_status_full"); if(full) full.value = s;
  // Keep the quick chips in sync where they have a matching option.
  const q = stageToQuickStatus(s);
  if(["Requirement","Proposal","Negotiation"].includes(s)){
    quickStatus = "Replied";
    document.querySelectorAll(".status-btn").forEach(b => b.classList.toggle("active", b.dataset.status === "Replied"));
  } else {
    quickStatus = q;
    document.querySelectorAll(".status-btn").forEach(b => b.classList.toggle("active", b.dataset.status === q));
  }
}
function addRemarkChip(text){
  const el = document.getElementById("f_notes"); if(!el) return;
  const cur = el.value.trim();
  if(!cur) el.value = text;
  else if(!cur.includes(text)) el.value = cur + "; " + text;
  el.focus();
}
function toggleMoreDetails(){
  const el = document.getElementById("moreDetails"); if(!el) return;
  el.classList.toggle("hidden");
  const btn = document.getElementById("moreDetailsBtn"); if(btn) btn.textContent = el.classList.contains("hidden") ? "More details" : "Hide details";
}
function plusDaysISO(n){ const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0,10); }
function autoFollowUp(stage, existing){
  if(existing) return existing;
  return (stage === "Contacted" || stage === "Replied") ? plusDaysISO(3) : null;
}
function applyAutoHandoff(lead){
  // 100 -> 5 rule, automated: Replied through Negotiation reach the team
  // queue without a manual handoff form. Lost is never handed over; Done
  // (Won) keeps any prior handoff state instead of forcing a new one.
  if(["Replied","Requirement","Proposal","Negotiation"].includes(lead.stage)){
    lead.handed_over = true;
    if(!lead.handoff_note) lead.handoff_note = lead.notes || "";
    if(!lead.handoff_date) lead.handoff_date = new Date().toISOString();
    if(!lead.requirement && lead.notes) lead.requirement = lead.notes;
  }
  return lead;
}
function findDuplicate(email, phone){
  const e = String(email || "").trim().toLowerCase();
  const p = digitsOnly(phone);
  return leads.find(l => {
    if(e && String(l.email || "").trim().toLowerCase() === e) return true;
    if(p){
      const lp = digitsOnly(l.phone);
      if(lp && (lp === p || (lp.length >= 10 && p.length >= 10 && lp.slice(-10) === p.slice(-10)))) return true;
    }
    return false;
  }) || null;
}
function lastActivityFor(leadId){
  const acts = activities.filter(a => a.lead_id === leadId);
  if(!acts.length) return null;
  acts.sort((a,b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return acts[0];
}
function countAddedToday(){
  const t = todayISO();
  return leads.filter(l => String(l.created_at || "").slice(0,10) === t).length;
}
function updateAddedToday(){
  const el = document.getElementById("addedTodayLine");
  if(el) el.textContent = "Added today: " + countAddedToday();
}
async function autoHandOver(id){
  const l = leads.find(x => x.id === id); if(!l) return;
  if(handoffLocked(l)){ alert("Handoff locked: " + l.name + " is " + l.stage + ". Only Replied leads reach the team."); return; }
  const updated = applyAutoHandoff({ ...l, updated_at: new Date().toISOString() });
  if(updated.stage === "Replied") updated.stage = "Replied";
  await saveLeadToBackend(updated);
  await logActivityToBackend(id, "Handoff", "Handed over automatically on reaching " + updated.stage);
  setView("handoff");
}
async function markDone(leadId){
  const l = leads.find(x => x.id === leadId); if(!l) return;
  const updated = { ...l, stage: "Won", outcome: "Won", updated_at: new Date().toISOString() };
  if(!updated.lead_code) ensureLeadCode(updated);
  await saveLeadToBackend(updated);
  await logActivityToBackend(leadId, "Note", "Marked Done");
}
async function saveDetailOutcome(){
  const l = leads.find(x => x.id === detailId); if(!l) return;
  const sel = document.getElementById("detailOutcome"); if(!sel) return;
  const outcome = sel.value;
  if(outcome !== "Won" && outcome !== "Lost"){ alert("Choose Won or Lost to set an outcome."); return; }
  const updated = { ...l, stage: outcome, outcome, updated_at: new Date().toISOString() };
  if(!updated.lead_code) ensureLeadCode(updated);
  await saveLeadToBackend(updated);
  openDetail(detailId);
}
// Easy status changer in lead detail (2026-10-30): pick any full stage
// — Contacted → Replied → Requirement → Proposal → Negotiation → Won/Lost
// — and Save status. Moving to Replied or later puts the lead in the
// team queue automatically via applyAutoHandoff; Won/Lost also set outcome.
// Moving back to New/Contacted clears the team-queue flag, otherwise a
// lead reverted from Replied would stay stuck in both Team queue and
// Locked out at the same time (found in live test 2026-10-30).
async function saveDetailStage(){
  const l = leads.find(x => x.id === detailId); if(!l) return;
  const sel = document.getElementById("detailStage"); if(!sel) return;
  const stage = sel.value; if(!stage) return;
  let updated = { ...l, stage, updated_at: new Date().toISOString() };
  if(stage === "Won" || stage === "Lost") updated.outcome = stage;
  else if(l.outcome === "Won" || l.outcome === "Lost") updated.outcome = "";
  if(!updated.lead_code) ensureLeadCode(updated);
  updated = applyAutoHandoff(updated);
  if(stage === "New" || stage === "Contacted"){
    updated.handed_over = false; updated.handoff_note = ""; updated.handoff_date = null;
  }
  await saveLeadToBackend(updated);
  await logActivityToBackend(detailId, "Note", "Status changed to " + (stage === "Won" ? "Done / Won" : stage));
  openDetail(detailId);
}
async function markDoneFromDetail(){ const id = detailId; closeModal("detailModal"); if(id) await markDone(id); }

const DEMO_KEY = "leadcrm_demo_leads_v1";
const DEMO_ACT_KEY = "leadcrm_demo_activities_v1";
function demoSeed(){
  const t = todayISO();
  const y = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const tm = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const mk = (id,name,company,email,phone,source,stage,assignee,follow_up_date,requirement) => ({
    id, name, company, email, phone, source, stage, assignee, follow_up_date,
    notes:"", requirement: requirement || "", website:"", lead_code:"",
    outcome: stage === "Won" ? "Won" : stage === "Lost" ? "Lost" : "",
    handed_over: stageIndex(stage) >= stageIndex("Requirement") && stage !== "Lost",
    handoff_note:"", handoff_date:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  });
  const seeded = [
    mk("demo-1","Ayesha Rahman","Rahman Trading","ayesha@example.com","+8801700000001","Email","Replied","","", "Wants a quote for website redesign"),
    mk("demo-2","Tanvir Ahmed","Ahmed Logistics","tanvir@example.com","+8801700000002","WhatsApp","Replied","","", "Needs delivery app, budget discussion"),
    mk("demo-3","Sara Khan","Khan Boutique","sara@example.com","+8801700000003","LinkedIn","Contacted","",tm,""),
    mk("demo-4","Imran Hossain","Hossain Foods","imran@example.com","+8801700000004","Email","New","",tm,""),
    mk("demo-5","Nusrat Jahan","Jahan Studio","nusrat@example.com","+8801700000005","Upwork","Requirement","Backend Team",t,"E-commerce site, 20 products"),
    mk("demo-6","Karim Uddin","Uddin Motors","karim@example.com","+8801700000006","Call","Proposal","Backend Team",tm,"Showroom site + booking form"),
    mk("demo-7","Farhana Islam","Islam Clinic","farhana@example.com","+8801700000007","Email","Contacted","",y,""),
    mk("demo-8","Rafi Chowdhury","Chowdhury Tech","rafi@example.com","+8801700000008","Marketplace","Won","Backend Team","","Won: landing page project"),
    mk("demo-9","Mitu Akter","Akter Fashion","mitu@example.com","+8801700000009","Email","New","",tm,""),
    mk("demo-10","Shakib Hasan","Hasan Export","shakib@example.com","+8801700000010","Email","Lost","","","Not interested right now"),
  ];
  // Global sequence for demo codes, in list order: ACM-style prefix + 001, 002, …
  seeded.forEach((lead, i) => { lead.lead_code = leadCodePrefix(lead.company || lead.name) + "-" + String(i + 1).padStart(3, "0"); });
  return seeded;
}
function saveDemo(){
  try{ localStorage.setItem(DEMO_KEY, JSON.stringify(leads)); localStorage.setItem(DEMO_ACT_KEY, JSON.stringify(activities)); }catch(e){}
}
function loadDemo(){
  try{
    const raw = localStorage.getItem(DEMO_KEY);
    if(raw){ leads = JSON.parse(raw); } else { leads = demoSeed(); saveDemo(); }
    const rawA = localStorage.getItem(DEMO_ACT_KEY);
    activities = rawA ? JSON.parse(rawA) : [];
  }catch(e){ leads = demoSeed(); activities = []; }
}

async function loadFromSupabase(){
  const { data, error } = await supabaseClient.from("leads").select("*").order("updated_at", { ascending:false });
  if(error){ console.error(error); setStatus("Supabase error: " + error.message); return; }
  leads = data || [];
  const { data: acts } = await supabaseClient.from("activities").select("*").order("created_at", { ascending:false }).limit(500);
  activities = acts || [];
  renderAll();
}
async function refresh(){
  if(mode === "supabase") await loadFromSupabase(); else { loadDemo(); renderAll(); }
}
function setStatus(msg){
  const el = document.getElementById("statusLine");
  if(el) el.textContent = msg;
}

async function saveLeadToBackend(lead){
  if(mode === "supabase"){
    const { error } = await supabaseClient.from("leads").upsert(lead);
    if(error) alert("Could not save to Supabase: " + error.message);
    else await loadFromSupabase();
  } else { saveDemo(); renderAll(); }
}
async function deleteLeadFromBackend(id){
  if(mode === "supabase"){
    await supabaseClient.from("activities").delete().eq("lead_id", id);
    const { error } = await supabaseClient.from("leads").delete().eq("id", id);
    if(error) alert("Could not delete: " + error.message);
    else await loadFromSupabase();
  } else {
    leads = leads.filter(l => l.id !== id);
    activities = activities.filter(a => a.lead_id !== id);
    saveDemo(); renderAll();
  }
}
async function logActivityToBackend(leadId, channel, note){
  const act = { lead_id: leadId, channel, note: note || (channel + " logged on " + new Date().toLocaleString()), created_at: new Date().toISOString() };
  if(mode === "supabase"){
    const { error } = await supabaseClient.from("activities").insert(act);
    if(error){ alert("Could not log activity: " + error.message); return; }
    await loadFromSupabase();
  } else {
    act.id = "act-" + Date.now() + "-" + Math.random().toString(36).slice(2,7);
    activities.unshift(act); saveDemo(); renderAll();
  }
}

function getFiltered(){
  const q = (document.getElementById("searchInput").value || "").toLowerCase();
  const stage = document.getElementById("filterStage").value;
  const source = document.getElementById("filterSource").value;
  const assignee = document.getElementById("filterAssignee").value;
  return leads.filter(l => {
    if(stage && l.stage !== stage) return false;
    if(source && l.source !== source) return false;
    if(assignee && (l.assignee || "") !== assignee) return false;
    if(q && !((l.name+" "+l.company+" "+l.email+" "+l.phone+" "+(l.website||"")+" "+(l.lead_code||"")+" "+(l.outcome||"")).toLowerCase().includes(q))) return false;
    return true;
  });
}
function renderStats(){
  const total = leads.length;
  const byStage = {}; STAGES.forEach(s => byStage[s] = leads.filter(l => l.stage === s).length);
  const repliedOrLater = leads.filter(isRepliedOrLater).length;
  const repliedRate = total ? Math.round(repliedOrLater / total * 100) : 0;
  const handed = leads.filter(l => l.handed_over).length;
  const won = byStage["Won"] || 0;
  const dueToday = leads.filter(l => l.follow_up_date === todayISO() && l.stage !== "Won" && l.stage !== "Lost").length;
  const overdue = leads.filter(l => l.follow_up_date && l.follow_up_date < todayISO() && l.stage !== "Won" && l.stage !== "Lost").length;
  const el = document.getElementById("stats");
  if(!el) return;
  el.innerHTML = `
    <div class="stat"><small>Total leads</small><b>${total}</b><p>All prospects in the system</p></div>
    <div class="stat"><small>Replied rate</small><b>${repliedRate}%</b><p>${repliedOrLater} of ${total} reached Replied or later</p></div>
    <div class="stat"><small>Handed over</small><b>${handed}</b><p>Only Replied leads go to the team</p></div>
    <div class="stat"><small>Done</small><b>${won}</b><p>Closed deals</p></div>
    <div class="stat"><small>Due today</small><b>${dueToday}</b><p>Follow-ups due today</p></div>
    <div class="stat"><small>Overdue</small><b>${overdue}</b><p>Follow-ups past due</p></div>`;
  const stageEl = document.getElementById("stageBreakdown");
  if (stageEl) {
  stageEl.innerHTML = STAGES
    .filter(s => s !== "Proposal" && s !== "Negotiation")
    .map(s => `
      <div class="row">
        <span>${s === "Won" ? "Done / Won" : s}</span>
        <b>${byStage[s]}</b>
      </div>
    `)
    .join("");
}
  const dueEl = document.getElementById("dueList");
  if(dueEl){
    const due = leads.filter(l => l.follow_up_date && l.follow_up_date <= todayISO() && l.stage !== "Won" && l.stage !== "Lost")
      .sort((a,b) => (a.follow_up_date||"").localeCompare(b.follow_up_date||"")).slice(0,8);
    dueEl.innerHTML = due.length ? due.map(l => `<div class="row"><span><b>${esc(l.name)}</b> <span class="muted">(${esc(l.stage)})</span></span><span class="due ${dueClass(l)}">${dueLabel(l)}</span></div>`).join("")
      : `<p class="muted">Nothing due today or overdue. Nice work.</p>`;
  }
  const assigneeSel = document.getElementById("filterAssignee");
  if(assigneeSel){
    const cur = assigneeSel.value;
    const names = [...new Set(leads.map(l => l.assignee).filter(Boolean))].sort();
    assigneeSel.innerHTML = `<option value="">All assignees</option>` + names.map(n => `<option>${esc(n)}</option>`).join("");
    assigneeSel.value = cur;
  }
}
function stagePill(stage){
  const cls = stage === "Won" ? "green" : stage === "Lost" ? "red" : stage === "Replied" ? "amber" : stage === "Requirement" || stage === "Proposal" ? "green" : "grey";
  return `<span class="pill ${cls}">${esc(displayStage(stage))}</span>`;
}
function leadRow(l){
  const last = lastActivityFor(l.id);
  const remark = (l.notes || "").length > 60 ? (l.notes || "").slice(0, 60) + "…" : (l.notes || "—");
  const web = l.website ? `<div><a class="website-link" href="${esc(l.website)}" target="_blank" rel="noopener">${esc(websiteDisplay(l.website))}</a></div>` : "";
  return `<tr>
    <td><div class="lead-name"><span class="lead-code">${esc(displayLeadCode(l))}</span> · ${esc(l.name)}</div><div class="muted">${esc(l.company)}</div></td>
    <td><div>${esc(l.email)}</div><div class="muted">${esc(l.phone)}</div>${web}</td>
    <td>${last ? esc(last.channel) : esc(l.source || "—")}</td>
    <td class="remark-cell">${esc(remark)}</td>
    <td>${stagePill(l.stage)}</td>
    <td>
      <button class="btn small secondary" onclick="openDetail('${l.id}')">Open</button>
      <button class="btn small secondary" onclick="openDetail('${l.id}')">Log</button>
      ${l.stage !== "Won" && l.stage !== "Lost" ? `<button class="btn small" onclick="markDone('${l.id}')">Mark Done</button>` : ""}
      ${l.handed_over ? `<span class="pill green">In team queue</span>` : ""}
    </td></tr>`;
}
function renderList(){
  const el = document.getElementById("listBody");
  if(!el) return;
  const rows = getFiltered();
  el.innerHTML = rows.length ? rows.map(leadRow).join("") : `<tr><td colspan="6"><div class="empty">No leads match these filters. Try clearing the search or add a new lead.</div></td></tr>`;
}
function renderBoard(){
  const el = document.getElementById("board");
  if(!el) return;
  const filtered = getFiltered();
  const groups = ["New","Contacted","Replied","Requirement","Proposal","Negotiation","Won","Lost"];
  el.innerHTML = groups.map(stage => {
    const items = filtered.filter(l => l.stage === stage);
    return `<div class="col"><h4>${esc(displayStage(stage))} <span>${items.length}</span></h4>` +
      (items.map(l => { const last = lastActivityFor(l.id); const remark = (l.notes || "").length > 60 ? (l.notes || "").slice(0, 60) + "…" : (l.notes || ""); return `<div class="leadcard" onclick="openDetail('${l.id}')">
        <h5><span class="lead-code">${esc(displayLeadCode(l))}</span> · ${esc(l.name)}</h5><p>${esc(l.company)}</p>
        ${l.website ? `<p><a class="website-link" href="${esc(l.website)}" target="_blank" rel="noopener">${esc(websiteDisplay(l.website))}</a></p>` : ""}
        ${remark ? `<p>${esc(remark)}</p>` : ""}
        <p class="muted">${last ? esc(last.channel) : esc(l.source || "—")}</p>
        ${handoffLocked(l) ? `<div class="lock">🔒 ${handoffLockReason(l)}</div>` : ""}
      </div>`; }).join("") || `<p class="muted">No leads</p>`) + `</div>`;
  }).join("");
}
function renderHandoff(){
  const ready = leads.filter(l => l.stage === "Replied" && !l.handed_over);
  const queue = leads.filter(l => l.handed_over);
  const locked = leads.filter(handoffLocked);
  const readyEl = document.getElementById("handoffReady");
  if(readyEl) readyEl.innerHTML = ready.length ? ready.map(l => `<div class="card">
    <b><span class="lead-code">${esc(displayLeadCode(l))}</span> · ${esc(l.name)}</b> <span class="muted">— ${esc(l.company)} · ${esc(l.source)}</span>
    <p class="muted">${esc(l.requirement || l.notes || "No requirement noted yet.")}</p>
    <button class="btn small" onclick="autoHandOver('${l.id}')">Hand over to team</button>
    <button class="btn small secondary" onclick="openDetail('${l.id}')">Open lead</button></div>`).join("")
    : `<p class="muted">No leads are ready yet. Only leads that reach Replied appear here — the other prospects stay with you and are never sent to the team.</p>`;
  const queueEl = document.getElementById("handoffQueue");
  if(queueEl) queueEl.innerHTML = queue.length ? queue.map(l => `<div class="card">
    <b><span class="lead-code">${esc(displayLeadCode(l))}</span> · ${esc(l.name)}</b> ${stagePill(l.stage)} <span class="muted">· Assigned to ${esc(l.assignee || "team")}</span>
    <p><b>Requirement:</b> ${esc(l.requirement || "—")}</p>
    ${l.website ? `<p><a class="website-link" href="${esc(l.website)}" target="_blank" rel="noopener">${esc(websiteDisplay(l.website))}</a></p>` : ""}
    <button class="btn small secondary" onclick="openDetail('${l.id}')">Open lead</button></div>`).join("")
    : `<p class="muted">Team queue is empty. Hand over a Replied lead to see it here.</p>`;
  const lockedEl = document.getElementById("handoffLocked");
  if(lockedEl) lockedEl.innerHTML = locked.length ? locked.map(l => `<div class="row"><span><b>${esc(l.name)}</b> <span class="muted">(${esc(l.stage)} · ${esc(l.source)})</span></span><span>🔒 Locked</span></div>`).join("")
    : `<p class="muted">No locked leads — every lead has reached Replied or later.</p>`;
  const c1 = document.getElementById("countReady"); if(c1) c1.textContent = ready.length;
  const c2 = document.getElementById("countQueue"); if(c2) c2.textContent = queue.length;
  const c3 = document.getElementById("countLocked"); if(c3) c3.textContent = locked.length;
}
function renderAll(){
  renderStats(); renderList(); renderBoard(); renderHandoff();
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.view === currentView));
  ["dashboardView","listView","boardView","handoffView"].forEach(id => {
    const el = document.getElementById(id); if(el) el.classList.toggle("hidden", id !== currentView + "View");
  });
}
function setView(view){
  currentView = view; renderAll();
  window.scrollTo({ top:0, behavior:"smooth" });
}

function openModal(id){ document.getElementById(id).classList.add("open"); }
function closeModal(id){ document.getElementById(id).classList.remove("open"); }
// Draft restore (2026-10-30, intermittent modal-close bug): if the Quick
// Add form ever closes unexpectedly (accidental backdrop tap, navigation,
// reload), the typed Who/Name/Company/Website/Remark must not be lost.
// The draft is saved on every input, restored only when opening a NEW
// lead, and cleared on Save or on an intentional Cancel.
const DRAFT_KEY = "leadcrm_quick_draft_v1";
function saveQuickDraft(){
  if(editingId) return;
  try{
    const d = {};
    ["f_who","f_name","f_company","f_website","f_notes","f_requirement"].forEach(id => { const el = document.getElementById(id); if(el) d[id] = el.value; });
    d.quickChannel = quickChannel; d.quickStatus = quickStatus;
    const outEl = document.getElementById("f_outcome"); if(outEl) d.f_outcome = outEl.value;
    if(d.f_who || d.f_name || d.f_notes) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  }catch(e){}
}
function clearQuickDraft(){ try{ localStorage.removeItem(DRAFT_KEY); }catch(e){} }
function restoreQuickDraft(){
  try{
    const raw = localStorage.getItem(DRAFT_KEY); if(!raw) return false;
    const d = JSON.parse(raw);
    Object.keys(d).forEach(id => { const el = document.getElementById(id); if(el && d[id] !== undefined) el.value = d[id]; });
    if(d.quickChannel) selectChannel(d.quickChannel);
    if(d.quickStatus) selectQuickStatus(d.quickStatus);
    if(d.f_name) nameManuallyEdited = true;
    if(d.f_company) companyManuallyEdited = true;
    if(d.f_website) websiteManuallyEdited = true;
    updateWhoParsed();
    return true;
  }catch(e){ return false; }
}
function cancelLeadForm(){ clearQuickDraft(); closeModal("leadModal"); }
function resetQuickForm(){
  quickChannel = "Email"; quickStatus = "Contacted";
  nameManuallyEdited = false; companyManuallyEdited = false; websiteManuallyEdited = false;
  document.getElementById("f_who").value = "";
  ["f_name","f_company","f_website","f_email","f_phone","f_assignee","f_follow","f_notes","f_requirement"].forEach(id => { const el = document.getElementById(id); if(el) el.value = ""; });
  const outEl = document.getElementById("f_outcome"); if(outEl) outEl.value = "";
  document.getElementById("whoParsed").textContent = "";
  document.getElementById("moreDetails").classList.add("hidden");
  document.getElementById("moreDetailsBtn").textContent = "More details";
  selectChannel("Email"); selectQuickStatus("Contacted");
  const full = document.getElementById("f_status_full"); if(full) full.value = "Contacted";
}
function openAddLead(){
  editingId = null;
  document.getElementById("leadFormTitle").textContent = "Quick add lead";
  resetQuickForm();
  const hadDraft = restoreQuickDraft();
  document.getElementById("quickSaved").classList.add("hidden");
  if(hadDraft){
    const el = document.getElementById("quickSaved");
    el.textContent = "Restored your unsaved draft — continue below, or Cancel to discard it.";
    el.classList.remove("hidden");
  }
  document.getElementById("deleteLeadBtn").classList.add("hidden");
  updateAddedToday();
  openModal("leadModal");
  setTimeout(() => document.getElementById("f_who").focus(), 50);
}
function openEditLead(){
  const l = leads.find(x => x.id === detailId); if(!l) return;
  editingId = l.id;
  document.getElementById("leadFormTitle").textContent = "Edit lead";
  document.getElementById("f_who").value = l.name || l.email || l.phone || "";
  document.getElementById("f_name").value = l.name || "";
  document.getElementById("f_company").value = l.company || "";
  document.getElementById("f_website").value = l.website || "";
  const outEl = document.getElementById("f_outcome"); if(outEl) outEl.value = outcomeFromLead(l);
  document.getElementById("f_email").value = l.email || "";
  document.getElementById("f_phone").value = l.phone || "";
  document.getElementById("f_source").value = l.source || "Email";
  document.getElementById("f_stage").value = l.stage || "New";
  document.getElementById("f_assignee").value = l.assignee || "";
  document.getElementById("f_follow").value = l.follow_up_date || "";
  document.getElementById("f_notes").value = l.notes || "";
  document.getElementById("f_requirement").value = l.requirement || "";
  document.getElementById("quickSaved").classList.add("hidden");
  // Editing: loaded values are the user's/manual values, so Who must not
  // overwrite them while typing in Who.
  nameManuallyEdited = true; companyManuallyEdited = true; websiteManuallyEdited = true;
  selectChannel(l.source || "Email"); selectQuickStatus(stageToQuickStatus(l.stage || "New"));
  const full = document.getElementById("f_status_full"); if(full) full.value = l.stage || "New";
  updateWhoParsed();
  document.getElementById("deleteLeadBtn").classList.remove("hidden");
  closeModal("detailModal"); openModal("leadModal");
}
async function submitLeadForm(e){
  e.preventDefault();
  updateWhoParsed();
  const parsed = parseWho(document.getElementById("f_who").value);
  // If Name was only auto-filled (not manually edited), trust the full
  // parsed Who value over any stale auto-filled value.
  const name = (!nameManuallyEdited && parsed.name ? parsed.name : (document.getElementById("f_name").value.trim() || parsed.name)).trim();
  const company = document.getElementById("f_company").value.trim() || parsed.company;
  const email = document.getElementById("f_email").value.trim() || parsed.email;
  const phone = document.getElementById("f_phone").value.trim() || parsed.phone;
  if(!name && !email && !phone){ alert("Enter a name, email, or phone first."); document.getElementById("f_who").focus(); return; }
  const moreOpen = !document.getElementById("moreDetails").classList.contains("hidden");
  let stage = quickStatusToStage(quickStatus);
  let source = quickChannel;
  if(moreOpen){
    stage = document.getElementById("f_stage").value || stage;
    source = document.getElementById("f_source").value || source;
  }
  // Visible full-status dropdown (always shown, not only in More details)
  // wins over the quick chips when it was used to pick a stage.
  const fullEl = document.getElementById("f_status_full");
  if(fullEl && fullEl.value && fullEl.value !== quickStatusToStage(quickStatus)) stage = fullEl.value;
  const outcomeEl = document.getElementById("f_outcome");
  const outcome = outcomeEl ? outcomeEl.value : "";
  // Outcome dropdown overrides Status / full stage when Won or Lost is chosen.
  if(outcome === "Won" || outcome === "Lost") stage = outcome;
  const remark = document.getElementById("f_notes").value.trim();
  const website = normalizeWebsite(document.getElementById("f_website").value.trim() || websiteFromEmail(email));
  let data = {
    name: name || email || phone, company, email, phone, website, source, stage,
    outcome,
    assignee: document.getElementById("f_assignee").value.trim(),
    follow_up_date: document.getElementById("f_follow").value || null,
    notes: remark,
    requirement: document.getElementById("f_requirement").value.trim(),
  };
  data.follow_up_date = autoFollowUp(stage, data.follow_up_date);
  if(editingId){
    const old = leads.find(l => l.id === editingId);
    let updated = applyAutoHandoff({ ...old, ...data, updated_at: new Date().toISOString() });
    if(stage === "New" || stage === "Contacted"){
      updated.handed_over = false; updated.handoff_note = ""; updated.handoff_date = null;
    }
    if(!updated.lead_code) ensureLeadCode(updated);
    if(!updated.requirement && updated.notes) updated.requirement = updated.notes;
    await saveLeadToBackend(updated);
    await logActivityToBackend(editingId, source, remark || (source + " contact"));
    closeModal("leadModal"); setStatus("Lead saved.");
    return;
  }
  // Duplicate guard: same email (case-insensitive) or same phone (digits only)
  const dup = findDuplicate(email, phone);
  if(dup){
    let updated = { ...dup };
    if(remark && !(updated.notes || "").includes(remark)) updated.notes = updated.notes ? updated.notes + "; " + remark : remark;
    if(!updated.website && website) updated.website = website;
    if(outcome === "Won" || outcome === "Lost"){ updated.stage = outcome; updated.outcome = outcome; }
    else if(stageIndex(stage) > stageIndex(updated.stage)) updated.stage = stage;
    if(!updated.lead_code) ensureLeadCode(updated);
    updated.follow_up_date = autoFollowUp(updated.stage, updated.follow_up_date);
    updated = applyAutoHandoff({ ...updated, updated_at: new Date().toISOString() });
    await saveLeadToBackend(updated);
    await logActivityToBackend(dup.id, source, remark || (source + " contact"));
    const savedEl = document.getElementById("quickSaved");
    savedEl.textContent = "Already in the system — updated " + (dup.name || dup.email || dup.phone) + " instead of creating a duplicate.";
    savedEl.classList.remove("hidden");
    clearQuickDraft(); resetQuickForm(); document.getElementById("quickSaved").classList.remove("hidden");
    document.getElementById("quickSaved").textContent = "Already in the system — updated " + (dup.name || dup.email || dup.phone) + " instead of creating a duplicate.";
    updateAddedToday(); document.getElementById("f_who").focus();
    return;
  }
  let lead = applyAutoHandoff({ ...data, lead_code: nextLeadCode(company, name || email || phone), handed_over:false, handoff_note:"", handoff_date:null });
  if(lead.handed_over){ lead.handoff_note = remark; lead.handoff_date = new Date().toISOString(); if(!lead.requirement) lead.requirement = remark; }
  let savedId = null;
  if(mode === "supabase"){
    await saveLeadToBackend(lead);
    // saveLeadToBackend reloads from Supabase; find the just-saved lead by email/phone
    const found = findDuplicate(email, phone);
    savedId = found ? found.id : null;
  } else {
    lead = { id:"demo-" + Date.now(), ...lead, created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
    leads.unshift(lead); saveDemo(); renderAll(); savedId = lead.id;
  }
  if(savedId) await logActivityToBackend(savedId, source, remark || (source + " contact"));
  addedTodayCount++;
  // Stay in the modal for the next lead: clear, show Saved, focus Who.
  const savedName = name;
  clearQuickDraft(); resetQuickForm();
  const savedEl = document.getElementById("quickSaved");
  savedEl.textContent = "Saved: " + savedName + " — add another below.";
  savedEl.classList.remove("hidden");
  updateAddedToday();
  setStatus("Lead saved.");
  document.getElementById("f_who").focus();
}
async function deleteCurrentLead(){
  if(!editingId) return;
  if(!confirm("Delete this lead and its activities? This cannot be undone.")) return;
  closeModal("leadModal"); await deleteLeadFromBackend(editingId); editingId = null;
}
function openDetail(id){
  const l = leads.find(x => x.id === id); if(!l) return;
  detailId = id;
  const acts = activities.filter(a => a.lead_id === id).slice(0,50);
  document.getElementById("detailBody").innerHTML = `
    <p><b><span class="lead-code">${esc(displayLeadCode(l))}</span> · ${esc(l.name)}</b> ${stagePill(l.stage)} · ${esc(l.source)}</p>
    <p class="muted">${esc(l.company)} · ${esc(l.email)} · ${esc(l.phone)}</p>
    ${l.website ? `<p><b>Website:</b> <a class="website-link" href="${esc(l.website)}" target="_blank" rel="noopener">${esc(websiteDisplay(l.website))}</a></p>` : ""}
    <p><b>Assignee:</b> ${esc(l.assignee || "Unassigned")} · <b>Follow-up:</b> <span class="due ${dueClass(l)}">${esc(dueLabel(l))}</span></p>
    <p><b>Requirement:</b> ${esc(l.requirement || "—")}</p>
    <p><b>Notes:</b> ${esc(l.notes || "—")}</p>
    <div class="fieldgrid"><div class="field"><label>Status — change anytime</label><select id="detailStage">${STAGES.map(s => `<option value="${s}" ${l.stage === s ? "selected" : ""}>${s === "Won" ? "Done / Won" : s}</option>`).join("")}</select></div>
    <div class="field"><label>Outcome</label><select id="detailOutcome"><option value="">— No outcome yet —</option><option value="Won" ${outcomeFromLead(l) === "Won" ? "selected" : ""}>Won</option><option value="Lost" ${outcomeFromLead(l) === "Lost" ? "selected" : ""}>Lost</option></select></div></div>
    <button class="btn small" onclick="saveDetailStage()">Save status</button>
    <button class="btn small secondary" onclick="saveDetailOutcome()">Save outcome</button>
    <p class="muted">Status goes Contacted → Replied → Requirement → Proposal → Negotiation → Done/Won or Lost. Replied or later goes to the team queue automatically.</p>
    ${l.handed_over ? `<p><span class="pill green">In team queue</span></p>` : ""}
    ${handoffLocked(l) ? `<div class="lock">🔒 ${handoffLockReason(l)} — this lead is ${esc(l.stage)}. Only Replied through Negotiation leads can be handed to the backend team.</div>` : ""}
    <h3>Log an activity (one tap)</h3>
    <div class="chips">${CHANNELS.map(c => `<button class="chip" onclick="quickLog('${c}')">+ ${c}</button>`).join("")}</div>
    <div class="field" style="margin-top:10px"><label>Optional note for the activity</label><input id="activityNote" placeholder="e.g. Asked for pricing, call back Thursday"></div>
    <button class="btn small" onclick="logNoteActivity()">Save note</button>
    <h3>Activity history</h3>
    ${acts.length ? acts.map(a => `<div class="activity"><b>${esc(a.channel)}</b> · <span class="muted">${new Date(a.created_at).toLocaleString()}</span><div>${esc(a.note || "")}</div></div>`).join("") : `<p class="muted">No activities yet.</p>`}`;
  openModal("detailModal");
}
async function quickLog(channel){
  const note = document.getElementById("activityNote") ? document.getElementById("activityNote").value.trim() : "";
  await logActivityToBackend(detailId, channel, note);
  openDetail(detailId);
}
async function logNoteActivity(){
  const note = document.getElementById("activityNote").value.trim();
  if(!note){ alert("Write a note first, or tap a channel above for a one-tap log."); return; }
  await logActivityToBackend(detailId, "Note", note);
  openDetail(detailId);
}
function openHandoff(id){
  // No manual handoff form in the fast flow: Replied leads are handed
  // over automatically. This kept for compatibility and now auto-hands over.
  return autoHandOver(id);
}
async function submitHandoff(e){
  e.preventDefault();
  const l = leads.find(x => x.id === detailId); if(!l) return;
  if(handoffLocked(l)){ alert("Handoff locked: this lead has not replied yet."); return; }
  const updated = { ...l,
    assignee: document.getElementById("h_assignee").value.trim() || l.assignee || "Backend Team",
    requirement: document.getElementById("h_note").value.trim() || l.requirement || "",
    handed_over: true, handoff_note: document.getElementById("h_note").value.trim(),
    handoff_date: new Date().toISOString(), stage: "Requirement", updated_at: new Date().toISOString() };
  await saveLeadToBackend(updated);
  await logActivityToBackend(detailId, "Handoff", "Handed over to " + updated.assignee + ": " + updated.requirement);
  closeModal("handoffModal"); setView("handoff"); setStatus("Handed over: " + l.name + " is now in the team queue.");
}
function initFilters(){
  const stageSel = document.getElementById("filterStage");
  stageSel.innerHTML = `<option value="">All stages</option>` + STAGES.map(s => `<option value="${s}">${s === "Won" ? "Done / Won" : s}</option>`).join("");
  const srcSel = document.getElementById("filterSource");
  srcSel.innerHTML = `<option value="">All sources</option>` + SOURCES.map(s => `<option>${s}</option>`).join("");
}
async function init(){
  initFilters();
  document.getElementById("searchInput").addEventListener("input", renderAll);
  document.getElementById("filterStage").addEventListener("change", renderAll);
  document.getElementById("filterSource").addEventListener("change", renderAll);
  document.getElementById("filterAssignee").addEventListener("change", renderAll);
  document.getElementById("leadForm").addEventListener("submit", submitLeadForm);
  const whoEl = document.getElementById("f_who"); if(whoEl) whoEl.addEventListener("input", updateWhoParsed);
  const nameEl = document.getElementById("f_name"); if(nameEl) nameEl.addEventListener("input", () => { nameManuallyEdited = true; });
  const compEl = document.getElementById("f_company"); if(compEl) compEl.addEventListener("input", () => { companyManuallyEdited = true; });
  const webEl = document.getElementById("f_website"); if(webEl) webEl.addEventListener("input", () => { websiteManuallyEdited = true; });
  // Bug fix 2026-10-30: pressing Enter in Who/Name submitted the form
  // immediately, clearing the form before the user had finished — which
  // looked like being kicked back to Dashboard. Enter in a single-line
  // input now moves to the next field instead of saving; Save lead (or
  // clicking it) is the only way to save. Enter in the remark textarea
  // still makes a new line, as normal.
  document.getElementById("leadForm").addEventListener("keydown", (e) => {
    if(e.key !== "Enter" || !e.target || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    const fields = [...document.querySelectorAll("#leadForm input, #leadForm textarea, #leadForm select")]
      .filter(el => el.type !== "hidden" && !el.disabled && el.offsetParent !== null);
    const idx = fields.indexOf(e.target);
    const next = fields[idx + 1];
    if(next) next.focus();
    else { const btn = document.querySelector('#leadForm button[type="submit"]'); if(btn) btn.focus(); }
  });
  document.getElementById("handoffForm").addEventListener("submit", submitHandoff);
  // Bug fix 2026-10-30 (intermittent manual-name close): clicking anywhere
  // inside the white modal must NEVER close it, and clicking the dark
  // backdrop must NOT close the Quick Add form either — an accidental
  // backdrop tap (especially on mobile, where the modal scrolls) was
  // losing the typed name and dropping the user back to Dashboard.
  // Close only via Cancel, Close, Save, or Delete buttons.
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => e.stopPropagation()));
  document.getElementById("leadForm").addEventListener("input", saveQuickDraft);
  document.getElementById("leadForm").addEventListener("change", saveQuickDraft);

  const pill = document.getElementById("modePill");
  if(hasSupabase && window.supabase){
    mode = "supabase";
    supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    pill.textContent = "● Connected"; pill.className = "mode-pill live";
    await loadFromSupabase();
    supabaseClient.channel("leads-changes")
      .on("postgres_changes", { event:"*", schema:"public", table:"leads" }, loadFromSupabase)
      .on("postgres_changes", { event:"*", schema:"public", table:"activities" }, loadFromSupabase)
      .subscribe();
    setInterval(loadFromSupabase, 5000);
  } else {
    mode = "demo";
    pill.textContent = "● Demo";
    loadDemo(); renderAll();
  }
  setStatus(mode === "supabase" ? "Connected" : "Demo");
}
document.addEventListener("DOMContentLoaded", init);
