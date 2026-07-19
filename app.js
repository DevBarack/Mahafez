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
    renderReview(); renderUnparsed(); renderTx(); renderReport(); renderWalletChart(); renderStrip();
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
function renderStrip() {
  const total = WALLETS.reduce((s, w) => s + (w.balance || 0), 0);
  const spent = WALLETS.reduce((s, w) => s + (w.spent || 0), 0);
  $("sTotal").textContent = money(total);
  $("sSpent").textContent = money(spent);
  $("sCount").textContent = TX.filter(t => t.status === "done").length;
}

function renderWallets() {
  const el = $("wallets");
  if (!WALLETS.length) { el.innerHTML = `<div class="empty">ما فيه محافظ بعد — أضف وحدة بالزر تحت</div>`; return; }
  el.innerHTML = WALLETS.map(w => {
    const bal = w.balance || 0, bud = w.budget || 1;
    const pct = Math.max(0, Math.min(100, (bal / bud) * 100));
    const cls = bal < 0 ? "over" : pct < 25 ? "low" : "";
    const color = bal < 0 ? "var(--red)" : pct < 25 ? "var(--gold)" : "var(--teal)";
    return `<div class="env tap ${cls}" data-edit="${w.id}" style="color:${color}">
      <div class="fill" style="inline-size:${pct}%"></div>
      <div class="top">
        <span class="name">${w.emoji || ""} ${esc(w.name)}</span>
        <span class="bal num">${money(bal)}</span>
      </div>
      <div class="sub"><span class="num">من ${money(bud)}</span><span class="num">صُرف ${money(w.spent || 0)}</span></div>
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
      <div class="l"><div class="m">${esc(t.merchant || "—")}</div><div class="w">${esc(t.walletName || "")}</div></div>
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
}

// ═══ حذف عملية نهائياً — يرجّع المبلغ للمحفظة إذا كانت مخصومة ═══
async function deleteTx(tx) {
  if (!tx) return;
  if (!confirm(`حذف عملية "${tx.merchant || "—"}" بمبلغ ${money(tx.amount)}؟ المبلغ بيرجع للمحفظة.`)) return;
  // إذا كانت مخصومة من محفظة → رجّع المبلغ
  if (tx.status === "done" && tx.wallet) {
    await updateDoc(doc(db, "wallets", tx.wallet), {
      balance: increment(tx.amount), spent: increment(-tx.amount)
    });
  }
  await deleteDoc(doc(db, "transactions", tx.id));
}

function renderReport() {
  const max = Math.max(...WALLETS.map(w => w.spent || 0), 1);
  const sorted = [...WALLETS].sort((a, b) => (b.spent || 0) - (a.spent || 0)).filter(w => (w.spent || 0) > 0);
  $("report").innerHTML = sorted.length ? sorted.map(w => {
    const s = w.spent || 0, bud = w.budget || 1;
    const over = s > bud;
    return `<div class="rep">
      <div class="l"><span>${w.emoji || ""} ${w.name}</span><span class="num" style="color:${over ? "var(--red)" : "var(--muted)"}">${money(s)} / ${money(bud)}</span></div>
      <div class="bar"><div style="width:${Math.min(100, (s / max) * 100)}%;background:${over ? "var(--red)" : "var(--teal)"}"></div></div>
    </div>`;
  }).join("") : `<div class="empty">ما صرفت شي بعد هذا الشهر</div>`;
}

// ═══ القسم ٢: رسم دائري (Donut) — الصرف حسب المحفظة ═══
let walletChart = null;
// ألوان القطع — تدرّجات من ثيم التطبيق
const CHART_COLORS = ["#2fa98a", "#d4af37", "#7aa6d4", "#d9645a", "#5ec9a7", "#c99b3a", "#9b8ade", "#e08a7f"];

function renderWalletChart() {
  const canvas = $("walletChart");
  if (!canvas || typeof Chart === "undefined") return;

  // جهّز البيانات: المحافظ اللي صُرف منها، مرتّبة تنازلي
  const spentWallets = WALLETS
    .filter(w => (w.spent || 0) > 0)
    .sort((a, b) => (b.spent || 0) - (a.spent || 0));

  const totalSpent = spentWallets.reduce((s, w) => s + (w.spent || 0), 0);

  // لو ما فيه صرف — امسح الرسم واعرض رسالة
  if (!spentWallets.length) {
    if (walletChart) { walletChart.destroy(); walletChart = null; }
    canvas.style.display = "none";
    if (!$("noChart")) {
      const p = document.createElement("div");
      p.id = "noChart"; p.className = "empty";
      p.textContent = "ما صرفت شي بعد هذا الشهر";
      canvas.parentNode.appendChild(p);
    }
    return;
  }
  if ($("noChart")) $("noChart").remove();
  canvas.style.display = "block";

  const labels = spentWallets.map(w => `${w.emoji || ""} ${w.name}`.trim());
  const data = spentWallets.map(w => w.spent || 0);
  const colors = spentWallets.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);

  // لو الرسم موجود — حدّث بياناته بدل ما تعيد إنشاءه (أنعم)
  if (walletChart) {
    walletChart.data.labels = labels;
    walletChart.data.datasets[0].data = data;
    walletChart.data.datasets[0].backgroundColor = colors;
    walletChart.options.plugins.centerText.total = totalSpent;
    walletChart.update();
    return;
  }

  // Plugin: يكتب الإجمالي في وسط الدائري
  const centerText = {
    id: "centerText",
    afterDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom } } = chart;
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const total = chart.options.plugins.centerText?.total || 0;
      ctx.save();
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#eaf3f0";
      ctx.font = "700 20px 'IBM Plex Sans Arabic', sans-serif";
      ctx.fillText(money(total), cx, cy - 6);
      ctx.fillStyle = "#8fa9a1";
      ctx.font = "500 11px 'IBM Plex Sans Arabic', sans-serif";
      ctx.fillText("إجمالي الصرف", cx, cy + 14);
      ctx.restore();
    }
  };

  walletChart = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor: "#142b26",
        borderWidth: 2,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      cutout: "62%",
      plugins: {
        centerText: { total: totalSpent },
        legend: {
          position: "bottom",
          labels: {
            color: "#8fa9a1",
            font: { family: "'IBM Plex Sans Arabic', sans-serif", size: 12 },
            padding: 12,
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true
          }
        },
        tooltip: {
          rtl: true,
          bodyFont: { family: "'IBM Plex Sans Arabic', sans-serif" },
          callbacks: {
            label(ctx) {
              const val = ctx.parsed;
              const pct = totalSpent ? Math.round((val / totalSpent) * 100) : 0;
              return ` ${money(val)} ريال · ${pct}%`;
            }
          }
        }
      },
      animation: { animateRotate: true, duration: 700 }
    },
    plugins: [centerText]
  });
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
$("refillBtn").onclick = async () => {
  if (!confirm("تعبئة كل المحافظ لمبلغها الشهري وتصفير عدّاد الصرف؟")) return;
  const b = writeBatch(db);
  WALLETS.forEach(w => b.update(doc(db, "wallets", w.id), { balance: w.budget || 0, spent: 0 }));
  await b.commit();
  alert("تمت التعبئة ✓");
};

// ═══ NAV ═══
document.querySelectorAll("nav button").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach(x => x.classList.remove("on"));
    document.querySelectorAll(".page").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    $("p-" + b.dataset.p).classList.add("on");
    window.scrollTo(0, 0);
    if (b.dataset.p === "rep" && walletChart) walletChart.resize();
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
  $("walletModal").hidden = false;
}
function closeWalletModal() { $("walletModal").hidden = true; editingWalletId = null; }

$("addWalletBtn").onclick = () => openWalletModal(null);
$("mCancelBtn").onclick = closeWalletModal;

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

$("mDeleteBtn").onclick = async () => {
  if (!editingWalletId) return;
  const w = WALLETS.find(x => x.id === editingWalletId);
  if (!confirm(`حذف محفظة "${w?.name}"؟ هذا الإجراء نهائي.`)) return;
  await deleteDoc(doc(db, "wallets", editingWalletId));
  closeWalletModal();
};

// ═══════════════════════════════════════════
// ═══ الخاصية ٢: توزيع الراتب بالنسب (تحكّم يدوي كامل) ═══
// ═══════════════════════════════════════════
// النِسب والمبلغ يُحفظون في settings/split
let splitPct = {};   // { walletId: نسبة }
let splitSalary = 0;

async function loadSplit() {
  const snap = await getDoc(doc(db, "settings", "split"));
  if (snap.exists()) {
    const d = snap.data();
    splitPct = d.pct || {};
    splitSalary = d.salary || 0;
  }
}

function renderSplit() {
  if (!WALLETS.length) { $("splitList").innerHTML = `<div class="empty">أضف محافظ أول</div>`; return; }

  const ids = WALLETS.map(w => w.id);
  // أي محفظة بدون نسبة محفوظة → تبدأ بصفر (ما نوزّع تلقائياً)
  ids.forEach(id => { if (splitPct[id] === undefined) splitPct[id] = 0; });
  // نظّف نسب محافظ محذوفة
  Object.keys(splitPct).forEach(id => { if (!ids.includes(id)) delete splitPct[id]; });

  // خانة المبلغ
  if (splitSalary) $("salaryInput").value = splitSalary;

  $("splitList").innerHTML = WALLETS.map(w => {
    const pct = round1(splitPct[w.id] || 0);
    return `<div class="split-row">
      <div class="top">
        <span class="name">${w.emoji || ""} ${esc(w.name)}</span>
        <span class="vals">
          <input class="pct-input num" id="pctin-${w.id}" type="number" inputmode="decimal"
                 min="0" max="100" step="1" value="${pct}" data-pctin="${w.id}"> %
          <span class="amt num" id="amt-${w.id}">0</span>
        </span>
      </div>
      <input type="range" min="0" max="100" step="1" value="${pct}" data-slider="${w.id}">
    </div>`;
  }).join("");

  // البار + الخانة متزامنين، وكل واحد مستقل (ما يعبث بالباقي)
  $("splitList").querySelectorAll("[data-slider]").forEach(s => {
    s.oninput = () => setPct(s.dataset.slider, clampPct(parseFloat(s.value)), "slider");
  });
  $("splitList").querySelectorAll("[data-pctin]").forEach(inp => {
    inp.oninput = () => setPct(inp.dataset.pctin, clampPct(parseFloat(inp.value)), "input");
  });
  recalcSplit();
}

const clampPct = v => isNaN(v) ? 0 : Math.max(0, Math.min(100, v));
const round1 = v => Math.round(v * 10) / 10;

// تعديل نسبة محفظة واحدة فقط — بدون أي توزيع تلقائي
function setPct(id, val, source) {
  splitPct[id] = val;
  // زامن الطرف الثاني (لو حرّك البار، حدّث الخانة، والعكس)
  const sl = document.querySelector(`[data-slider="${id}"]`);
  const inp = document.querySelector(`[data-pctin="${id}"]`);
  if (source !== "slider" && sl) sl.value = val;
  if (source !== "input" && inp) inp.value = round1(val);
  recalcSplit();
}

function recalcSplit() {
  const salary = parseFloat($("salaryInput").value) || 0;
  let allocatedPct = 0, allocatedAmt = 0;
  WALLETS.forEach(w => {
    const p = splitPct[w.id] || 0;
    allocatedPct += p;
    const amt = (salary * p) / 100;
    allocatedAmt += amt;
    const el = $("amt-" + w.id);
    if (el) el.textContent = money(amt);
  });
  const remainPct = 100 - allocatedPct;
  const remainAmt = salary - allocatedAmt;

  $("splitAllocated").textContent = round1(allocatedPct) + "%";
  $("splitRemain").textContent = round1(remainPct) + "%";
  $("splitRemainAmt").textContent = money(remainAmt);

  // تلوين: أخضر لو 100%، ذهبي لو باقي، أحمر لو تجاوز
  const box = document.querySelector(".split-total");
  if (box) {
    box.classList.remove("ok", "warn", "bad");
    if (Math.abs(remainPct) < 0.05) box.classList.add("ok");
    else if (remainPct > 0) box.classList.add("warn");
    else box.classList.add("bad");
  }
}

$("salaryInput").addEventListener("input", () => {
  splitSalary = parseFloat($("salaryInput").value) || 0;
  recalcSplit();
});

// دالة مشتركة: تحقّق + تحديث الميزانيات + حفظ. ترجّع الراتب لو نجحت، أو null لو وقفت.
async function applySplitCore(needConfirmMismatch = true) {
  const salary = parseFloat($("salaryInput").value);
  if (!salary || salary <= 0) { $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "اكتب مبلغ الشهر أول"; return null; }

  const totalPct = WALLETS.reduce((s, w) => s + (splitPct[w.id] || 0), 0);
  if (needConfirmMismatch && Math.abs(totalPct - 100) >= 0.05) {
    const msg = totalPct > 100
      ? `مجموع النسب ${round1(totalPct)}% (تجاوزت 100%). تبي تكمّل؟`
      : `مجموع النسب ${round1(totalPct)}% (باقي ${round1(100 - totalPct)}% غير موزّع). تبي تكمّل؟`;
    if (!confirm(msg)) return null;
  }

  const batch = writeBatch(db);
  WALLETS.forEach(w => {
    const newBudget = Math.round((salary * (splitPct[w.id] || 0)) / 100 * 100) / 100;
    batch.update(doc(db, "wallets", w.id), { budget: newBudget, pct: splitPct[w.id] || 0 });
  });
  await batch.commit();
  splitSalary = salary;
  await setDoc(doc(db, "settings", "split"), { pct: splitPct, salary, updatedAt: serverTimestamp() });
  return salary;
}

// زر ١: طبّق الميزانيات فقط (ما يعبّي)
$("applySplitBtn").onclick = async () => {
  $("applySplitBtn").disabled = true; $("applySplitBtn").textContent = "…";
  try {
    const ok = await applySplitCore(true);
    if (ok !== null) {
      $("splitMsg").style.color = "var(--teal)";
      $("splitMsg").textContent = "تم تحديث ميزانيات المحافظ ✓";
      setTimeout(() => { $("splitMsg").textContent = ""; }, 4000);
    }
  } catch (e) {
    $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "صار خطأ، حاول مرة ثانية";
  }
  $("applySplitBtn").disabled = false; $("applySplitBtn").textContent = "طبّق على المحافظ";
};

// زر ٢: طبّق + عبّي المحافظ (ينسخ الميزانية للرصيد ويصفّر الصرف) — بتأكيد
$("applyRefillBtn").onclick = async () => {
  if (!confirm("⚠️ هذا يطبّق التوزيع ثم يعبّي كل محفظة بمبلغها الجديد ويصفّر عدّاد الصرف. استخدمه بداية الشهر فقط. تكمّل؟")) return;
  $("applyRefillBtn").disabled = true; $("applyRefillBtn").textContent = "…";
  try {
    const salary = await applySplitCore(true);
    if (salary !== null) {
      // بعد تحديث الميزانيات، عبّي: balance = budget، spent = 0
      const batch = writeBatch(db);
      WALLETS.forEach(w => {
        const newBudget = Math.round((salary * (splitPct[w.id] || 0)) / 100 * 100) / 100;
        batch.update(doc(db, "wallets", w.id), { balance: newBudget, spent: 0 });
      });
      await batch.commit();
      $("splitMsg").style.color = "var(--teal)";
      $("splitMsg").textContent = "تم التطبيق والتعبئة ✓ — المحافظ جاهزة للشهر الجديد";
      setTimeout(() => { $("splitMsg").textContent = ""; }, 4500);
    }
  } catch (e) {
    $("splitMsg").style.color = "var(--red)"; $("splitMsg").textContent = "صار خطأ، حاول مرة ثانية";
  }
  $("applyRefillBtn").disabled = false; $("applyRefillBtn").textContent = "طبّق وعبّي المحافظ للشهر الجديد";
};

// ═══ helpers ═══
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function fmt(ts) {
  if (!ts?.toDate) return "";
  const d = ts.toDate();
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" }) + " · " +
         d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
