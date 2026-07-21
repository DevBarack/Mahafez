import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocs, getDoc, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, increment, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, AUTH_EMAIL } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const $ = id => document.getElementById(id);
const money = n => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

let WALLETS = [], TX = [], unsub = [];

// ═══ AUTH ═══
setPersistence(auth, browserLocalPersistence);

$("loginBtn").onclick = async () => {
  $("loginErr").textContent = "";
  const pw = $("pw").value.trim();
  if (!pw) { $("loginErr").textContent = "اكتب كلمة المرور"; return; }
  try {
    await signInWithEmailAndPassword(auth, AUTH_EMAIL, pw);
  } catch (e) {
    $("loginErr").textContent = "كلمة المرور غير صحيحة";
  }
};
$("pw").addEventListener("keydown", e => { if (e.key === "Enter") $("loginBtn").click(); });
$("outBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, user => {
  unsub.forEach(u => u()); unsub = [];
  if (user) {
    $("login").hidden = true; $("app").hidden = false;
    $("today").textContent = new Date().toLocaleDateString("ar-SA-u-ca-gregory", { day: "numeric", month: "long" });
    loadSplit();
    loadCounters();
    listen();
  } else {
    $("app").hidden = true; $("login").hidden = false; $("pw").value = "";
  }
});

// ═══ LIVE DATA ═══
function listen() {
  unsub.push(onSnapshot(query(collection(db, "wallets"), orderBy("order")), snap => {
    WALLETS = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderWallets(); renderReview(); fillPickers(); renderReport(); renderWalletChart();
  }));
  unsub.push(onSnapshot(query(collection(db, "transactions"), orderBy("createdAt", "desc"), limit(150)), snap => {
    TX = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderReview(); renderUnparsed(); renderTx(); renderWallets(); renderReport(); renderWalletChart(); renderStrip();
    autoSort();
  }));
}

// ═══ PARSE raw SMS text → amount + merchant + card ═══
// الشورت كت يرسل النص الخام، والتطبيق يقسّمه هنا
function parseSMS(raw) {
  if (!raw) return null;
  const amtM = raw.match(/SAR\s*([\d,]+(?:\.\d{1,2})?)/) ||
                raw.match(/([\d,]+(?:\.\d{1,2})?)\s*SAR/) ||
               raw.match(/مبلغ\s*([\d,]+(?:\.\d{1,2})?)/) ||
               raw.match(/بيع\s*([\d,]+(?:\.\d{1,2})?)/);
  const merM = raw.match(/من\s+(?!حساب)([^\n]+?)(?:\s+في|\s+-\s+SA|\n|$)/);
  const cardM = raw.match(/بطاقة[^\d]*(\d{4})/);
  const amount = amtM ? parseFloat(amtM[1].replace(/,/g, "")) : null;
  const merchant = merM ? merM[1].trim() : null;
  const card = cardM ? (cardM[1] === "7497" ? "visa" : "mada") : "";
  if (!amount || !merchant) return null;
  return { amount, merchant, card };
}

// ═══ AUTO-SORT: parse raw texts, then match merchants against learned memory ═══
async function autoSort() {
  // ١) عمليات وصلت كنص خام من الشورت كت → قسّمها أول
  const rawOnes = TX.filter(t => t.status === "raw");
  for (const t of rawOnes) {
    const parsed = parseSMS(t.raw);
    if (parsed) {
      await updateDoc(doc(db, "transactions", t.id), {
        amount: parsed.amount, merchant: parsed.merchant,
        card: parsed.card, status: "pending"
      });
    } else {
      // ما قدر يقسّمها — علّمها عشان تراجعها يدوي
      await updateDoc(doc(db, "transactions", t.id), { status: "unparsed" });
    }
  }
  // ٢) عمليات جاهزة (فيها متجر) → صنّفها من الذاكرة
  const pending = TX.filter(t => t.status === "pending");
  for (const t of pending) {
    const key = norm(t.merchant);
    if (!key) continue;
    const m = await getDoc(doc(db, "merchants", key));
    if (m.exists()) await assign(t, m.data().wallet, false);
  }
}
const norm = s => (s || "").toString().trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 90);

