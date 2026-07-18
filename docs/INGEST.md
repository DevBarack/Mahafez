# واجهة الاستقبال / Ingest Interface

هذا هو "المنفذ" اللي الشورت كت يكتب فيه. **ما فيه سيرفر تبنيه** — الشورت كت يكتب
مباشرة في Firestore عبر HTTPS، والتطبيق يقرأ ويصنّف ويخصم تلقائياً.

```
┌─────────────┐   HTTPS POST    ┌──────────────┐   onSnapshot   ┌─────────┐
│ iPhone      │ ──────────────► │  Firestore   │ ─────────────► │ التطبيق │
│ Shortcut    │  (يكتب عملية)   │ transactions │  (حيّ فوري)    │  يصنّف  │
└─────────────┘                 └──────────────┘                └─────────┘
```

---

## نقطة الاتصال (Endpoint)

الشورت كت يعمل طلبين HTTP:

### ١) تسجيل الدخول (يجيب توكن)
```
POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=API_KEY
Content-Type: application/json

{ "email": "me@mahafez.local", "password": "PASSWORD", "returnSecureToken": true }
```
الرد يحتوي `idToken` — خذه واستخدمه في الطلب الثاني.

### ٢) كتابة العملية
```
POST https://firestore.googleapis.com/v1/projects/PROJECT_ID/databases/(default)/documents/transactions
Authorization: Bearer <idToken>
Content-Type: application/json
```

**الجسم (Body)** — لاحظ صيغة Firestore الخاصة (كل قيمة داخل نوعها):
```json
{
  "fields": {
    "amount":    { "doubleValue": 324 },
    "merchant":  { "stringValue": "MYSR(q-Burj Al Hamam" },
    "status":    { "stringValue": "pending" },
    "source":    { "stringValue": "sms" },
    "card":      { "stringValue": "mada" },
    "raw":       { "stringValue": "<نص الرسالة كامل>" },
    "createdAt": { "timestampValue": "2026-07-17T19:06:00Z" }
  }
}
```

هذا كل شي. التطبيق يلقط العملية فوراً:
- **متجر معروف** (من الذاكرة) → يخصم تلقائياً من محفظته ✅
- **متجر جديد** → يظهر في «تحتاج مراجعة» → تختاره مرة → يتعلّمه

---

## الحقول

| الحقل | النوع | إلزامي | ملاحظة |
|---|---|---|---|
| `amount` | doubleValue | ✅ | المبلغ (رقم) |
| `merchant` | stringValue | ✅ | اسم المتجر من الرسالة |
| `status` | stringValue | ✅ | دايماً `pending` (التطبيق يغيّرها) |
| `source` | stringValue | — | `sms` أو `manual` |
| `card` | stringValue | — | `mada` أو `visa` (مفيد للتقارير) |
| `raw` | stringValue | — | نص الرسالة كامل (للمراجعة) |
| `createdAt` | timestampValue | ✅ | ISO 8601 بصيغة UTC |

> **card:** رسالة الإنماء تكتب «بطاقة 5902 مدى» أو «بطاقة ائتمانية 7497».
> لو استخرجت هذا، تقدر تفلتر عمليات الفيزا بسهولة في التقرير.

---

## الاستخراج من رسالة الإنماء (Regex)

الرسائل ٣ صيغ:
```
شراء عبر نقاط بيع SAR 324 بطاقة 5902* مدى-ApplePay من MYSR في ...
شراء إنترنت مبلغ SAR 63.35 بطاقة 5902* مدى من Tech advanced ...
شراء POS - Apple Pay SAR 34.40 بطاقة ائتمانية 7497* من HAMAD ...
```

| تستخرج | Regex |
|---|---|
| المبلغ | `SAR\s*([\d,]+(?:\.\d{1,2})?)` |
| المتجر | `من\s+(?!حساب)([^\n]+?)(?:\s+في|\s+-\s+SA|$)` |
| البطاقة | `بطاقة\s+(\d{4})` → لو `7497`=visa، غيره=mada |

جرّبها على [regex101.com](https://regex101.com) قبل ما تحطها.

---

## اختبار المنفذ قبل الشورت كت

افتح `test-ingest.html` في المتصفح — يحاكي بالضبط اللي يسويه الشورت كت
(تسجيل دخول + كتابة عملية). لو نجح، الشورت كت بينجح.

---

## الأمان

- قواعد Firestore تمنع أي كتابة بدون توكن صالح (تسجيل دخول).
- كلمة المرور مخزّنة داخل الشورت كت على جهازك فقط.
- `API_KEY` مو سر — الحماية من القواعد + كلمة المرور.
- الشورت كت **يكتب فقط**. تحويل الفلوس الفعلي يبقى بيدك في تطبيق البنك.
