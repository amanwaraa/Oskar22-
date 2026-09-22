const BOT_TOKEN = "8743553964:AAFdDUy2isOSdgvc50ltCDrSVvlK9dOSu2U";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const APP_TAG = 'OSCAR_ACCOUNTING_ACTIVATION_V1';
const PORTABLE_FORMAT = 'OSCAR_MZAUTH_V4';
const WORKER_VERSION = '2.2.0-mzauth-v4';
const ACTIVATION_WRAP_KEY = ['AM','_8Q','2x','!m','7Z','b4','_r','9P','@k','5N'].join('');
const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(`Oscar Telegram Bot Worker ${WORKER_VERSION} is running ✅`, {
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
        });
      }

      if (request.method === 'GET' && url.pathname === '/setup') {
        await ensureD1(env);
        const webhookUrl = `${url.origin}/webhook`;
        const tg = await telegram('setWebhook', {
          url: webhookUrl,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: false
        });
        return json({ success: !!tg.ok, webhook: webhookUrl, telegram: tg });
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        await ensureD1(env);
        const info = await telegram('getWebhookInfo', {});
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_sessions WHERE active=1').first();
        return json({ status: 'running', version: WORKER_VERSION, active_sessions: Number(count?.count || 0), webhook: info });
      }

      // App -> bot notification. The accounting app calls this after any invoice is created.
      if (request.method === 'POST' && url.pathname === '/api/app/invoice') {
        await ensureD1(env);
        const body = await request.json();
        const companyId = String(body?.companyId || '').trim();
        const invoice = body?.invoice;
        if (!companyId || !invoice) return json({ ok: false, error: 'companyId and invoice are required' }, 400);
        const rows = await env.DB.prepare(
          'SELECT chat_id,account_id FROM telegram_sessions WHERE company_id=? AND active=1 ORDER BY updated_at DESC'
        ).bind(companyId).all();
        const text = formatInvoiceNotification(invoice, body?.companyName || '');
        let sent = 0;
        for (const row of rows.results || []) {
          try {
            const r = await sendMessage(String(row.chat_id), text, mainMenuButton());
            if (r?.ok) sent++;
          } catch (_) {}
        }
        return json({ ok: true, sent });
      }

      // Generic app event hook for future use.
      if (request.method === 'POST' && url.pathname === '/api/app/event') {
        await ensureD1(env);
        const body = await request.json();
        const companyId = String(body?.companyId || '').trim();
        const text = String(body?.text || '').trim();
        if (!companyId || !text) return json({ ok: false }, 400);
        const rows = await env.DB.prepare('SELECT chat_id FROM telegram_sessions WHERE company_id=? AND active=1').bind(companyId).all();
        let sent = 0;
        for (const row of rows.results || []) {
          const r = await sendMessage(String(row.chat_id), `🔔 <b>تحديث من أوسكار</b>\n\n${e(text)}`, mainMenuButton());
          if (r?.ok) sent++;
        }
        return json({ ok: true, sent });
      }

      if (request.method === 'POST' && url.pathname === '/webhook') {
        await ensureD1(env);
        const update = await request.json();
        ctx.waitUntil(processUpdate(update, env));
        return new Response('OK');
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('WORKER_ERROR', error);
      return json({ ok: false, error: String(error?.message || error) }, 500);
    }
  }
};

async function ensureD1(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_sessions (
      chat_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      company_name TEXT,
      account_id TEXT,
      account_name TEXT,
      account_role TEXT,
      payload_json TEXT NOT NULL,
      logged_in_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_states (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'IDLE',
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_sessions_company ON telegram_sessions(company_id,active)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_sessions_account ON telegram_sessions(company_id,account_id,active)')
  ]);
}

async function processUpdate(update, env) {
  if (update?.callback_query) {
    const q = update.callback_query;
    try { await telegram('answerCallbackQuery', { callback_query_id: q.id }); } catch (_) {}
    const chatId = String(q.message?.chat?.id || q.from?.id || '');
    if (!chatId) return;
    return handleCallback(chatId, String(q.data || ''), env, q);
  }
  const msg = update?.message;
  if (!msg) return;
  const chatId = String(msg.chat?.id || '');
  if (!chatId) return;

  const text = String(msg.text || '').trim();
  if (text === '/logout' || text === '🚪 تسجيل خروج') return logout(chatId, env);
  if (text === '/start') return start(chatId, env, msg);

  if (msg.document && /\.mzauth$/i.test(String(msg.document.file_name || ''))) {
    return loginFromTelegramDocument(chatId, msg.document, env);
  }

  const session = await getSession(chatId, env);
  if (!session) return askForLoginFile(chatId);

  const state = await getState(chatId, env);
  if (state.mode !== 'IDLE') return handleStateText(chatId, text, session, state, env, msg);

  // Friendly text shortcuts in addition to buttons.
  if (/^(القائمة|menu|الرئيسية)$/i.test(text)) return showMainMenu(chatId, session);
  if (/بحث/i.test(text)) {
    await setState(chatId, 'GLOBAL_SEARCH', {}, env);
    return sendMessage(chatId, '🔎 اكتب كلمة البحث الآن: اسم صنف، فاتورة، عميل أو مورد.', backButton());
  }
  return showMainMenu(chatId, session);
}

async function start(chatId, env, msg) {
  const session = await getSession(chatId, env);
  if (session) return showMainMenu(chatId, session);
  const name = e(msg?.from?.first_name || 'مستخدم');
  return sendMessage(chatId,
    `👋 أهلاً ${name} في <b>أوسكار المحاسبي عبر تيليجرام</b>.\n\n` +
    `لتسجيل الدخول بنفس حساب البرنامج، أرسل هنا <b>ملف الدخول .mzauth</b> الخاص بالمدير أو الموظف.\n\n` +
    `بعد التحقق ستظهر لك الأقسام حسب صلاحيات نفس الحساب.`,
    { inline_keyboard: [[{ text: '📎 أرسل ملف الدخول .mzauth', callback_data: 'login_help' }]] }
  );
}

async function askForLoginFile(chatId) {
  return sendMessage(chatId,
    '🔐 <b>يلزم تسجيل الدخول</b>\n\nأرسل ملف دخول أوسكار <code>.mzauth</code> هنا مباشرة.',
    { inline_keyboard: [[{ text: 'ℹ️ طريقة الدخول', callback_data: 'login_help' }]] }
  );
}