// ═══ ASSIGN a transaction to a wallet (and deduct) ═══
async function assign(tx, walletId, learn = true) {
  const w = WALLETS.find(x => x.id === walletId);
  if (!w) return;
  await updateDoc(doc(db, "wallets", walletId), {
    balance: increment(-tx.amount),
    spent: increment(tx.amount)
  });
  await updateDoc(doc(db, "transactions", tx.id), {
    wallet: walletId, walletName: w.name, status: "done"
  });
  if (learn && tx.merchant) {
    await setDoc(doc(db, "merchants", norm(tx.merchant)), {
      wallet: walletId, merchant: tx.merchant, updatedAt: serverTimestamp()
    });
  }
}

// ═══ UNDO ═══
async function undo(tx) {
  if (!tx.wallet) return;
  await updateDoc(doc(db, "wallets", tx.wallet), {
    balance: increment(tx.amount), spent: increment(-tx.amount)
  });
  await updateDoc(doc(db, "transactions", tx.id), { status: "pending", wallet: null, walletName: null });
}

// ═══ RENDER ═══
// العدّاد والصرف توأم: يُحسبان من سجل العمليات، ويحترمان آخر تصفير (خط الأساس)
let txBaseline = 0; // عدد العمليات المكتملة وقت آخر تصفير

function renderStrip() {
  const total = WALLETS.reduce((s, w) => s + (w.balance || 0), 0);
  // العمليات المكتملة، الأحدث أول (TX أصلاً مرتّبة desc)
  const doneTx = TX.filter(t => t.status === "done");
  // نتجاهل أقدم (txBaseline) عملية — يعني نعدّ ونجمع بس اللي بعد آخر تصفير
  const afterReset = txBaseline > 0 ? doneTx.slice(0, Math.max(0, doneTx.length - txBaseline)) : doneTx;
  const spent = afterReset.reduce((s, t) => s + (t.amount || 0), 0);
  $("sTotal").textContent = money(total);
  $("sSpent").textContent = money(spent);
  $("sCount").textContent = afterReset.length;
}

function renderWallets() {
  const el = $("wallets");
  if (!WALLETS.length) { el.innerHTML = `<div class="empty">ما فيه محافظ بعد — أضف وحدة بالزر تحت</div>`; return; }
  const spentMap = spentByWalletFromTx(); // نفس مصدر التقرير والشريط العلوي
  el.innerHTML = WALLETS.map(w => {
    const bal = w.balance || 0, bud = w.budget || 1;
    const spent = spentMap[w.id] || 0;
    const pct = Math.max(0, Math.min(100, (bal / bud) * 100));
    const cls = bal < 0 ? "over" : pct < 25 ? "low" : "";
    const color = bal < 0 ? "var(--red)" : pct < 25 ? "var(--gold)" : "var(--teal)";
    return `<div class="env tap ${cls}" data-edit="${w.id}" style="color:${color}">
      <div class="fill" style="inline-size:${pct}%"></div>
      <div class="top">
        <span class="name">${w.emoji || ""} ${esc(w.name)}</span>
        <span class="bal num">${money(bal)}</span>
      </div>
      <div class="sub"><span class="num">من ${money(bud)}</span><span class="num">صُرف ${money(spent)}</span></div>
    </div>`;
  }).join("");
  el.querySelectorAll("[data-edit]").forEach(c => {
    c.onclick = () => openWalletModal(c.dataset.edit);
  });
  renderStrip();
}

function renderReview() {
  const pend = TX.filter(t => t.status === "pending");
  $("reviewWrap").hidden = !pend.length;
  $("revCount").textContent = pend.length;
  if (!pend.length) return;
  $("reviewList").innerHTML = pend.map(t => `
    <div class="review">
      <div class="top">
        <span class="merchant">${esc(t.merchant || "بدون اسم")}</span>
        <span class="amt num">${money(t.amount)}</span>
      </div>
      <div class="meta num">${fmt(t.createdAt)}</div>
      <div class="row">
        <select id="sel-${t.id}">${WALLETS.map(w => `<option value="${w.id}">${w.emoji || ""} ${w.name}</option>`).join("")}</select>
        <button data-assign="${t.id}">اخصم</button>
      </div>
    </div>`).join("");
  $("reviewList").querySelectorAll("[data-assign]").forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.assign;
      const tx = TX.find(t => t.id === id);
      b.disabled = true; b.textContent = "…";
      await assign(tx, $("sel-" + id).value, true);
    };
  });
}

