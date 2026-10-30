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

const DEMO_KEY = "leadcrm_demo_leads_v1";
const DEMO_ACT_KEY = "leadcrm_demo_activities_v1";
function demoSeed(){
  const t = todayISO();
  const y = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const tm = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  const mk = (id,name,company,email,phone,source,stage,assignee,follow_up_date,requirement) => ({
    id, name, company, email, phone, source, stage, assignee, follow_up_date,
    notes:"", requirement: requirement || "", handed_over: stageIndex(stage) >= stageIndex("Requirement") && stage !== "Lost",
    handoff_note:"", handoff_date:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  });
  return [
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
    if(q && !((l.name+" "+l.company+" "+l.email+" "+l.phone).toLowerCase().includes(q))) return false;
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
    <div class="stat"><small>Won</small><b>${won}</b><p>Closed deals</p></div>
    <div class="stat"><small>Due today</small><b>${dueToday}</b><p>Follow-ups due today</p></div>
    <div class="stat"><small>Overdue</small><b>${overdue}</b><p>Follow-ups past due</p></div>`;
  const stageEl = document.getElementById("stageBreakdown");
  if(stageEl) stageEl.innerHTML = STAGES.map(s => `<div class="row"><span>${s}</span><b>${byStage[s]}</b></div>`).join("");
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
  return `<span class="pill ${cls}">${esc(stage)}</span>`;
}
function leadRow(l){
  const locked = handoffLocked(l);
  return `<tr>
    <td><div class="lead-name">${esc(l.name)}</div><div class="muted">${esc(l.company)}</div></td>
    <td><div>${esc(l.email)}</div><div class="muted">${esc(l.phone)}</div></td>
    <td>${esc(l.source)}</td>
    <td>${stagePill(l.stage)}</td>
    <td>${esc(l.assignee || "—")}</td>
    <td><span class="due ${dueClass(l)}">${esc(dueLabel(l))}</span></td>
    <td>
      <button class="btn small secondary" onclick="openDetail('${l.id}')">Open</button>
      ${locked
        ? `<button class="btn small" disabled title="Locked: only Replied leads can be handed over">🔒 Handoff locked</button>`
        : (l.handed_over
          ? `<span class="pill green">Handed over</span>`
          : `<button class="btn small" onclick="openHandoff('${l.id}')">Hand over</button>`)}
    </td></tr>`;
}
function renderList(){
  const el = document.getElementById("listBody");
  if(!el) return;
  const rows = getFiltered();
  el.innerHTML = rows.length ? rows.map(leadRow).join("") : `<tr><td colspan="7"><div class="empty">No leads match these filters. Try clearing the search or add a new lead.</div></td></tr>`;
}
function renderBoard(){
  const el = document.getElementById("board");
  if(!el) return;
  const filtered = getFiltered();
  const groups = ["New","Contacted","Replied","Requirement","Proposal","Negotiation","Won","Lost"];
  el.innerHTML = groups.map(stage => {
    const items = filtered.filter(l => l.stage === stage);
    return `<div class="col"><h4>${esc(stage)} <span>${items.length}</span></h4>` +
      (items.map(l => `<div class="leadcard" onclick="openDetail('${l.id}')">
        <h5>${esc(l.name)}</h5><p>${esc(l.company)} · ${esc(l.source)}</p>
        <p>${esc(l.assignee ? "Assigned: " + l.assignee : "Unassigned")} · <span class="due ${dueClass(l)}">${esc(dueLabel(l))}</span></p>
        ${handoffLocked(l) ? `<div class="lock">🔒 ${handoffLockReason(l)}</div>` : ""}
      </div>`).join("") || `<p class="muted">No leads</p>`) + `</div>`;
  }).join("");
}
function renderHandoff(){
  const ready = leads.filter(l => l.stage === "Replied" && !l.handed_over);
  const queue = leads.filter(l => l.handed_over);
  const locked = leads.filter(handoffLocked);
  const readyEl = document.getElementById("handoffReady");
  if(readyEl) readyEl.innerHTML = ready.length ? ready.map(l => `<div class="card">
    <b>${esc(l.name)}</b> <span class="muted">— ${esc(l.company)} · ${esc(l.source)}</span>
    <p class="muted">${esc(l.requirement || l.notes || "No requirement noted yet.")}</p>
    <button class="btn small" onclick="openHandoff('${l.id}')">Hand over to team</button>
    <button class="btn small secondary" onclick="openDetail('${l.id}')">Open lead</button></div>`).join("")
    : `<p class="muted">No leads are ready yet. Only leads that reach Replied appear here — the other prospects stay with you and are never sent to the team.</p>`;
  const queueEl = document.getElementById("handoffQueue");
  if(queueEl) queueEl.innerHTML = queue.length ? queue.map(l => `<div class="card">
    <b>${esc(l.name)}</b> ${stagePill(l.stage)} <span class="muted">· Assigned to ${esc(l.assignee || "team")}</span>
    <p><b>Requirement:</b> ${esc(l.requirement || "—")}</p>
    <p class="muted">Handoff note: ${esc(l.handoff_note || "—")} ${l.handoff_date ? "· " + new Date(l.handoff_date).toLocaleString() : ""}</p>
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
function openAddLead(){
  editingId = null;
  document.getElementById("leadFormTitle").textContent = "Add lead";
  ["f_name","f_company","f_email","f_phone","f_assignee","f_follow","f_notes","f_requirement"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("f_source").value = "Email";
  document.getElementById("f_stage").value = "New";
  document.getElementById("deleteLeadBtn").classList.add("hidden");
  openModal("leadModal");
}
function openEditLead(){
  const l = leads.find(x => x.id === detailId); if(!l) return;
  editingId = l.id;
  document.getElementById("leadFormTitle").textContent = "Edit lead";
  document.getElementById("f_name").value = l.name || "";
  document.getElementById("f_company").value = l.company || "";
  document.getElementById("f_email").value = l.email || "";
  document.getElementById("f_phone").value = l.phone || "";
  document.getElementById("f_source").value = l.source || "Email";
  document.getElementById("f_stage").value = l.stage || "New";
  document.getElementById("f_assignee").value = l.assignee || "";
  document.getElementById("f_follow").value = l.follow_up_date || "";
  document.getElementById("f_notes").value = l.notes || "";
  document.getElementById("f_requirement").value = l.requirement || "";
  document.getElementById("deleteLeadBtn").classList.remove("hidden");
  closeModal("detailModal"); openModal("leadModal");
}
async function submitLeadForm(e){
  e.preventDefault();
  const name = document.getElementById("f_name").value.trim();
  if(!name){ alert("Name is required."); return; }
  const data = {
    name, company: document.getElementById("f_company").value.trim(),
    email: document.getElementById("f_email").value.trim(),
    phone: document.getElementById("f_phone").value.trim(),
    source: document.getElementById("f_source").value,
    stage: document.getElementById("f_stage").value,
    assignee: document.getElementById("f_assignee").value.trim(),
    follow_up_date: document.getElementById("f_follow").value || null,
    notes: document.getElementById("f_notes").value.trim(),
    requirement: document.getElementById("f_requirement").value.trim(),
  };
  if(editingId){
    const old = leads.find(l => l.id === editingId);
    await saveLeadToBackend({ ...old, ...data, updated_at: new Date().toISOString() });
  } else if(mode === "supabase"){
    await saveLeadToBackend({ ...data, handed_over:false, handoff_note:"", handoff_date:null });
  } else {
    const lead = { id:"demo-" + Date.now(), ...data, handed_over:false, handoff_note:"", handoff_date:null, created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
    leads.unshift(lead); saveDemo(); renderAll();
  }
  closeModal("leadModal"); setStatus("Lead saved.");
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
    <p><b>${esc(l.name)}</b> ${stagePill(l.stage)} · ${esc(l.source)}</p>
    <p class="muted">${esc(l.company)} · ${esc(l.email)} · ${esc(l.phone)}</p>
    <p><b>Assignee:</b> ${esc(l.assignee || "Unassigned")} · <b>Follow-up:</b> <span class="due ${dueClass(l)}">${esc(dueLabel(l))}</span></p>
    <p><b>Requirement:</b> ${esc(l.requirement || "—")}</p>
    <p><b>Notes:</b> ${esc(l.notes || "—")}</p>
    ${l.handed_over ? `<p><b>Handed over:</b> ${esc(l.handoff_note || "")} ${l.handoff_date ? "· " + new Date(l.handoff_date).toLocaleString() : ""}</p>` : ""}
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
  const l = leads.find(x => x.id === id); if(!l) return;
  if(handoffLocked(l)){
    alert("Handoff locked: " + l.name + " is " + l.stage + ". Only leads that have Replied (or later) can be handed to the backend team. The other prospects stay with you.");
    return;
  }
  if(l.handed_over){ alert(l.name + " is already handed over."); setView("handoff"); return; }
  detailId = id;
  document.getElementById("handoffLeadName").textContent = l.name + " — " + (l.company || "") + " (" + l.stage + ")";
  document.getElementById("h_assignee").value = l.assignee || "";
  document.getElementById("h_note").value = l.requirement || "";
  openModal("handoffModal");
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
  stageSel.innerHTML = `<option value="">All stages</option>` + STAGES.map(s => `<option>${s}</option>`).join("");
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
  document.getElementById("handoffForm").addEventListener("submit", submitHandoff);
  document.querySelectorAll(".modal-backdrop").forEach(b => b.addEventListener("click", e => { if(e.target === b) b.classList.remove("open"); }));

  const banner = document.getElementById("modeBanner");
  const pill = document.getElementById("modePill");
  if(hasSupabase && window.supabase){
    mode = "supabase";
    supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    pill.textContent = "● Live — shared Supabase"; pill.className = "mode-pill live";
    banner.className = "banner live";
    banner.innerHTML = "<b>Live shared mode.</b> Everyone opening this Vercel URL shares the same Supabase database, so teammates editing at the same time will see each other's updates (realtime + refresh every 5 seconds). Last write wins if two people edit the same lead at once.";
    await loadFromSupabase();
    supabaseClient.channel("leads-changes")
      .on("postgres_changes", { event:"*", schema:"public", table:"leads" }, loadFromSupabase)
      .on("postgres_changes", { event:"*", schema:"public", table:"activities" }, loadFromSupabase)
      .subscribe();
    setInterval(loadFromSupabase, 5000);
  } else {
    mode = "demo";
    pill.textContent = "Local Demo — not shared";
    banner.innerHTML = "<b>Local Demo mode — demo data is NOT shared with teammates.</b> This browser is storing leads locally only. To share with your team, follow README.md: create a free Supabase project, run schema.sql, paste the URL + anon key into config.js, push to GitHub and deploy on Vercel. The demo leads below are examples — delete or edit them, or clear them by deleting all leads.";
    loadDemo(); renderAll();
  }
  setStatus(mode === "supabase" ? "Connected to shared Supabase database." : "Local Demo mode. Add Supabase in config.js to share with teammates.");
}
document.addEventListener("DOMContentLoaded", init);
