# محافظي — Mahafez

تطبيق ويب لنظام المحافظ (Envelope Budgeting). رسالة الإنماء تجيك → الشورت كت
يقرأها → التطبيق يصنّفها ويخصمها من المحفظة الصح → تشوف تقاريرك أي وقت.

**التصنيف يتعلّم:** أول مرة تصنّف متجر، يحفظه. المرة الجاية يعرفه لحاله.

---

## ١) أنشئ مشروع Firebase

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project** → سمّه `mahafez`
   (Google Analytics: تقدر تعطّله)
2. **Build → Firestore Database** → Create database → **Production mode** → اختر
   `eur3` أو الأقرب لك
3. **Build → Authentication** → Get started → **Email/Password** → فعّله
4. نفس الصفحة → تبويب **Users** → **Add user**
   - Email: `me@mahafez.local`
   - Password: اختر كلمة مرور قوية (هذي اللي تدخل فيها التطبيق والشورت كت)
5. **⚙️ Project settings → General** → انزل لـ Your apps → أيقونة `</>` (Web)
   → سمّه `mahafez-web` → انسخ كائن `firebaseConfig`

## ٢) عبّي الإعدادات

افتح `public/firebase-config.js` وحط قيمك:

```js
export const firebaseConfig = { apiKey: "...", projectId: "...", ... };
export const AUTH_EMAIL = "me@mahafez.local";
```

## ٣) ارفعه على GitHub

```bash
cd mahafez
git init
git add .
git commit -m "محافظي: نظام المحافظ"
git branch -M main
git remote add origin https://github.com/USERNAME/mahafez.git
git push -u origin main
```

> ملاحظة: `firebaseConfig` مو سر — الأمان من قواعد Firestore + كلمة المرور.

## ٤) انشر على Firebase Hosting

```bash
npm i -g firebase-tools
firebase login
firebase use --add          # اختر مشروعك
firebase deploy
```

بيعطيك رابط مثل `https://mahafez-xxxxx.web.app` — افتحه بجوالك و**أضفه للشاشة
الرئيسية** (Share → Add to Home Screen) يصير كأنه تطبيق.

## ٥) جهّز المحافظ (مرة وحدة)

افتح `https://mahafez-xxxxx.web.app/seed.html` → اكتب كلمة المرور →
**أنشئ المحافظ + ذاكرة المتاجر**.

يبني الـ14 محفظة + ~60 متجر من اللي صنّفناها سوا (دانكن، التميمي، النهدي، إلخ).

بعدها احذف `seed.html` وأعد النشر لو تبي (اختياري — محمي بكلمة المرور).

## ٦) اختبر المنفذ (قبل الشورت كت)

افتح `https://mahafez-xxxxx.web.app/test-ingest.html` → اكتب كلمة المرور →
جرّب عيّنة رسالة → **استخرج وأرسل**. لو ظهرت العملية في التطبيق، المنفذ شغّال.

## ٧) الشورت كت في الآيفون

راجع [`docs/SHORTCUT.md`](docs/SHORTCUT.md) للخطوات، و[`docs/INGEST.md`](docs/INGEST.md)
لواجهة الاستقبال (الـ endpoint والحقول)، و[`docs/SNIPPETS.md`](docs/SNIPPETS.md)
للصق السريع (URLs + regex + JSON).

---

## الاستخدام اليومي

| الشاشة | وش تسوي |
|---|---|
| **الرئيسية** | أرصدة المحافظ + العمليات اللي تحتاج مراجعة |
| **العمليات** | سجل كل شي، مع زر تراجع |
| **التقرير** | الصرف حسب المحفظة مقابل الميزانية |
| **إضافة** | عملية يدوية + تعبئة الشهر الجديد |

**أول الشهر:** افتح **إضافة → تعبئة المحافظ للشهر الجديد**. يرجّع كل محفظة
لمبلغها ويصفّر الصرف.

**متجر جديد:** يوصل الشورت كت → يظهر في "تحتاج مراجعة" → تختار المحفظة →
يخصم **ويحفظ المتجر للأبد**. المرة الجاية يتصنّف تلقائياً.

---

## البنية

```
public/
  index.html          التطبيق
  seed.html           تجهيز أول مرة
  firebase-config.js  إعداداتك (عبّيها)
firestore.rules       الأمان: تسجيل دخول مطلوب
firebase.json         إعداد النشر
docs/SHORTCUT.md      دليل الشورت كت
```

**Firestore:**
- `wallets/{id}` — `{name, emoji, budget, balance, spent, order}`
- `transactions/{id}` — `{amount, merchant, wallet, status, source, createdAt}`
- `merchants/{slug}` — `{wallet, merchant}` ← الذاكرة المتعلّمة

---

*أداة تخطيط شخصية — ليست استشارة مالية مرخّصة.*