// عمليات ما قدر التطبيق يقرأها من النص — أضفها يدوي
function renderUnparsed() {
  const unp = TX.filter(t => t.status === "unparsed");
  $("unparsedWrap").hidden = !unp.length;
  $("unpCount").textContent = unp.length;
  if (!unp.length) return;
  $("unparsedList").innerHTML = unp.map(t => `
    <div class="review" style="border-color:var(--gold);background:linear-gradient(180deg,rgba(212,175,55,.09),transparent)">
      <div style="font-size:.78rem;color:var(--muted);margin-bottom:8px">${esc((t.raw || "").slice(0, 140))}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <input id="amt-${t.id}" type="number" inputmode="decimal" placeholder="المبلغ"
          style="flex:1;min-width:90px;background:#0c1a17;border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:10px">
        <select id="wsel-${t.id}" style="flex:2;min-width:120px">${WALLETS.map(w => `<option value="${w.id}">${w.emoji || ""} ${w.name}</option>`).join("")}</select>
        <button data-manual="${t.id}">اخصم</button>
      </div>
    </div>`).join("");
  $("unparsedList").querySelectorAll("[data-manual]").forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.manual;
      const tx = TX.find(t => t.id === id);
      const amt = parseFloat($("amt-" + id).value);
      if (!amt || amt <= 0) { $("amt-" + id).style.borderColor = "var(--red)"; return; }
      b.disabled = true; b.textContent = "…";
      // اكتب المبلغ ثم اخصم من المحفظة المختارة
      await updateDoc(doc(db, "transactions", id), { amount: amt, merchant: tx.merchant || "يدوي", status: "pending" });
      const fresh = { ...tx, amount: amt };
      await assign(fresh, $("wsel-" + id).value, false);
    };
  });
}

function renderTx() {
  const done = TX.filter(t => t.status === "done");
  $("txList").innerHTML = done.length ? done.map(t => `
    <div class="tx">
      <div class="l"><div class="m">${esc(t.merchant || "—")}</div>
        <select class="tx-wallet" data-reassign="${t.id}">
          ${WALLETS.map(w => `<option value="${w.id}" ${w.id === t.wallet ? "selected" : ""}>${w.emoji || ""} ${esc(w.name)}</option>`).join("")}
        </select>
      </div>
      <div class="r"><div class="a num">${money(t.amount)}</div><div class="d num">${fmt(t.createdAt)}</div></div>
      <div class="acts">
        <button class="undo" data-undo="${t.id}">تراجع</button>
        <button class="del" data-del="${t.id}">حذف</button>
      </div>
    </div>`).join("") : `<div class="empty">ما فيه عمليات بعد</div>`;
  $("txList").querySelectorAll("[data-undo]").forEach(b => {
    b.onclick = () => undo(TX.find(t => t.id === b.dataset.undo));
  });
  $("txList").querySelectorAll("[data-del]").forEach(b => {
    b.onclick = () => deleteTx(TX.find(t => t.id === b.dataset.del));
  });
  // تغيير تصنيف العملية لمحفظة ثانية
  $("txList").querySelectorAll("[data-reassign]").forEach(sel => {
    sel.onchange = () => reassignTx(TX.find(t => t.id === sel.dataset.reassign), sel.value);
  });
}

// ═══ تعديل تصنيف عملية: انقلها من محفظتها الحالية لمحفظة ثانية ═══
// يرجّع المبلغ للمحفظة القديمة، ويخصمه من الجديدة، ويحدّث ذاكرة المتجر
async function reassignTx(tx, newWalletId) {
  if (!tx || !newWalletId || newWalletId === tx.wallet) return;
  const newW = WALLETS.find(w => w.id === newWalletId);
  if (!newW) return;
  // رجّع المبلغ للمحفظة القديمة
  if (tx.wallet) {
    await updateDoc(doc(db, "wallets", tx.wallet), {
      balance: increment(tx.amount), spent: increment(-tx.amount)
    });
  }
  // اخصم من المحفظة الجديدة
  await updateDoc(doc(db, "wallets", newWalletId), {
    balance: increment(-tx.amount), spent: increment(tx.amount)
  });
  // حدّث العملية
  await updateDoc(doc(db, "transactions", tx.id), {
    wallet: newWalletId, walletName: newW.name
  });
  // علّم الذاكرة: هذا المتجر يروح للمحفظة الجديدة (عشان المرات الجاية)
  if (tx.merchant) {
    await setDoc(doc(db, "merchants", norm(tx.merchant)), {
      wallet: newWalletId, merchant: tx.merchant, updatedAt: serverTimestamp()
    });
  }
}

