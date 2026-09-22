# Telegram Bot Oscar – Cloudflare Worker

هذا المشروع جاهز للرفع إلى GitHub وربطه بـ Cloudflare Workers.

## الملفات
- `worker.js` كود البوت.
- `wrangler.jsonc` إعداد Cloudflare Worker.
- `package.json` إعداد النشر.
- `schema.sql` جداول D1 في حال احتجت إنشاءها من جديد.

## بعد رفع المشروع إلى GitHub
1. افتح Cloudflare > Workers & Pages.
2. اربط المستودع من GitHub.
3. استخدم اسم Worker: `telegram-bot-oscar`.
4. بعد أول Deploy افتح Settings > Bindings.
5. أضف D1 Database binding:
   - Variable name: `DB`
   - Database: `telegram-bot-db`
6. Deploy مرة أخرى إذا طلب Cloudflare ذلك.
7. افتح:
   `https://telegram-bot-oscar.homeworkhhh76.workers.dev/setup`
8. بعدها أرسل `/start` إلى البوت في Telegram.

ملاحظة: قاعدة البيانات `telegram-bot-db` والجداول التي أنشأتها سابقًا يمكن الاستمرار باستخدامها.
