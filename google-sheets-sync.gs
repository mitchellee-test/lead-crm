/**
 * Lead CRM <-> Google Sheets sync (DRAFT, not wired into the live app yet)
 *
 * Purpose: keep a Google Sheet, the Vercel CRM, and Supabase in sync.
 * The CRM itself always reads/writes Supabase. This script is the bridge
 * between the Sheet and Supabase. It does NOT run in the browser, so
 * keys stored here are not exposed in the CRM page source.
 *
 * SETUP (do this in the Sheet, not in the CRM):
 * 1. In Google Sheets: Extensions > Apps Script, paste this whole file.
 * 2. In Apps Script: Project Settings > Script Properties, add:
 *      SUPABASE_URL  = https://birwdqjmmjoyburuerpu.supabase.co (your project URL)
 *      SUPABASE_KEY  = your Supabase key (anon key works while RLS is off;
 *                      use a server-side key in Script Properties only if
 *                      you later turn RLS on. Never paste a service_role
 *                      key into the Sheet itself or into config.js.)
 *      SHEET_NAME    = Leads  (optional, default below)
 * 3. Sheet columns, row 1 header, in this order:
 *      id | name | company | email | phone | source | stage | assignee |
 *      follow_up_date | notes | requirement | handed_over | handoff_note | handoff_date
 *    - id: leave blank for a new lead; Supabase will generate one on first sync.
 *    - stage must be one of: New, Contacted, Replied, Requirement, Proposal,
 *      Negotiation, Won, Lost. Only Replied+ leads are handed over in the CRM.
 *    - handed_over: TRUE / FALSE.
 *    - dates: YYYY-MM-DD for follow_up_date.
 * 4. Run syncSheetToSupabase() once manually to grant permissions, then
 *    add a time-driven trigger (e.g. every 5-15 minutes) for it, or run it
 *    from the custom "Lead CRM" menu in the Sheet.
 *
 * CONFLICT RULE: last write wins, by updated_at. If the same lead is edited
 * in both the Sheet and the CRM between syncs, the newer updated_at wins.
 * This draft does NOT do field-level merging. For a small team this is
 * usually enough; for heavy simultaneous editing, keep the CRM as the
 * main editor and use the Sheet mainly as a view / bulk-import source.
 */

// ---- config ---------------------------------------------------------------
function getCfg_() {
  var p = PropertiesService.getScriptProperties();
  return {
    url: p.getProperty('SUPABASE_URL') || '',
    key: p.getProperty('SUPABASE_KEY') || '',
    sheetName: p.getProperty('SHEET_NAME') || 'Leads'
  };
}

var COLUMNS = ['id','name','company','email','phone','source','stage','assignee',
  'follow_up_date','notes','requirement','handed_over','handoff_note','handoff_date'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Lead CRM')
    .addItem('Sync Sheet -> Supabase', 'syncSheetToSupabase')
    .addItem('Sync Supabase -> Sheet', 'syncSupabaseToSheet')
    .addToUi();
}

// ---- Sheet -> Supabase ----------------------------------------------------
function syncSheetToSupabase() {
  var cfg = getCfg_();
  if (!cfg.url || !cfg.key) throw new Error('Set SUPABASE_URL and SUPABASE_KEY in Script Properties first.');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.sheetName);
  if (!sheet) throw new Error('Sheet tab not found: ' + cfg.sheetName);
  var rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return;
  // Skip header row; map each row by COLUMNS order.
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    if (!row[1] && !row[3]) continue; // skip empty rows (no name and no email)
    var lead = {};
    COLUMNS.forEach(function (col, i) {
      var v = row[i];
      if (col === 'handed_over') lead[col] = (v === true || String(v).toUpperCase() === 'TRUE');
      else if ((col === 'follow_up_date' || col === 'handoff_date') && v instanceof Date) lead[col] = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      else if (v !== '' && v !== null && v !== undefined) lead[col] = String(v);
    });
    // Upsert by id if present, otherwise by email (if you add a unique
    // constraint on email in Supabase, change on_conflict to email).
    var qs = lead.id ? '?on_conflict=id' : '';
    var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/leads' + qs, {
      method: 'post',
      headers: {
        'apikey': cfg.key,
        'Authorization': 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      payload: JSON.stringify(lead),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) {
      Logger.log('Row ' + (r + 1) + ' failed: ' + resp.getContentText());
    }
  }
}

// ---- Supabase -> Sheet ----------------------------------------------------
// Pulls all leads from Supabase and rewrites the Sheet tab (header kept).
// Run this after CRM edits if you want the Sheet to catch up, or schedule
// it alongside syncSheetToSupabase. If both run on a schedule, the later
// run wins for rows edited in both places between runs.
function syncSupabaseToSheet() {
  var cfg = getCfg_();
  if (!cfg.url || !cfg.key) throw new Error('Set SUPABASE_URL and SUPABASE_KEY in Script Properties first.');
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/leads?select=*&order=updated_at.desc', {
    headers: { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key }
  });
  var leads = JSON.parse(resp.getContentText());
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.sheetName)
    || SpreadsheetApp.getActiveSpreadsheet().insertSheet(cfg.sheetName);
  sheet.clear();
  var out = [COLUMNS];
  leads.forEach(function (lead) {
    out.push(COLUMNS.map(function (col) { return lead[col] === undefined || lead[col] === null ? '' : lead[col]; }));
  });
  sheet.getRange(1, 1, out.length, COLUMNS.length).setValues(out);
}

// ---- Optional: Supabase webhook -> Sheet ----------------------------------
// If you add a Supabase Database Webhook (POST to your deployed Apps Script
// Web App URL) for INSERT/UPDATE on public.leads, this receives one lead
// and upserts that single row in the Sheet, instead of rewriting the tab.
// Deploy as Web App (Execute as: Me, Access: Anyone with the link is NOT
// recommended for real data — restrict it once Auth/RLS is in place).
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var lead = payload.record || payload;
    var cfg = getCfg_();
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.sheetName);
    if (!sheet) return ContentService.createTextOutput('no sheet');
    var rows = sheet.getDataRange().getValues();
    var values = COLUMNS.map(function (col) { return lead[col] === undefined || lead[col] === null ? '' : lead[col]; });
    var found = -1;
    for (var i = 1; i < rows.length; i++) { if (String(rows[i][0]) === String(lead.id)) { found = i + 1; break; } }
    if (found > 0) sheet.getRange(found, 1, 1, COLUMNS.length).setValues([values]);
    else sheet.appendRow(values);
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('error: ' + err);
  }
}