// ═══ حذف عملية نهائياً — يرجّع المبلغ للمحفظة إذا كانت مخصومة ═══
async function deleteTx(tx) {
  if (!tx) return;
  // إذا كانت مخصومة من محفظة → رجّع المبلغ
  if (tx.status === "done" && tx.wallet) {
    await updateDoc(doc(db, "wallets", tx.wallet), {
      balance: increment(tx.amount), spent: increment(-tx.amount)
    });
  }
  await deleteDoc(doc(db, "transactions", tx.id));
}

// ═══ حساب الصرف لكل محفظة من سجل العمليات (نفس مصدر الشريط العلوي، يحترم آخر تصفير) ═══
function spentByWalletFromTx() {
  const doneTx = TX.filter(t => t.status === "done");
  const afterReset = txBaseline > 0 ? doneTx.slice(0, Math.max(0, doneTx.length - txBaseline)) : doneTx;
  const map = {}; // walletId -> مجموع
  afterReset.forEach(t => { if (t.wallet) map[t.wallet] = (map[t.wallet] || 0) + (t.amount || 0); });
  return map;
}

function renderReport() {
  const spentMap = spentByWalletFromTx();
  const max = Math.max(...WALLETS.map(w => spentMap[w.id] || 0), 1);
  const sorted = [...WALLETS]
    .map(w => ({ ...w, _spent: spentMap[w.id] || 0 }))
    .sort((a, b) => b._spent - a._spent)
    .filter(w => w._spent > 0);
  $("report").innerHTML = sorted.length ? sorted.map(w => {
    const s = w._spent, bud = w.budget || 1;
    const over = s > bud;
    return `<div class="rep">
      <div class="l"><span>${w.emoji || ""} ${w.name}</span><span class="num" style="color:${over ? "var(--red)" : "var(--muted)"}">${money(s)} / ${money(bud)}</span></div>
      <div class="bar"><div style="width:${Math.min(100, (s / max) * 100)}%;background:${over ? "var(--red)" : "var(--teal)"}"></div></div>
    </div>`;
  }).join("") : `<div class="empty">ما صرفت شي بعد هذا الشهر</div>`;
}

// ═══ القسم ٢: رسم دائري (Donut) بـSVG خام — بدون أي مكتبة خارجية ═══
const CHART_COLORS = ["#2fa98a", "#d4af37", "#7aa6d4", "#d9645a", "#5ec9a7", "#c99b3a", "#9b8ade", "#e08a7f"];

function renderWalletChart() {
  const host = $("walletChart");
  if (!host) return;

  // البيانات من سجل العمليات (يطابق تفصيل الصرف والشريط العلوي)
  const spentMap = spentByWalletFromTx();
  const spentWallets = WALLETS
    .map(w => ({ ...w, _spent: spentMap[w.id] || 0 }))
    .filter(w => w._spent > 0)
    .sort((a, b) => b._spent - a._spent);
  const totalSpent = spentWallets.reduce((s, w) => s + w._spent, 0);

  if (!spentWallets.length || totalSpent <= 0) {
    host.innerHTML = `<div class="empty">ما صرفت شي بعد</div>`;
    return;
  }

  // ابنِ الدائري: دائرة لكل محفظة بـstroke-dasharray
  const R = 80, C = 2 * Math.PI * R, cx = 130, cy = 110;
  let offset = 0;
  let segments = "";
  let legend = "";
  spentWallets.forEach((w, i) => {
    const val = w._spent;
    const frac = val / totalSpent;
    const len = frac * C;
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const pct = Math.round(frac * 100);
    segments += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none"
      stroke="${color}" stroke-width="26"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${cx} ${cy})"></circle>`;
    offset += len;
    legend += `<div class="lg-item">
      <span class="lg-dot" style="background:${color}"></span>
      <span class="lg-name">${w.emoji || ""} ${esc(w.name)}</span>
      <span class="lg-val num">${money(val)} · ${pct}%</span>
    </div>`;
  });

  host.innerHTML = `
    <svg viewBox="0 0 260 220" width="100%" style="max-height:230px">
      ${segments}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#eaf3f0"
        style="font:700 22px 'IBM Plex Sans Arabic',sans-serif">${money(totalSpent)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="#8fa9a1"
        style="font:500 11px 'IBM Plex Sans Arabic',sans-serif">إجمالي الصرف</text>
    </svg>
    <div class="chart-legend">${legend}</div>`;
}

function fillPickers() {
  $("aWallet").innerHTML = WALLETS.map(w => `<option value="${w.id}">${w.emoji || ""} ${w.name}</option>`).join("");
}