async function loginFromTelegramDocument(chatId, doc, env) {
  await sendMessage(chatId, '⏳ جاري قراءة ملف الدخول والتحقق من حساب أوسكار...');
  try {
    const file = await telegram('getFile', { file_id: doc.file_id });
    if (!file?.ok || !file.result?.file_path) throw new Error('تعذر تنزيل ملف الدخول من تيليجرام.');
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.result.file_path}`);
    if (!res.ok) throw new Error('فشل تنزيل ملف الدخول.');
    // اقرأ البايتات نفسها كما يفعل التطبيق ولا تعتمد على تحويل HTTP إلى نص.
    // ملفات .mzauth عبارة عن Base64 ASCII؛ هذا يمنع أي اختلاف ترميز/BOM أثناء تنزيل تيليجرام.
    const fileBytes = new Uint8Array(await res.arrayBuffer());
    const opaque = activationFileAscii(fileBytes);
    const payload = await unpackActivationFile(opaque);
    const verified = await verifyActivationPayload(payload);
    if (verified?.account) payload.account = { ...(payload.account || {}), ...verified.account };
    await env.DB.prepare(`INSERT INTO telegram_sessions(
      chat_id,company_id,company_name,account_id,account_name,account_role,payload_json,logged_in_at,updated_at,active
    ) VALUES(?,?,?,?,?,?,?,?,?,1)
    ON CONFLICT(chat_id) DO UPDATE SET
      company_id=excluded.company_id,company_name=excluded.company_name,account_id=excluded.account_id,
      account_name=excluded.account_name,account_role=excluded.account_role,payload_json=excluded.payload_json,
      logged_in_at=excluded.logged_in_at,updated_at=excluded.updated_at,active=1`).bind(
        chatId,
        String(payload.companyId || payload.tenantId || ''),
        String(payload.companyName || ''),
        String(payload.account?.id || ''),
        String(payload.account?.name || 'مستخدم'),
        String(payload.account?.roleName || payload.account?.role || payload.type || ''),
        JSON.stringify(payload),
        new Date().toISOString(),
        new Date().toISOString()
      ).run();
    await setState(chatId, 'IDLE', {}, env);
    await sendMessage(chatId,
      `✅ <b>تم تسجيل الدخول بنجاح</b>\n\n🏢 ${e(payload.companyName || 'الشركة')}\n👤 ${e(payload.account?.name || 'مستخدم')}\n🛡 ${e(payload.account?.roleName || payload.account?.role || (payload.type === 'company-manager' ? 'مدير الشركة' : 'حساب أوسكار'))}`
    );
    return showMainMenu(chatId, { payload });
  } catch (error) {
    console.error('LOGIN_ERROR', error);
    return sendMessage(chatId, `❌ <b>تعذر تسجيل الدخول</b>\n\n${e(String(error?.message || error))}\n\nتأكد أنك أرسلت أحدث ملف دخول صالح.`);
  }
}

async function logout(chatId, env) {
  await env.DB.prepare('UPDATE telegram_sessions SET active=0,updated_at=? WHERE chat_id=?').bind(new Date().toISOString(), chatId).run();
  await setState(chatId, 'IDLE', {}, env);
  return sendMessage(chatId, '🚪 تم تسجيل الخروج من حساب أوسكار.\n\nأرسل ملف <code>.mzauth</code> للدخول من جديد.');
}

function hasPerm(session, key) {
  const p = session?.payload || session;
  if (!p) return false;
  if (p.type === 'company-manager') return true;
  const role = String(p.account?.role || '').toLowerCase();
  if (role === 'admin') return true;
  const perms = p.account?.permissions || p.permissions || {};
  return perms?.[key] === true;
}

async function showMainMenu(chatId, session) {
  const p = session.payload || session;
  const buttons = [];
  const row = (...items) => buttons.push(items);
  if (hasPerm(session, 'canAccessDashboard')) row(btn('📊 الرئيسية', 'dashboard'), btn('🔎 بحث شامل', 'global_search'));
  if (hasPerm(session, 'canAccessCashier')) row(btn('🛒 البيع', 'sale'), btn('🧺 السلة', 'cart'));
  if (hasPerm(session, 'canAccessProducts') || hasPerm(session, 'canAccessCashier')) row(btn('📦 الأصناف', 'products'), btn('🗂 الأقسام', 'categories'));
  if (hasPerm(session, 'canAccessSales')) row(btn('🧾 الفواتير', 'invoices'), btn('↩️ المرتجعات', 'returns'));
  if (hasPerm(session, 'canAccessCustomers')) row(btn('👥 العملاء', 'customers'), btn('💳 ديون العملاء', 'customer_debts'));
  if (hasPerm(session, 'canAccessSuppliers')) row(btn('🏭 الموردون', 'suppliers'), btn('📒 حسابات الموردين', 'supplier_balances'));
  if (hasPerm(session, 'canAccessAccounts')) row(btn('💰 الحسابات', 'accounts'), btn('🕐 الورديات', 'shifts'));
  if (hasPerm(session, 'canAccessVouchers')) row(btn('💵 السندات', 'vouchers'), btn('➕ سند جديد', 'voucher_new'));
  if (hasPerm(session, 'canAccessPurchases')) row(btn('🛍 المشتريات', 'purchases'));
  if (hasPerm(session, 'canAccessExpenses')) row(btn('💸 المصروفات', 'expenses'), btn('➕ مصروف جديد', 'expense_new'));
  if (hasPerm(session, 'canAccessInventory')) row(btn('📚 المخزون', 'inventory'), btn('⚠️ النواقص', 'low_stock'));
  if (hasPerm(session, 'canAccessReports') || p.type === 'company-manager') row(btn('📈 التقارير', 'reports'));
  row(btn('👤 حسابي', 'account'), btn('🚪 تسجيل خروج', 'logout'));
  return sendMessage(chatId,
    `🏠 <b>أوسكار المحاسبي</b>\n🏢 ${e(p.companyName || 'الشركة')}\n👤 ${e(p.account?.name || 'مستخدم')}\n\nاختر القسم:`,
    { inline_keyboard: buttons }
  );
}

function btn(text, callback_data) { return { text, callback_data }; }
function mainMenuButton() { return { inline_keyboard: [[btn('🏠 القائمة الرئيسية', 'menu')]] }; }
function backButton() { return { inline_keyboard: [[btn('⬅️ رجوع', 'menu')]] }; }

async function handleCallback(chatId, data, env) {
  if (data === 'login_help') return askForLoginFile(chatId);
  const session = await getSession(chatId, env);
  if (!session) return askForLoginFile(chatId);
  if (data === 'menu') { await setState(chatId, 'IDLE', {}, env); return showMainMenu(chatId, session); }
  if (data === 'logout') return logout(chatId, env);
  if (data === 'dashboard') return showDashboard(chatId, session);
  if (data === 'account') return showAccount(chatId, session);
  if (data === 'global_search') { await setState(chatId, 'GLOBAL_SEARCH', {}, env); return sendMessage(chatId, '🔎 اكتب كلمة البحث الآن:', backButton()); }
  if (data === 'products') return showProducts(chatId, session, env);
  if (data === 'categories') return showCategories(chatId, session, env, false);
  if (data === 'sale') return showCategories(chatId, session, env, true);
  if (data === 'cart') return showCart(chatId, session, env);
  if (data === 'invoices') return showInvoices(chatId, session, env, 'sale');
  if (data === 'returns') return showInvoices(chatId, session, env, 'return');
  if (data === 'customers') return showCustomers(chatId, session, env);
  if (data === 'customer_debts') return showCustomerDebts(chatId, session);
  if (data === 'suppliers') return showSuppliers(chatId, session, env);
  if (data === 'supplier_balances') return showSupplierBalances(chatId, session);
  if (data === 'accounts') return showAccounts(chatId, session);
  if (data === 'shifts') return showShifts(chatId, session);
  if (data === 'vouchers') return showVouchers(chatId, session);
  if (data === 'voucher_new') return beginVoucher(chatId, session, env);
  if (data === 'purchases') return showPurchases(chatId, session);
  if (data === 'expenses') return showExpenses(chatId, session);
  if (data === 'expense_new') return beginExpense(chatId, session, env);
  if (data === 'inventory') return showInventory(chatId, session);
  if (data === 'low_stock') return showLowStock(chatId, session);
  if (data === 'reports') return showReports(chatId, session);
  if (data === 'sale_search') { await setState(chatId, 'SALE_SEARCH', {}, env); return sendMessage(chatId, '🔎 اكتب اسم الصنف أو SKU أو الباركود:', backButton()); }
  if (data === 'product_search') { await setState(chatId, 'PRODUCT_SEARCH', {}, env); return sendMessage(chatId, '🔎 اكتب اسم الصنف أو SKU أو الباركود:', backButton()); }
  if (data === 'invoice_search') { await setState(chatId, 'INVOICE_SEARCH', {}, env); return sendMessage(chatId, '🔎 اكتب رقم الفاتورة أو اسم العميل:', backButton()); }
  if (data === 'customer_search') { await setState(chatId, 'CUSTOMER_SEARCH', {}, env); return sendMessage(chatId, '🔎 اكتب اسم العميل أو رقم الهاتف:', backButton()); }
  if (data === 'supplier_search') { await setState(chatId, 'SUPPLIER_SEARCH', {}, env); return sendMessage(chatId, '🔎 اكتب اسم المورد أو رقم الهاتف:', backButton()); }

  const state = await getState(chatId, env);
  if (data.startsWith('cat:')) return openCategory(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('prod:')) return openProduct(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('unit:')) return addUnitToCart(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('cart_rm:')) return removeCartItem(chatId, session, Number(data.split(':')[1]), env);
  if (data === 'cart_clear') { await patchState(chatId, d => ({ ...d, cart: [] }), env); return showCart(chatId, session, env); }
  if (data === 'checkout_cash') return checkoutCash(chatId, session, env);
  if (data === 'checkout_debt') return chooseDebtCustomer(chatId, session, env);
  if (data.startsWith('debtcust:')) return checkoutDebtForCustomer(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('inv:')) return showInvoiceDetail(chatId, session, state, Number(data.split(':')[1]));
  if (data.startsWith('cust:')) return showCustomerDetail(chatId, session, state, Number(data.split(':')[1]));
  if (data.startsWith('supp:')) return showSupplierDetail(chatId, session, state, Number(data.split(':')[1]));
  if (data === 'voucher_receipt') return chooseVoucherParty(chatId, session, 'receipt', env);
  if (data === 'voucher_payment') return chooseVoucherParty(chatId, session, 'payment', env);
  if (data.startsWith('vparty:')) return chooseVoucherPartyIndex(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('excat:')) return finishExpenseCategory(chatId, session, state, Number(data.split(':')[1]), env);
  return showMainMenu(chatId, session);
}

async function handleStateText(chatId, text, session, state, env) {
  if (!text) return sendMessage(chatId, 'اكتب قيمة نصية صحيحة.', backButton());
  if (state.mode === 'GLOBAL_SEARCH') {
    await setState(chatId, 'IDLE', {}, env);
    return globalSearch(chatId, session, text);
  }
  if (state.mode === 'SALE_SEARCH' || state.mode === 'PRODUCT_SEARCH') {
    const products = await searchProducts(session.payload, text);
    const ids = products.slice(0, 12).map(x => x.id);
    const saleMode = state.mode === 'SALE_SEARCH';
    await setState(chatId, saleMode ? 'SALE_PRODUCTS' : 'BROWSE_PRODUCTS', { product_ids: ids, cart: state.data?.cart || [], saleMode }, env);
    return sendProductResults(chatId, products.slice(0, 12), saleMode);
  }
  if (state.mode === 'INVOICE_SEARCH') {
    const all = await readStore(session.payload, 'invoices');
    const q = norm(text);
    const rows = all.filter(x => norm(x.invoiceNumber).includes(q) || norm(x.customerName).includes(q)).slice(0, 12);
    const ids = rows.map(x => x.id);
    await setState(chatId, 'INVOICE_RESULTS', { invoice_ids: ids }, env);
    return sendInvoiceResults(chatId, rows);
  }
  if (state.mode === 'CUSTOMER_SEARCH') {
    const all = await readStore(session.payload, 'customers');
    const q = norm(text);
    const rows = all.filter(x => norm(x.name).includes(q) || norm(x.phone).includes(q)).slice(0, 12);
    await setState(chatId, 'CUSTOMER_RESULTS', { customer_ids: rows.map(x => x.id) }, env);
    return sendCustomerResults(chatId, rows);
  }
  if (state.mode === 'SUPPLIER_SEARCH') {
    const all = await readStore(session.payload, 'suppliers');
    const q = norm(text);
    const rows = all.filter(x => norm(x.name).includes(q) || norm(x.phone).includes(q)).slice(0, 12);
    await setState(chatId, 'SUPPLIER_RESULTS', { supplier_ids: rows.map(x => x.id) }, env);
    return sendSupplierResults(chatId, rows);
  }
  if (state.mode === 'VOUCHER_AMOUNT') {
    const amount = Number(String(text).replace(',', '.'));
    if (!(amount > 0)) return sendMessage(chatId, '❌ اكتب مبلغاً صحيحاً أكبر من صفر.');
    const data = { ...state.data, amount };
    await setState(chatId, 'VOUCHER_NOTES', data, env);
    return sendMessage(chatId, '📝 اكتب ملاحظات السند، أو اكتب <code>-</code> بدون ملاحظات.');
  }
  if (state.mode === 'VOUCHER_NOTES') {
    const data = { ...state.data, notes: text === '-' ? '' : text };
    const result = await createVoucherRemote(session.payload, data, chatId);
    await setState(chatId, 'IDLE', {}, env);
    return sendMessage(chatId, `✅ تم إنشاء السند رقم <b>${e(result.voucherNumber)}</b> بمبلغ <b>${money(result.amount, result.currency)}</b>.`, mainMenuButton());
  }
  if (state.mode === 'EXPENSE_AMOUNT') {
    const amount = Number(String(text).replace(',', '.'));
    if (!(amount > 0)) return sendMessage(chatId, '❌ اكتب مبلغاً صحيحاً أكبر من صفر.');
    const settings = await getSettings(session.payload);
    const cats = Array.isArray(settings.expenseCategories) && settings.expenseCategories.length ? settings.expenseCategories : ['أخرى'];
    await setState(chatId, 'EXPENSE_CATEGORY', { amount, categories: cats }, env);
    return sendMessage(chatId, `💸 المبلغ: <b>${money(amount, settings.currencySymbol || '₪')}</b>\nاختر نوع المصروف:`, {
      inline_keyboard: chunk(cats.slice(0, 20).map((c, i) => btn(c, `excat:${i}`)), 2).concat([[btn('⬅️ إلغاء', 'menu')]])
    });
  }
  if (state.mode === 'EXPENSE_NOTES') {
    const data = { ...state.data, notes: text === '-' ? '' : text };
    const result = await createExpenseRemote(session.payload, data, chatId);
    await setState(chatId, 'IDLE', {}, env);
    return sendMessage(chatId, `✅ تم تسجيل المصروف <b>${money(result.amount, result.currency)}</b> — ${e(result.category)}`, mainMenuButton());
  }
  return showMainMenu(chatId, session);
}

async function showDashboard(chatId, session) {
  const p = session.payload;
  const [invoices, purchases, customers, suppliers, stock, products, accounts, expenses, settings] = await Promise.all([
    readStore(p, 'invoices'), readStore(p, 'purchases'), readStore(p, 'customers'), readStore(p, 'suppliers'),
    readStore(p, 'stock'), readStore(p, 'products'), readStore(p, 'accounts'), readStore(p, 'expenses'), getSettings(p)
  ]);
  const today = new Date().toISOString().slice(0,10);
  const todaySales = invoices.filter(x => String(x.date || '').slice(0,10) === today && x.type === 'sale').reduce((s,x)=>s+num(x.grandTotal),0);
  const todayPurchases = purchases.filter(x => String(x.date || '').slice(0,10) === today).reduce((s,x)=>s+num(x.grandTotal),0);
  const todayExpenses = expenses.filter(x => String(x.date || x.createdAt || '').slice(0,10) === today && !x.deletedAt).reduce((s,x)=>s+num(x.amount),0);
  const ar = customers.reduce((s,x)=>s+Math.max(0,num(x.balance)),0);
  const ap = suppliers.reduce((s,x)=>s+Math.max(0,num(x.balance)),0);
  const totalAccounts = accounts.reduce((s,x)=>s+num(x.balance),0);
  const low = countLowStock(products, stock, settings.activeWarehouseId);
  const cur = settings.currencySymbol || '₪';
  return sendMessage(chatId,
    `📊 <b>لوحة التحكم</b>\n\n`+
    `🧾 مبيعات اليوم: <b>${money(todaySales, cur)}</b>\n`+
    `🛍 مشتريات اليوم: <b>${money(todayPurchases, cur)}</b>\n`+
    `💸 مصروفات اليوم: <b>${money(todayExpenses, cur)}</b>\n`+
    `💰 أرصدة الحسابات: <b>${money(totalAccounts, cur)}</b>\n`+
    `👥 مستحق على العملاء: <b>${money(ar, cur)}</b>\n`+
    `🏭 مستحق للموردين: <b>${money(ap, cur)}</b>\n`+
    `⚠️ أصناف منخفضة: <b>${low}</b>`,
    mainMenuButton()
  );
}

async function showAccount(chatId, session) {
  const p = session.payload;
  return sendMessage(chatId,
    `👤 <b>الحساب الحالي</b>\n\n🏢 ${e(p.companyName || '')}\n👤 ${e(p.account?.name || '')}\n📱 ${e(p.account?.phone || '—')}\n🛡 ${e(p.account?.roleName || p.account?.role || (p.type==='company-manager'?'مدير الشركة':'حساب'))}\n🆔 <code>${e(p.account?.id || '')}</code>`,
    { inline_keyboard: [[btn('🚪 تسجيل خروج', 'logout')],[btn('🏠 الرئيسية', 'menu')]] }
  );
}

async function showProducts(chatId, session, env) {
  const products = (await readStore(session.payload, 'products')).filter(x => !x.deletedAt).sort((a,b)=>Date.parse(b.createdAt||0)-Date.parse(a.createdAt||0)).slice(0, 10);
  await setState(chatId, 'PRODUCT_RESULTS', { product_ids: products.map(x=>x.id) }, env);
  return sendMessage(chatId,
    `📦 <b>الأصناف</b> — أحدث ${products.length}\n\n` + products.map((x,i)=>`${i+1}. ${e(x.name)} — ${money(defaultSalePrice(x), '')}`).join('\n'),
    { inline_keyboard: [[btn('🔎 بحث عن صنف', 'product_search')],[btn('🗂 الأقسام', 'categories'),btn('🏠 الرئيسية','menu')]] }
  );
}

async function showCategories(chatId, session, env, saleMode) {
  const cats = (await readStore(session.payload, 'categories')).filter(x => !x.deletedAt).sort((a,b)=>num(a.displayOrder)-num(b.displayOrder));
  await setState(chatId, saleMode ? 'SALE_CATEGORIES' : 'BROWSE_CATEGORIES', { category_ids: cats.map(x=>x.id), saleMode, cart: (await getState(chatId, env)).data?.cart || [] }, env);
  const buttons = cats.slice(0, 30).map((c,i)=>btn(`📁 ${c.name}`,`cat:${i}`));
  const footer = saleMode ? [[btn('🔎 بحث صنف','sale_search'),btn('🧺 السلة','cart')],[btn('🏠 الرئيسية','menu')]] : [[btn('🔎 بحث صنف','product_search')],[btn('🏠 الرئيسية','menu')]];
  return sendMessage(chatId, saleMode ? '🛒 <b>البيع — اختر القسم</b>' : '🗂 <b>أقسام الأصناف</b>', { inline_keyboard: chunk(buttons,2).concat(footer) });
}

async function openCategory(chatId, session, state, idx, env) {
  const categoryId = state.data?.category_ids?.[idx];
  if (!categoryId) return showMainMenu(chatId, session);
  const all = (await readStore(session.payload, 'products')).filter(x => !x.deletedAt && String(x.categoryId||'')===String(categoryId));
  const saleMode = !!state.data?.saleMode || state.mode === 'SALE_CATEGORIES';
  const ids = all.slice(0, 20).map(x=>x.id);
  await setState(chatId, saleMode ? 'SALE_PRODUCTS' : 'BROWSE_PRODUCTS', { ...state.data, product_ids: ids, saleMode }, env);
  return sendProductResults(chatId, all.slice(0,20), saleMode);
}

async function sendProductResults(chatId, products, saleMode) {
  if (!products.length) return sendMessage(chatId, 'لا توجد أصناف مطابقة.', { inline_keyboard:[[btn('🔎 بحث','sale_search')],[btn('🏠 الرئيسية','menu')]] });
  const buttons = products.map((p,i)=>btn(`${p.name} • ${money(defaultSalePrice(p),'')}`,`prod:${i}`));
  return sendMessage(chatId, `${saleMode?'🛒':'📦'} <b>${saleMode?'اختر الصنف للبيع':'نتائج الأصناف'}</b>`, {
    inline_keyboard: buttons.map(x=>[x]).concat([[btn('🔎 بحث', saleMode?'sale_search':'product_search'), saleMode?btn('🧺 السلة','cart'):btn('🏠 الرئيسية','menu')],[btn('🏠 الرئيسية','menu')]])
  });
}

async function openProduct(chatId, session, state, idx, env) {
  const productId = state.data?.product_ids?.[idx];
  if (!productId) return showMainMenu(chatId, session);
  const products = await readStore(session.payload, 'products');
  const p = products.find(x=>String(x.id)===String(productId));
  if (!p) return sendMessage(chatId,'الصنف غير موجود.',mainMenuButton());
  const settings = await getSettings(session.payload);
  const stock = await readStore(session.payload, 'stock');
  const wh = settings.activeWarehouseId;
  const st = stock.find(x=>String(x.productId)===String(p.id)&&String(x.warehouseId)===String(wh));
  const units = Array.isArray(p.units)&&p.units.length?p.units:[{id:p.baseUnitId||'base',name:p.baseUnitName||'وحدة',conversionToBase:1,salePrice:num(p.salePrice),isDefaultSale:true}];
  const saleMode = !!state.data?.saleMode || state.mode.startsWith('SALE');
  await setState(chatId, saleMode?'SALE_PRODUCT':'PRODUCT_DETAIL', { ...state.data, selected_product_id:p.id, unit_ids:units.map(u=>u.id), saleMode }, env);
  const text = `📦 <b>${e(p.name)}</b>\n`+
    `🏷 ${e(p.internalCode||p.sku||'—')}\n`+
    `📊 المخزون الأساسي: <b>${num(st?.baseQuantity).toFixed(2)}</b>\n`+
    `💵 السعر: <b>${money(defaultSalePrice(p),settings.currencySymbol||'₪')}</b>`;
  if (!saleMode) return sendMessage(chatId,text,{inline_keyboard:[[btn('🛒 بيع هذا الصنف','sale')],[btn('🏠 الرئيسية','menu')]]});
  return sendMessage(chatId, text+'\n\nاختر الوحدة لإضافة كمية 1 إلى السلة:', {
    inline_keyboard: units.slice(0,15).map((u,i)=>[btn(`➕ 1 ${u.name} — ${money(num(u.salePrice)||defaultSalePrice(p),settings.currencySymbol||'₪')}`,`unit:${i}`)]).concat([[btn('🧺 السلة','cart'),btn('🏠 الرئيسية','menu')]])
  });
}

async function addUnitToCart(chatId, session, state, unitIdx, env) {
  const productId = state.data?.selected_product_id;
  const unitId = state.data?.unit_ids?.[unitIdx];
  if (!productId || !unitId) return showMainMenu(chatId,session);
  await patchState(chatId, data => {
    const cart = Array.isArray(data.cart)?[...data.cart]:[];
    const hit = cart.find(x=>String(x.productId)===String(productId)&&String(x.unitId)===String(unitId));
    if (hit) hit.quantity = num(hit.quantity)+1; else cart.push({productId,unitId,quantity:1});
    return {...data,cart};
  }, env);
  return sendMessage(chatId,'✅ تم إضافة الصنف إلى السلة.',{inline_keyboard:[[btn('🧺 عرض السلة','cart'),btn('➕ متابعة البيع','sale')],[btn('🏠 الرئيسية','menu')]]});
}

async function showCart(chatId, session, env) {
  const state = await getState(chatId, env);
  const cart = Array.isArray(state.data?.cart)?state.data.cart:[];
  if (!cart.length) return sendMessage(chatId,'🧺 السلة فارغة.',{inline_keyboard:[[btn('🛒 بدء البيع','sale')],[btn('🏠 الرئيسية','menu')]]});
  const products = await readStore(session.payload,'products');
  const settings = await getSettings(session.payload);
  const lines=[]; let total=0;
  cart.forEach((ci,i)=>{const p=products.find(x=>String(x.id)===String(ci.productId));if(!p)return;const u=(p.units||[]).find(x=>String(x.id)===String(ci.unitId))||{};const price=num(u.salePrice)||defaultSalePrice(p);const line=price*num(ci.quantity);total+=line;lines.push(`${i+1}. ${e(p.name)} — ${num(ci.quantity)} ${e(u.name||p.baseUnitName||'وحدة')} × ${money(price,settings.currencySymbol||'₪')} = <b>${money(line,settings.currencySymbol||'₪')}</b>`)});
  const rm = cart.slice(0,8).map((_,i)=>btn(`🗑 ${i+1}`,`cart_rm:${i}`));
  return sendMessage(chatId,`🧺 <b>سلة البيع</b>\n\n${lines.join('\n')}\n\n💰 الإجمالي: <b>${money(total,settings.currencySymbol||'₪')}</b>`,{
    inline_keyboard: [[btn('💵 إتمام نقدي','checkout_cash'),btn('🧾 بيع آجل','checkout_debt')],...[chunk(rm,4)], [btn('🗑 تفريغ السلة','cart_clear'),btn('➕ إضافة أصناف','sale')],[btn('🏠 الرئيسية','menu')]].flatMap(x=>Array.isArray(x[0])?x:[x])
  });
}

async function removeCartItem(chatId, session, idx, env){
  await patchState(chatId,d=>{const cart=Array.isArray(d.cart)?[...d.cart]:[];cart.splice(idx,1);return{...d,cart}},env);
  return showCart(chatId,session,env);
}

async function checkoutCash(chatId, session, env) {
  const state=await getState(chatId,env);const cart=state.data?.cart||[];
  if(!cart.length)return showCart(chatId,session,env);
  await sendMessage(chatId,'⏳ جاري حفظ الفاتورة وتحديث المخزون والحسابات...');
  try{
    const invoice=await createSaleRemote(session.payload,cart,{paymentType:'cash'},chatId);
    await patchState(chatId,d=>({...d,cart:[]}),env);
    return sendMessage(chatId,formatInvoiceNotification(invoice,session.payload.companyName),{inline_keyboard:[[btn('🛒 بيع جديد','sale'),btn('🧾 الفواتير','invoices')],[btn('🏠 الرئيسية','menu')]]});
  }catch(error){return sendMessage(chatId,`❌ تعذر إتمام البيع:\n${e(String(error?.message||error))}`,{inline_keyboard:[[btn('🧺 السلة','cart')],[btn('🏠 الرئيسية','menu')]]})}
}

async function chooseDebtCustomer(chatId, session, env) {
  const customers=(await readStore(session.payload,'customers')).filter(x=>!x.deletedAt&&String(x.id)!=='cust-walkin').slice(0,20);
  if(!customers.length)return sendMessage(chatId,'لا يوجد عملاء مسجلون للبيع الآجل.',mainMenuButton());
  const state=await getState(chatId,env);await setState(chatId,'DEBT_CUSTOMER',{...state.data,customer_ids:customers.map(x=>x.id)},env);
  return sendMessage(chatId,'👥 اختر العميل للبيع الآجل:',{inline_keyboard:customers.map((x,i)=>[btn(`${x.name} • رصيد ${num(x.balance).toFixed(2)}`,`debtcust:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});
}

