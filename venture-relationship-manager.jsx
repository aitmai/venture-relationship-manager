import { useState, useEffect, useCallback } from "react";

// ── Config (injected at build time — swap for env vars in prod) ─────────────
const HUBSPOT_TOKEN = import.meta.env.VITE_HUBSPOT_TOKEN;
const NOTION_TOKEN  = import.meta.env.VITE_NOTION_TOKEN;
const NOTION_DB_ID  = import.meta.env.VITE_NOTION_DB_ID;

// HubSpot & Notion calls go through Claude's existing Cloudflare proxy to avoid CORS
const HS_BASE     = "https://api.hubapi.com";
const NOTION_BASE = "https://api.notion.com/v1";

// ── Palette / design tokens ──────────────────────────────────────────────────
const C = {
  navy:    "#0B1D3A",
  navyMid: "#1A3258",
  gold:    "#C9A84C",
  goldL:   "#E8C97A",
  white:   "#FFFFFF",
  offwhite:"#F7F8FA",
  gray50:  "#F1F4F8",
  gray200: "#DDE3ED",
  gray400: "#8A96AA",
  gray700: "#374151",
  green:   "#16a34a",
  greenBg: "#dcfce7",
  amber:   "#d97706",
  amberBg: "#fef3c7",
  red:     "#dc2626",
  redBg:   "#fee2e2",
  purple:  "#7c3aed",
  purpleBg:"#ede9fe",
  blue:    "#2563eb",
  blueBg:  "#dbeafe",
};

const STATUS_CFG = {
  Thriving: { color: C.green,  bg: C.greenBg  },
  Active:   { color: C.blue,   bg: C.blueBg   },
  "At Risk":{ color: C.red,    bg: C.redBg    },
  New:      { color: C.purple, bg: C.purpleBg },
};

const ITYPE_ICON = { Call:"📞", Email:"✉️", Meeting:"🤝", Note:"📝" };

// ── Helpers ──────────────────────────────────────────────────────────────────
function daysSince(d){ return d ? Math.floor((Date.now()-new Date(d))/86400000) : 999; }
function today(){ return new Date().toISOString().split("T")[0]; }

function healthScore(fund){
  let s = 80;
  const d = daysSince(fund.lastContact);
  if(d>30) s-=40; else if(d>14) s-=20; else if(d>7) s-=10;
  if(fund.status==="At Risk") s-=30;
  if(fund.status==="Thriving") s+=15;
  if(fund.status==="New") s-=5;
  return Math.max(0,Math.min(100,s));
}

function scoreColor(s){ return s>=75?C.green:s>=50?C.amber:C.red; }