// ═══ ADD manual ═══
$("addBtn").onclick = async () => {
  $("addErr").textContent = "";
  const amt = parseFloat($("aAmt").value);
  const merch = $("aMerch").value.trim();
  const wid = $("aWallet").value;
  if (!amt || amt <= 0) { $("addErr").textContent = "اكتب مبلغ صحيح"; return; }
  if (!wid) { $("addErr").textContent = "اختر محفظة"; return; }
  const w = WALLETS.find(x => x.id === wid);
  const ref = await addDoc(collection(db, "transactions"), {
    amount: amt, merchant: merch || "يدوي", wallet: wid, walletName: w.name,
    status: "done", source: "manual", createdAt: serverTimestamp()
  });
  await updateDoc(doc(db, "wallets", wid), { balance: increment(-amt), spent: increment(amt) });
  if (merch) await setDoc(doc(db, "merchants", norm(merch)), { wallet: wid, merchant: merch, updatedAt: serverTimestamp() });
  $("aAmt").value = ""; $("aMerch").value = "";
  $("addErr").style.color = "var(--teal)"; $("addErr").textContent = "تسجّلت ✓";
  setTimeout(() => { $("addErr").textContent = ""; $("addErr").style.color = "var(--red)"; }, 1600);
};

// ═══ REFILL monthly ═══
let refillArmed2 = false, refillTimer2 = null;
$("refillBtn").onclick = async () => {
  if (!refillArmed2) {
    refillArmed2 = true;
    $("refillBtn").textContent = "⚠️ اضغط مرة ثانية للتأكيد";
    clearTimeout(refillTimer2);
    refillTimer2 = setTimeout(() => { refillArmed2 = false; $("refillBtn").textContent = "تعبئة المحافظ للشهر الجديد"; }, 4000);
    return;
  }
  clearTimeout(refillTimer2); refillArmed2 = false;
  $("refillBtn").disabled = true; $("refillBtn").textContent = "…";
  try {
    const b = writeBatch(db);
    WALLETS.forEach(w => b.update(doc(db, "wallets", w.id), { balance: w.budget || 0, spent: 0 }));
    await b.commit();
    $("refillBtn").textContent = "تمت التعبئة ✓";
    setTimeout(() => { $("refillBtn").textContent = "تعبئة المحافظ للشهر الجديد"; }, 2500);
  } catch (e) {
    $("refillBtn").textContent = "صار خطأ، حاول مرة ثانية";
    setTimeout(() => { $("refillBtn").textContent = "تعبئة المحافظ للشهر الجديد"; }, 2500);
  }
  $("refillBtn").disabled = false;
};

// ═══ NAV ═══
document.querySelectorAll("nav button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach(x => x.classList.remove("on"));
    document.querySelectorAll(".page").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    $("p-" + b.dataset.p).classList.add("on");
    window.scrollTo(0, 0);
    if (b.dataset.p === "split") renderSplit();
  };
});

// ═══════════════════════════════════════════
// ═══ الخاصية ١: تعديل / إضافة / حذف محفظة ═══
// ═══════════════════════════════════════════
let editingWalletId = null;

function openWalletModal(walletId) {
  editingWalletId = walletId; // null = محفظة جديدة
  const w = walletId ? WALLETS.find(x => x.id === walletId) : null;
  $("modalTitle").textContent = w ? "تعديل المحفظة" : "محفظة جديدة";
  $("mName").value = w ? w.name : "";
  $("mEmoji").value = w ? (w.emoji || "") : "";
  $("mBudget").value = w ? (w.budget || "") : "";
  $("mErr").textContent = "";
  $("mDeleteBtn").style.display = w ? "block" : "none"; // ما نعرض حذف لمحفظة جديدة
  $("mDeleteBtn").textContent = "حذف المحفظة"; delWalletArmed = false;
  $("walletModal").hidden = false;
}
function closeWalletModal() { $("walletModal").hidden = true; editingWalletId = null; }

$("addWalletBtn").onclick = () => openWalletModal(null);
$("mCancelBtn").onclick = closeWalletModal;

// ═══ تصفير العدّادات (عدّاد العمليات العلوي + عدّاد الصرف في المحافظ) ═══
// ما يمس سجل العمليات — التواريخ محفوظة للتقارير
async function loadCounters() {
  const snap = await getDoc(doc(db, "settings", "counters"));
  if (snap.exists()) {
    const d = snap.data();
    // إصلاح لمرة واحدة: خط الأساس القديم يُلغى عشان العدّاد يرجع يحسب كل العمليات
    if (!d.v2) {
      txBaseline = 0;
      await setDoc(doc(db, "settings", "counters"), { txBaseline: 0, v2: true });
    } else {
      txBaseline = d.txBaseline || 0;
    }
  }
  renderStrip();
}

