# الشورت كت — من رسالة الإنماء للمحفظة

الفكرة: أتمتة تراقب رسائل الإنماء → تستخرج المبلغ واسم المتجر → ترسلها لـ Firestore
→ التطبيق يصنّفها ويخصمها.

**تحتاج قيمتين من Firebase:**
- `API_KEY` — نفس `apiKey` في `firebase-config.js`
- `PROJECT_ID` — نفس `projectId`

---

## الجزء ١: الشورت كت (Shortcuts → + جديد)

سمّه **`سجّل مصروف`**.

### 1. Receive input
أول خطوة تلقائية — نص الرسالة يجي في `Shortcut Input`.

### 2. استخرج المبلغ
**Match Text**
- Text: `Shortcut Input`
- Regex: 
  ```
  SAR\s*([\d,]+(?:\.\d{1,2})?)
  ```
**Get Group at Index** → Index: `1` → من `Matches`
**Replace Text** → ابحث `,` استبدله بـ `` (فاضي) → من نتيجة المجموعة
→ **Set Variable** باسم `AMOUNT`

### 3. استخرج اسم المتجر
**Match Text**
- Text: `Shortcut Input`
- Regex:
  ```
  من\s+(?!حساب)([^\n]+)
  ```
**Get Group at Index** → Index: `1`
→ **Set Variable** باسم `MERCHANT`

> الـ `(?!حساب)` تتجاهل سطر «من حساب *8000».

### 4. سجّل الدخول (احصل على التوكن)
**Get Contents of URL**
- URL:
  ```
  https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=API_KEY
  ```
- Method: `POST`
- Request Body: `JSON`
  | Key | Type | Value |
  |---|---|---|
  | `email` | Text | `me@mahafez.local` |
  | `password` | Text | كلمة المرور حقتك |
  | `returnSecureToken` | Boolean | `true` |

**Get Dictionary Value** → Key: `idToken` → من نتيجة الطلب
→ **Set Variable** باسم `TOKEN`

### 5. أرسلها لـ Firestore
**Get Contents of URL**
- URL:
  ```
  https://firestore.googleapis.com/v1/projects/PROJECT_ID/databases/(default)/documents/transactions
  ```
- Method: `POST`
- Headers:
  | Key | Value |
  |---|---|
  | `Authorization` | `Bearer ` + متغيّر `TOKEN` |
- Request Body: `JSON`

بنية الـ JSON (Dictionary داخل Dictionary):

```
fields  (Dictionary)
├── amount     (Dictionary) → doubleValue    (Number) = متغيّر AMOUNT
├── merchant   (Dictionary) → stringValue    (Text)   = متغيّر MERCHANT
├── status     (Dictionary) → stringValue    (Text)   = pending
├── source     (Dictionary) → stringValue    (Text)   = sms
├── raw        (Dictionary) → stringValue    (Text)   = Shortcut Input
└── createdAt  (Dictionary) → timestampValue (Text)   = التاريخ (تحت)
```

**للتاريخ:** أضف قبلها **Format Date**
- Date: `Current Date`
- Format: `Custom` → `yyyy-MM-dd'T'HH:mm:ss'Z'`
- Timezone: `UTC`

### 6. تأكيد (اختياري)
**Show Notification**
- Title: `سُجّلت`
- Body: `MERCHANT` + ` — ` + `AMOUNT`

---

## الجزء ٢: الأتمتة (تشغيل تلقائي)

**Shortcuts → Automation → + → Message**

| الإعداد | القيمة |
|---|---|
| Sender | `alinma` |
| Message Contains | `شراء` |
| Run | `سجّل مصروف` |
| **Run Immediately** | ✅ (مهم — بدونها تحتاج تضغط كل مرة) |
| Notify When Run | حسب ذوقك |

---

## الجزء ٣: جرّبها

انسخ رسالة إنماء قديمة، وشغّل الشورت كت يدوياً (الصق النص كـ input).
لازم تظهر العملية في التطبيق خلال ثانية.

**متجر معروف** (دانكن، التميمي…) → يتصنّف ويتخصم تلقائياً.
**متجر جديد** → يظهر في «تحتاج مراجعة» → تختاره مرة وحدة → يتعلّمه.

---

## لو صار خطأ

| المشكلة | الحل |
|---|---|
| المبلغ يطلع فاضي | جرّب الـ regex على النص في [regex101.com](https://regex101.com) |
| اسم المتجر غلط | بعض الرسائل صيغتها مختلفة — عدّل الـ regex أو صنّفها يدوي |
| `PERMISSION_DENIED` | تأكد إن قواعد Firestore منشورة وإن التوكن يوصل صح |
| `INVALID_ARGUMENT` | راجع بنية الـ JSON — لازم `fields` ثم نوع القيمة |
| ما تشتغل تلقائياً | فعّل **Run Immediately** في الأتمتة |

---

## ملاحظات أمان

- كلمة المرور مخزّنة داخل الشورت كت على جهازك.
- قواعد Firestore تمنع أي قراءة/كتابة بدون تسجيل دخول.
- `apiKey` مو سر — هو معرّف المشروع، والحماية من القواعد.
- الشورت كت **يسجّل فقط**. أي تحويل فلوس يبقى بيدك في تطبيق البنك.