async function checkoutDebtForCustomer(chatId, session, state, idx, env) {
  const customerId=state.data?.customer_ids?.[idx]; const cart=state.data?.cart||[];
  if(!customerId||!cart.length)return showCart(chatId,session,env);
  await sendMessage(chatId,'⏳ جاري حفظ فاتورة الآجل...');
  try{
    const invoice=await createSaleRemote(session.payload,cart,{paymentType:'debt',customerId},chatId);
    await patchState(chatId,d=>({...d,cart:[]}),env);
    return sendMessage(chatId,formatInvoiceNotification(invoice,session.payload.companyName),{inline_keyboard:[[btn('🛒 بيع جديد','sale'),btn('🧾 الفواتير','invoices')],[btn('🏠 الرئيسية','menu')]]});
  }catch(error){return sendMessage(chatId,`❌ ${e(String(error?.message||error))}`,mainMenuButton())}
}

async function showInvoices(chatId, session, env, type) {
  const rows=(await readStore(session.payload,'invoices')).filter(x=>type==='return'?x.type==='return':x.type!=='return').sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)).slice(0,12);
  await setState(chatId,'INVOICE_RESULTS',{invoice_ids:rows.map(x=>x.id)},env);
  return sendInvoiceResults(chatId,rows);
}
async function sendInvoiceResults(chatId,rows){
  const text=rows.length?rows.map((x,i)=>`${i+1}. ${e(x.invoiceNumber||x.id)} — ${e(x.customerName||x.supplierName||'')} — ${num(x.grandTotal).toFixed(2)}`).join('\n'):'لا توجد فواتير.';
  return sendMessage(chatId,`🧾 <b>الفواتير</b>\n\n${text}`,{inline_keyboard:rows.map((x,i)=>[btn(`${x.invoiceNumber||x.id} • ${num(x.grandTotal).toFixed(2)}`,`inv:${i}`)]).concat([[btn('🔎 بحث فاتورة','invoice_search')],[btn('🏠 الرئيسية','menu')]])});
}
async function showInvoiceDetail(chatId,session,state,idx){
  const id=state.data?.invoice_ids?.[idx];if(!id)return showMainMenu(chatId,session);const rows=await readStore(session.payload,'invoices');const x=rows.find(r=>String(r.id)===String(id));if(!x)return sendMessage(chatId,'الفاتورة غير موجودة.',mainMenuButton());
  return sendMessage(chatId,formatInvoiceNotification(x,session.payload.companyName),mainMenuButton());
}