let resetArmed = false, resetTimer = null;
$("resetCountersBtn").onclick = async () => {
  if (!resetArmed) {
    resetArmed = true;
    $("resetCountersBtn").textContent = "⚠️ اضغط مرة ثانية للتصفير";
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { resetArmed = false; $("resetCountersBtn").textContent = "صفّر عدّادات الصرف"; }, 4000);
    return;
  }
  clearTimeout(resetTimer); resetArmed = false;
  $("resetCountersBtn").disabled = true; $("resetCountersBtn").textContent = "…";
  try {
    // ١) صفّر عدّاد الصرف في كل محفظة (الأرصدة تبقى زي ما هي)
    const batch = writeBatch(db);
    WALLETS.forEach(w => batch.update(doc(db, "wallets", w.id), { spent: 0 }));
    await batch.commit();
    // ٢) صفّر العدّاد العلوي عبر تخزين خط الأساس = عدد العمليات الحالي
    txBaseline = TX.filter(t => t.status === "done").length;
    await setDoc(doc(db, "settings", "counters"), { txBaseline, v2: true, updatedAt: serverTimestamp() });
    renderStrip();
    $("resetCountersBtn").textContent = "تم التصفير ✓";
    setTimeout(() => { $("resetCountersBtn").textContent = "صفّر عدّادات الصرف"; }, 2500);
  } catch (e) {
    $("resetCountersBtn").textContent = "صار خطأ، حاول مرة ثانية";
    setTimeout(() => { $("resetCountersBtn").textContent = "صفّر عدّادات الصرف"; }, 2500);
  }
  $("resetCountersBtn").disabled = false;
};

$("mSaveBtn").onclick = async () => {
  const name = $("mName").value.trim();
  const emoji = $("mEmoji").value.trim();
  const budget = parseFloat($("mBudget").value);
  if (!name) { $("mErr").textContent = "اكتب اسم المحفظة"; return; }
  if (isNaN(budget) || budget < 0) { $("mErr").textContent = "اكتب مبلغ صحيح"; return; }
  $("mSaveBtn").disabled = true; $("mSaveBtn").textContent = "…";
  try {
    if (editingWalletId) {
      // تعديل: نحدّث الاسم/الرمز/الميزانية فقط (ما نلمس الرصيد الحالي)
      await updateDoc(doc(db, "wallets", editingWalletId), { name, emoji, budget });
    } else {
      // إضافة: محفظة جديدة، رصيدها = ميزانيتها، صرفها 0
      const order = WALLETS.length ? Math.max(...WALLETS.map(w => w.order || 0)) + 1 : 0;
      await addDoc(collection(db, "wallets"), {
        name, emoji, budget, balance: budget, spent: 0, order, pct: 0
      });
    }
    closeWalletModal();
  } catch (e) {
    $("mErr").textContent = "صار خطأ، حاول مرة ثانية";
  }
  $("mSaveBtn").disabled = false; $("mSaveBtn").textContent = "حفظ";
};

let delWalletArmed = false, delWalletTimer = null;
$("mDeleteBtn").onclick = async () => {
  if (!editingWalletId) return;
  if (!delWalletArmed) {
    delWalletArmed = true;
    $("mDeleteBtn").textContent = "⚠️ اضغط مرة ثانية للحذف نهائياً";
    clearTimeout(delWalletTimer);
    delWalletTimer = setTimeout(() => { delWalletArmed = false; $("mDeleteBtn").textContent = "حذف المحفظة"; }, 4000);
    return;
  }
  clearTimeout(delWalletTimer); delWalletArmed = false;
  await deleteDoc(doc(db, "wallets", editingWalletId));
  closeWalletModal();
};

// ═══════════════════════════════════════════
// ═══ الخاصية ٢: توزيع الراتب بالنسب (تحكّم يدوي كامل) ═══
// ═══════════════════════════════════════════
// النِسب والمبلغ يُحفظون في settings/split
let splitPct = {};   // { walletId: نسبة } — محسوبة، تُحفظ للجسر
let splitAmt = {};   // { walletId: مبلغ }
let splitSalary = 0;

async function loadSplit() {
  const snap = await getDoc(doc(db, "settings", "split"));
  if (snap.exists()) {
    const d = snap.data();
    splitPct = d.pct || {};
    splitSalary = d.salary || 0;
    splitAmt = d.amt || {};
  }
}

