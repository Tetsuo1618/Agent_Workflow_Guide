import { useState, useRef, useCallback } from "react";

// ─── Styles injected once ───────────────────────────────────────────────────
if (!document.head.querySelector("[data-ledger]")) {
  const s = document.createElement("style");
  s.setAttribute("data-ledger", "1");
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0b0c0e; }
    @keyframes fadeUp { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
    @keyframes spin   { to { transform: rotate(360deg) } }
    @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:.5} }
    button { cursor: pointer; font-family: inherit; }
    input, select { font-family: inherit; }
    input:focus, select:focus, button:focus { outline: none; }
    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button { opacity: .4; }
    ::-webkit-scrollbar { width: 3px; height: 3px; }
    ::-webkit-scrollbar-track { background: #0b0c0e; }
    ::-webkit-scrollbar-thumb { background: #2a2a35; border-radius: 2px; }
  `;
  document.head.appendChild(s);
}

// ─── Claude receipt AI ──────────────────────────────────────────────────────
async function analyzeReceipt(b64, mediaType) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
        { type: "text", text: `Extract all purchases from this receipt. Return ONLY valid JSON (no markdown):
{"merchant":"name","date":"YYYY-MM-DD or null","total":number_or_null,"category":"Food & Dining|Groceries|Shopping|Transport|Health|Entertainment|Utilities|Other","items":[{"name":"item name","amount":number}]}
If unreadable: {"error":"Cannot read receipt"}` }
      ]}]
    })
  });
  const d = await r.json();
  const txt = d.content?.find(b => b.type === "text")?.text || "";
  return JSON.parse(txt.replace(/```json|```/g, "").trim());
}

// ─── Constants ──────────────────────────────────────────────────────────────
const CATS = [
  { id: "Food & Dining",  icon: "🍽", color: "#e07b4a" },
  { id: "Groceries",      icon: "🛒", color: "#c9a84c" },
  { id: "Shopping",       icon: "🛍", color: "#7e9fd4" },
  { id: "Transport",      icon: "🚗", color: "#6ec6a0" },
  { id: "Health",         icon: "💊", color: "#d47e9f" },
  { id: "Entertainment",  icon: "🎬", color: "#a07ed4" },
  { id: "Utilities",      icon: "⚡", color: "#78b4c8" },
  { id: "Bills",          icon: "📋", color: "#e0a050" },
  { id: "Other",          icon: "📦", color: "#888"    },
];
const catColor = id => CATS.find(c => c.id === id)?.color ?? "#888";
const catIcon  = id => CATS.find(c => c.id === id)?.icon  ?? "📦";
const f2 = n => "$" + Number(n || 0).toFixed(2);
const uid = () => Math.random().toString(36).slice(2, 9);
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const now = new Date();
const weeksInMonth = (m, y) => new Date(y, m + 1, 0).getDate() / 7;

const DEFAULT_BILLS = [
  { id:"rent",  label:"Rent",            icon:"🏠", freq:"monthly", amount:"", color:"#e07b4a", cat:"Bills"     },
  { id:"phone", label:"Phones",          icon:"📱", freq:"monthly", amount:"", color:"#7e9fd4", cat:"Bills"     },
  { id:"ins",   label:"Insurance",       icon:"🛡", freq:"monthly", amount:"", color:"#d47e9f", cat:"Bills"     },
  { id:"gas",   label:"Gas",             icon:"⛽", freq:"weekly",  amount:"", color:"#6ec6a0", cat:"Transport" },
  { id:"groc",  label:"Food/Groceries",  icon:"🛒", freq:"weekly",  amount:"", color:"#c9a84c", cat:"Groceries" },
  { id:"ex0",   label:"Extra",           icon:"➕", freq:"extra",   amount:"", color:"#a07ed4", cat:"Other", editable:true },
];

// ─── helpers ─────────────────────────────────────────────────────────────────
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const statusColor = pct =>
  pct >= 100 ? "#e07b4a" : pct >= 80 ? "#c9a84c" : "#6ec6a0";

// ─── Main Component ──────────────────────────────────────────────────────────
export default function Ledger() {
  const [month,  setMonth]  = useState(now.getMonth());
  const [year,   setYear]   = useState(now.getFullYear());

  // budget setup
  const [income,        setIncome]        = useState("");
  const [monthlyBudget, setMonthlyBudget] = useState("");
  const [weeklyBudget,  setWeeklyBudget]  = useState("");

  const [bills,    setBills]    = useState(DEFAULT_BILLS);
  const [expenses, setExpenses] = useState([]);

  const [tab, setTab] = useState("money");

  // add-expense form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ desc:"", amount:"", category:"Food & Dining", date:"" });

  // receipt
  const [dragging,   setDragging]   = useState(false);
  const [analyzing,  setAnalyzing]  = useState(false);
  const [analyzeMsg, setAnalyzeMsg] = useState("");
  const fileRef = useRef();

  // ── Derived numbers ─────────────────────────────────────────────────────────
  const weeks = weeksInMonth(month, year);

  const billTotals = bills.map(b => {
    const a = parseFloat(b.amount) || 0;
    const mo = b.freq === "weekly" ? a * weeks : a;
    return { ...b, weeklyAmt: a, mo };
  });
  const totalFixedBills = billTotals.reduce((s, b) => s + b.mo, 0);

  const filtered = expenses.filter(e => {
    const d = new Date(e.date + "T00:00:00");
    return d.getMonth() === month && d.getFullYear() === year;
  });
  const totalVariableExp = filtered.reduce((s, e) => s + e.amount, 0);
  const totalSpent       = totalFixedBills + totalVariableExp;

  const inc  = parseFloat(income)        || 0;
  const mBud = parseFloat(monthlyBudget) || 0;
  const wBud = parseFloat(weeklyBudget)  || 0;

  // what's actually left
  const monthlyLeft = mBud > 0 ? mBud - totalSpent : inc > 0 ? inc - totalSpent : null;
  const weeklyLeft  = wBud > 0 ? wBud - (totalSpent / weeks) : null;

  const monthlyPct = mBud > 0 ? clamp((totalSpent / mBud) * 100, 0, 100) : 0;
  const weeklyPct  = wBud > 0 ? clamp(((totalSpent / weeks) / wBud) * 100, 0, 100) : 0;

  // breakdown for chart
  const allSpend = totalSpent || 1;
  const breakdown = CATS.map(cat => {
    const bSum = billTotals.filter(b => b.cat === cat.id).reduce((s, b) => s + b.mo, 0);
    const eSum = filtered.filter(e => e.category === cat.id).reduce((s, e) => s + e.amount, 0);
    const sum  = bSum + eSum;
    return { ...cat, sum, pct: (sum / allSpend) * 100 };
  }).filter(c => c.sum > 0).sort((a, b) => b.sum - a.sum);

  // ── Bill helpers ─────────────────────────────────────────────────────────────
  const updateBill = (id, k, v) => setBills(p => p.map(b => b.id === id ? { ...b, [k]: v } : b));
  const removeBill = id          => setBills(p => p.filter(b => b.id !== id));
  const addExtra   = ()          => setBills(p => [...p, { id:uid(), label:"Extra", icon:"➕", freq:"extra", amount:"", color:"#a07ed4", cat:"Other", editable:true }]);

  // ── Expense helpers ──────────────────────────────────────────────────────────
  const addExpense = () => {
    if (!form.desc || !form.amount) return;
    const d = form.date || `${year}-${String(month + 1).padStart(2, "0")}-01`;
    setExpenses(p => [...p, { id:uid(), desc:form.desc, amount:parseFloat(form.amount), category:form.category, date:d, source:"manual" }]);
    setForm({ desc:"", amount:"", category:"Food & Dining", date:"" });
    setShowForm(false);
  };
  const delExp = id => setExpenses(p => p.filter(e => e.id !== id));

  // ── Receipt handler ──────────────────────────────────────────────────────────
  const processFile = useCallback(async file => {
    if (!file?.type.startsWith("image/")) { setAnalyzeMsg("⚠ Image files only (JPG/PNG/WEBP)"); return; }
    setAnalyzing(true); setAnalyzeMsg("Reading receipt…");
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload  = () => res(r.result.split(",")[1]);
        r.onerror = () => rej();
        r.readAsDataURL(file);
      });
      setAnalyzeMsg("AI extracting items…");
      const result = await analyzeReceipt(b64, file.type);
      if (result.error) { setAnalyzeMsg("⚠ " + result.error); return; }
      const ds = result.date || `${year}-${String(month + 1).padStart(2,"0")}-01`;
      if (result.items?.length > 0) {
        const ni = result.items.map(item => ({
          id: uid(),
          desc: `${result.merchant ? result.merchant + " — " : ""}${item.name}`,
          amount: item.amount,
          category: result.category || "Other",
          date: ds,
          source: "receipt"
        }));
        setExpenses(p => [...p, ...ni]);
        setAnalyzeMsg(`✓ Added ${ni.length} item(s) from ${result.merchant || "receipt"}`);
      } else if (result.total) {
        setExpenses(p => [...p, { id:uid(), desc:result.merchant||"Receipt", amount:result.total, category:result.category||"Other", date:ds, source:"receipt" }]);
        setAnalyzeMsg(`✓ ${result.merchant || "Receipt"} — ${f2(result.total)}`);
      } else {
        setAnalyzeMsg("⚠ No items found on receipt.");
      }
    } catch { setAnalyzeMsg("⚠ Analysis failed. Check connection."); }
    finally {
      setAnalyzing(false);
      setTimeout(() => setAnalyzeMsg(""), 6000);
    }
  }, [month, year]);

  const onDrop = e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]); };

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div style={C.root}>
      <div style={C.gridBg} />

      {/* ── HEADER ── */}
      <header style={C.header}>
        <div>
          <div style={C.eyebrow}>MY MONEY — BUDGET TRACKER</div>
          <div style={C.title}>LEDGER<span style={C.dot}>.</span></div>
        </div>
        <div style={C.monthRow}>
          <button style={C.navBtn} onClick={() => { if(month===0){setMonth(11);setYear(y=>y-1);}else setMonth(m=>m-1); }}>◀</button>
          <span style={C.monthLbl}>{MONTHS[month]} {year}</span>
          <button style={C.navBtn} onClick={() => { if(month===11){setMonth(0);setYear(y=>y+1);}else setMonth(m=>m+1); }}>▶</button>
        </div>
      </header>

      {/* ── BUDGET SETUP STRIP ── */}
      <div style={C.setupStrip}>
        <div style={C.setupLabel}>⚙ MY BUDGET SETUP</div>
        <div style={C.setupBoxes}>
          <BudgetBox icon="💵" label="Monthly Income" value={income}      onChange={setIncome}        hint="What you earn per month" color="#6ec6a0"/>
          <BudgetBox icon="📅" label="Monthly Limit"  value={monthlyBudget} onChange={setMonthlyBudget} hint="Max you can spend monthly" color="#c9a84c"/>
          <BudgetBox icon="📆" label="Weekly Budget"  value={weeklyBudget}  onChange={setWeeklyBudget}  hint="Max you can spend weekly"  color="#7e9fd4"/>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={C.tabs}>
        {[
          ["money",    "💰 MY MONEY"],
          ["bills",    "📋 BILLS"],
          ["txns",     "➕ EXPENSES"],
          ["receipts", "🧾 RECEIPTS"],
          ["overview", "📊 OVERVIEW"],
        ].map(([id, lbl]) => (
          <button key={id} style={{ ...C.tab, ...(tab === id ? C.tabOn : {}) }} onClick={() => setTab(id)}>
            {lbl}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════
          TAB: MY MONEY  — the beginner-friendly view
      ════════════════════════════════════════════ */}
      {tab === "money" && (
        <div style={C.panel}>

          {/* Income card */}
          {inc > 0 && (
            <div style={{ ...C.moneyCard, borderColor: "#6ec6a040" }}>
              <div style={C.mcIcon}>💵</div>
              <div style={C.mcBody}>
                <div style={C.mcLabel}>MONTHLY INCOME</div>
                <div style={{ ...C.mcAmt, color:"#6ec6a0" }}>{f2(inc)}</div>
                <div style={C.mcSub}>What comes in every month</div>
              </div>
            </div>
          )}

          {/* Monthly section */}
          <SectionHead>THIS MONTH — {MONTHS[month]} {year}</SectionHead>
          <div style={C.monthlyGrid}>
            <MoneyTile
              label="Fixed Bills"
              sub="Rent, phone, insurance…"
              amount={totalFixedBills}
              icon="📋"
              color="#e0a050"
            />
            <MoneyTile
              label="Variable Spending"
              sub="Expenses & receipts logged"
              amount={totalVariableExp}
              icon="🛍"
              color="#7e9fd4"
            />
            <MoneyTile
              label="Total Spent"
              sub={`${MONTHS[month]} ${year} combined`}
              amount={totalSpent}
              icon="💸"
              color="#e07b4a"
              highlight
            />
            {monthlyLeft !== null && (
              <MoneyTile
                label={monthlyLeft >= 0 ? "Left to Spend" : "Over Budget!"}
                sub={mBud > 0 ? `of ${f2(mBud)} monthly limit` : `of ${f2(inc)} income`}
                amount={Math.abs(monthlyLeft)}
                icon={monthlyLeft >= 0 ? "✅" : "🚨"}
                color={monthlyLeft >= 0 ? "#6ec6a0" : "#e07b4a"}
                highlight
              />
            )}
          </div>

          {/* Monthly budget bar */}
          {mBud > 0 && (
            <div style={C.budBar}>
              <div style={C.budBarTop}>
                <span style={C.budBarLbl}>MONTHLY BUDGET USED</span>
                <span style={{ color: statusColor(monthlyPct), fontSize:12, fontWeight:700 }}>
                  {monthlyPct.toFixed(1)}%
                </span>
              </div>
              <div style={C.budBarTrack}>
                <div style={{ ...C.budBarFill, width:`${monthlyPct}%`, background:statusColor(monthlyPct) }}/>
              </div>
              <div style={C.budBarSub}>
                {f2(totalSpent)} spent of {f2(mBud)} budget
                {monthlyLeft !== null && monthlyLeft < 0 &&
                  <span style={{ color:"#e07b4a", marginLeft:8 }}>— {f2(Math.abs(monthlyLeft))} over!</span>
                }
              </div>
            </div>
          )}

          {/* Weekly section */}
          <SectionHead style={{ marginTop:28 }}>THIS WEEK — AVG BREAKDOWN</SectionHead>
          <div style={C.monthlyGrid}>
            <MoneyTile
              label="Bills Per Week"
              sub={`Fixed bills ÷ ${weeks.toFixed(2)} weeks`}
              amount={totalFixedBills / weeks}
              icon="📋"
              color="#e0a050"
            />
            <MoneyTile
              label="Spending Per Week"
              sub="Variable expenses ÷ weeks"
              amount={totalVariableExp / weeks}
              icon="🛍"
              color="#7e9fd4"
            />
            <MoneyTile
              label="Total Per Week"
              sub="Everything combined"
              amount={totalSpent / weeks}
              icon="💸"
              color="#e07b4a"
              highlight
            />
            {wBud > 0 && (() => {
              const weekLeft = wBud - (totalSpent / weeks);
              return (
                <MoneyTile
                  label={weekLeft >= 0 ? "Left This Week" : "Over Weekly!"}
                  sub={`of ${f2(wBud)} weekly limit`}
                  amount={Math.abs(weekLeft)}
                  icon={weekLeft >= 0 ? "✅" : "🚨"}
                  color={weekLeft >= 0 ? "#6ec6a0" : "#e07b4a"}
                  highlight
                />
              );
            })()}
          </div>

          {/* Weekly budget bar */}
          {wBud > 0 && (
            <div style={C.budBar}>
              <div style={C.budBarTop}>
                <span style={C.budBarLbl}>WEEKLY BUDGET USED (avg)</span>
                <span style={{ color: statusColor(weeklyPct), fontSize:12, fontWeight:700 }}>
                  {weeklyPct.toFixed(1)}%
                </span>
              </div>
              <div style={C.budBarTrack}>
                <div style={{ ...C.budBarFill, width:`${weeklyPct}%`, background:statusColor(weeklyPct) }}/>
              </div>
              <div style={C.budBarSub}>
                {f2(totalSpent / weeks)} per week of {f2(wBud)} weekly budget
              </div>
            </div>
          )}

          {/* Quick tip if nothing set up yet */}
          {inc === 0 && mBud === 0 && wBud === 0 && (
            <div style={C.tip}>
              <div style={C.tipIcon}>💡</div>
              <div>
                <div style={C.tipHead}>Get started in 3 steps</div>
                <div style={C.tipBody}>
                  1. Enter your income and budget limits above.<br/>
                  2. Go to BILLS and enter your monthly/weekly costs.<br/>
                  3. Log expenses or drop receipts — your money picture builds automatically.
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════
          TAB: BILLS
      ════════════════════════════════ */}
      {tab === "bills" && (
        <div style={C.panel}>

          <SectionHead>MONTHLY FIXED <Hint>paid once a month — same every time</Hint></SectionHead>
          {bills.filter(b => b.freq === "monthly").map(b => (
            <BillRow key={b.id} bill={b} onUpdate={updateBill} onRemove={b.editable ? removeBill : null} weeks={weeks} />
          ))}

          <SectionHead style={{ marginTop:24 }}>
            WEEKLY RECURRING
            <Hint>enter what you spend per week — we multiply by {weeks.toFixed(2)} weeks to get the monthly total</Hint>
          </SectionHead>
          {bills.filter(b => b.freq === "weekly").map(b => (
            <BillRow key={b.id} bill={b} onUpdate={updateBill} onRemove={b.editable ? removeBill : null} weeks={weeks} />
          ))}

          <SectionHead style={{ marginTop:24 }}>EXTRAS / ONE-TIME <Hint>anything that only happens this month</Hint></SectionHead>
          {bills.filter(b => b.freq === "extra").map(b => (
            <BillRow key={b.id} bill={b} onUpdate={updateBill} onRemove={removeBill} weeks={weeks} />
          ))}
          <button style={C.addExBtn} onClick={addExtra}>+ ADD EXTRA BILL</button>

          {/* Bills totals */}
          <div style={C.billTotals}>
            <TotalLine label="Monthly Fixed Bills" amt={billTotals.filter(b=>b.freq==="monthly").reduce((s,b)=>s+b.mo,0)} color="#e0a050"/>
            <TotalLine label={`Weekly Bills × ${weeks.toFixed(2)} weeks`} amt={billTotals.filter(b=>b.freq==="weekly").reduce((s,b)=>s+b.mo,0)} color="#c9a84c"/>
            <TotalLine label="Extras" amt={billTotals.filter(b=>b.freq==="extra").reduce((s,b)=>s+b.mo,0)} color="#a07ed4"/>
            <div style={C.totalDivider}/>
            <TotalLine label="TOTAL BILLS THIS MONTH" amt={totalFixedBills} color="#e0d8cc" big/>
          </div>
        </div>
      )}

      {/* ════════════════════════════════
          TAB: EXPENSES
      ════════════════════════════════ */}
      {tab === "txns" && (
        <div style={C.panel}>
          <div style={{ marginBottom:14 }}>
            <button style={C.addBtn} onClick={() => setShowForm(f => !f)}>
              {showForm ? "— CANCEL" : "+ LOG AN EXPENSE"}
            </button>
          </div>

          {showForm && (
            <div style={C.form}>
              <div style={C.formGrid}>
                <input style={C.inp} placeholder="What did you spend on?" value={form.desc}
                  onChange={e => setForm(f => ({ ...f, desc: e.target.value }))} />
                <input style={C.inp} placeholder="Amount ($)" type="number" step="0.01" value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
                <select style={{ ...C.inp, ...C.sel }} value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                  {CATS.map(c => <option key={c.id} value={c.id}>{c.icon} {c.id}</option>)}
                </select>
                <input style={C.inp} type="date" value={form.date}
                  onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <button style={C.subBtn} onClick={addExpense}>SAVE EXPENSE</button>
            </div>
          )}

          {filtered.length === 0
            ? <EmptyState msg={`No expenses logged for ${MONTHS[month]} ${year}.\nTap the button above to add one.`}/>
            : (
              <div style={C.txnList}>
                {[...filtered].sort((a,b) => new Date(b.date) - new Date(a.date)).map((e, i) => (
                  <div key={e.id} style={{ ...C.txnRow, animationDelay:`${i * 35}ms` }}>
                    <div style={{ ...C.txnAccent, background: catColor(e.category) }}/>
                    <span style={C.txnIco}>{catIcon(e.category)}</span>
                    <div style={C.txnMeta}>
                      <div style={C.txnDesc}>{e.desc}</div>
                      <div style={C.txnSub}>
                        <span style={{ color: catColor(e.category), fontSize:8, letterSpacing:"0.1em" }}>{e.category}</span>
                        <span style={C.txnDate}>{e.date}</span>
                        {e.source === "receipt" && <span style={C.badge}>RECEIPT</span>}
                      </div>
                    </div>
                    <div style={{ ...C.txnAmt, color: catColor(e.category) }}>{f2(e.amount)}</div>
                    <button style={C.delBtn} onClick={() => delExp(e.id)}>✕</button>
                  </div>
                ))}
                <div style={C.txnTotalRow}>
                  <span style={C.txnTotalLbl}>VARIABLE TOTAL</span>
                  <span style={{ ...C.txnTotalAmt, color:"#7e9fd4" }}>{f2(totalVariableExp)}</span>
                </div>
                <div style={C.txnTotalRow}>
                  <span style={C.txnTotalLbl}>+ FIXED BILLS</span>
                  <span style={{ ...C.txnTotalAmt, color:"#e0a050" }}>{f2(totalFixedBills)}</span>
                </div>
                <div style={{ ...C.txnTotalRow, borderTop:"1px solid rgba(201,168,76,0.25)", paddingTop:10 }}>
                  <span style={{ ...C.txnTotalLbl, color:"#c9a84c" }}>= GRAND TOTAL</span>
                  <span style={{ ...C.txnTotalAmt, color:"#c9a84c", fontSize:20 }}>{f2(totalSpent)}</span>
                </div>
              </div>
            )
          }
        </div>
      )}

      {/* ════════════════════════════════
          TAB: RECEIPTS
      ════════════════════════════════ */}
      {tab === "receipts" && (
        <div style={C.panel}>
          <SectionHead>DROP A RECEIPT — AI READS EVERY ITEM AUTOMATICALLY</SectionHead>
          <div
            style={{ ...C.dropZone, ...(dragging ? C.dropActive : {}), ...(analyzing ? C.dropAnalyzing : {}) }}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => !analyzing && fileRef.current.click()}
          >
            <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }}
              onChange={e => processFile(e.target.files[0])} />
            {analyzing
              ? <div style={C.dc}><div style={C.spin}/><div style={C.dmsg}>{analyzeMsg}</div></div>
              : <div style={C.dc}>
                  <div style={{ fontSize:36 }}>🧾</div>
                  <div style={C.dTitle}>DRAG & DROP YOUR RECEIPT HERE</div>
                  <div style={C.dSub}>or click to browse — JPG / PNG / WEBP</div>
                  {analyzeMsg && (
                    <div style={{ ...C.dmsg, marginTop:10, color: analyzeMsg.startsWith("✓") ? "#6ec6a0" : "#e07b4a" }}>
                      {analyzeMsg}
                    </div>
                  )}
                </div>
            }
          </div>

          {filtered.filter(e => e.source === "receipt").length > 0 && (
            <>
              <SectionHead style={{ marginTop:24 }}>RECEIPT ITEMS — {MONTHS[month]} {year}</SectionHead>
              <div style={C.txnList}>
                {filtered.filter(e => e.source === "receipt").map((e, i) => (
                  <div key={e.id} style={{ ...C.txnRow, animationDelay:`${i*35}ms` }}>
                    <div style={{ ...C.txnAccent, background: catColor(e.category) }}/>
                    <span style={C.txnIco}>{catIcon(e.category)}</span>
                    <div style={C.txnMeta}>
                      <div style={C.txnDesc}>{e.desc}</div>
                      <div style={C.txnSub}>
                        <span style={{ color:catColor(e.category), fontSize:8, letterSpacing:"0.1em" }}>{e.category}</span>
                        <span style={C.txnDate}>{e.date}</span>
                      </div>
                    </div>
                    <div style={{ ...C.txnAmt, color:catColor(e.category) }}>{f2(e.amount)}</div>
                    <button style={C.delBtn} onClick={() => delExp(e.id)}>✕</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ════════════════════════════════
          TAB: OVERVIEW (charts)
      ════════════════════════════════ */}
      {tab === "overview" && (
        <div style={C.panel}>
          <SectionHead>WHERE YOUR MONEY GOES — {MONTHS[month]} {year}</SectionHead>

          {breakdown.length === 0
            ? <EmptyState msg="No spending data yet for this month."/>
            : <>
                <div style={C.catList}>
                  {breakdown.map((cat, i) => (
                    <div key={cat.id} style={{ ...C.catRow, animationDelay:`${i*50}ms` }}>
                      <div style={C.catLeft}>
                        <span style={{ fontSize:15 }}>{cat.icon}</span>
                        <span style={C.catName}>{cat.id}</span>
                      </div>
                      <div style={C.barTrack}>
                        <div style={{ ...C.barFill, width:`${cat.pct}%`, background:cat.color }}/>
                      </div>
                      <div style={{ color:cat.color, fontSize:12, fontWeight:700, minWidth:70, textAlign:"right" }}>{f2(cat.sum)}</div>
                      <div style={C.catPct}>{cat.pct.toFixed(1)}%</div>
                    </div>
                  ))}
                </div>

                {/* donut */}
                <div style={C.ringWrap}>
                  <div style={C.ring}>
                    {breakdown.map((cat, i) => {
                      const off = breakdown.slice(0, i).reduce((s, c) => s + c.pct, 0);
                      return (
                        <div key={cat.id} style={{
                          position:"absolute", inset:0, borderRadius:"50%",
                          background:`conic-gradient(transparent ${off}%,${cat.color} ${off}%,${cat.color} ${off+cat.pct}%,transparent ${off+cat.pct}%)`
                        }}/>
                      );
                    })}
                    <div style={C.ringHole}>
                      <div style={C.ringAmt}>{f2(totalSpent)}</div>
                      <div style={C.ringMo}>{MONTHS[month]}</div>
                    </div>
                  </div>
                  <div style={C.legend}>
                    {breakdown.map(cat => (
                      <div key={cat.id} style={C.legendItem}>
                        <div style={{ width:7, height:7, borderRadius:"50%", background:cat.color, flexShrink:0 }}/>
                        <span style={C.legendLbl}>{cat.icon} {cat.id}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
          }
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function BudgetBox({ icon, label, value, onChange, hint, color }) {
  return (
    <div style={BB.wrap}>
      <div style={BB.lbl}>{icon} {label}</div>
      <div style={BB.inputWrap}>
        <span style={BB.dollar}>$</span>
        <input
          style={{ ...BB.input, borderColor: value ? color + "60" : "rgba(255,255,255,0.08)" }}
          type="number" step="0.01" placeholder="0.00"
          value={value} onChange={e => onChange(e.target.value)}
        />
      </div>
      <div style={BB.hint}>{hint}</div>
    </div>
  );
}

function BillRow({ bill, onUpdate, onRemove, weeks }) {
  const a  = parseFloat(bill.amount) || 0;
  const mo = bill.freq === "weekly" ? a * weeks : a;

  return (
    <div style={{ ...BR.row, borderColor: bill.color + "28" }}>
      <span style={{ fontSize:18, flexShrink:0 }}>{bill.icon}</span>

      {bill.editable
        ? <input style={BR.nameInput} value={bill.label}
            onChange={e => onUpdate(bill.id, "label", e.target.value)} />
        : <span style={BR.name}>{bill.label}</span>
      }

      <div style={BR.inputBox}>
        <span style={BR.dollar}>$</span>
        <input style={BR.amtInput} type="number" placeholder="0.00" step="0.01"
          value={bill.amount} onChange={e => onUpdate(bill.id, "amount", e.target.value)} />
      </div>

      <span style={BR.per}>
        {bill.freq === "weekly"  && "/wk"}
        {bill.freq === "monthly" && "/mo"}
        {bill.freq === "extra"   && "once"}
      </span>

      <span style={BR.arrow}>→</span>

      <div style={BR.moTotal}>
        <span style={{ color: mo > 0 ? bill.color : "#444", fontSize:14, fontWeight:700 }}>
          {mo > 0 ? f2(mo) : "—"}
        </span>
        {bill.freq === "weekly" && mo > 0 &&
          <span style={BR.moSub}>/mo</span>
        }
      </div>

      {onRemove
        ? <button style={BR.del} onClick={() => onRemove(bill.id)}>✕</button>
        : <div style={{ width:22 }}/>
      }
    </div>
  );
}

function MoneyTile({ label, sub, amount, icon, color, highlight }) {
  return (
    <div style={{
      ...MT.wrap,
      borderColor: color + (highlight ? "50" : "20"),
      background: highlight ? color + "0a" : "rgba(255,255,255,0.018)",
    }}>
      <div style={MT.icon}>{icon}</div>
      <div style={{ ...MT.amt, color }}>{f2(amount)}</div>
      <div style={MT.label}>{label}</div>
      <div style={MT.sub}>{sub}</div>
    </div>
  );
}

function TotalLine({ label, amt, color, big }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding: big ? "12px 0 0" : "6px 0" }}>
      <span style={{ fontSize: big ? 9 : 8, letterSpacing:"0.2em", color: big ? "#a0987c" : "#555" }}>{label}</span>
      <span style={{ fontSize: big ? 18 : 13, fontWeight:700, color }}>{f2(amt)}</span>
    </div>
  );
}

function SectionHead({ children, style }) {
  return (
    <div style={{ fontSize:8, letterSpacing:"0.3em", color:"#555", marginBottom:12,
                  display:"flex", alignItems:"center", flexWrap:"wrap", gap:8, ...style }}>
      {children}
    </div>
  );
}

function Hint({ children }) {
  return <span style={{ fontSize:8, color:"#c9a84c", letterSpacing:"0.06em", fontStyle:"italic" }}>{children}</span>;
}

function EmptyState({ msg }) {
  return (
    <div style={{ textAlign:"center", color:"#3a3a4a", fontSize:11, lineHeight:2,
                  padding:"44px 0", letterSpacing:"0.05em", whiteSpace:"pre-line" }}>
      {msg}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const C = {
  root: { minHeight:"100vh", background:"#0b0c0e", color:"#e0d8cc",
          fontFamily:"'Space Mono','Courier New',monospace", paddingBottom:80, position:"relative" },
  gridBg: { position:"fixed", inset:0, pointerEvents:"none", zIndex:0,
             backgroundImage:"linear-gradient(rgba(201,168,76,0.025) 1px,transparent 1px),linear-gradient(90deg,rgba(201,168,76,0.025) 1px,transparent 1px)",
             backgroundSize:"44px 44px" },

  // header
  header: { position:"relative", zIndex:2, display:"flex", justifyContent:"space-between",
            alignItems:"flex-end", padding:"28px 24px 16px",
            borderBottom:"1px solid rgba(201,168,76,0.1)" },
  eyebrow:{ fontSize:8, letterSpacing:"0.35em", color:"#c9a84c", marginBottom:5 },
  title:  { fontSize:"clamp(26px,6vw,44px)", fontWeight:700, color:"#e0d8cc", letterSpacing:"-0.02em" },
  dot:    { color:"#c9a84c" },
  monthRow:{ display:"flex", alignItems:"center", gap:10 },
  navBtn: { background:"rgba(201,168,76,0.07)", border:"1px solid rgba(201,168,76,0.18)",
            color:"#c9a84c", fontSize:11, padding:"6px 10px", borderRadius:2, transition:"all 0.15s" },
  monthLbl:{ fontSize:11, letterSpacing:"0.2em", color:"#c9a84c", minWidth:84, textAlign:"center" },

  // budget setup strip
  setupStrip:{ position:"relative", zIndex:2, padding:"16px 24px",
               background:"rgba(255,255,255,0.015)",
               borderBottom:"1px solid rgba(255,255,255,0.04)" },
  setupLabel:{ fontSize:8, letterSpacing:"0.3em", color:"#555", marginBottom:12 },
  setupBoxes:{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10 },

  // tabs
  tabs: { position:"relative", zIndex:2, display:"flex", padding:"0 24px",
          borderBottom:"1px solid rgba(255,255,255,0.05)", overflowX:"auto" },
  tab:  { background:"none", border:"none", borderBottom:"2px solid transparent",
          color:"#555", fontSize:8, letterSpacing:"0.2em", padding:"12px 10px",
          transition:"all 0.15s", whiteSpace:"nowrap" },
  tabOn:{ color:"#c9a84c", borderBottomColor:"#c9a84c" },

  panel:{ position:"relative", zIndex:1, padding:"20px 24px" },

  // money tab
  moneyCard:{ display:"flex", alignItems:"center", gap:14, padding:"16px",
              background:"rgba(110,198,160,0.04)", border:"1px solid",
              borderRadius:4, marginBottom:16, animation:"fadeUp 0.4s ease both" },
  mcIcon: { fontSize:28 },
  mcBody: { flex:1 },
  mcLabel:{ fontSize:8, letterSpacing:"0.25em", color:"#555", marginBottom:4 },
  mcAmt:  { fontSize:24, fontWeight:700 },
  mcSub:  { fontSize:9, color:"#555", marginTop:3 },

  monthlyGrid:{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:10, marginBottom:16 },

  budBar:     { padding:"14px 16px", background:"rgba(255,255,255,0.02)",
                border:"1px solid rgba(255,255,255,0.05)", borderRadius:4, marginBottom:10 },
  budBarTop:  { display:"flex", justifyContent:"space-between", marginBottom:8 },
  budBarLbl:  { fontSize:8, letterSpacing:"0.25em", color:"#555" },
  budBarTrack:{ height:6, background:"rgba(255,255,255,0.06)", borderRadius:3, overflow:"hidden" },
  budBarFill: { height:"100%", borderRadius:3, transition:"width 0.6s cubic-bezier(0.4,0,0.2,1)" },
  budBarSub:  { fontSize:9, color:"#555", marginTop:6 },

  tip:    { display:"flex", gap:14, padding:"18px", background:"rgba(201,168,76,0.04)",
            border:"1px solid rgba(201,168,76,0.12)", borderRadius:4, marginTop:24,
            animation:"fadeUp 0.5s ease 0.2s both" },
  tipIcon:{ fontSize:22, flexShrink:0 },
  tipHead:{ fontSize:10, color:"#c9a84c", letterSpacing:"0.1em", marginBottom:8 },
  tipBody:{ fontSize:10, color:"#777", lineHeight:1.9 },

  // bills tab
  billTotals:{ marginTop:20, paddingTop:16, borderTop:"1px solid rgba(255,255,255,0.05)" },
  totalDivider:{ height:1, background:"rgba(255,255,255,0.05)", margin:"8px 0" },
  addExBtn:{ background:"none", border:"1px dashed rgba(160,126,212,0.3)", color:"#a07ed4",
             fontSize:8, letterSpacing:"0.18em", padding:"8px 14px", borderRadius:2,
             marginTop:8, transition:"all 0.15s" },

  // expense form
  addBtn: { background:"none", border:"1px solid rgba(201,168,76,0.28)", color:"#c9a84c",
            fontSize:9, letterSpacing:"0.2em", padding:"8px 16px", borderRadius:2, transition:"all 0.15s" },
  form:   { padding:14, background:"rgba(201,168,76,0.03)", border:"1px solid rgba(201,168,76,0.08)",
            borderRadius:3, marginBottom:16 },
  formGrid:{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:10 },
  inp:    { background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:2, color:"#e0d8cc", fontFamily:"'Space Mono','Courier New',monospace",
            fontSize:11, padding:"8px 10px", width:"100%" },
  sel:    { appearance:"none", cursor:"pointer" },
  subBtn: { background:"rgba(201,168,76,0.08)", border:"1px solid rgba(201,168,76,0.28)",
            color:"#c9a84c", fontSize:9, letterSpacing:"0.2em", padding:"9px",
            borderRadius:2, width:"100%", transition:"all 0.15s" },

  // transaction list
  txnList:{ display:"flex", flexDirection:"column", gap:2 },
  txnRow: { display:"flex", alignItems:"center", gap:9, padding:"10px 11px",
            background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.04)",
            borderRadius:3, animation:"fadeUp 0.35s ease both" },
  txnAccent:{ width:3, height:32, borderRadius:2, flexShrink:0 },
  txnIco: { fontSize:15, flexShrink:0 },
  txnMeta:{ flex:1, minWidth:0 },
  txnDesc:{ fontSize:11, color:"#e0d8cc", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  txnSub: { display:"flex", gap:8, marginTop:2, flexWrap:"wrap" },
  txnDate:{ fontSize:8, color:"#555" },
  badge:  { fontSize:7, letterSpacing:"0.15em", color:"#c9a84c",
            border:"1px solid rgba(201,168,76,0.25)", padding:"1px 4px", borderRadius:2 },
  txnAmt: { fontSize:12, fontWeight:700, flexShrink:0 },
  delBtn: { background:"none", border:"none", color:"#2e2e3a", fontSize:9, padding:"3px 5px", flexShrink:0 },
  txnTotalRow:{ display:"flex", justifyContent:"space-between", alignItems:"center",
                padding:"10px 11px 4px", marginTop:2 },
  txnTotalLbl:{ fontSize:8, letterSpacing:"0.22em", color:"#555" },
  txnTotalAmt:{ fontSize:14, fontWeight:700 },

  // overview
  catList:{ display:"flex", flexDirection:"column", gap:11 },
  catRow: { display:"grid", gridTemplateColumns:"120px 1fr 70px 44px",
            alignItems:"center", gap:12, animation:"fadeUp 0.4s ease both" },
  catLeft:{ display:"flex", alignItems:"center", gap:7 },
  catName:{ fontSize:9, letterSpacing:"0.07em", color:"#a0987c" },
  barTrack:{ height:4, background:"rgba(255,255,255,0.06)", borderRadius:2, overflow:"hidden" },
  barFill: { height:"100%", borderRadius:2, transition:"width 0.6s cubic-bezier(0.4,0,0.2,1)" },
  catPct: { fontSize:8, color:"#555", textAlign:"right" },

  ringWrap:{ marginTop:28, display:"flex", flexDirection:"column", alignItems:"center", gap:14 },
  ring:    { position:"relative", width:160, height:160, borderRadius:"50%", background:"rgba(255,255,255,0.02)" },
  ringHole:{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)",
             width:90, height:90, borderRadius:"50%", background:"#0b0c0e",
             display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" },
  ringAmt: { fontSize:12, fontWeight:700, color:"#c9a84c" },
  ringMo:  { fontSize:7, color:"#555", letterSpacing:"0.2em", marginTop:2 },
  legend:  { display:"flex", flexWrap:"wrap", gap:"5px 16px", justifyContent:"center" },
  legendItem:{ display:"flex", alignItems:"center", gap:5 },
  legendLbl: { fontSize:8, color:"#888" },

  // receipt drop
  dropZone: { border:"1px dashed rgba(201,168,76,0.15)", borderRadius:3, padding:"44px 24px",
               cursor:"pointer", transition:"all 0.2s", background:"rgba(201,168,76,0.01)", marginBottom:8 },
  dropActive:   { border:"1px dashed #c9a84c", background:"rgba(201,168,76,0.04)" },
  dropAnalyzing:{ border:"1px dashed rgba(110,198,160,0.3)", background:"rgba(110,198,160,0.02)", cursor:"default" },
  dc:    { display:"flex", flexDirection:"column", alignItems:"center", gap:9 },
  dTitle:{ fontSize:9, letterSpacing:"0.27em", color:"#c9a84c" },
  dSub:  { fontSize:8, color:"#555", letterSpacing:"0.1em" },
  dmsg:  { fontSize:11, letterSpacing:"0.05em" },
  spin:  { width:24, height:24, borderRadius:"50%", border:"2px solid rgba(110,198,160,0.12)",
           borderTopColor:"#6ec6a0", animation:"spin 0.8s linear infinite" },
};

// BudgetBox styles
const BB = {
  wrap:     { display:"flex", flexDirection:"column", gap:5 },
  lbl:      { fontSize:8, letterSpacing:"0.2em", color:"#888" },
  inputWrap:{ display:"flex", alignItems:"center", background:"rgba(255,255,255,0.04)",
              border:"1px solid rgba(255,255,255,0.08)", borderRadius:3, overflow:"hidden",
              transition:"border-color 0.2s" },
  dollar:   { padding:"0 6px 0 10px", color:"#555", fontSize:13, flexShrink:0 },
  input:    { background:"transparent", border:"none", color:"#e0d8cc",
              fontFamily:"'Space Mono','Courier New',monospace",
              fontSize:13, fontWeight:700, padding:"9px 8px 9px 0", width:"100%",
              transition:"border-color 0.2s" },
  hint:     { fontSize:7, color:"#444", letterSpacing:"0.08em" },
};

// BillRow styles
const BR = {
  row:      { display:"flex", alignItems:"center", gap:10, padding:"12px 14px",
              background:"rgba(255,255,255,0.02)", border:"1px solid", borderRadius:3,
              animation:"fadeUp 0.4s ease both", marginBottom:5 },
  nameInput:{ background:"transparent", border:"none",
              borderBottom:"1px solid rgba(255,255,255,0.08)", color:"#a0987c",
              fontFamily:"'Space Mono','Courier New',monospace",
              fontSize:11, padding:"2px 4px", minWidth:0, flex:1 },
  name:     { fontSize:11, color:"#a0987c", letterSpacing:"0.04em", flex:1, minWidth:0 },
  inputBox: { display:"flex", alignItems:"center", background:"rgba(255,255,255,0.04)",
              border:"1px solid rgba(255,255,255,0.07)", borderRadius:2, overflow:"hidden", flexShrink:0 },
  dollar:   { padding:"0 4px 0 8px", color:"#555", fontSize:12, flexShrink:0 },
  amtInput: { background:"transparent", border:"none", color:"#e0d8cc",
              fontFamily:"'Space Mono','Courier New',monospace",
              fontSize:13, fontWeight:700, padding:"7px 7px 7px 0", width:80 },
  per:      { fontSize:8, color:"#555", letterSpacing:"0.1em", flexShrink:0, minWidth:30 },
  arrow:    { fontSize:11, color:"#333", flexShrink:0 },
  moTotal:  { display:"flex", alignItems:"baseline", gap:3, flexShrink:0, minWidth:72, justifyContent:"flex-end" },
  moSub:    { fontSize:7, color:"#666", letterSpacing:"0.1em" },
  del:      { background:"none", border:"none", color:"#2a2a35", fontSize:9, padding:"3px 5px", flexShrink:0 },
};

// MoneyTile styles
const MT = {
  wrap: { padding:"16px 14px", border:"1px solid", borderRadius:4,
          display:"flex", flexDirection:"column", gap:5,
          animation:"fadeUp 0.4s ease both", transition:"border-color 0.3s" },
  icon: { fontSize:20 },
  amt:  { fontSize:"clamp(16px,3vw,22px)", fontWeight:700 },
  label:{ fontSize:9, letterSpacing:"0.12em", color:"#a0987c" },
  sub:  { fontSize:8, color:"#555", letterSpacing:"0.04em" },
};