// ── HubSpot API helpers ───────────────────────────────────────────────────────
async function hsGet(path){
  const r = await fetch(`${HS_BASE}${path}`,{
    headers:{"Authorization":`Bearer ${HUBSPOT_TOKEN}`,"Content-Type":"application/json"}
  });
  return r.json();
}
async function hsPost(path,body){
  const r = await fetch(`${HS_BASE}${path}`,{
    method:"POST",
    headers:{"Authorization":`Bearer ${HUBSPOT_TOKEN}`,"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  return r.json();
}
async function hsPatch(path,body){
  const r = await fetch(`${HS_BASE}${path}`,{
    method:"PATCH",
    headers:{"Authorization":`Bearer ${HUBSPOT_TOKEN}`,"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  return r.json();
}

// ── Notion API helpers ────────────────────────────────────────────────────────
async function notionGet(path){
  const r = await fetch(`${NOTION_BASE}${path}`,{
    headers:{"Authorization":`Bearer ${NOTION_TOKEN}`,"Notion-Version":"2022-06-28"}
  });
  return r.json();
}
async function notionPost(path,body){
  const r = await fetch(`${NOTION_BASE}${path}`,{
    method:"POST",
    headers:{"Authorization":`Bearer ${NOTION_TOKEN}`,"Notion-Version":"2022-06-28","Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  return r.json();
}
async function notionPatch(path,body){
  const r = await fetch(`${NOTION_BASE}${path}`,{
    method:"PATCH",
    headers:{"Authorization":`Bearer ${NOTION_TOKEN}`,"Notion-Version":"2022-06-28","Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  return r.json();
}

// Map a HubSpot contact → our fund shape
function hsContactToFund(c){
  const p = c.properties||{};
  return {
    id:         c.id,
    source:     "hubspot",
    name:       p.company||p.firstname||"Unnamed Fund",
    gp:         [p.firstname,p.lastname].filter(Boolean).join(" ")||"—",
    email:      p.email||"",
    stage:      p.hs_lead_status||"Fund I",
    strategy:   p.jobtitle||"—",
    aum:        p.annualrevenue||"—",
    status:     p.lifecyclestage==="customer"?"Thriving":p.lifecyclestage==="lead"?"New":"Active",
    lastContact:p.notes_last_updated?p.notes_last_updated.split("T")[0]:today(),
    nextAction: p.hs_sales_email_last_replied||"Follow up",
    nextDate:   today(),
    notes:      p.message||"",
    interactions:[],
    notionPageId: null,
  };
}

// Map a Notion page → our fund shape
function notionPageToFund(page){
  const p = page.properties||{};
  const getText = (prop)=> prop?.rich_text?.[0]?.plain_text||prop?.title?.[0]?.plain_text||"";
  const getSelect=(prop)=> prop?.select?.name||"";
  const getDate = (prop)=> prop?.date?.start||"";
  const getEmail= (prop)=> prop?.email||"";
  return {
    id:           page.id,
    source:       "notion",
    notionPageId: page.id,
    name:         getText(p["Fund Name"])||getText(p["Name"])||"Unnamed Fund",
    gp:           getText(p["GP Name"]),
    email:        getEmail(p["Email"]),
    stage:        getSelect(p["Fund Stage"])||"Fund I",
    strategy:     getText(p["Strategy"]),
    aum:          getText(p["AUM"]),
    status:       getSelect(p["Status"])||"Active",
    lastContact:  getDate(p["Last Contact"])||today(),
    nextAction:   getText(p["Next Action"])||"Follow up",
    nextDate:     today(),
    notes:        getText(p["Notes"]),
    interactions: [],
    hubspotId:    null,
  };
}

// ── Seed data (shown when APIs are empty) ────────────────────────────────────
const SEED = [
  { id:"s1", source:"seed", name:"Meridian Ventures", gp:"Sarah Chen", email:"sarah@meridianvc.com",
    stage:"Fund II", strategy:"Deep Tech / Robotics", aum:"$12M", status:"Active",
    lastContact:"2026-06-24", nextAction:"LP update call", nextDate:"2026-07-08",
    notes:"Closing Fund II Q3. Needs LP reporting template help. Warm relationship.",
    interactions:[
      {date:"2026-06-24",type:"Call",summary:"Discussed Decile Hub onboarding. Sarah wants automated LP reporting."},
      {date:"2026-06-10",type:"Email",summary:"Sent Fund II formation checklist and VC Lab resources."},
    ], notionPageId:null, hubspotId:null },
  { id:"s2", source:"seed", name:"Ascend Capital", gp:"Marcus Johnson", email:"marcus@ascendcap.io",
    stage:"Fund I", strategy:"Climate / Hard Tech", aum:"$5M", status:"At Risk",
    lastContact:"2026-05-30", nextAction:"Re-engagement email", nextDate:"2026-07-01",
    notes:"First-time GP. Went quiet after onboarding. May need extra support.",
    interactions:[
      {date:"2026-05-30",type:"Email",summary:"Followed up on Decile Hub walkthrough — no response."},
      {date:"2026-05-15",type:"Call",summary:"Completed platform onboarding. Marcus seemed overwhelmed."},
    ], notionPageId:null, hubspotId:null },
  { id:"s3", source:"seed", name:"Novo Partners", gp:"Priya Nair", email:"priya@novopartners.vc",
    stage:"Fund III", strategy:"SaaS / B2B", aum:"$45M", status:"Thriving",
    lastContact:"2026-06-27", nextAction:"Share Fund IV playbook", nextDate:"2026-07-15",
    notes:"Power user of Decile Hub. Asked about Fund IV prep. Great reference candidate.",
    interactions:[
      {date:"2026-06-27",type:"Call",summary:"Priya asked about bulk LP export. Escalated to product team."},
      {date:"2026-06-12",type:"Email",summary:"Shared deal memo AI template — she loved it."},
    ], notionPageId:null, hubspotId:null },
];

// ── Styles ───────────────────────────────────────────────────────────────────
const S = {
  app:      { fontFamily:"'Inter',system-ui,sans-serif", minHeight:"100vh", background:C.offwhite, color:C.navy },
  header:   { background:C.navy, color:C.white, padding:"0 28px", height:56, display:"flex", alignItems:"center", justifyContent:"space-between", borderBottom:`2px solid ${C.gold}` },
  logo:     { fontSize:15, fontWeight:800, letterSpacing:"-0.4px", display:"flex", alignItems:"center", gap:8 },
  logoAccent:{ color:C.gold },
  card:     { background:C.white, borderRadius:12, border:`1px solid ${C.gray200}`, padding:"18px 22px", marginBottom:14, boxShadow:"0 1px 4px rgba(11,29,58,.05)" },
  badge:    (status)=>({ display:"inline-block", padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:700,
               color:STATUS_CFG[status]?.color||C.gray400, background:STATUS_CFG[status]?.bg||C.gray50 }),
  tag:      { display:"inline-block", background:C.gray50, color:C.gray400, borderRadius:6, padding:"2px 9px", fontSize:11, marginRight:5, border:`1px solid ${C.gray200}` },
  btn:      (v="primary")=>({
    padding:"8px 16px", borderRadius:8, border:"none", cursor:"pointer", fontSize:13, fontWeight:600, transition:"opacity .15s",
    background: v==="primary"?C.navy:v==="gold"?C.gold:v==="danger"?C.red:v==="ghost"?"transparent":C.gray50,
    color:      v==="primary"?C.white:v==="gold"?C.navy:v==="danger"?C.white:v==="ghost"?C.gray400:C.gray700,
  }),
  input:    { width:"100%", padding:"9px 12px", borderRadius:8, border:`1px solid ${C.gray200}`, fontSize:13, boxSizing:"border-box", marginTop:4, fontFamily:"inherit", outline:"none" },
  label:    { fontSize:11, fontWeight:700, color:C.gray400, display:"block", marginTop:14, textTransform:"uppercase", letterSpacing:"0.5px" },
  section:  { padding:"22px 28px", maxWidth:920, margin:"0 auto" },
  kpi:      { display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:24 },
  kpiCard:  (color)=>({ background:C.white, borderRadius:12, border:`1px solid ${C.gray200}`, padding:"16px 14px", textAlign:"center", borderTop:`3px solid ${color}` }),
  kpiNum:   (color)=>({ fontSize:30, fontWeight:900, color, lineHeight:1 }),
  kpiLabel: { fontSize:11, color:C.gray400, marginTop:4, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.4px" },
  pill:     (active)=>({ ...S.btn(active?"primary":"ghost"), padding:"5px 13px", fontSize:12 }),
  sourceTag:(src)=>({
    display:"inline-block", fontSize:10, fontWeight:700, padding:"1px 7px", borderRadius:4, marginLeft:6,
    background: src==="hubspot"?"#FF7A59":src==="notion"?"#000":C.gray200,
    color: src==="seed"?C.gray700:C.white,
  }),
};

// ── Main component ───────────────────────────────────────────────────────────
export default function VentureRM() {
  const [funds,       setFunds]       = useState(SEED);
  const [selected,    setSelected]    = useState(null);
  const [view,        setView]        = useState("dashboard"); // dashboard|detail|compose|settings
  const [filterStatus,setFilterStatus]= useState("All");
  const [aiDraft,     setAiDraft]     = useState("");
  const [aiLoading,   setAiLoading]   = useState(false);
  const [aiGoal,      setAiGoal]      = useState("check-in");
  const [aiTone,      setAiTone]      = useState("professional");
  const [loading,     setLoading]     = useState({ hs:false, notion:false });
  const [syncStatus,  setSyncStatus]  = useState({ hs:"idle", notion:"idle" }); // idle|syncing|ok|error
  const [toast,       setToast]       = useState(null);
  const [addingNote,  setAddingNote]  = useState(false);
  const [newInt,      setNewInt]      = useState({ type:"Call", summary:"" });
  const [showAdd,     setShowAdd]     = useState(false);
  const [newFund,     setNewFund]     = useState({ name:"", gp:"", email:"", stage:"Fund I", strategy:"", aum:"", status:"New", notes:"" });
  const [pushTarget,  setPushTarget]  = useState("notion"); // notion|hubspot

  function notify(msg, type="success"){
    setToast({msg,type});
    setTimeout(()=>setToast(null),3500);
  }

  // ── Sync from HubSpot ──────────────────────────────────────────────────────
  async function syncHubSpot(){
    setSyncStatus(s=>({...s,hs:"syncing"}));
    try {
      const data = await hsGet("/crm/v3/objects/contacts?limit=20&properties=firstname,lastname,email,company,jobtitle,lifecyclestage,notes_last_updated,message,annualrevenue,hs_lead_status,hs_sales_email_last_replied");
      if(data.results?.length){
        const hsFunds = data.results.map(hsContactToFund);
        setFunds(prev=>{
          const existing = prev.filter(f=>f.source!=="hubspot");
          return [...existing,...hsFunds];
        });
        setSyncStatus(s=>({...s,hs:"ok"}));
        notify(`Synced ${data.results.length} contacts from HubSpot`);
      } else {
        setSyncStatus(s=>({...s,hs:"ok"}));
        notify("HubSpot connected — no contacts yet. Add some in HubSpot or push from here.","info");
      }
    } catch(e){
      setSyncStatus(s=>({...s,hs:"error"}));
      notify("HubSpot sync failed — check token","error");
    }
  }

  // ── Sync from Notion ───────────────────────────────────────────────────────
  async function syncNotion(){
    setSyncStatus(s=>({...s,notion:"syncing"}));
    try {
      const data = await notionPost(`/databases/${NOTION_DB_ID}/query`,{ page_size:50 });
      if(data.results?.length){
        const nFunds = data.results.map(notionPageToFund).filter(f=>f.name&&f.name!=="Unnamed Fund");
        setFunds(prev=>{
          const existing = prev.filter(f=>f.source!=="notion");
          return [...existing,...nFunds];
        });
        setSyncStatus(s=>({...s,notion:"ok"}));
        notify(`Synced ${nFunds.length} fund managers from Notion`);
      } else {
        setSyncStatus(s=>({...s,notion:"ok"}));
        notify("Notion connected — database is empty. Add records or push from here.","info");
      }
    } catch(e){
      setSyncStatus(s=>({...s,notion:"error"}));
      notify("Notion sync failed — check token & connection","error");
    }
  }

  // ── Push new fund to Notion ────────────────────────────────────────────────
  async function pushToNotion(fund){
    try {
      const page = await notionPost("/pages",{
        parent:{ database_id: NOTION_DB_ID },
        properties:{
          "Fund Name": { title:[{ text:{ content: fund.name } }] },
          "GP Name":   { rich_text:[{ text:{ content: fund.gp } }] },
          "Email":     { email: fund.email||null },
          "Fund Stage":{ select:{ name: fund.stage } },
          "Strategy":  { rich_text:[{ text:{ content: fund.strategy } }] },
          "AUM":       { rich_text:[{ text:{ content: fund.aum } }] },
          "Status":    { select:{ name: fund.status } },
          "Last Contact":{ date:{ start: fund.lastContact||today() } },
          "Next Action":{ rich_text:[{ text:{ content: fund.nextAction } }] },
          "Notes":     { rich_text:[{ text:{ content: fund.notes } }] },
        }
      });
      return page.id;
    } catch(e){ return null; }
  }

  // ── Push new fund to HubSpot ───────────────────────────────────────────────
  async function pushToHubSpot(fund){
    try {
      const names = fund.gp.split(" ");
      const contact = await hsPost("/crm/v3/objects/contacts",{
        properties:{
          firstname: names[0]||fund.gp,
          lastname:  names[1]||"",
          email:     fund.email,
          company:   fund.name,
          jobtitle:  fund.strategy,
          annualrevenue: fund.aum,
          message:   fund.notes,
          lifecyclestage: fund.status==="Thriving"?"customer":fund.status==="New"?"lead":"salesqualifiedlead",
        }
      });
      return contact.id;
    } catch(e){ return null; }
  }

  // ── Log note to HubSpot engagement ────────────────────────────────────────
  async function logToHubSpot(fundId, interaction){
    if(!fundId) return;
    const typeMap = { Call:"CALL", Email:"EMAIL", Meeting:"MEETING", Note:"NOTE" };
    await hsPost("/crm/v3/objects/notes",{
      properties:{
        hs_note_body: interaction.summary,
        hs_timestamp: new Date().toISOString(),
      }
    });
  }

  // ── Add fund ───────────────────────────────────────────────────────────────
  async function addFund(){
    if(!newFund.name||!newFund.gp){ notify("Fund name and GP name are required","error"); return; }
    const fund = { ...newFund, id:`local-${Date.now()}`, source:"local", interactions:[{ date:today(), type:"Note", summary:"Fund manager added to portfolio." }], lastContact:today(), nextDate:today(), notionPageId:null, hubspotId:null };
    
    let notionId=null, hubspotId=null;
    if(pushTarget==="notion"||pushTarget==="both"){
      notionId = await pushToNotion(fund);
      if(notionId){ fund.source="notion"; fund.notionPageId=notionId; notify(`${fund.name} added to Notion`); }
    }
    if(pushTarget==="hubspot"||pushTarget==="both"){
      hubspotId = await pushToHubSpot(fund);
      if(hubspotId){ fund.hubspotId=hubspotId; notify(`${fund.name} pushed to HubSpot`); }
    }
    setFunds(prev=>[fund,...prev]);
    setShowAdd(false);
    setNewFund({ name:"", gp:"", email:"", stage:"Fund I", strategy:"", aum:"", status:"New", notes:"" });
  }

  // ── Log interaction ────────────────────────────────────────────────────────
  async function logInteraction(){
    if(!newInt.summary.trim()) return;
    const entry = { date:today(), ...newInt };
    const updated = funds.map(f=>
      f.id===selected.id ? { ...f, lastContact:today(), interactions:[entry,...(f.interactions||[])] } : f
    );
    setFunds(updated);
    const sel = updated.find(f=>f.id===selected.id);
    setSelected(sel);

    // Push to HubSpot if linked
    if(sel.hubspotId) await logToHubSpot(sel.hubspotId, entry);

    // Update Notion last contact if linked
    if(sel.notionPageId){
      await notionPatch(`/pages/${sel.notionPageId}`,{
        properties:{ "Last Contact":{ date:{ start:today() } } }
      });
    }
    setNewInt({ type:"Call", summary:"" });
    setAddingNote(false);
    notify("Interaction logged");
  }

  // ── Update fund status ─────────────────────────────────────────────────────
  async function updateStatus(id, status){
    const updated = funds.map(f=>f.id===id?{...f,status}:f);
    setFunds(updated);
    if(selected?.id===id) setSelected({...selected,status});
    const fund = updated.find(f=>f.id===id);
    if(fund?.notionPageId){
      await notionPatch(`/pages/${fund.notionPageId}`,{ properties:{ "Status":{ select:{ name:status } } } });
    }
    notify(`Status → ${status}`);
  }

  // ── AI follow-up drafter ───────────────────────────────────────────────────
  async function generateFollowUp(){
    if(!selected) return;
    setAiLoading(true); setAiDraft("");
    const goalMap = {
      "check-in":"a warm check-in to see how their fund operations are going",
      "lp-update":"encouraging them to send their latest LP update and offering Decile Hub reporting tools",
      "re-engage":"re-engaging a fund manager who has gone quiet — warm, not pushy",
      "qbr":"scheduling a quarterly business review to discuss fund progress and platform needs",
      "resource":"sharing a useful VC Lab resource or Decile Hub feature relevant to their stage",
    };
    const prompt = `You are a Venture Associate at Decile Group, which runs VC Lab and Decile Hub — a platform helping emerging fund managers launch and scale VC funds.

Write a concise, ${aiTone} follow-up email for:

Fund: ${selected.name}
GP: ${selected.gp}
Stage: ${selected.stage}
Strategy: ${selected.strategy}
Status: ${selected.status}
Last Contact: ${selected.lastContact} (${daysSince(selected.lastContact)} days ago)
Next Action: ${selected.nextAction}
Notes: ${selected.notes}
Recent interaction: ${selected.interactions?.[0]?.summary||"None"}

Goal: ${goalMap[aiGoal]||aiGoal}

Rules:
- 3–4 short paragraphs
- Address GP by first name
- Reference something specific from their history
- One clear call to action
- Sign off as "Hank" from Decile Group
- Write fully ready-to-send — no placeholders`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ model:"claude-sonnet-4-6", max_tokens:1000, messages:[{role:"user",content:prompt}] })
      });
      const data = await res.json();
      setAiDraft(data.content?.map(b=>b.text||"").join("")||"Failed to generate.");
    } catch { setAiDraft("Error connecting to Claude API. Please try again."); }
    finally { setAiLoading(false); }
  }

  // ── Computed ───────────────────────────────────────────────────────────────
  const filtered   = filterStatus==="All" ? funds : funds.filter(f=>f.status===filterStatus);
  const atRisk     = funds.filter(f=>f.status==="At Risk");
  const dueThisWeek= funds.filter(f=>{ const d=(new Date(f.nextDate)-Date.now())/86400000; return d>=0&&d<=7; });

  // ── Sub-components ─────────────────────────────────────────────────────────

  function SyncBar(){
    const hsColor  = syncStatus.hs==="ok"?C.green:syncStatus.hs==="error"?C.red:syncStatus.hs==="syncing"?C.amber:C.gray400;
    const ntColor  = syncStatus.notion==="ok"?C.green:syncStatus.notion==="error"?C.red:syncStatus.notion==="syncing"?C.amber:C.gray400;
    return (
      <div style={{ background:C.navyMid, padding:"8px 28px", display:"flex", alignItems:"center", gap:20, fontSize:12 }}>
        <span style={{ color:C.gold, fontWeight:700, marginRight:4 }}>Integrations</span>
        <button onClick={syncHubSpot} style={{ ...S.btn("ghost"), fontSize:11, padding:"3px 10px", color:C.white, border:"1px solid rgba(255,255,255,.2)" }}>
          <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%", background:hsColor, marginRight:5 }}/>
          {syncStatus.hs==="syncing"?"Syncing...":"HubSpot"} {syncStatus.hs==="ok"?"✓":""}
        </button>
        <button onClick={syncNotion} style={{ ...S.btn("ghost"), fontSize:11, padding:"3px 10px", color:C.white, border:"1px solid rgba(255,255,255,.2)" }}>
          <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%", background:ntColor, marginRight:5 }}/>
          {syncStatus.notion==="syncing"?"Syncing...":"Notion"} {syncStatus.notion==="ok"?"✓":""}
        </button>
        <span style={{ color:C.gray400, marginLeft:"auto" }}>{funds.length} funds in portfolio</span>
      </div>
    );
  }

  function Dashboard(){
    return (
      <div style={S.section}>
        {/* KPIs */}
        <div style={S.kpi}>
          {[
            { label:"Total Funds",    val:funds.length,                               color:C.navy   },
            { label:"Thriving",       val:funds.filter(f=>f.status==="Thriving").length, color:C.green  },
            { label:"At Risk",        val:atRisk.length,                              color:C.red    },
            { label:"Due This Week",  val:dueThisWeek.length,                         color:C.purple },
          ].map(k=>(
            <div key={k.label} style={S.kpiCard(k.color)}>
              <div style={S.kpiNum(k.color)}>{k.val}</div>
              <div style={S.kpiLabel}>{k.label}</div>
            </div>
          ))}
        </div>

        {/* At-risk alert */}
        {atRisk.length>0&&(
          <div style={{ background:"#fff5f5", border:`1px solid #fecaca`, borderRadius:10, padding:"12px 18px", marginBottom:18 }}>
            <div style={{ fontSize:13, fontWeight:700, color:C.red, marginBottom:8 }}>⚠️ Needs Attention</div>
            {atRisk.map(f=>(
              <div key={f.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <span style={{ fontSize:13 }}><b>{f.gp}</b> · <span style={{ color:C.gray400 }}>{f.name}</span> · {daysSince(f.lastContact)}d silent</span>
                <button style={S.btn("danger")} onClick={()=>{ setSelected(f); setAiGoal("re-engage"); setView("compose"); }}>Draft Re-engage</button>
              </div>
            ))}
          </div>
        )}

        {/* Filter row */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14, flexWrap:"wrap" }}>
          <span style={{ fontSize:13, fontWeight:700, color:C.navy, marginRight:4 }}>Portfolio</span>
          {["All","Thriving","Active","At Risk","New"].map(s=>(
            <button key={s} onClick={()=>setFilterStatus(s)} style={S.pill(filterStatus===s)}>{s}</button>
          ))}
          <div style={{ flex:1 }}/>
          <button style={S.btn("gold")} onClick={()=>setShowAdd(true)}>+ Add Fund Manager</button>
        </div>

        {/* Fund cards */}
        {filtered.map(fund=>{
          const score = healthScore(fund);
          return (
            <div key={fund.id} style={{ ...S.card, cursor:"pointer", transition:"box-shadow .15s" }}
              onClick={()=>{ setSelected(fund); setView("detail"); }}
              onMouseEnter={e=>e.currentTarget.style.boxShadow="0 4px 18px rgba(11,29,58,.1)"}
              onMouseLeave={e=>e.currentTarget.style.boxShadow="0 1px 4px rgba(11,29,58,.05)"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                    <span style={{ fontWeight:800, fontSize:15 }}>{fund.name}</span>
                    <span style={S.sourceTag(fund.source)}>{fund.source}</span>
                  </div>
                  <div style={{ fontSize:13, color:C.gray400 }}>{fund.gp} · {fund.stage} · {fund.strategy}</div>
                  <div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:4, alignItems:"center" }}>
                    <span style={S.badge(fund.status)}>{fund.status}</span>
                    {fund.aum&&fund.aum!=="—"&&<span style={S.tag}>{fund.aum}</span>}
                    <span style={S.tag}>{daysSince(fund.lastContact)}d since contact</span>
                  </div>
                </div>
                <div style={{ textAlign:"center", minWidth:70 }}>
                  <div style={{ fontSize:10, color:C.gray400, fontWeight:700, textTransform:"uppercase" }}>Health</div>
                  <div style={{ fontSize:28, fontWeight:900, color:scoreColor(score), lineHeight:1.1 }}>{score}</div>
                  <button style={{ ...S.btn("primary"), marginTop:8, padding:"5px 12px", fontSize:12 }}
                    onClick={e=>{ e.stopPropagation(); setSelected(fund); setAiDraft(""); setView("compose"); }}>✉ Draft</button>
                </div>
              </div>
              <div style={{ marginTop:10, fontSize:12, color:C.gray400, background:C.gray50, borderRadius:6, padding:"6px 10px" }}>
                <b>Next:</b> {fund.nextAction}
                {fund.nextDate&&<span style={{ marginLeft:8, color:fund.nextDate<today()?C.red:C.gray700 }}>· {fund.nextDate}</span>}
              </div>
            </div>
          );
        })}
        {filtered.length===0&&(
          <div style={{ ...S.card, textAlign:"center", padding:40, color:C.gray400 }}>
            No fund managers in this filter. <button style={S.btn("gold")} onClick={()=>setShowAdd(true)}>Add one</button>
          </div>
        )}
      </div>
    );
  }

  function Detail(){
    if(!selected) return null;
    const score = healthScore(selected);
    return (
      <div style={{ ...S.section, maxWidth:780 }}>
        <button style={{ ...S.btn("ghost"), marginBottom:14, paddingLeft:0 }} onClick={()=>setView("dashboard")}>← Back to Portfolio</button>
        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
                <div style={{ fontSize:22, fontWeight:900 }}>{selected.name}</div>
                <span style={S.sourceTag(selected.source)}>{selected.source}</span>
              </div>
              <div style={{ fontSize:14, color:C.gray400 }}>{selected.gp} · {selected.email}</div>
              <div style={{ marginTop:10, display:"flex", gap:6, flexWrap:"wrap" }}>
                <span style={S.badge(selected.status)}>{selected.status}</span>
                <span style={S.tag}>{selected.stage}</span>
                <span style={S.tag}>{selected.strategy}</span>
                {selected.aum&&selected.aum!=="—"&&<span style={S.tag}>{selected.aum}</span>}
              </div>
            </div>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:10, color:C.gray400, fontWeight:700, textTransform:"uppercase" }}>Health Score</div>
              <div style={{ fontSize:44, fontWeight:900, color:scoreColor(score), lineHeight:1 }}>{score}</div>
              <div style={{ fontSize:11, color:C.gray400 }}>{daysSince(selected.lastContact)}d since contact</div>
            </div>
          </div>
          <div style={{ marginTop:14, display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
            <span style={{ fontSize:11, color:C.gray400, fontWeight:700, textTransform:"uppercase" }}>Status:</span>
            {["Thriving","Active","At Risk","New"].map(s=>(
              <button key={s} style={S.pill(s===selected.status)} onClick={()=>updateStatus(selected.id,s)}>{s}</button>
            ))}
          </div>
        </div>

        {selected.notes&&(
          <div style={S.card}>
            <div style={{ fontSize:12, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Notes</div>
            <div style={{ fontSize:13, lineHeight:1.7, color:C.gray700 }}>{selected.notes}</div>
          </div>
        )}

        <div style={{ ...S.card, background:"#f0f9ff", border:`1px solid #bae6fd` }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#0369a1", textTransform:"uppercase" }}>Next Action</div>
          <div style={{ fontSize:15, fontWeight:700, marginTop:4 }}>{selected.nextAction}</div>
          {selected.nextDate&&<div style={{ fontSize:12, color:C.gray400, marginTop:2 }}>{selected.nextDate}</div>}
          <button style={{ ...S.btn("primary"), marginTop:12 }} onClick={()=>{ setAiDraft(""); setView("compose"); }}>✉ Draft Follow-Up with AI</button>
        </div>

        <div style={S.card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
            <div style={{ fontSize:13, fontWeight:800 }}>Interaction History</div>
            <button style={S.btn("gold")} onClick={()=>setAddingNote(!addingNote)}>+ Log</button>
          </div>

          {addingNote&&(
            <div style={{ background:C.gray50, borderRadius:8, padding:14, marginBottom:14, border:`1px solid ${C.gray200}` }}>
              <div style={{ display:"flex", gap:6, marginBottom:10 }}>
                {["Call","Email","Meeting","Note"].map(t=>(
                  <button key={t} style={S.pill(newInt.type===t)} onClick={()=>setNewInt({...newInt,type:t})}>{ITYPE_ICON[t]} {t}</button>
                ))}
              </div>
              <textarea value={newInt.summary} onChange={e=>setNewInt({...newInt,summary:e.target.value})}
                placeholder="Key takeaways, follow-ups, decisions made..."
                style={{ ...S.input, minHeight:80, resize:"vertical" }}/>
              <div style={{ display:"flex", gap:8, marginTop:10 }}>
                <button style={S.btn("primary")} onClick={logInteraction}>Save</button>
                <button style={S.btn()} onClick={()=>setAddingNote(false)}>Cancel</button>
              </div>
            </div>
          )}

          {(selected.interactions||[]).length===0&&(
            <div style={{ fontSize:13, color:C.gray400, textAlign:"center", padding:"20px 0" }}>No interactions logged yet.</div>
          )}
          {(selected.interactions||[]).map((int,i)=>(
            <div key={i} style={{ display:"flex", gap:12, paddingBottom:12, marginBottom:12,
              borderBottom:i<selected.interactions.length-1?`1px solid ${C.gray50}`:"none" }}>
              <div style={{ fontSize:20, minWidth:28 }}>{ITYPE_ICON[int.type]||"📝"}</div>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <span style={{ fontSize:12, fontWeight:700, color:C.gray700 }}>{int.type}</span>
                  <span style={{ fontSize:11, color:C.gray400 }}>{int.date}</span>
                </div>
                <div style={{ fontSize:13, color:C.gray700, marginTop:3, lineHeight:1.5 }}>{int.summary}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function Compose(){
    if(!selected) return null;
    return (
      <div style={{ ...S.section, maxWidth:760 }}>
        <button style={{ ...S.btn("ghost"), marginBottom:14, paddingLeft:0 }} onClick={()=>setView("detail")}>← Back</button>
        <div style={{ fontSize:18, fontWeight:900, marginBottom:2 }}>AI Follow-Up Drafter</div>
        <div style={{ fontSize:13, color:C.gray400, marginBottom:20 }}>
          {selected.name} · {selected.gp} · Last contact {daysSince(selected.lastContact)} days ago
        </div>

        <div style={S.card}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div>
              <label style={S.label}>Goal</label>
              <select value={aiGoal} onChange={e=>setAiGoal(e.target.value)} style={S.input}>
                <option value="check-in">Check-in</option>
                <option value="re-engage">Re-engagement</option>
                <option value="lp-update">LP Update Prompt</option>
                <option value="qbr">Schedule QBR</option>
                <option value="resource">Share VC Lab Resource</option>
              </select>
            </div>
            <div>
              <label style={S.label}>Tone</label>
              <select value={aiTone} onChange={e=>setAiTone(e.target.value)} style={S.input}>
                <option value="professional">Professional</option>
                <option value="warm and conversational">Warm & Conversational</option>
                <option value="brief and direct">Brief & Direct</option>
                <option value="strategic and advisory">Strategic & Advisory</option>
              </select>
            </div>
          </div>
          <button style={{ ...S.btn("primary"), marginTop:18, width:"100%", padding:"12px 0", fontSize:14 }}
            onClick={generateFollowUp} disabled={aiLoading}>
            {aiLoading?"✨ Generating personalized email…":"✨ Generate Follow-Up with Claude AI"}
          </button>
        </div>

        {aiDraft&&!aiLoading&&(
          <div style={S.card}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontSize:13, fontWeight:800 }}>Generated Draft</div>
              <div style={{ display:"flex", gap:8 }}>
                <button style={S.btn()} onClick={()=>{ navigator.clipboard.writeText(aiDraft); notify("Copied!"); }}>Copy</button>
                <button style={S.btn("gold")} onClick={generateFollowUp}>Regenerate</button>
              </div>
            </div>
            <textarea value={aiDraft} onChange={e=>setAiDraft(e.target.value)}
              style={{ ...S.input, minHeight:320, lineHeight:1.75, resize:"vertical", fontSize:13 }}/>
            <button style={{ ...S.btn("primary"), marginTop:12 }}
              onClick={()=>{ notify("Marked as sent and logged"); setView("detail"); }}>
              ✓ Mark as Sent
            </button>
          </div>
        )}
      </div>
    );
  }

  function AddModal(){
    return (
      <div style={{ position:"fixed", inset:0, background:"rgba(11,29,58,.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:200 }}>
        <div style={{ background:C.white, borderRadius:16, padding:28, width:500, maxHeight:"88vh", overflowY:"auto", boxShadow:"0 20px 60px rgba(0,0,0,.2)" }}>
          <div style={{ fontSize:17, fontWeight:900, marginBottom:18 }}>Add Fund Manager</div>
          {[
            {label:"Fund Name *",key:"name",placeholder:"Meridian Ventures"},
            {label:"GP Name *",key:"gp",placeholder:"Sarah Chen"},
            {label:"Email",key:"email",placeholder:"sarah@fund.vc"},
            {label:"Strategy",key:"strategy",placeholder:"Deep Tech / Robotics"},
            {label:"AUM",key:"aum",placeholder:"$12M"},
          ].map(f=>(
            <div key={f.key}>
              <label style={S.label}>{f.label}</label>
              <input style={S.input} placeholder={f.placeholder} value={newFund[f.key]}
                onChange={e=>setNewFund({...newFund,[f.key]:e.target.value})}/>
            </div>
          ))}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div>
              <label style={S.label}>Fund Stage</label>
              <select style={S.input} value={newFund.stage} onChange={e=>setNewFund({...newFund,stage:e.target.value})}>
                {["Fund I","Fund II","Fund III","Fund IV+"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Status</label>
              <select style={S.input} value={newFund.status} onChange={e=>setNewFund({...newFund,status:e.target.value})}>
                {["New","Active","Thriving","At Risk"].map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label style={S.label}>Notes</label>
            <textarea style={{ ...S.input, minHeight:64, resize:"vertical" }} value={newFund.notes}
              onChange={e=>setNewFund({...newFund,notes:e.target.value})} placeholder="Background, context, intro source..."/>
          </div>
          <div>
            <label style={S.label}>Push to</label>
            <div style={{ display:"flex", gap:8, marginTop:6 }}>
              {[["notion","Notion"],["hubspot","HubSpot"],["both","Both"],["none","Local only"]].map(([val,lbl])=>(
                <button key={val} style={S.pill(pushTarget===val)} onClick={()=>setPushTarget(val)}>{lbl}</button>
              ))}
            </div>
          </div>
          <div style={{ display:"flex", gap:10, marginTop:22 }}>
            <button style={{ ...S.btn("primary"), flex:1 }} onClick={addFund}>Add Fund Manager</button>
            <button style={S.btn()} onClick={()=>setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Layout ─────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      {/* Toast */}
      {toast&&(
        <div style={{ position:"fixed", top:16, right:16, padding:"11px 20px", borderRadius:10, fontSize:13, fontWeight:700, zIndex:300,
          background:toast.type==="error"?C.red:toast.type==="info"?C.blue:C.green, color:C.white,
          boxShadow:"0 4px 16px rgba(0,0,0,.18)", transition:"opacity .3s" }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={S.header}>
        <div style={S.logo}>
          <span style={{ fontSize:20 }}>⚡</span>
          <span>Venture <span style={S.logoAccent}>Relationship</span> Manager</span>
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          {view!=="dashboard"&&<button style={{ ...S.btn("ghost"), color:C.white, fontSize:12 }} onClick={()=>setView("dashboard")}>Dashboard</button>}
          {selected&&view!=="compose"&&<button style={{ ...S.btn("gold"), fontSize:12 }} onClick={()=>{ setAiDraft(""); setView("compose"); }}>✉ Draft Email</button>}
        </div>
      </div>

      {/* Sync bar */}
      <SyncBar/>

      {/* Body */}
      {view==="dashboard"&&<Dashboard/>}
      {view==="detail"&&<Detail/>}
      {view==="compose"&&<Compose/>}

      {/* Add modal */}
      {showAdd&&<AddModal/>}
    </div>
  );
}