const round1 = v => Math.round(v * 10) / 10;
const round2 = v => Math.round(v * 100) / 100;

function renderSplit() {
  if (!WALLETS.length) { $("splitList").innerHTML = `<div class="empty">أضف محافظ أول</div>`; return; }

  const ids = WALLETS.map(w => w.id);
  // تهيئة: لو عندنا مبالغ محفوظة استخدمها، وإلا من النسب × الراتب، وإلا صفر
  ids.forEach(id => {
    if (splitAmt[id] === undefined) {
      splitAmt[id] = splitSalary && splitPct[id] ? round2(splitSalary * splitPct[id] / 100) : 0;
    }
  });
  Object.keys(splitAmt).forEach(id => { if (!ids.includes(id)) delete splitAmt[id]; });
  Object.keys(splitPct).forEach(id => { if (!ids.includes(id)) delete splitPct[id]; });

  // الراتب = المحفوظ أو مجموع المبالغ
  if (!splitSalary) splitSalary = sumAmts();
  $("salaryInput").value = splitSalary || "";

  $("splitList").innerHTML = WALLETS.map(w => {
    const amt = round2(splitAmt[w.id] || 0);
    const pct = splitSalary ? round1((amt / splitSalary) * 100) : 0;
    return `<div class="split-row">
      <div class="top"><span class="name">${w.emoji || ""} ${esc(w.name)}</span></div>
      <div class="io">
        <span class="io-box"><input class="amt-input num" id="amtin-${w.id}" type="number" inputmode="decimal"
               step="0.01" value="${amt || ""}" placeholder="0" data-amtin="${w.id}"><label>ريال</label></span>
        <span class="io-box"><input class="pct-input num" id="pctin-${w.id}" type="number" inputmode="decimal"
               step="0.1" value="${pct || ""}" placeholder="0" data-pctin="${w.id}"><label>%</label></span>
      </div>
      <input type="range" min="0" max="100" step="0.5" value="${pct}" data-slider="${w.id}">
    </div>`;
  }).join("");

  // كتابة مبلغ → المجموع يصير الراتب، والنسب تتحدّث
  $("splitList").querySelectorAll("[data-amtin]").forEach(inp => {
    inp.oninput = () => {
      const id = inp.dataset.amtin;
      splitAmt[id] = parseFloat(inp.value) || 0;
      splitSalary = sumAmts();
      $("salaryInput").value = round2(splitSalary) || "";
      refreshRowsExcept("amt", id);
      recalcSplit();
    };
  });

  // كتابة نسبة → مبلغها = نسبة × الراتب (الراتب ثابت)
  $("splitList").querySelectorAll("[data-pctin]").forEach(inp => {
    inp.oninput = () => {
      const id = inp.dataset.pctin;
      const pct = Math.max(0, Math.min(100, parseFloat(inp.value) || 0));
      splitAmt[id] = round2((splitSalary * pct) / 100);
      refreshRowsExcept("pct", id);
      recalcSplit();
    };
  });

  // تحريك البار = نسبة المحفظة من الراتب → يحدّث مبلغها
  $("splitList").querySelectorAll("[data-slider]").forEach(s => {
    s.oninput = () => {
      const id = s.dataset.slider;
      const pct = parseFloat(s.value) || 0;
      splitAmt[id] = round2((splitSalary * pct) / 100);
      refreshRowsExcept("slider", id);
      recalcSplit();
    };
  });

  recalcSplit();
}

const sumAmts = () => WALLETS.reduce((s, w) => s + (splitAmt[w.id] || 0), 0);

// حدّث كل صف (مبلغ + نسبة + بار)، ماعدا الحقل اللي المستخدم يكتب فيه
function refreshRowsExcept(source, skipId) {
  WALLETS.forEach(w => {
    const amt = splitAmt[w.id] || 0;
    const pct = splitSalary ? (amt / splitSalary) * 100 : 0;
    const ai = document.querySelector(`[data-amtin="${w.id}"]`);
    const pi = document.querySelector(`[data-pctin="${w.id}"]`);
    const sl = document.querySelector(`[data-slider="${w.id}"]`);
    if (ai && !(source === "amt" && w.id === skipId)) ai.value = round2(amt) || "";
    if (pi && !(source === "pct" && w.id === skipId)) pi.value = round1(pct) || "";
    if (sl && !(source === "slider" && w.id === skipId)) sl.value = pct;
  });
}