async function showCustomers(chatId,session,env){const rows=(await readStore(session.payload,'customers')).filter(x=>!x.deletedAt).slice(0,12);await setState(chatId,'CUSTOMER_RESULTS',{customer_ids:rows.map(x=>x.id)},env);return sendCustomerResults(chatId,rows)}
async function sendCustomerResults(chatId,rows){return sendMessage(chatId,`👥 <b>العملاء</b>\n\n${rows.length?rows.map((x,i)=>`${i+1}. ${e(x.name)} — ${e(x.phone||'')} — الرصيد ${num(x.balance).toFixed(2)}`).join('\n'):'لا يوجد عملاء.'}`,{inline_keyboard:rows.map((x,i)=>[btn(x.name,`cust:${i}`)]).concat([[btn('🔎 بحث عميل','customer_search')],[btn('🏠 الرئيسية','menu')]])})}
async function showCustomerDetail(chatId,session,state,idx){const id=state.data?.customer_ids?.[idx];const rows=await readStore(session.payload,'customers');const x=rows.find(r=>String(r.id)===String(id));if(!x)return sendMessage(chatId,'العميل غير موجود.',mainMenuButton());return sendMessage(chatId,`👤 <b>${e(x.name)}</b>\n📱 ${e(x.phone||'—')}\n💳 الرصيد: <b>${num(x.balance).toFixed(2)}</b>\n📍 ${e(x.address||'—')}`,mainMenuButton())}
async function showCustomerDebts(chatId,session){const s=await getSettings(session.payload);const rows=(await readStore(session.payload,'customers')).filter(x=>num(x.balance)>0).sort((a,b)=>num(b.balance)-num(a.balance)).slice(0,20);return sendMessage(chatId,`💳 <b>ديون العملاء</b>\n\n${rows.length?rows.map(x=>`${e(x.name)}: <b>${money(x.balance,s.currencySymbol||'₪')}</b>`).join('\n'):'لا توجد ديون عملاء.'}`,mainMenuButton())}

async function showSuppliers(chatId,session,env){const rows=(await readStore(session.payload,'suppliers')).filter(x=>!x.deletedAt).slice(0,12);await setState(chatId,'SUPPLIER_RESULTS',{supplier_ids:rows.map(x=>x.id)},env);return sendSupplierResults(chatId,rows)}
async function sendSupplierResults(chatId,rows){return sendMessage(chatId,`🏭 <b>الموردون</b>\n\n${rows.length?rows.map((x,i)=>`${i+1}. ${e(x.name)} — ${e(x.phone||'')} — ${num(x.balance).toFixed(2)}`).join('\n'):'لا يوجد موردون.'}`,{inline_keyboard:rows.map((x,i)=>[btn(x.name,`supp:${i}`)]).concat([[btn('🔎 بحث مورد','supplier_search')],[btn('🏠 الرئيسية','menu')]])})}
async function showSupplierDetail(chatId,session,state,idx){const id=state.data?.supplier_ids?.[idx];const rows=await readStore(session.payload,'suppliers');const x=rows.find(r=>String(r.id)===String(id));if(!x)return sendMessage(chatId,'المورد غير موجود.',mainMenuButton());return sendMessage(chatId,`🏭 <b>${e(x.name)}</b>\n📱 ${e(x.phone||'—')}\n💳 الرصيد: <b>${num(x.balance).toFixed(2)}</b>\n📍 ${e(x.address||'—')}`,mainMenuButton())}
async function showSupplierBalances(chatId,session){const s=await getSettings(session.payload);const rows=(await readStore(session.payload,'suppliers')).filter(x=>num(x.balance)!==0).sort((a,b)=>Math.abs(num(b.balance))-Math.abs(num(a.balance))).slice(0,20);return sendMessage(chatId,`📒 <b>حسابات الموردين</b>\n\n${rows.length?rows.map(x=>`${e(x.name)}: <b>${money(x.balance,s.currencySymbol||'₪')}</b>`).join('\n'):'لا توجد أرصدة موردين.'}`,mainMenuButton())}

