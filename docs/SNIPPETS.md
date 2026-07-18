# لصق سريع للشورت كت / Copy-Paste Snippets

قيمك (من `firebase-config.js`):
- `AIzaSyBxhz6d25HiC7P45-uTFL0IIiYtNgXOu8w` = قيمة `apiKey`
- `mahafez-ecbcd` = قيمة `projectId`

---

## URL — تسجيل الدخول (الخطوة ٤)
```
https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyBxhz6d25HiC7P45-uTFL0IIiYtNgXOu8w
```

## URL — كتابة العملية (الخطوة ٥)
```
https://firestore.googleapis.com/v1/projects/mahafez-ecbcd/databases/(default)/documents/transactions
```

## Header (الخطوة ٥)
```
Authorization : Bearer [متغيّر TOKEN]
```

---

## Regex — المبلغ
```
SAR\s*([\d,]+(?:\.\d{1,2})?)
```

## Regex — المتجر
```
من\s+(?!حساب)([^\n]+?)(?:\s+في|\s+-\s+SA|$)
```

## Regex — رقم البطاقة (اختياري، لتمييز مدى/فيزا)
```
بطاقة[^\d]*(\d{4})
```
لو الناتج `7497` → البطاقة visa، غيره → mada.

---

## بنية الـ JSON Body (الخطوة ٥)

في Shortcuts، كل سطر «Dictionary» جوّا «Dictionary». الشكل النهائي:

```
fields (Dictionary)
├─ amount    (Dictionary) → doubleValue    (Number) : [متغيّر AMOUNT]
├─ merchant  (Dictionary) → stringValue    (Text)   : [متغيّر MERCHANT]
├─ status    (Dictionary) → stringValue    (Text)   : pending
├─ source    (Dictionary) → stringValue    (Text)   : sms
├─ card      (Dictionary) → stringValue    (Text)   : [متغيّر CARD]
├─ raw       (Dictionary) → stringValue    (Text)   : [Shortcut Input]
└─ createdAt (Dictionary) → timestampValue (Text)   : [متغيّر DATE]
```

**DATE:** أضف Action «Format Date» →
- Format: Custom → `yyyy-MM-dd'T'HH:mm:ss'Z'`
- Timezone: UTC

---

## نموذج JSON نهائي (للمرجع فقط — Shortcuts يبنيه بالـ Dictionaries)
```json
{
  "fields": {
    "amount":    { "doubleValue": 324 },
    "merchant":  { "stringValue": "MYSR(q-Burj Al Hamam" },
    "status":    { "stringValue": "pending" },
    "source":    { "stringValue": "sms" },
    "card":      { "stringValue": "mada" },
    "raw":       { "stringValue": "شراء عبر نقاط بيع SAR 324 ..." },
    "createdAt": { "timestampValue": "2026-07-17T19:06:00Z" }
  }
}
```
