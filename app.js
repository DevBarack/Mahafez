import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDocs, getDoc, setDoc, addDoc,
  updateDoc, deleteDoc, query, where, orderBy, limit, onSnapshot,
  serverTimestamp, increment, writeBatch, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, AUTH_EMAIL } from "./firebase-config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);
const $ = id => document.getElementById(id);
const money = n => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
// نسخة العرض: الرقم متبوع بـ"ر.س" (تُستخدم في العرض فقط، مو في خانات الإدخال)
const sar = n => `${money(n)} ر.س`;

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
    renderWallets(); renderReview(); fillPickers(); renderReportAll();
  }));
  unsub.push(onSnapshot(query(collection(db, "transactions"), orderBy("createdAt", "desc"), limit(1000)), snap => {
    TX = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderReview(); renderUnparsed(); renderTx(); renderWallets(); renderReportAll(); renderStrip();
    autoSort();
  }));
}

// ═══ PARSE raw SMS text → amount + merchant + card ═══
// الشورت كت يرسل النص الخام، والتطبيق يقسّمه هنا
function parseSMS(raw) {
  if (!raw) return null;
  // تعقيم: شِل رموز الاتجاه المخفية (RTL/LTR marks) اللي يحشرها iOS في الرسائل المخلوطة
  raw = raw.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\u00a0/g, " ");

  // ═ صفر) استرجاع/إلغاء = فلوس راجعة، مو مصروف → نتجاهلها (skip)
  if (/استرجاع|استرداد|عكس عملية|إلغاء عملية/.test(raw)) return { skip: true };

  let amount = null, merchant = null;

  // ═ ٠.٥) إنماء الصيغة الجديدة: "شراء POS-ApplePay بـ SAR 66.00 بطاقة ائتمانية *7497 لدى Fastel Fue/SA في ..."
  // المبلغ بعد "بـ SAR" والمتجر بعد "لدى" وينتهي بـ"/SA" أو "في"
  // ═ ٠.٥) إنماء الحديثة — استخراج بالحذف: شِل التاريخ/الوقت ثم الرصيد ثم البطاقة؛ الباقي هو المبلغ (أي ترتيب)
  if (!/بمبلغ/.test(raw)) {
    let t = raw
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")                              // الوقت
      .replace(/\d{2,4}-\d{1,2}-\d{2,4}/g, " ")                               // التاريخ
      .replace(/[\d,]+(?:\.\d{1,2})?\s*(?:ال)?رصيد/g, " ")                    // "16,732.48 رصيد"
      .replace(/(?:ال)?رصيد\s*:?\s*(?:SAR\s*)?[\d,]+(?:\.\d{1,2})?/g, " ")  // "الرصيد: 16,732.48"
      .replace(/\*+\s*\d{4}|\d{4}\s*\*+/g, " ");                            // رقم البطاقة
    const aM = t.match(/([\d,]+\.\d{1,2})/) || t.match(/(?:^|[^\d,.])([1-9]\d{0,5})(?![\d,.])/);
    const mM = t.match(/لدى[:\s]+([\s\S]+?)(?:\s+في(?=[:\s]|$)|\s*$)/);
    if (aM && mM) {
      amount = parseFloat(aM[1].replace(/,/g, ""));
      merchant = mM[1].replace(/\s+/g, " ").trim()
        .replace(/\*+$/, "").replace(/^\*+/, "")
        .replace(/^SA\s*\/\s*/i, "").replace(/\s*\/\s*SA\b\s*$/i, "").trim();
      const cardN = raw.match(/\*+(\d{4})/) || raw.match(/(\d{4})\*+/);
      const card = cardN ? (cardN[1] === "7497" ? "visa" : "mada") : "";
      if (amount && merchant && merchant.length > 1) return { amount, merchant, card };
    }
  }

  // ═ ١) ساب (SAB): "لدى MERCHANT بمبلغ CUR X.XX" — للدولي ناخذ الإجمالي بالريال (شامل الرسوم)
  const sabM = raw.match(/لدى\s+([^\n]+?)\s+بمبلغ\s+([A-Z]{3})\s*([\d,]+(?:\.\d{1,2})?)/);
  if (sabM) {
    merchant = sabM[1].trim();
    const cur = sabM[2];
    if (cur === "SAR") {
      amount = parseFloat(sabM[3].replace(/,/g, ""));
    } else {
      // عملة أجنبية → الإجمالي بالريال (مع الرسوم الدولية)، وإلا المبلغ بالريال
      const totM = raw.match(/المبلغ الإجمالي بالريال[:\s]*([\d,]+(?:\.\d{1,2})?)/) ||
                   raw.match(/المبلغ بالريال[:\s]*([\d,]+(?:\.\d{1,2})?)/);
      if (totM) amount = parseFloat(totM[1].replace(/,/g, ""));
    }
    // بطاقة ساب (مثلاً 2143) — نصنّفها ائتمانية
    const sabCard = raw.match(/\((\d{4})\)/);
    if (amount && merchant) return { amount, merchant, card: sabCard ? "sab-" + sabCard[1] : "sab" };
  }

  // ═ ٢) إنماء - صيغة "شراء عبر: POS ... مبلغ: SAR X لدى: MERCHANT في: ..."
  const posM = raw.match(/مبلغ[:\s]*SAR\s*([\d,]+(?:\.\d{1,2})?)[\s\S]*?لدى[:\s]+([^\n]+?)(?:\s+في[:\s]|\n|$)/);
  if (posM) {
    amount = parseFloat(posM[1].replace(/,/g, ""));
    merchant = posM[2].trim().replace(/\s*-\s*SA$/, "");
    const cardM0 = raw.match(/(\d{4})\*{0,2}(?:\s|$)/) || raw.match(/\*{1,2}(\d{4})/);
    const card = cardM0 ? (cardM0[1] === "7497" ? "visa" : "mada") : "";
    if (amount && merchant) return { amount, merchant, card };
  }

  // ═ ٣) الصيغ القديمة (مدى نقاط بيع / ائتمانية POS بـ"من")
  const amtM = raw.match(/SAR\s*([\d,]+(?:\.\d{1,2})?)/) ||
               raw.match(/([\d,]+(?:\.\d{1,2})?)\s*SAR/) ||
               raw.match(/مبلغ\s*([\d,]+(?:\.\d{1,2})?)/) ||
               raw.match(/بيع\s*([\d,]+(?:\.\d{1,2})?)/);
  const merM = raw.match(/من\s+(?!حساب)([^\n]+?)(?:\s+في|\s+-\s+SA|\n|$)/);
  const cardM = raw.match(/بطاقة[^\d]*(\d{4})/);
  amount = amtM ? parseFloat(amtM[1].replace(/,/g, "")) : null;
  merchant = merM ? merM[1].trim() : null;
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
    if (parsed?.skip) {
      // استرجاع/إلغاء — مو مصروف، نحذفها من السجل
      await deleteDoc(doc(db, "transactions", t.id));
    } else if (parsed) {
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
let txBaseline = 0; // (قديم) عدد العمليات وقت آخر تصفير — للتوافق الرجعي
let cycleStart = null; // (جديد) تاريخ بداية الدورة الحالية — له الأولوية لو موجود

// عمليات الدورة الحالية: بالتاريخ لو فيه cycleStart، وإلا بالعدّاد القديم
function inCurrentCycle(doneTx) {
  if (cycleStart) {
    return doneTx.filter(t => {
      const d = t.createdAt?.toDate ? t.createdAt.toDate() : null;
      return d && d >= cycleStart;
    });
  }
  return txBaseline > 0 ? doneTx.slice(0, Math.max(0, doneTx.length - txBaseline)) : doneTx;
}

function renderStrip() {
  // العمليات المكتملة بعد آخر تصفير
  const doneTx = TX.filter(t => t.status === "done");
  const afterReset = inCurrentCycle(doneTx);
  const spent = afterReset.reduce((s, t) => s + (t.amount || 0), 0);
  // مبلغ الشهر الثابت = الراتب المحفوظ في التوزيع (أو مجموع الحدود لو ما فيه راتب)
  const salary = splitSalary || WALLETS.reduce((s, w) => s + (w.budget || 0), 0);
  const remaining = salary - spent; // المتبقي من المبلغ الأساسي
  $("sSalary").textContent = money(salary);
  $("sSalarySub").textContent = `من ${sar(salary)}`;
  countUpTo($("sTotal"), remaining);
  $("sSpent").textContent = money(spent);
  $("sCount").textContent = afterReset.length;
}

function renderWallets() {
  const el = $("wallets");
  if (!WALLETS.length) { el.innerHTML = `<div class="empty">ما فيه محافظ بعد — أضف وحدة بالزر تحت</div>`; return; }
  const spentMap = spentByWalletFromTx(); // نفس مصدر التقرير والشريط العلوي
  el.innerHTML = WALLETS.map(w => {
    const bud = w.budget || 1;
    const spent = spentMap[w.id] || 0;
    // الرصيد يُحسب دايماً = الحد − الصرف الفعلي (مصدر حقيقة واحد، ما ينحرف أبداً)
    const bal = round2((w.budget || 0) - spent);
    // البار = المتبقي من الحد حسب الصرف الفعلي (يبدأ 100% وينقص مع الصرف)
    const remainPct = Math.max(0, Math.min(100, (1 - spent / bud) * 100));
    const overBudget = spent > bud;
    const nearLimit = !overBudget && remainPct < 25;
    const cls = overBudget ? "over" : nearLimit ? "low" : "";
    const color = overBudget ? "var(--red)" : nearLimit ? "var(--gold)" : "var(--teal)";
    // لو تجاوز الحد، نملأ البار كامل بالأحمر
    const fillPct = overBudget ? 100 : remainPct;
    return `<div class="env tap ${cls}" data-edit="${w.id}" style="color:${color}">
      <div class="fill" style="inline-size:${fillPct}%"></div>
      <div class="top">
        <span class="name">${w.emoji || ""} ${esc(w.name)}${overBudget ? '<span class="badge">تجاوز</span>' : ''}</span>
        <span class="bal num">${sar(bal)}</span>
      </div>
      <div class="sub"><span class="num">من ${money(bud)}</span><span class="num">صُرف ${sar(spent)}</span></div>
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
        <span class="amt num">${sar(t.amount)}</span>
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
  // لو المستخدم يكتب في خانة اسم، لا تعيد الرسم الحين (حماية كتابته من الضياع)
  const active = document.activeElement;
  if (active && active.dataset && active.dataset.mname) return;
  const filterW = $("txFilter") ? $("txFilter").value : "";
  const done = TX.filter(t => t.status === "done" && (!filterW || t.wallet === filterW));
  // سطر ملخص عند التصفية: العدد والمجموع
  let summary = "";
  if (filterW && done.length) {
    const tot = done.reduce((s, t) => s + (t.amount || 0), 0);
    summary = `<div class="filter-sum num">${done.length} عملية · المجموع ${sar(tot)}</div>`;
  }
  $("txList").innerHTML = done.length ? summary + done.map(t => `
    <div class="tx">
      <div class="l">
        <input class="m m-edit num-off" data-mname="${t.id}" value="${esc(t.merchant || "")}" placeholder="اسم العملية" />
        <select class="tx-wallet" data-reassign="${t.id}">
          ${WALLETS.map(w => `<option value="${w.id}" ${w.id === t.wallet ? "selected" : ""}>${w.emoji || ""} ${esc(w.name)}</option>`).join("")}
        </select>
      </div>
      <div class="r"><div class="a num">${sar(t.amount)}</div><div class="d num">${fmt(t.createdAt)}</div></div>
      <div class="acts">
        <button class="undo" data-undo="${t.id}">تراجع</button>
        <button class="del" data-del="${t.id}">حذف</button>
      </div>
    </div>`).join("") : `<div class="empty">${filterW ? "ما فيه عمليات في هذي المحفظة" : "ما فيه عمليات بعد"}</div>`;
  // تعديل اسم العملية: يحفظ عند الخروج من الخانة أو Enter
  $("txList").querySelectorAll("[data-mname]").forEach(inp => {
    const save = async () => {
      const tx = TX.find(t => t.id === inp.dataset.mname);
      const newName = inp.value.trim();
      if (!tx || newName === (tx.merchant || "") || !newName) { inp.value = tx?.merchant || ""; return; }
      await updateDoc(doc(db, "transactions", tx.id), { merchant: newName });
    };
    inp.onblur = save;
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } };
  });
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
  const afterReset = inCurrentCycle(doneTx);
  const map = {}; // walletId -> مجموع
  afterReset.forEach(t => { if (t.wallet) map[t.wallet] = (map[t.wallet] || 0) + (t.amount || 0); });
  return map;
}

// ═══ التقرير: الفترة بنطاق يومي (من/إلى) — فاضية = الفترة الحالية ═══
let repFrom = null, repTo = null; // Date أو null

// عمليات الفترة المختارة
function txForPeriod() {
  const doneTx = TX.filter(t => t.status === "done");
  if (!repFrom && !repTo) {
    // الفترة الحالية (منذ آخر تصفير)
    return inCurrentCycle(doneTx);
  }
  const from = repFrom ? new Date(repFrom.getFullYear(), repFrom.getMonth(), repFrom.getDate(), 0, 0, 0) : null;
  const to = repTo ? new Date(repTo.getFullYear(), repTo.getMonth(), repTo.getDate(), 23, 59, 59) : null;
  return doneTx.filter(t => {
    const d = t.createdAt?.toDate ? t.createdAt.toDate() : null;
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });
}

// ربط حقول التاريخ والاختصارات
function setChip(id) {
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("on"));
  if (id) $(id)?.classList.add("on");
}
function syncDateInputs() {
  const f = (d) => (d && d.getFullYear() > 2000) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "";
  if ($("repFrom")) $("repFrom").value = f(repFrom);
  if ($("repTo")) $("repTo").value = f(repTo);
}
if ($("repFrom")) $("repFrom").oninput = () => { repFrom = $("repFrom").value ? new Date($("repFrom").value + "T12:00:00") : null; setChip(null); renderReportAll(); };
if ($("repTo")) $("repTo").oninput = () => { repTo = $("repTo").value ? new Date($("repTo").value + "T12:00:00") : null; setChip(null); renderReportAll(); };
if ($("chipCurrent")) $("chipCurrent").onclick = () => { repFrom = repTo = null; syncDateInputs(); setChip("chipCurrent"); renderReportAll(); };
if ($("chipMonth")) $("chipMonth").onclick = () => {
  const now = new Date();
  repFrom = new Date(now.getFullYear(), now.getMonth(), 1); repTo = now;
  syncDateInputs(); setChip("chipMonth"); renderReportAll();
};
if ($("chipAll")) $("chipAll").onclick = () => {
  repFrom = new Date(2000, 0, 1); repTo = null; // كل التاريخ
  syncDateInputs(); setChip("chipAll"); renderReportAll();
};
if ($("chip7")) $("chip7").onclick = () => {
  const now = new Date();
  repFrom = new Date(now.getTime() - 6 * 86400000); repTo = now;
  syncDateInputs(); setChip("chip7"); renderReportAll();
};

// ═══ تصدير CSV للفترة المحددة (بدون مكتبات — نص خالص مع BOM للعربي) ═══
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmtDateISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

if ($("exportCsvBtn")) $("exportCsvBtn").onclick = () => {
  const tx = txForPeriod();
  if (!tx.length) { $("csvMsg").style.color = "var(--red)"; $("csvMsg").textContent = "ما فيه عمليات في هذه الفترة"; return; }
  const rows = [["التاريخ", "المتجر", "المبلغ", "المحفظة"]];
  tx.forEach(t => {
    const d = t.createdAt?.toDate ? t.createdAt.toDate() : null;
    const w = WALLETS.find(x => x.id === t.wallet);
    rows.push([d ? fmtDateISO(d) : "", t.merchant || "", t.amount || 0, w ? w.name : (t.walletName || "")]);
  });
  rows.push([]); rows.push(["— ملخص المحافظ —"]); rows.push(["المحفظة", "الصرف", "عدد العمليات"]);
  const byW = {};
  tx.forEach(t => { const k = t.wallet; if (!byW[k]) byW[k] = { total: 0, n: 0 }; byW[k].total += t.amount || 0; byW[k].n++; });
  Object.entries(byW).sort((a, b) => b[1].total - a[1].total).forEach(([id, d]) => {
    const w = WALLETS.find(x => x.id === id);
    rows.push([w ? w.name : "غير مصنّفة", Math.round(d.total * 100) / 100, d.n]);
  });
  rows.push([]); rows.push(["— أكثر المتاجر —"]); rows.push(["المتجر", "الصرف", "عدد العمليات"]);
  const byM = {};
  tx.forEach(t => { const k = (t.merchant || "؟").trim(); if (!byM[k]) byM[k] = { total: 0, n: 0 }; byM[k].total += t.amount || 0; byM[k].n++; });
  Object.entries(byM).sort((a, b) => b[1].total - a[1].total).forEach(([name, d]) => {
    rows.push([name, Math.round(d.total * 100) / 100, d.n]);
  });
  const total = tx.reduce((s, t) => s + (t.amount || 0), 0);
  rows.push([]); rows.push(["الإجمالي", Math.round(total * 100) / 100, tx.length + " عملية"]);

  const csv = "\ufeff" + rows.map(r => r.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const tag = repFrom || repTo ? `${repFrom ? fmtDateISO(repFrom) : "بداية"}_${repTo ? fmtDateISO(repTo) : "اليوم"}` : "الفترة-الحالية";
  a.download = `محافظي-${tag}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  $("csvMsg").style.color = "var(--teal)"; $("csvMsg").textContent = `نزّلت ${tx.length} عملية ✓`;
  setTimeout(() => { $("csvMsg").textContent = ""; }, 3000);
};

// ═══ حفظ التقرير PDF (بالرسومات) — طباعة النظام ═══
if ($("printBtn")) $("printBtn").onclick = () => window.print();

// ═══ استيراد CSV: معاينة ثم إضافة ═══
let csvPending = [];
if ($("csvFile")) $("csvFile").onchange = async () => {
  $("csvMsg").textContent = ""; $("csvImportBtn").hidden = true; csvPending = [];
  const file = $("csvFile").files[0];
  if (!file) return;
  const text = (await file.text()).replace(/^\ufeff/, "");
  const first = text.split("\n")[0];
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : ",";
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  let ok = 0, bad = [];
  lines.forEach((line, i) => {
    const cells = line.split(delim).map(c => c.trim().replace(/^"|"$/g, ""));
    if (cells.length < 4) { if (line.trim()) bad.push(i + 1); return; }
    const [dateS, merch, amtS, wName] = cells;
    if (/تاريخ|date/i.test(dateS)) return; // سطر العناوين
    let d = null;
    let m1 = dateS.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let m2 = dateS.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m1) d = new Date(+m1[1], +m1[2] - 1, +m1[3], 12);
    else if (m2) d = new Date(+m2[3], +m2[2] - 1, +m2[1], 12);
    // ارفض التواريخ المتدحرجة (يوم 99 يصير شهر ثاني) والمستقبلية
    if (d) {
      const [yy, mm, dd] = m1 ? [+m1[1], +m1[2], +m1[3]] : [+m2[3], +m2[2], +m2[1]];
      if (d.getFullYear() !== yy || d.getMonth() + 1 !== mm || d.getDate() !== dd || d > new Date()) d = null;
    }
    const amt = parseFloat(String(amtS).replace(/,/g, ""));
    const w = WALLETS.find(x => norm(x.name) === norm(wName) || norm(`${x.emoji} ${x.name}`) === norm(wName));
    if (!d || isNaN(d) || !amt || amt <= 0 || !merch || !w) { bad.push(i + 1); return; }
    csvPending.push({ amount: amt, merchant: merch, wallet: w.id, walletName: w.name, date: d });
    ok++;
  });
  if (!ok) {
    $("csvMsg").style.color = "var(--red)";
    $("csvMsg").textContent = "ما قدرت أقرأ أي سطر — تأكد من الأعمدة: التاريخ، المتجر، المبلغ، المحفظة (بنفس أسماء محافظك)";
    return;
  }
  $("csvMsg").style.color = "var(--teal)";
  $("csvMsg").textContent = `جاهز: ${ok} عملية` + (bad.length ? ` — تجاهلت ${bad.length} سطر (${bad.slice(0, 5).join("،")}${bad.length > 5 ? "…" : ""})` : "");
  $("csvImportBtn").hidden = false;
  $("csvImportBtn").textContent = `أضف ${ok} عملية`;
};

if ($("csvImportBtn")) $("csvImportBtn").onclick = async () => {
  if (!csvPending.length) return;
  $("csvImportBtn").disabled = true; $("csvImportBtn").textContent = "…";
  try {
    // Firestore batch حده 500 — نقسّم لو أكثر
    for (let i = 0; i < csvPending.length; i += 450) {
      const batch = writeBatch(db);
      csvPending.slice(i, i + 450).forEach(p => {
        const ref = doc(collection(db, "transactions"));
        batch.set(ref, {
          amount: p.amount, merchant: p.merchant, wallet: p.wallet, walletName: p.walletName,
          status: "done", source: "csv", createdAt: Timestamp.fromDate(p.date)
        });
      });
      await batch.commit();
    }
    $("csvMsg").style.color = "var(--teal)"; $("csvMsg").textContent = `أضفت ${csvPending.length} عملية ✓`;
    csvPending = []; $("csvFile").value = ""; $("csvImportBtn").hidden = true;
  } catch (e) {
    $("csvMsg").style.color = "var(--red)"; $("csvMsg").textContent = "صار خطأ: " + (e?.message || e);
  }
  $("csvImportBtn").disabled = false;
};

// صرف كل محفظة ضمن الفترة المختارة
function spentByWalletForPeriod() {
  const map = {};
  txForPeriod().forEach(t => { if (t.wallet) map[t.wallet] = (map[t.wallet] || 0) + (t.amount || 0); });
  return map;
}

// ═══ ترند الصرف عبر الأشهر — أعمدة SVG من كامل السجل ═══
function renderTrendChart() {
  const host = $("trendChart");
  if (!host) return;
  // جمّع الصرف حسب الشهر من كل العمليات المكتملة
  const byMonth = {};
  TX.filter(t => t.status === "done").forEach(t => {
    const d = t.createdAt?.toDate ? t.createdAt.toDate() : null;
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    byMonth[key] = (byMonth[key] || 0) + (t.amount || 0);
  });
  const months = Object.keys(byMonth).sort(); // الأقدم → الأحدث
  if (months.length < 1) { host.innerHTML = `<div class="empty">ما فيه بيانات بعد</div>`; return; }

  const labelOf = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("ar-SA-u-ca-gregory", { month: "short" });
  };
  const max = Math.max(...months.map(k => byMonth[k]), 1);

  const W = 340, H = 190, padB = 34, padT = 26;
  const n = months.length;
  const gap = 14;
  const barW = Math.min(56, (W - gap * (n + 1)) / n);
  const chartH = H - padB - padT;

  let bars = "";
  months.forEach((k, i) => {
    const v = byMonth[k];
    const h = Math.max(4, (v / max) * chartH);
    const x = gap + i * (barW + gap);
    const y = H - padB - h;
    const isLast = i === n - 1; // الشهر الأحدث مميّز
    bars += `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="7"
        fill="${isLast ? "#2fa98a" : "#1e5c4c"}"/>
      <text x="${x + barW / 2}" y="${y - 8}" text-anchor="middle" fill="#8fa9a1"
        style="font:600 11px 'IBM Plex Sans Arabic',sans-serif">${money(v)}</text>
      <text x="${x + barW / 2}" y="${H - padB + 18}" text-anchor="middle" fill="#5e7a72"
        style="font:500 11px 'IBM Plex Sans Arabic',sans-serif">${labelOf(k)}</text>`;
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:210px">
    <line x1="0" y1="${H - padB}" x2="${W}" y2="${H - padB}" stroke="#22463f" stroke-width="1"/>
    ${bars}
  </svg>`;
}

// ═══ الأكثر صرفاً (للفترة المختارة) — مستويين: متاجر أو محافظ ═══
let topScale = "merchants"; // "merchants" أو "wallets"

function renderTopMerchants() {
  const host = $("topMerchants");
  if (!host) return;
  const byKey = {};
  txForPeriod().forEach(t => {
    let key, emoji = "";
    if (topScale === "wallets") {
      const w = WALLETS.find(x => x.id === t.wallet);
      key = w ? w.name : (t.walletName || "غير مصنّفة");
      emoji = w?.emoji || "";
    } else {
      key = (t.merchant || "غير معروف").trim();
    }
    if (!byKey[key]) byKey[key] = { total: 0, count: 0, emoji };
    byKey[key].total += t.amount || 0;
    byKey[key].count++;
  });
  const sorted = Object.entries(byKey).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
  if (!sorted.length) { host.innerHTML = `<div class="empty">ما فيه عمليات في هذه الفترة</div>`; return; }
  const max = sorted[0][1].total || 1;
  host.innerHTML = sorted.map(([name, d], i) => `
    <div class="merch">
      <div class="l"><span class="rank num">${i + 1}</span><span class="mname">${d.emoji ? d.emoji + " " : ""}${esc(name)}</span></div>
      <div class="r"><span class="mtotal num">${sar(d.total)}</span><span class="mcount num">${d.count} عملية</span></div>
      <div class="mbar"><i style="width:${(d.total / max) * 100}%"></i></div>
    </div>`).join("");
}

// مفتاح التبديل بين المستويين
document.querySelectorAll("#topScale button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("#topScale button").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    topScale = b.dataset.scale;
    renderTopMerchants();
  };
});

// إحصائيات الفترة (إجمالي + عدد)
function renderRepStats() {
  const tx = txForPeriod();
  const total = tx.reduce((s, t) => s + (t.amount || 0), 0);
  if ($("repTotal")) $("repTotal").textContent = sar(total);
  if ($("repCount")) $("repCount").textContent = tx.length;
}

// يجدّد كل أقسام التقرير معاً
function renderReportAll() {
  renderRepStats();
  renderWalletChart();
  renderTrendChart();
  renderTopMerchants();
  renderReport();
}

function renderReport() {
  const spentMap = spentByWalletForPeriod();
  const max = Math.max(...WALLETS.map(w => spentMap[w.id] || 0), 1);
  const sorted = [...WALLETS]
    .map(w => ({ ...w, _spent: spentMap[w.id] || 0 }))
    .sort((a, b) => b._spent - a._spent)
    .filter(w => w._spent > 0);
  $("report").innerHTML = sorted.length ? sorted.map(w => {
    const s = w._spent, bud = w.budget || 1;
    const over = s > bud;
    return `<div class="rep">
      <div class="l"><span>${w.emoji || ""} ${w.name}</span><span class="num" style="color:${over ? "var(--red)" : "var(--muted)"}">${money(s)} / ${sar(bud)}</span></div>
      <div class="bar"><div style="width:${Math.min(100, (s / max) * 100)}%;background:${over ? "var(--red)" : "var(--teal)"}"></div></div>
    </div>`;
  }).join("") : `<div class="empty">ما صرفت شي بعد هذا الشهر</div>`;
}

// ═══ القسم ٢: رسم دائري (Donut) بـSVG خام — بدون أي مكتبة خارجية ═══
const CHART_COLORS = ["#2fa98a", "#d4af37", "#7aa6d4", "#d9645a", "#5ec9a7", "#c99b3a", "#9b8ade", "#e08a7f"];

function renderWalletChart() {
  const host = $("walletChart");
  if (!host) return;

  // البيانات من الفترة المختارة في التقرير
  const spentMap = spentByWalletForPeriod();
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
      <span class="lg-val num">${sar(val)} · ${pct}%</span>
    </div>`;
  });

  host.innerHTML = `
    <svg viewBox="0 0 260 220" width="100%" style="max-height:230px">
      ${segments}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#eaf3f0"
        style="font:700 22px 'IBM Plex Sans Arabic',sans-serif">${sar(totalSpent)}</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="#8fa9a1"
        style="font:500 11px 'IBM Plex Sans Arabic',sans-serif">إجمالي الصرف</text>
    </svg>
    <div class="chart-legend">${legend}</div>`;
}

function fillPickers() {
  $("aWallet").innerHTML = WALLETS.map(w => `<option value="${w.id}">${w.emoji || ""} ${w.name}</option>`).join("");
  // فلتر العمليات: عبّي الخيارات مع الحفاظ على الاختيار الحالي
  if ($("txFilter")) {
    const cur = $("txFilter").value;
    $("txFilter").innerHTML = `<option value="">📂 كل المحافظ</option>` +
      WALLETS.map(w => `<option value="${w.id}">${w.emoji || ""} ${w.name}</option>`).join("");
    if ([...$("txFilter").options].some(o => o.value === cur)) $("txFilter").value = cur;
  }
}
if ($("txFilter")) $("txFilter").onchange = () => renderTx();

// ═══ ADD manual ═══
$("addBtn").onclick = async () => {
  $("addErr").textContent = "";
  const amt = parseFloat($("aAmt").value);
  const merch = $("aMerch").value.trim();
  const wid = $("aWallet").value;
  const dateStr = $("aDate").value; // YYYY-MM-DD أو فاضي
  if (!amt || amt <= 0) { $("addErr").textContent = "اكتب مبلغ صحيح"; return; }
  if (!merch) { $("addErr").textContent = "اكتب اسم العملية"; return; }
  if (!wid) { $("addErr").textContent = "اختر محفظة"; return; }
  // تاريخ مخصص → نخزّنه (12 ظهراً محلياً عشان ما ينزاح ليوم ثاني بفروقات التوقيت)
  let createdAt = serverTimestamp();
  if (dateStr) {
    const d = new Date(dateStr + "T12:00:00");
    if (isNaN(d)) { $("addErr").textContent = "التاريخ غير صحيح"; return; }
    if (d > new Date()) { $("addErr").textContent = "التاريخ في المستقبل!"; return; }
    createdAt = Timestamp.fromDate(d);
  }
  const w = WALLETS.find(x => x.id === wid);
  const ref = await addDoc(collection(db, "transactions"), {
    amount: amt, merchant: merch, wallet: wid, walletName: w.name,
    status: "done", source: "manual", createdAt
  });
  await updateDoc(doc(db, "wallets", wid), { balance: increment(-amt), spent: increment(amt) });
  if (merch) await setDoc(doc(db, "merchants", norm(merch)), { wallet: wid, merchant: merch, updatedAt: serverTimestamp() });
  $("aAmt").value = ""; $("aMerch").value = ""; $("aDate").value = "";
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

// ═══ أعد قراءة العمليات المعلّقة بالمحرّك المحدّث ═══
if ($("retryParseBtn")) $("retryParseBtn").onclick = async () => {
  const unp = TX.filter(t => t.status === "unparsed" && t.raw);
  if (!unp.length) return;
  $("retryParseBtn").disabled = true;
  $("retryParseBtn").textContent = "…";
  let ok = 0, skipped = 0, still = 0, firstFail = null;
  for (const t of unp) {
    const parsed = parseSMS(t.raw);
    if (parsed?.skip) {
      await deleteDoc(doc(db, "transactions", t.id));
      skipped++;
    } else if (parsed) {
      await updateDoc(doc(db, "transactions", t.id), {
        amount: parsed.amount, merchant: parsed.merchant,
        card: parsed.card || "", status: "pending"
      });
      ok++;
    } else {
      still++;
      if (!firstFail) firstFail = t.raw;
    }
  }
  $("retryParseBtn").disabled = false;
  $("retryParseBtn").textContent = `قرأت ${ok}` + (skipped ? ` · تجاهلت ${skipped} استرجاع` : "") + (still ? ` · بقي ${still} يدوي` : " ✓");
  // تشخيص: اعرض أول رسالة فاشلة بصيغة تكشف الرموز المخفية
  if (still && firstFail) {
    let d = document.getElementById("parseDebug");
    if (!d) { d = document.createElement("div"); d.id = "parseDebug"; d.style.cssText = "font-size:.6rem;color:var(--dim);direction:ltr;text-align:left;word-break:break-all;margin:8px 0;padding:8px;background:#0a1512;border-radius:8px"; $("retryParseBtn").after(d); }
    const esc200 = [...firstFail.slice(0,160)].map(c => {
      const cp = c.codePointAt(0);
      return (cp >= 0x20 && cp < 0x7f) || (cp >= 0x0600 && cp <= 0x06ff) ? c : "\\u" + cp.toString(16).padStart(4,"0");
    }).join("");
    d.textContent = "DEBUG v28: " + esc200;
  }
  setTimeout(() => { $("retryParseBtn").textContent = "🔄 أعد قراءتها بالمحرّك المحدّث"; }, 5000);
};

// ═══ بدء دورة جديدة من تاريخ محدد: يطبّق التوزيع + يصفّر بالتاريخ ═══
let cycleArmed = false, cycleTimer = null;
if ($("newCycleBtn")) $("newCycleBtn").onclick = async () => {
  const dateStr = $("cycleDate").value;
  if (!dateStr) { $("newCycleBtn").textContent = "اختر التاريخ أول ⬆️"; setTimeout(() => { $("newCycleBtn").textContent = "ابدأ الدورة الجديدة"; }, 2500); return; }
  const start = new Date(dateStr + "T00:00:00");
  if (isNaN(start) || start > new Date()) { $("newCycleBtn").textContent = "تاريخ غير صالح"; setTimeout(() => { $("newCycleBtn").textContent = "ابدأ الدورة الجديدة"; }, 2500); return; }
  if (!cycleArmed) {
    cycleArmed = true;
    $("newCycleBtn").textContent = "⚠️ بيطبّق التوزيع ويبدأ من " + dateStr + " — اضغط للتأكيد";
    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(() => { cycleArmed = false; $("newCycleBtn").textContent = "ابدأ الدورة الجديدة"; }, 6000);
    return;
  }
  clearTimeout(cycleTimer); cycleArmed = false;
  $("newCycleBtn").disabled = true; $("newCycleBtn").textContent = "…";
  try {
    // ١) طبّق التوزيع المكتوب في تبويب التوزيع (يحدّث budgets)
    await applySplitCore();
    // ٢) خزّن بداية الدورة (بالتاريخ) وصفّر النظام القديم
    cycleStart = start;
    await setDoc(doc(db, "settings", "counters"), {
      cycleStart: Timestamp.fromDate(start), txBaseline: 0, v2: true, updatedAt: serverTimestamp()
    });
    // ٣) الصرف والأرصدة مشتقة تلقائياً من الدورة — نصفّر العدّاد المخزّن القديم للنظافة بس
    const batch = writeBatch(db);
    WALLETS.forEach(w => batch.update(doc(db, "wallets", w.id), { spent: 0 }));
    await batch.commit();
    renderWallets(); renderStrip(); renderReportAll();
    $("newCycleBtn").textContent = "✓ بدأت الدورة من " + dateStr;
    setTimeout(() => { $("newCycleBtn").textContent = "ابدأ الدورة الجديدة"; }, 4000);
  } catch (e) {
    $("newCycleBtn").textContent = "صار خطأ: " + String(e?.message || e).slice(0, 40);
    setTimeout(() => { $("newCycleBtn").textContent = "ابدأ الدورة الجديدة"; }, 4000);
  }
  $("newCycleBtn").disabled = false;
};

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
      cycleStart = d.cycleStart?.toDate ? d.cycleStart.toDate() : null;
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
    cycleStart = new Date();
    txBaseline = 0;
    await setDoc(doc(db, "settings", "counters"), { cycleStart: Timestamp.fromDate(cycleStart), txBaseline: 0, v2: true, updatedAt: serverTimestamp() });
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

  $("splitAllocated").textContent = sar(total);
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
    $("splitMsg").textContent = "بيحدّث الحدود، والرصيد = الحد الجديد ناقص المصروف الفعلي";
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
      // ذكاء: الرصيد الجديد = الحد الجديد − المصروف الفعلي من سجل العمليات
      const spentMap = spentByWalletFromTx();
      const batch = writeBatch(db);
      WALLETS.forEach(w => {
        const newBudget = round2(splitAmt[w.id] || 0);
        const spent = spentMap[w.id] || 0;
        batch.update(doc(db, "wallets", w.id), { balance: round2(newBudget - spent) });
      });
      await batch.commit();
      $("splitMsg").style.color = "var(--teal)";
      $("splitMsg").textContent = "تم ✓ — حدّثت الحدود وخصمت المصروف السابق من الأرصدة";
      setTimeout(() => { $("splitMsg").textContent = ""; }, 4500);
    }
  } catch (e) {
    $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "صار خطأ: " + (e?.message || e);
  }
  $("applyRefillBtn").disabled = false; $("applyRefillBtn").textContent = "طبّق التوزيع وحدّث المحافظ";
};

// ═══ helpers ═══
// عدّاد تصاعدي ناعم للرقم البطل (يوقف على القيمة النهائية)
let countUpRaf = null;
function countUpTo(el, target) {
  if (!el) return;
  const prev = parseFloat((el.dataset.val || "0")) || 0;
  el.dataset.val = target;
  if (Math.abs(target - prev) < 0.01) { el.textContent = sar(target); return; }
  if (countUpRaf) cancelAnimationFrame(countUpRaf);
  const start = performance.now(), dur = 500;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = sar(prev + (target - prev) * ease);
    if (p < 1) countUpRaf = requestAnimationFrame(step);
  };
  countUpRaf = requestAnimationFrame(step);
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function fmt(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }) + " · " +
         d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