// كتابة الراتب فوق → وزّعه على المحافظ حسب النسب الحالية
$("salaryInput").addEventListener("input", () => {
  const newSalary = parseFloat($("salaryInput").value) || 0;
  const oldTotal = sumAmts();
  if (oldTotal > 0) {
    WALLETS.forEach(w => {
      const frac = (splitAmt[w.id] || 0) / oldTotal;
      splitAmt[w.id] = round2(newSalary * frac);
    });
  }
  splitSalary = newSalary;
  refreshRowsExcept("salary", null);
  recalcSplit();
});

function recalcSplit() {
  const total = sumAmts();
  // خزّن النسب (الجسر) من المبالغ الحالية
  WALLETS.forEach(w => { splitPct[w.id] = total ? ((splitAmt[w.id] || 0) / total) * 100 : 0; });

  $("splitAllocated").textContent = money(total);
  const totalPct = WALLETS.reduce((s, w) => s + (splitPct[w.id] || 0), 0);
  $("splitRemain").textContent = round1(totalPct) + "%";

  const box = document.querySelector(".split-total");
  if (box) { box.classList.remove("warn", "bad"); box.classList.add("ok"); }
}

// دالة مشتركة: تحديث الميزانيات + حفظ. ترجّع الراتب لو نجحت، أو null.
async function applySplitCore() {
  const total = sumAmts();
  if (!total || total <= 0) { $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "عبّي مبالغ المحافظ أو اكتب الراتب أول"; return null; }

  const batch = writeBatch(db);
  WALLETS.forEach(w => {
    const newBudget = round2(splitAmt[w.id] || 0);
    batch.update(doc(db, "wallets", w.id), { budget: newBudget, pct: splitPct[w.id] || 0 });
  });
  await batch.commit();
  splitSalary = total;
  await setDoc(doc(db, "settings", "split"), { pct: splitPct, amt: splitAmt, salary: total, updatedAt: serverTimestamp() });
  return total;
}

// زر التوزيع: يحدّث الميزانيات ويعبّي الأرصدة فقط — لا يصفّر عدّاد الصرف (منفصل)
let refillArmed = false;
let refillTimer = null;
$("applyRefillBtn").onclick = async () => {
  // تحقّق: لازم يكون فيه مبالغ (أو راتب موزّع)
  if (sumAmts() <= 0) {
    $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "عبّي مبالغ المحافظ أو اكتب الراتب أول";
    return;
  }
  // الضغطة الأولى: تسليح + تحذير
  if (!refillArmed) {
    refillArmed = true;
    $("applyRefillBtn").textContent = "⚠️ اضغط مرة ثانية للتأكيد";
    $("applyRefillBtn").style.background = "var(--gold)";
    $("splitMsg").style.color = "var(--muted)";
    $("splitMsg").textContent = "بيحدّث ميزانيات المحافظ ويعبّي الأرصدة (ما يمس عدّاد الصرف)";
    clearTimeout(refillTimer);
    refillTimer = setTimeout(() => {
      refillArmed = false;
      $("applyRefillBtn").textContent = "طبّق التوزيع وحدّث المحافظ";
      $("applyRefillBtn").style.background = "";
      $("splitMsg").textContent = "";
    }, 4000);
    return;
  }
  // الضغطة الثانية: نفّذ
  clearTimeout(refillTimer);
  refillArmed = false;
  $("applyRefillBtn").style.background = "";
  $("applyRefillBtn").disabled = true; $("applyRefillBtn").textContent = "…";
  try {
    const salary = await applySplitCore();
    if (salary !== null) {
      const batch = writeBatch(db);
      WALLETS.forEach(w => {
        const newBudget = Math.round((salary * (splitPct[w.id] || 0)) / 100 * 100) / 100;
        // نحدّث الميزانية ونعبّي الرصيد — بدون ما نلمس spent (عدّاد الصرف منفصل)
        batch.update(doc(db, "wallets", w.id), { balance: newBudget });
      });
      await batch.commit();
      $("splitMsg").style.color = "var(--teal)";
      $("splitMsg").textContent = "تم ✓ — المحافظ اتحدّثت بالتوزيع الجديد";
      setTimeout(() => { $("splitMsg").textContent = ""; }, 4500);
    }
  } catch (e) {
    $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "صار خطأ: " + (e?.message || e);
  }
  $("applyRefillBtn").disabled = false; $("applyRefillBtn").textContent = "طبّق التوزيع وحدّث المحافظ";
};

// ═══ helpers ═══
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function fmt(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }) + " · " +
         d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