async function showAccounts(chatId,session){const s=await getSettings(session.payload);const rows=await readStore(session.payload,'accounts');return sendMessage(chatId,`💰 <b>الحسابات المالية</b>\n\n${rows.length?rows.map(x=>`${x.isDefault?'⭐ ':''}${e(x.name)}: <b>${money(x.balance,s.currencySymbol||'₪')}</b>`).join('\n'):'لا توجد حسابات.'}`,mainMenuButton())}
async function showShifts(chatId,session){const s=await getSettings(session.payload);const rows=(await readStore(session.payload,'shifts')).sort((a,b)=>Date.parse(b.startTime||0)-Date.parse(a.startTime||0)).slice(0,10);return sendMessage(chatId,`🕐 <b>الورديات</b>\n\n${rows.length?rows.map(x=>`#${e(x.shiftNumber||x.id)} — ${e(x.status||'')} — متوقع ${money(x.expectedCash,s.currencySymbol||'₪')}`).join('\n'):'لا توجد ورديات.'}`,mainMenuButton())}

async function showVouchers(chatId,session){const s=await getSettings(session.payload);const rows=(await readStore(session.payload,'vouchers')).sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)).slice(0,12);return sendMessage(chatId,`💵 <b>السندات</b>\n\n${rows.length?rows.map(x=>`${x.type==='receipt'?'⬇️ قبض':'⬆️ صرف'} #${e(x.voucherNumber)} — ${e(x.partyName||'')} — ${money(x.amount,s.currencySymbol||'₪')}`).join('\n'):'لا توجد سندات.'}`,{inline_keyboard:[[btn('➕ سند قبض','voucher_receipt'),btn('➖ سند صرف','voucher_payment')],[btn('🏠 الرئيسية','menu')]]})}
async function beginVoucher(chatId,session,env){await setState(chatId,'VOUCHER_TYPE',{},env);return sendMessage(chatId,'💵 اختر نوع السند:',{inline_keyboard:[[btn('⬇️ سند قبض من عميل','voucher_receipt')],[btn('⬆️ سند صرف لمورد','voucher_payment')],[btn('🏠 إلغاء','menu')]]})}
async function chooseVoucherParty(chatId,session,type,env){const store=type==='receipt'?'customers':'suppliers';const rows=(await readStore(session.payload,store)).filter(x=>!x.deletedAt).slice(0,20);await setState(chatId,'VOUCHER_PARTY',{voucherType:type,party_ids:rows.map(x=>x.id),partyStore:store},env);return sendMessage(chatId,type==='receipt'?'👥 اختر العميل:':'🏭 اختر المورد:',{inline_keyboard:rows.map((x,i)=>[btn(x.name,`vparty:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])})}
async function chooseVoucherPartyIndex(chatId,session,state,idx,env){const id=state.data?.party_ids?.[idx];if(!id)return showMainMenu(chatId,session);await setState(chatId,'VOUCHER_AMOUNT',{...state.data,partyId:id},env);return sendMessage(chatId,'💵 اكتب مبلغ السند:')}

async function showPurchases(chatId,session){const s=await getSettings(session.payload);const rows=(await readStore(session.payload,'purchases')).sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)).slice(0,12);return sendMessage(chatId,`🛍 <b>المشتريات</b>\n\n${rows.length?rows.map(x=>`${e(x.invoiceNumber||x.id)} — ${e(x.supplierName||'')} — <b>${money(x.grandTotal,s.currencySymbol||'₪')}</b>`).join('\n'):'لا توجد مشتريات.'}`,mainMenuButton())}
async function showExpenses(chatId,session){const s=await getSettings(session.payload);const rows=(await readStore(session.payload,'expenses')).filter(x=>!x.deletedAt).sort((a,b)=>Date.parse(b.date||b.createdAt||0)-Date.parse(a.date||a.createdAt||0)).slice(0,12);return sendMessage(chatId,`💸 <b>المصروفات</b>\n\n${rows.length?rows.map(x=>`${e(x.category||'أخرى')} — ${money(x.amount,s.currencySymbol||'₪')} — ${String(x.date||'').slice(0,10)}`).join('\n'):'لا توجد مصروفات.'}`,{inline_keyboard:[[btn('➕ مصروف جديد','expense_new')],[btn('🏠 الرئيسية','menu')]]})}
async function beginExpense(chatId,session,env){await setState(chatId,'EXPENSE_AMOUNT',{},env);return sendMessage(chatId,'💸 اكتب مبلغ المصروف:')}
async function finishExpenseCategory(chatId,session,state,idx,env){const category=state.data?.categories?.[idx]||'أخرى';await setState(chatId,'EXPENSE_NOTES',{...state.data,category},env);return sendMessage(chatId,`📝 النوع: <b>${e(category)}</b>\nاكتب الملاحظات أو <code>-</code> بدون ملاحظات.`)}

async function showInventory(chatId,session){const settings=await getSettings(session.payload);const [products,stock]=await Promise.all([readStore(session.payload,'products'),readStore(session.payload,'stock')]);const wh=settings.activeWarehouseId;const map=new Map(stock.filter(x=>String(x.warehouseId)===String(wh)).map(x=>[String(x.productId),num(x.baseQuantity)]));const rows=products.filter(x=>!x.deletedAt).slice(0,30);return sendMessage(chatId,`📚 <b>المخزون — ${e(wh||'المخزن')}</b>\n\n${rows.map(x=>`${e(x.name)}: <b>${(map.get(String(x.id))||0).toFixed(2)}</b>`).join('\n')}`,mainMenuButton())}
async function showLowStock(chatId,session){const settings=await getSettings(session.payload);const [products,stock]=await Promise.all([readStore(session.payload,'products'),readStore(session.payload,'stock')]);const wh=settings.activeWarehouseId;const map=new Map(stock.filter(x=>String(x.warehouseId)===String(wh)).map(x=>[String(x.productId),num(x.baseQuantity)]));const rows=products.filter(x=>!x.deletedAt&&(map.get(String(x.id))||0)<=num(x.reorderPoint)).slice(0,30);return sendMessage(chatId,`⚠️ <b>الأصناف المنخفضة</b>\n\n${rows.length?rows.map(x=>`${e(x.name)}: ${(map.get(String(x.id))||0).toFixed(2)} / حد ${num(x.reorderPoint).toFixed(2)}`).join('\n'):'لا توجد أصناف منخفضة حسب حدود إعادة الطلب.'}`,mainMenuButton())}

async function showReports(chatId,session){const p=session.payload;const s=await getSettings(p);const [invoices,purchases,expenses,products]=await Promise.all([readStore(p,'invoices'),readStore(p,'purchases'),readStore(p,'expenses'),readStore(p,'products')]);const now=Date.now(),monthAgo=now-30*86400000;const sales=invoices.filter(x=>x.type==='sale'&&Date.parse(x.date||0)>=monthAgo);const returns=invoices.filter(x=>x.type==='return'&&Date.parse(x.date||0)>=monthAgo);const saleTotal=sales.reduce((a,x)=>a+num(x.grandTotal),0);const returnTotal=returns.reduce((a,x)=>a+num(x.grandTotal),0);const purTotal=purchases.filter(x=>Date.parse(x.date||0)>=monthAgo).reduce((a,x)=>a+num(x.grandTotal),0);const expTotal=expenses.filter(x=>!x.deletedAt&&Date.parse(x.date||x.createdAt||0)>=monthAgo).reduce((a,x)=>a+num(x.amount),0);const cost=sales.reduce((a,x)=>a+(x.items||[]).reduce((z,it)=>z+num(it.fifoCostTotal),0),0);const profit=saleTotal-returnTotal-cost-expTotal;return sendMessage(chatId,`📈 <b>تقرير آخر 30 يوم</b>\n\n🧾 المبيعات: <b>${money(saleTotal,s.currencySymbol||'₪')}</b>\n↩️ المرتجعات: <b>${money(returnTotal,s.currencySymbol||'₪')}</b>\n🛍 المشتريات: <b>${money(purTotal,s.currencySymbol||'₪')}</b>\n💸 المصروفات: <b>${money(expTotal,s.currencySymbol||'₪')}</b>\n📦 تكلفة البضاعة المباعة: <b>${money(cost,s.currencySymbol||'₪')}</b>\n💹 صافي تقريبي: <b>${money(profit,s.currencySymbol||'₪')}</b>\n📦 عدد الأصناف: <b>${products.filter(x=>!x.deletedAt).length}</b>`,mainMenuButton())}

async function globalSearch(chatId,session,text){const p=session.payload;const q=norm(text);const [products,invoices,customers,suppliers]=await Promise.all([readStore(p,'products'),readStore(p,'invoices'),readStore(p,'customers'),readStore(p,'suppliers')]);const ps=products.filter(x=>norm(x.name).includes(q)||norm(x.internalCode||x.sku).includes(q)||JSON.stringify(x.barcodes||x.units||[]).includes(text)).slice(0,5);const iv=invoices.filter(x=>norm(x.invoiceNumber).includes(q)||norm(x.customerName).includes(q)).slice(0,5);const cs=customers.filter(x=>norm(x.name).includes(q)||norm(x.phone).includes(q)).slice(0,5);const ss=suppliers.filter(x=>norm(x.name).includes(q)||norm(x.phone).includes(q)).slice(0,5);let out=`🔎 <b>نتائج البحث: ${e(text)}</b>\n`;if(ps.length)out+=`\n📦 الأصناف:\n${ps.map(x=>'• '+e(x.name)).join('\n')}\n`;if(iv.length)out+=`\n🧾 الفواتير:\n${iv.map(x=>'• '+e(x.invoiceNumber)+' — '+e(x.customerName||'')).join('\n')}\n`;if(cs.length)out+=`\n👥 العملاء:\n${cs.map(x=>'• '+e(x.name)+' '+e(x.phone||'')).join('\n')}\n`;if(ss.length)out+=`\n🏭 الموردون:\n${ss.map(x=>'• '+e(x.name)+' '+e(x.phone||'')).join('\n')}\n`;if(!ps.length&&!iv.length&&!cs.length&&!ss.length)out+='\nلا توجد نتائج.';return sendMessage(chatId,out,mainMenuButton())}

async function createVoucherRemote(payload,data,chatId){const settings=await getSettings(payload);const [accounts,customers,suppliers,vouchers]=await Promise.all([readStore(payload,'accounts'),readStore(payload,'customers'),readStore(payload,'suppliers'),readStore(payload,'vouchers')]);const account=accounts.find(x=>x.isDefault)||accounts[0];if(!account)throw new Error('لا يوجد حساب مالي.');const isReceipt=data.voucherType==='receipt';const parties=isReceipt?customers:suppliers;const party=parties.find(x=>String(x.id)===String(data.partyId));if(!party)throw new Error('الطرف غير موجود.');const max=vouchers.reduce((m,x)=>Math.max(m,Number(x.voucherNumber)||0),100);const now=new Date().toISOString();const voucher={id:'vouch-'+Date.now(),voucherNumber:max+1,type:isReceipt?'receipt':'payment',partyType:isReceipt?'customer':'supplier',partyId:party.id,partyName:party.name,amount:num(data.amount),date:now,sourceType:'account',accountId:account.id,accountName:account.name,notes:data.notes||'',userId:payload.account?.id||'',userName:payload.account?.name||'Telegram',createdAt:now};const nextAccount={...account,balance:num(account.balance)+(isReceipt?num(data.amount):-num(data.amount))};let nextParty={...party};if(isReceipt)nextParty.balance=num(party.balance)-num(data.amount);else nextParty.balance=num(party.balance)-num(data.amount);const stmt={id:'stmt-'+Date.now(),partnerType:isReceipt?'customer':'supplier',partnerId:party.id,partnerName:party.name,date:now,referenceType:isReceipt?'RECEIPT_VOUCHER':'PAYMENT_VOUCHER',referenceId:voucher.id,referenceNumber:String(voucher.voucherNumber),description:`${isReceipt?'سند قبض':'سند صرف'} رقم ${voucher.voucherNumber}${data.notes?` (${data.notes})`:''}`,debit:isReceipt?0:num(data.amount),credit:isReceipt?num(data.amount):0,runningBalance:nextParty.balance};await writeBatch(payload,[chg('vouchers',voucher.id,voucher),chg('accounts',nextAccount.id,nextAccount),chg(isReceipt?'customers':'suppliers',nextParty.id,nextParty),chg('partner_statements',stmt.id,stmt)],chatId);return{...voucher,currency:settings.currencySymbol||'₪'}}

async function createExpenseRemote(payload,data,chatId){const settings=await getSettings(payload);const [accounts,shifts]=await Promise.all([readStore(payload,'accounts'),readStore(payload,'shifts')]);const account=accounts.find(x=>x.isDefault)||accounts[0];if(!account)throw new Error('لا يوجد حساب مالي.');const now=new Date().toISOString();const exp={id:'exp-'+Date.now(),date:now,category:data.category||'أخرى',amount:num(data.amount),accountId:account.id,accountName:account.name,notes:data.notes||'',userId:payload.account?.id||'',userName:payload.account?.name||'Telegram',deletedAt:null,createdAt:now};const changes=[chg('expenses',exp.id,exp),chg('accounts',account.id,{...account,balance:num(account.balance)-num(data.amount)})];const active=shifts.find(x=>String(x.status).toLowerCase()==='open');if(active&&account.type==='cash'){changes.push(chg('shifts',active.id,{...active,totalCashExpenses:num(active.totalCashExpenses)+num(data.amount),expectedCash:num(active.expectedCash)-num(data.amount)}))}await writeBatch(payload,changes,chatId);return{...exp,currency:settings.currencySymbol||'₪'}}

async function createSaleRemote(payload,cart,opts,chatId){
  const [settings,warehouses,products,stock,accounts,customers,recipes,shifts] = await Promise.all([
    getSettings(payload), readStore(payload,'warehouses'), readStore(payload,'products'), readStore(payload,'stock'), readStore(payload,'accounts'), readStore(payload,'customers'), readStore(payload,'recipes'), readStore(payload,'shifts')
  ]);
  const warehouseId=settings.activeWarehouseId||(warehouses.find(x=>x.isDefault)||warehouses[0])?.id;if(!warehouseId)throw new Error('لا يوجد مخزن نشط.');
  const warehouse=warehouses.find(x=>String(x.id)===String(warehouseId))||warehouses[0]||{name:'صالة العرض'};
  const cashCustomer={id:'cust-walkin',name:'عميل نقدي',balance:0,isVirtual:true};
  const customer=opts.customerId?customers.find(x=>String(x.id)===String(opts.customerId)):cashCustomer;if(!customer)throw new Error('العميل غير موجود.');
  if(opts.paymentType==='debt'&&customer.id==='cust-walkin')throw new Error('البيع الآجل يحتاج عميلاً مسجلاً.');
  const prodCopies=products.map(p=>({...p,fifoBatches:Array.isArray(p.fifoBatches)?p.fifoBatches.map(b=>({...b})):[]}));
  const stockMap=new Map(stock.map(s=>[`${s.productId}\u0001${s.warehouseId}`,{...s}]));
  const modifiedStockKeys=new Set();
  const recipeMap=new Map(recipes.map(r=>[String(r.productId||r.mealProductId||''),r]).filter(x=>x[0]));
  const now=new Date().toISOString(),invoiceNumber=`INV-${Date.now().toString().slice(-6)}`,invoiceId='inv-'+Date.now(),syncId=`sale-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const movements=[];let subtotal=0,taxTotal=0;
  function consumeFifo(productId,baseQty,fallback){const p=prodCopies.find(x=>String(x.id)===String(productId));if(!p)return baseQty*fallback;let left=Math.max(0,baseQty),cost=0;const c=p.fifoBatches.filter(b=>(String(b.warehouseId||warehouseId)===String(warehouseId))&&num(b.remainingBaseQty)>0).sort((a,b)=>Date.parse(a.receivedAt||0)-Date.parse(b.receivedAt||0));for(const b of c){if(left<=0)break;const take=Math.min(left,num(b.remainingBaseQty));cost+=take*(num(b.unitCost)||fallback);b.remainingBaseQty=Math.max(0,num(b.remainingBaseQty)-take);left-=take}if(left>0)cost+=left*fallback;return cost}
  function deduct(productId,productName,baseQty,meta={}){const key=`${productId}\u0001${warehouseId}`,existing=stockMap.get(key)||{productId,warehouseId,baseQuantity:0};const newQty=num(existing.baseQuantity)-baseQty;if(settings.allowNegativeStock===false&&newQty<0)throw new Error(`المخزون غير كافٍ للصنف ${productName}`);const next={...existing,baseQuantity:newQty,updatedAt:now};stockMap.set(key,next);modifiedStockKeys.add(key);movements.push({id:'mov-'+Math.random().toString(36).slice(2,9),date:now,productId,productName,warehouseId,warehouseName:warehouse.name||'صالة العرض',type:meta.type||'sale',unitName:meta.unitName||'وحدة أساسية',quantityInUnit:meta.quantityInUnit??baseQty,conversionFactor:meta.conversionFactor||1,baseQuantityChange:-baseQty,newBaseBalance:newQty,referenceId:invoiceId,referenceType:'INVOICE',userId:payload.account?.id||'',userName:payload.account?.name||'Telegram',recipeId:meta.recipeId,manufacturedProductId:meta.manufacturedProductId,manufacturedProductName:meta.manufacturedProductName})}
  const items=[];
  for(const ci of cart){const p=prodCopies.find(x=>String(x.id)===String(ci.productId));if(!p)throw new Error('أحد الأصناف لم يعد موجوداً.');const units=Array.isArray(p.units)&&p.units.length?p.units:[{id:p.baseUnitId||'base',name:p.baseUnitName||'وحدة',conversionToBase:1,salePrice:num(p.salePrice)}];const u=units.find(x=>String(x.id)===String(ci.unitId))||units[0];const qty=Math.max(0.0001,num(ci.quantity));const factor=num(u.conversionToBase||u.multiplier)||1;const unitPrice=num(u.salePrice)||defaultSalePrice(p);const lineSubtotal=qty*unitPrice;const taxRate=num(p.taxRate??settings.taxRate);const lineTax=lineSubtotal*taxRate/100;subtotal+=lineSubtotal;taxTotal+=lineTax;const baseQuantity=qty*factor;const fallbackBaseCost=factor?num(u.costPrice||p.costPrice)/factor:num(p.costPrice);const recipe=recipeMap.get(String(p.id));let fifoCost=0;const recipeConsumption=[];if(recipe&&Array.isArray(recipe.ingredients||recipe.items)&&(recipe.ingredients||recipe.items).length){for(const ing of (recipe.ingredients||recipe.items)){const ip=prodCopies.find(x=>String(x.id)===String(ing.ingredientProductId||ing.productId));if(!ip)continue;const ius=ip.units||[];const iu=ius.find(x=>String(x.id)===String(ing.ingredientUnitId||ing.unitId))||ius.find(x=>String(x.id)===String(ip.baseUnitId))||ius[0]||{};const ifactor=num(ing.conversionFactor??iu.conversionToBase)||1;const per=num(ing.baseQuantity)>0?num(ing.baseQuantity):num(ing.quantity)*ifactor;const req=per*qty;if(req<=0)continue;const baseCost=num(ip.costPrice)||num(iu.costPrice)/Math.max(1,num(iu.conversionToBase)||1);const c=consumeFifo(ip.id,req,baseCost);fifoCost+=c;recipeConsumption.push({recipeId:recipe.id,productId:ip.id,productName:ip.name,unitId:iu.id||'',unitName:iu.name||ip.baseUnitName||'وحدة',quantityPerMeal:num(ing.quantity),conversionFactor:ifactor,baseQuantityPerMeal:per,soldMealQuantity:qty,baseQuantity:req,fifoCostTotal:c});deduct(ip.id,ip.name,req,{type:'recipe_sale',unitName:iu.name||'وحدة',quantityInUnit:num(ing.quantity)*qty,conversionFactor:ifactor,recipeId:recipe.id,manufacturedProductId:p.id,manufacturedProductName:p.name})}}else{fifoCost=consumeFifo(p.id,baseQuantity,fallbackBaseCost);deduct(p.id,p.name,baseQuantity,{type:'sale',unitName:u.name||'وحدة',quantityInUnit:qty,conversionFactor:factor})}items.push({id:'item-'+Math.random().toString(36).slice(2,9),productId:p.id,productName:p.name,unitId:u.id,unitName:u.name||p.baseUnitName||'وحدة',quantity:qty,conversionFactor:factor,baseQuantity,unitPrice,discount:0,taxRate,total:lineSubtotal+lineTax,fifoCostTotal:fifoCost,costPriceAtSale:qty>0?fifoCost/qty:0,isManufacturedMeal:recipeConsumption.length>0,recipeId:recipe?.id,recipeConsumption})}
  const grandTotal=Math.max(0,subtotal+taxTotal);let paid=opts.paymentType==='cash'?grandTotal:0;const remaining=Math.max(0,grandTotal-paid);const account=accounts.find(x=>x.isDefault)||accounts[0];if(opts.paymentType==='cash'&&!account)throw new Error('لا يوجد صندوق أو حساب افتراضي.');const payments=opts.paymentType==='cash'?[{accountId:account.id,method:account.type||'cash',amount:grandTotal}]:[];
  const activeShift=shifts.find(x=>String(x.status).toLowerCase()==='open');
  const invoice={id:invoiceId,invoiceNumber,type:'sale',date:now,customerId:customer.id,customerName:customer.name,cashierId:payload.account?.id||'',cashierName:payload.account?.name||'Telegram',shiftId:activeShift?.id,branchId:settings.activeBranchName,warehouseId,items,subtotal,lineDiscountTotal:0,invoiceDiscountType:'fixed',invoiceDiscountValue:0,invoiceDiscountAmount:0,discountTotal:0,taxTotal,roundingAdjustment:0,grandTotal,paidAmount:paid,remainingAmount:remaining,changeAmount:0,paymentType:opts.paymentType,payments,status:'completed',notes:'تمت من بوت تيليجرام',syncId,isSynced:false,createdAt:now};
  const changes=[chg('invoices',invoice.id,invoice)];
  for(const key of modifiedStockKeys){const s=stockMap.get(key);if(s)changes.push(chg('stock',JSON.stringify([s.productId,s.warehouseId]),s));}
  for(const m of movements)changes.push(chg('stock_movements',m.id,m));
  for(const p of prodCopies)if(products.find(x=>x.id===p.id)&&JSON.stringify(p.fifoBatches)!==JSON.stringify(products.find(x=>x.id===p.id)?.fifoBatches))changes.push(chg('products',p.id,p));
  if(opts.paymentType==='cash'){changes.push(chg('accounts',account.id,{...account,balance:num(account.balance)+grandTotal}));if(activeShift){const cash=account.type==='cash'?grandTotal:0,other=account.type==='cash'?0:grandTotal;changes.push(chg('shifts',activeShift.id,{...activeShift,totalCashSales:num(activeShift.totalCashSales)+cash,totalOtherSales:num(activeShift.totalOtherSales)+other,expectedCash:num(activeShift.expectedCash)+cash}))}}
  if(remaining>0&&customer.id!=='cust-walkin'){const nb=num(customer.balance)+remaining;changes.push(chg('customers',customer.id,{...customer,balance:nb}));const stmt={id:'stmt-'+Date.now(),partnerType:'customer',partnerId:customer.id,partnerName:customer.name,date:now,type:'sale',referenceNumber:invoiceNumber,description:`فاتورة مبيعات آجل رقم ${invoiceNumber}`,debit:remaining,credit:0,runningBalance:nb};changes.push(chg('partner_statements',stmt.id,stmt))}
  await writeBatch(payload,changes,chatId);return invoice;
}

function chg(store,key,value){return{store,key:String(key),value,deleted:false}}

async function readStore(payload,store){const db=payload.database||{};const table=tursoTable(db);const companyId=String(payload.companyId||payload.tenantId||'');if(!companyId)throw new Error('معرف الشركة غير موجود.');const pre=`oscar/companies/${encodeURIComponent(companyId)}/d/${encodeURIComponent(store)}/`,hi=pre+'\uffff';const [r]=await pipeline(db,[{sql:`SELECT path,payload,deleted,updated_at FROM ${table} WHERE path>=? AND path<? ORDER BY updated_at DESC`,args:[pre,hi]}],60000);const rows=resultRows(r);const out=[];for(const row of rows){if(Number(row.deleted)===1)continue;let v=parseJson(row.payload);if(v&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,'v')){if(v.deleted)continue;v=v.v}if(v!=null)out.push(v)}return out}
async function getSettings(payload){const rows=await readStore(payload,'settings');return rows.find(x=>x?.key==='store_config')||rows[0]||{currencySymbol:'₪',activeWarehouseId:'wh-main',activeBranchName:'الفرع الرئيسي',allowNegativeStock:false,taxRate:0,expenseCategories:['أخرى']}}

async function writeBatch(payload,changes,chatId){const db=payload.database||{};const table=tursoTable(db),meta=table+'_syncmeta',companyId=String(payload.companyId||payload.tenantId||'');await ensureRemoteSchema(db);const statements=[{sql:`UPDATE ${meta} SET batch=batch+1 WHERE id=1`,args:[]}];let n=0;for(const c of changes){const rev=Date.now()*1000+(n++%900);const path=`oscar/companies/${encodeURIComponent(companyId)}/d/${encodeURIComponent(c.store)}/${encodeURIComponent(c.key)}`;const envelope={v:c.deleted?null:c.value,deleted:!!c.deleted,rev,deviceId:`TG-${chatId}`,tenantId:companyId};statements.push({sql:`INSERT INTO ${table}(path,payload,deleted,updated_at,sync_batch) VALUES(?,?,?,?,(SELECT batch FROM ${meta} WHERE id=1)) ON CONFLICT(path) DO UPDATE SET payload=excluded.payload,deleted=excluded.deleted,updated_at=excluded.updated_at,sync_batch=excluded.sync_batch WHERE excluded.updated_at>=${table}.updated_at`,args:[path,JSON.stringify(envelope),c.deleted?1:0,rev]})}await pipeline(db,statements,Math.max(30000,changes.length*700));return true}
async function ensureRemoteSchema(db){const table=tursoTable(db),meta=table+'_syncmeta';await pipeline(db,[{sql:`CREATE TABLE IF NOT EXISTS ${table} (path TEXT PRIMARY KEY,payload TEXT,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,sync_batch INTEGER NOT NULL DEFAULT 0)`,args:[]},{sql:`CREATE TABLE IF NOT EXISTS ${meta} (id INTEGER PRIMARY KEY CHECK(id=1),batch INTEGER NOT NULL DEFAULT 0)`,args:[]},{sql:`INSERT OR IGNORE INTO ${meta}(id,batch) VALUES(1,0)`,args:[]}]);try{await pipeline(db,[{sql:`ALTER TABLE ${table} ADD COLUMN sync_batch INTEGER NOT NULL DEFAULT 0`,args:[]}])}catch(e){if(!/duplicate column|already exists/i.test(String(e?.message||e)))throw e}}

async function getSession(chatId,env){const row=await env.DB.prepare('SELECT * FROM telegram_sessions WHERE chat_id=? AND active=1').bind(chatId).first();if(!row)return null;try{return{...row,payload:JSON.parse(row.payload_json)}}catch(_){return null}}
async function getState(chatId,env){const row=await env.DB.prepare('SELECT mode,data_json FROM telegram_states WHERE chat_id=?').bind(chatId).first();if(!row)return{mode:'IDLE',data:{}};let data={};try{data=JSON.parse(row.data_json||'{}')}catch(_){}return{mode:row.mode||'IDLE',data}}
async function setState(chatId,mode,data,env){await env.DB.prepare(`INSERT INTO telegram_states(chat_id,mode,data_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data_json=excluded.data_json,updated_at=excluded.updated_at`).bind(chatId,mode,JSON.stringify(data||{}),new Date().toISOString()).run()}
async function patchState(chatId,fn,env){const s=await getState(chatId,env);const next=fn({...s.data});await setState(chatId,s.mode,next,env);return next}


function activationFileAscii(bytes){
  // ملف mzauth نص Base64 فقط. نحذف BOM والمسافات وأي CR/LF بشكل صريح.
  let out='';
  for(let i=0;i<bytes.length;i++){
    const c=bytes[i];
    if(i===0 && c===0xEF && bytes[i+1]===0xBB && bytes[i+2]===0xBF){i+=2;continue;}
    if(c===9||c===10||c===13||c===32)continue;
    if(c>127)throw new Error('ملف الدخول يحتوي على ترميز غير متوقع.');
    out+=String.fromCharCode(c);
  }
  return out.trim();
}


async function sha256Hex(text){
  const bytes=enc.encode(String(text||''));
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function portableUnwrapText(value){
  const raw=unb64(value),key=enc.encode(ACTIVATION_WRAP_KEY),out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw[i]^key[i%key.length];
  return dec.decode(out);
}
async function unpackPortableActivationFile(text){
  let box;try{box=JSON.parse(String(text||'').trim())}catch(_){throw new Error('صيغة ملف الدخول الجديدة غير صالحة.');}
  if(box?.format!==PORTABLE_FORMAT||Number(box?.version)!==4)throw new Error('إصدار ملف الدخول غير مدعوم.');
  try{
    const plain=portableUnwrapText(box?.primary?.data||'');
    const sum=await sha256Hex(plain);
    if(box?.primary?.checksum&&sum!==String(box.primary.checksum))throw new Error('CHECKSUM');
    const payload=JSON.parse(plain);
    if(payload?.app!==APP_TAG)throw new Error('APP');
    return payload;
  }catch(primaryError){
    console.error('MZAUTH_V4_PRIMARY_ERROR',String(primaryError?.message||primaryError));
    if(box?.recovery?.data){
      try{return await unpackLegacyActivationFile(box.recovery.data)}catch(recoveryError){
        console.error('MZAUTH_V4_RECOVERY_ERROR',String(recoveryError?.message||recoveryError));
      }
    }
    throw new Error('تعذر قراءة ملف الدخول الجديد أو أن الملف تالف.');
  }
}
async function unpackActivationFile(text){
  const clean=String(text||'').trim();
  if(clean.startsWith('{'))return unpackPortableActivationFile(clean);
  return unpackLegacyActivationFile(clean);
}

async function unpackLegacyActivationFile(text){
  // نفس تنسيق oscar-activation-runtime.js في التطبيق المرفق.
  let raw;
  try{raw=unb64(String(text||'').replace(/\s+/g,''))}
  catch(_){throw new Error('ملف التفعيل غير صالح.');}

  if(raw.length<90||raw[0]!==0x6d)throw new Error('ملف التفعيل غير صالح.');

  let o=1;
  const keySalt=raw.slice(o,o+16);o+=16;
  const len=(raw[o++]<<8)|raw[o++];
  if(len<29||o+len+44>raw.length)throw new Error('ملف التفعيل تالف.');

  const keyBlob=raw.slice(o,o+len);o+=len;

  let activationKey='';
  try{
    activationKey=await aesDecryptCompat(
      keyBlob.slice(12),
      ACTIVATION_WRAP_KEY,
      keySalt,
      keyBlob.slice(0,12),
      220000
    );
  }catch(err){
    console.error('MZAUTH_WRAP_DECRYPT_ERROR', String(err?.message||err), {
      total: raw.length, keyBlobLen: len
    });
    throw new Error('تعذر التحقق من ملف التفعيل.');
  }

  const payloadSalt=raw.slice(o,o+16);o+=16;
  const payloadIv=raw.slice(o,o+12);o+=12;
  const cipher=raw.slice(o);

  try{
    const plain=await aesDecryptCompat(cipher,activationKey,payloadSalt,payloadIv,220000);
    const payload=JSON.parse(plain);
    if(payload?.app!==APP_TAG||String(payload.activationKey||'').trim()!==String(activationKey).trim())throw new Error('MISMATCH');
    return payload;
  }catch(err){
    console.error('MZAUTH_PAYLOAD_DECRYPT_ERROR', String(err?.message||err));
    throw new Error('فشل فك ملف الدخول أو تم العبث به.');
  }
}

function accountPath(payload){
  const companyId=encodeURIComponent(String(payload.companyId||payload.tenantId||''));
  const base=`oscar/companies/${companyId}`;
  if(payload.type==='company-manager')return `${base}/access/company`;
  return `${base}/d/employees/${encodeURIComponent(String(payload.account?.id||''))}`;
}

async function verifyActivationPayload(payload){
  // مطابقة منطق verifyPayloadRemote الموجود داخل تطبيق أوسكار نفسه.
  const db=payload.database||{};
  const companyId=String(payload.companyId||payload.tenantId||'');
  if(!companyId||!db.databaseURL||!db.authToken)throw new Error('ملف التفعيل لا يحتوي على قاعدة شركة صالحة.');

  const base=`oscar/companies/${encodeURIComponent(companyId)}`;
  const accessPath=`${base}/access/company`;
  let access=unwrapRecord(await readExact(db,accessPath,true));

  if(!access)throw new Error('مفتاح الشركة غير مسجل في قاعدة الشركة.');
  if(String(access.companyKey||'').toUpperCase()!==String(payload.companyKey||payload.activationKey||'').toUpperCase())throw new Error('ملف التفعيل لا يطابق مفتاح الشركة.');
  if(access.status!=='active')throw new Error('تم إيقاف مفتاح الشركة من الإدارة العامة.');
  if(access.endAt&&Date.now()>=new Date(access.endAt).getTime())throw new Error('انتهت مدة تفعيل الشركة.');

  const account=payload.account||{};
  let verifiedAccount=null;

  if(payload.type==='company-manager'){
    let row=access.manager;
    if(!row||row.active===false)throw new Error('حساب مدير الشركة غير متاح.');
    if(String(row.id||'')!==String(account.id||''))throw new Error('ملف المدير لا يطابق الحساب المسجل.');

    const fileVersion=String(account.authVersion||'');
    const currentVersion=String(row.authVersion||'');
    const previousVersion=String(row.previousAuthVersion||'');
    const pendingVersion=String(row.pendingAuthVersion||'');
    const policyVersion=Number(row.authPolicyVersion||0);

    if(fileVersion===currentVersion){
      if(pendingVersion&&pendingVersion===currentVersion){
        const committed={
          ...row,
          previousAuthVersion:'',
          pendingAuthVersion:'',
          pendingIssuedAt:'',
          authPolicyVersion:2,
          activatedAt:new Date().toISOString(),
          updatedAt:new Date().toISOString()
        };
        const updatedAt=Date.now();
        const nextAccess={...access,manager:committed,updatedAt};
        await writeExact(db,accessPath,nextAccess,updatedAt,false);
        access=nextAccess;
        row=committed;
      }
    }else if(previousVersion&&fileVersion===previousVersion&&pendingVersion){
      // الملف السابق صالح مؤقتاً حتى يتم استعمال الملف الجديد مرة واحدة.
    }else if(policyVersion<2){
      const recovered={
        ...row,
        ...account,
        id:row.id||account.id,
        active:true,
        authVersion:fileVersion,
        previousAuthVersion:'',
        pendingAuthVersion:'',
        pendingIssuedAt:'',
        authPolicyVersion:2,
        recoveredAt:new Date().toISOString(),
        updatedAt:new Date().toISOString()
      };
      const updatedAt=Date.now();
      const nextAccess={...access,manager:recovered,updatedAt};
      await writeExact(db,accessPath,nextAccess,updatedAt,false);
      access=nextAccess;
      row=recovered;
    }else{
      throw new Error('تم إصدار ملف مدير أحدث. استخدم الملف الجديد.');
    }

    verifiedAccount=row;
  }else{
    const row=unwrapRecord(await readExact(db,accountPath(payload),false));
    if(!row)throw new Error('الحساب غير موجود في قاعدة الشركة أو لم تتم مزامنته بعد.');
    if(row.active===false)throw new Error('تم إيقاف هذا الحساب.');
    if(String(row.authVersion||'')!==String(account.authVersion||''))throw new Error('تم إصدار ملف دخول أحدث لهذا الحساب.');
    if(payload.type==='representative'&&String(row.role||'')!=='مندوب')throw new Error('الحساب لم يعد مندوباً.');
    if(payload.type==='branch-manager'&&String(row.role||'')!=='مدير فرع')throw new Error('حساب مدير الفرع غير متاح.');
    verifiedAccount=row;
  }

  return {access,online:true,account:JSON.parse(JSON.stringify(verifiedAccount||account))};
}

function tursoTable(db){return String(db?.table||'oscar_rtdb').trim().replace(/[^a-zA-Z0-9_]/g,'')||'oscar_rtdb'}
function tursoUrl(db){const u=String(db?.databaseURL||'').trim();if(!u)throw new Error('رابط قاعدة الشركة غير موجود.');return u.replace(/^libsql:\/\//i,'https://').replace(/\/+$/,'')+'/v2/pipeline'}
function sqlArg(value){if(value==null)return{type:'null'};if(typeof value==='number'&&Number.isInteger(value))return{type:'integer',value:String(value)};if(typeof value==='number')return{type:'float',value:String(value)};return{type:'text',value:String(value)}}
function cell(c){if(!c||c.type==='null')return null;if(c.type==='integer'||c.type==='float'){const n=Number(c.value);return Number.isFinite(n)?n:c.value}return c.value}
function resultRows(result){const names=(result?.cols||[]).map(c=>c.name);return(result?.rows||[]).map(r=>Object.fromEntries(r.map((c,i)=>[names[i],cell(c)])))}
async function pipeline(db,statements,timeout=26000){const token=String(db?.authToken||'').trim();if(!token)throw new Error('توكن قاعدة الشركة غير موجود.');const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);try{const res=await fetch(tursoUrl(db),{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({requests:[...statements.map(st=>({type:'execute',stmt:{sql:st.sql,args:(st.args||[]).map(sqlArg)}})),{type:'close'}]}),signal:controller.signal});const text=await res.text();if(!res.ok)throw new Error(`Turso HTTP ${res.status}: ${text.slice(0,180)}`);const data=JSON.parse(text);return statements.map((_,i)=>{const item=data?.results?.[i];if(!item||item.type!=='ok')throw new Error(item?.error?.message||'خطأ SQL');return item.response?.result||{cols:[],rows:[]}})}finally{clearTimeout(timer)}}
function normalizeRemotePath(path){return String(path||'').trim().replace(/\.json(?:\?.*)?$/i,'').replace(/^\/+|\/+$/g,'').replace(/\/{2,}/g,'/')}
async function readExact(db,path,ensure=false){
  if(ensure)await ensureRemoteSchema(db);
  const table=tursoTable(db),p=normalizeRemotePath(path);
  const[r]=await pipeline(db,[{sql:`SELECT payload,deleted,updated_at FROM ${table} WHERE path=? LIMIT 1`,args:[p]}]);
  const row=resultRows(r)[0];
  if(!row||Number(row.deleted)===1)return null;
  return parseJson(row.payload);
}
async function writeExact(db,path,value,updatedAt=Date.now(),deleted=false){
  await ensureRemoteSchema(db);
  const table=tursoTable(db),p=normalizeRemotePath(path);
  await pipeline(db,[{
    sql:`INSERT INTO ${table}(path,payload,deleted,updated_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET payload=excluded.payload,deleted=excluded.deleted,updated_at=excluded.updated_at`,
    args:[p,JSON.stringify(value),deleted?1:0,Number(updatedAt)||Date.now()]
  }]);
  return true;
}
function unwrapRecord(v){if(v&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,'v'))return v.deleted?null:v.v;return v}
function parseJson(v){if(typeof v!=='string')return v;try{return JSON.parse(v)}catch(_){return v}}

async function deriveAesKeyCompat(password,salt,iterations=220000){
  const material=await crypto.subtle.importKey('raw',enc.encode(String(password)),'PBKDF2',false,['deriveBits','deriveKey']);
  try{
    const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,256);
    return crypto.subtle.importKey('raw',bits,{name:'AES-GCM'},false,['decrypt']);
  }catch(firstError){
    try{
      return await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt']);
    }catch(secondError){
      console.error('PBKDF2_ERROR',String(firstError?.message||firstError),String(secondError?.message||secondError));
      throw secondError;
    }
  }
}
async function aesDecryptCompat(cipher,password,salt,iv,iterations=220000){
  const key=await deriveAesKeyCompat(password,salt,iterations);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,cipher);
  return dec.decode(plain);
}
function unb64(s){
  const clean=String(s||'').replace(/\s+/g,'');
  if(!clean)throw new Error('EMPTY_BASE64');
  return Uint8Array.from(atob(clean),c=>c.charCodeAt(0));
}

async function searchProducts(payload,text){const q=norm(text);const all=(await readStore(payload,'products')).filter(x=>!x.deletedAt);return all.filter(p=>norm(p.name).includes(q)||norm(p.internalCode||p.sku).includes(q)||(p.units||[]).some(u=>(u.barcodes||[]).some(b=>String(b).includes(text)))).slice(0,30)}
function defaultSalePrice(p){const us=Array.isArray(p.units)?p.units:[];const u=us.find(x=>x.isDefaultSale)||us.find(x=>String(x.id)===String(p.baseUnitId))||us[0];return num(u?.salePrice||p.salePrice)}
function countLowStock(products,stock,warehouseId){const m=new Map(stock.filter(x=>String(x.warehouseId)===String(warehouseId)).map(x=>[String(x.productId),num(x.baseQuantity)]));return products.filter(x=>!x.deletedAt&&(m.get(String(x.id))||0)<=num(x.reorderPoint)).length}
function formatInvoiceNotification(inv,companyName=''){const symbol=inv.currencySymbol||'₪';const type=inv.type==='purchase'?'🛍 فاتورة مشتريات':inv.type==='return'?'↩️ فاتورة مرتجع':'🧾 فاتورة مبيعات';const party=inv.customerName||inv.supplierName||'';const items=(inv.items||[]).slice(0,30).map((x,i)=>`${i+1}. ${e(x.productName||x.name||'صنف')} — ${num(x.quantity)} ${e(x.unitName||'')} × ${num(x.unitPrice).toFixed(2)} = <b>${num(x.total||num(x.quantity)*num(x.unitPrice)).toFixed(2)}</b>`).join('\n');return `${type}\n${companyName?`🏢 ${e(companyName)}\n`:''}🔢 <b>${e(inv.invoiceNumber||inv.id||'')}</b>\n👤 ${e(party||'عميل نقدي')}\n📅 ${e(String(inv.date||inv.createdAt||'').replace('T',' ').slice(0,16))}\n\n${items||'بدون أصناف'}\n\n💰 الإجمالي: <b>${num(inv.grandTotal).toFixed(2)} ${e(symbol)}</b>\n💵 المدفوع: ${num(inv.paidAmount).toFixed(2)}\n🧾 المتبقي: ${num(inv.remainingAmount).toFixed(2)}${inv.notes?`\n📝 ${e(inv.notes)}`:''}`}

async function sendMessage(chatId,text,replyMarkup=null){const body={chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true};if(replyMarkup)body.reply_markup=replyMarkup;return telegram('sendMessage',body)}
async function telegram(method,data={}){const res=await fetch(`${TG_API}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return res.json()}
function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{'Content-Type':'application/json; charset=UTF-8',...corsHeaders()}})}
function corsHeaders(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}}
function e(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function norm(v){return String(v??'').trim().toLowerCase()}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function money(v,symbol=''){return `${num(v).toFixed(2)}${symbol?` ${e(symbol)}`:''}`}
function chunk(arr,n){const out=[];for(let i=0;i<arr.length;i+=n)out.push(arr.slice(i,i+n));return out}
