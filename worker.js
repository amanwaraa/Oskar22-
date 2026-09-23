const BOT_TOKEN = "8743553964:AAFdDUy2isOSdgvc50ltCDrSVvlK9dOSu2U";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const APP_TAG = 'OSCAR_ACCOUNTING_ACTIVATION_V1';
const ACTIVATION_WRAP_KEY = ['AM','_8Q','2x','!m','7Z','b4','_r','9P','@k','5N'].join('');
const enc = new TextEncoder();
const dec = new TextDecoder();
const BOT_VERSION = '3.0.0-oscar-full-link';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

      if (request.method === 'GET' && url.pathname === '/') {
        return new Response('Oscar Telegram Bot Worker is running ✅', {
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
        const commands = await telegram('setMyCommands', { commands: [
          { command:'start', description:'بدء البوت أو فتح الحساب' },
          { command:'menu', description:'القائمة الرئيسية' },
          { command:'check', description:'فحص ربط قاعدة أوسكار' },
          { command:'login', description:'تسجيل الدخول بملف mzauth' },
          { command:'logout', description:'تسجيل الخروج' }
        ]});
        return json({ success: !!tg.ok, version: BOT_VERSION, webhook: webhookUrl, telegram: tg, commands });
      }

      if (request.method === 'GET' && url.pathname === '/status') {
        await ensureD1(env);
        const info = await telegram('getWebhookInfo', {});
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_sessions WHERE active=1').first();
        return json({ status: 'running', version: BOT_VERSION, active_sessions: Number(count?.count || 0), webhook: info });
      }

      // App -> bot notification. Optional push path; cron polling is also enabled as a fallback.
      if (request.method === 'POST' && url.pathname === '/api/app/invoice') {
        await ensureD1(env);
        const body = await request.json();
        const companyId = String(body?.companyId || '').trim();
        const invoice = body?.invoice;
        if (!companyId || !invoice) return json({ ok: false, error: 'companyId and invoice are required' }, 400);
        const entityType = String(body?.entityType || (invoice?.type === 'purchase' ? 'purchase' : 'invoice'));
        const sent = await deliverEntityToCompany(env, companyId, invoice, entityType, body?.companyName || '');
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
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async()=>{
      try {
        await ensureD1(env);
        await pollNewAccountingEvents(env);
      } catch (error) {
        console.error('SCHEDULED_SYNC_ERROR', error);
      }
    })());
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
      active INTEGER NOT NULL DEFAULT 1,
      invoice_cursor INTEGER NOT NULL DEFAULT 0,
      purchase_cursor INTEGER NOT NULL DEFAULT 0,
      verification_state TEXT NOT NULL DEFAULT 'verified',
      verification_message TEXT,
      verified_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_states (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'IDLE',
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_deliveries (
      delivery_key TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      sent_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_sessions_company ON telegram_sessions(company_id,active)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_sessions_account ON telegram_sessions(company_id,account_id,active)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tg_deliveries_chat ON telegram_deliveries(chat_id,sent_at)')
  ]);
  // Existing deployments may have the older sessions table. Upgrade in place without deleting sessions.
  for (const sql of [
    "ALTER TABLE telegram_sessions ADD COLUMN invoice_cursor INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE telegram_sessions ADD COLUMN purchase_cursor INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE telegram_sessions ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'verified'",
    "ALTER TABLE telegram_sessions ADD COLUMN verification_message TEXT",
    "ALTER TABLE telegram_sessions ADD COLUMN verified_at TEXT"
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) {
      if (!/duplicate column|already exists/i.test(String(e?.message || e))) console.warn('D1_MIGRATION', String(e?.message || e));
    }
  }
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
  if (text === '/login') return askForLoginFile(chatId);

  if (msg.document && /\.mzauth$/i.test(String(msg.document.file_name || ''))) {
    return loginFromTelegramDocument(chatId, msg.document, env);
  }

  const session = await getSession(chatId, env);
  if (!session) return askForLoginFile(chatId);

  if (text === '/check') return showConnectionCheck(chatId, session);
  if (text === '/menu') return showMainMenu(chatId, session);
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
  await sendMessage(chatId, '⏳ جاري قراءة ملف الدخول وربطه بنفس حساب أوسكار...');
  try {
    const fileName = String(doc?.file_name || '');
    if (!/\.mzauth$/i.test(fileName)) throw new Error('أرسل ملف دخول أوسكار بصيغة .mzauth');
    const file = await telegram('getFile', { file_id: doc.file_id });
    if (!file?.ok || !file.result?.file_path) throw new Error('تعذر تنزيل ملف الدخول من تيليجرام.');
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.result.file_path}`, { cache:'no-store' });
    if (!res.ok) throw new Error('فشل تنزيل ملف الدخول من تيليجرام.');
    const fileBytes = new Uint8Array(await res.arrayBuffer());
    if (!fileBytes.length) throw new Error('ملف الدخول فارغ.');
    const opaque = activationFileAscii(fileBytes);
    const rawPayload = await unpackActivationFile(opaque);
    const payload = normalizeActivationPayload(rawPayload);
    const verified = await verifyActivationPayloadFlexible(payload);
    if (verified?.account) payload.account = { ...(payload.account || {}), ...verified.account };

    // Start cursors from the current cloud state so login does not flood Telegram with old invoices.
    const [invoiceCursor, purchaseCursor] = await Promise.all([
      remoteStoreMaxRev(payload, 'invoices').catch(()=>-1),
      remoteStoreMaxRev(payload, 'purchases').catch(()=>-1)
    ]);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO telegram_sessions(
      chat_id,company_id,company_name,account_id,account_name,account_role,payload_json,
      logged_in_at,updated_at,active,invoice_cursor,purchase_cursor,verification_state,verification_message,verified_at
    ) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET
      company_id=excluded.company_id,company_name=excluded.company_name,account_id=excluded.account_id,
      account_name=excluded.account_name,account_role=excluded.account_role,payload_json=excluded.payload_json,
      logged_in_at=excluded.logged_in_at,updated_at=excluded.updated_at,active=1,
      invoice_cursor=excluded.invoice_cursor,purchase_cursor=excluded.purchase_cursor,
      verification_state=excluded.verification_state,verification_message=excluded.verification_message,verified_at=excluded.verified_at`).bind(
        chatId,
        String(payload.companyId || payload.tenantId || ''),
        String(payload.companyName || ''),
        String(payload.account?.id || ''),
        String(payload.account?.name || payload.account?.displayName || 'مستخدم'),
        String(payload.account?.roleName || payload.account?.role || payload.type || ''),
        JSON.stringify(payload), now, now,
        Number(invoiceCursor || 0), Number(purchaseCursor || 0),
        verified?.provisional ? 'provisional' : 'verified',
        verified?.error ? String(verified.error).slice(0,500) : null, now
      ).run();
    await setState(chatId, 'IDLE', {}, env);
    const verifyText = verified?.provisional ? '\n\n⚡ تم قبول الملف، وسيُعاد التحقق من الصلاحية تلقائياً عند الاتصال.' : '';
    await sendMessage(chatId,
      `✅ <b>تم تسجيل الدخول وربط الحساب</b>\n\n🏢 ${e(payload.companyName || 'الشركة')}\n👤 ${e(payload.account?.name || payload.account?.displayName || 'مستخدم')}\n🛡 ${e(payload.account?.roleName || payload.account?.role || (payload.type === 'company-manager' ? 'مدير الشركة' : 'حساب أوسكار'))}${verifyText}`
    );
    return showMainMenu(chatId, { payload });
  } catch (error) {
    console.error('LOGIN_ERROR', error);
    return sendMessage(chatId, `❌ <b>تعذر تسجيل الدخول</b>\n\n${e(String(error?.message || error))}\n\nأرسل نفس ملف <code>.mzauth</code> الذي تدخل به إلى البرنامج.`, {
      inline_keyboard:[[btn('🔄 محاولة جديدة','login_help')]]
    });
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
  const role = String(p.account?.role || p.account?.roleCode || '').trim().toLowerCase();
  if (role === 'admin') return true;
  const raw = p.account?.permissions ?? p.permissions ?? {};
  if (Array.isArray(raw)) {
    if (raw.includes('*') || raw.includes(key)) return true;
  } else if (raw && typeof raw === 'object' && raw[key] === true) return true;
  // نفس ترحيل الصلاحيات القديمة في برنامج أوسكار.
  const defaults = {
    cashier: new Set(['canAccessCashier','canAccessSales','canAccessCustomers']),
    accountant: new Set(['canAccessDashboard','canAccessSales','canAccessPurchases','canAccessVouchers','canAccessCustomers','canAccessSuppliers','canAccessAccounts','canAccessExpenses','canAccessReports']),
    inventory_mgr: new Set(['canAccessProducts','canAccessCategories','canAccessInventory','canAccessPurchases','canAccessBarcodes'])
  };
  if (defaults[role]?.has(key)) return true;
  if (raw && typeof raw === 'object') {
    if (key === 'canAccessPurchases' && raw.canManagePurchases === true) return true;
    if (key === 'canAccessVouchers' && raw.canManageVouchers === true) return true;
    if (key === 'canAccessInventory' && raw.canManageInventory === true) return true;
    if (key === 'canAccessReports' && raw.canViewReports === true) return true;
  }
  return false;
}

async function showConnectionCheck(chatId,session){
  try{
    const p=session.payload;const [products,invoices,customers]=await Promise.all([readStore(p,'products'),readStore(p,'invoices'),readStore(p,'customers')]);
    return sendMessage(chatId,`✅ <b>الربط يعمل</b>\n\n🏢 ${e(p.companyName||'')}\n📦 الأصناف: ${products.length}\n🧾 الفواتير: ${invoices.length}\n👥 العملاء: ${customers.length}\n\nالبوت يقرأ نفس قاعدة أوسكار مباشرة.`,mainMenuButton());
  }catch(error){return sendMessage(chatId,`❌ <b>مشكلة في ربط قاعدة أوسكار</b>\n\n${e(String(error?.message||error))}`,mainMenuButton())}
}

async function showMainMenu(chatId, session) {
  const p = session.payload || session;
  const buttons = [];
  const row = (...items) => buttons.push(items);
  if (hasPerm(session, 'canAccessDashboard')) row(btn('📊 الرئيسية', 'dashboard'), btn('🔎 بحث شامل', 'global_search'));
  if (hasPerm(session, 'canAccessCashier')) row(btn('🛒 بيع', 'sale'), btn('🧺 السلة', 'cart'));
  if (hasPerm(session, 'canAccessSales')) row(btn('🧾 الفواتير', 'invoices'), btn('↩️ مرتجع بيع', 'return_new'));
  if (hasPerm(session, 'canAccessProducts') || hasPerm(session, 'canAccessCashier')) row(btn('📦 الأصناف', 'products'), btn('🗂 الأقسام', 'categories'));
  if (hasPerm(session, 'canAccessPurchases')) row(btn('🛍 المشتريات', 'purchases'), btn('➕ فاتورة شراء', 'purchase_new'));
  if (hasPerm(session, 'canAccessCustomers')) row(btn('👥 العملاء', 'customers'), btn('➕ عميل', 'customer_new'));
  if (hasPerm(session, 'canAccessCustomers')) row(btn('💳 ديون العملاء', 'customer_debts'));
  if (hasPerm(session, 'canAccessSuppliers')) row(btn('🏭 الموردون', 'suppliers'), btn('➕ مورد', 'supplier_new'));
  if (hasPerm(session, 'canAccessSuppliers')) row(btn('📒 حسابات الموردين', 'supplier_balances'));
  if (hasPerm(session, 'canAccessAccounts')) row(btn('💰 الحسابات', 'accounts'), btn('🔄 تحويل مالي', 'account_transfer'));
  if (hasPerm(session, 'canAccessAccounts')) row(btn('🕐 الورديات', 'shifts'), btn('🔓/🔒 الوردية', 'shift_action'));
  if (hasPerm(session, 'canAccessVouchers')) row(btn('💵 السندات', 'vouchers'), btn('➕ سند جديد', 'voucher_new'));
  if (hasPerm(session, 'canAccessExpenses')) row(btn('💸 المصروفات', 'expenses'), btn('➕ مصروف', 'expense_new'));
  if (hasPerm(session, 'canAccessInventory')) row(btn('📚 المخزون', 'inventory'), btn('🔁 تحويل مخزون', 'stock_transfer'));
  if (hasPerm(session, 'canAccessInventory')) row(btn('⚠️ النواقص', 'low_stock'));
  if (hasPerm(session, 'canAccessEmployees')) row(btn('👨‍💼 الموظفون', 'employees'));
  if (hasPerm(session, 'canAccessReports') || p.type === 'company-manager') row(btn('📈 التقارير', 'reports'));
  row(btn('📋 المزيد', 'more'), btn('👤 حسابي', 'account'));
  row(btn('🚪 تسجيل خروج', 'logout'));
  return sendMessage(chatId,
    `🏠 <b>أوسكار المحاسبي — Telegram</b>\n🏢 ${e(p.companyName || 'الشركة')}\n👤 ${e(p.account?.name || p.account?.displayName || 'مستخدم')}\n\nاختر العملية:`,
    { inline_keyboard: buttons }
  );
}

function btn(text, callback_data) { return { text, callback_data }; }
function mainMenuButton() { return { inline_keyboard: [[btn('🏠 القائمة الرئيسية', 'menu')]] }; }
function backButton() { return { inline_keyboard: [[btn('⬅️ رجوع', 'menu')]] }; }

function permissionForCallback(data){
  const d=String(data||'');
  if(['dashboard'].includes(d))return 'canAccessDashboard';
  if(['sale','cart','checkout_cash','checkout_debt','sale_search'].includes(d)||/^(cat:|prod:|unit:|cart_rm:|debtcust:)/.test(d))return 'canAccessCashier';
  if(['invoices','returns','invoice_search','return_new','return_balance','return_account'].includes(d)||/^retinv:/.test(d))return 'canAccessSales';
  if(['products','categories','product_search'].includes(d))return 'canAccessProducts';
  if(['customers','customer_debts','customer_search','customer_new'].includes(d)||/^cust:/.test(d))return 'canAccessCustomers';
  if(['suppliers','supplier_balances','supplier_search','supplier_new'].includes(d)||/^supp:/.test(d))return 'canAccessSuppliers';
  if(['accounts','shifts','account_transfer','shift_action','shift_open','shift_close'].includes(d)||/^(trfrom:|trto:)/.test(d))return 'canAccessAccounts';
  if(['vouchers','voucher_new','voucher_receipt','voucher_payment'].includes(d)||/^vparty:/.test(d))return 'canAccessVouchers';
  if(['purchases','purchase_new','purchase_search','purchase_cart','purchase_finish_cash','purchase_finish_debt'].includes(d)||/^(pursupp:|pprod:|punit:)/.test(d))return 'canAccessPurchases';
  if(['expenses','expense_new'].includes(d)||/^excat:/.test(d))return 'canAccessExpenses';
  if(['inventory','low_stock','stock_transfer'].includes(d)||/^(stfrom:|stto:|stprod:|stunit:)/.test(d))return 'canAccessInventory';
  if(['reports'].includes(d))return 'canAccessReports';
  if(['employees'].includes(d))return 'canAccessEmployees';
  if(['held_invoices'].includes(d))return 'canAccessSales';
  if(['transfers_history'].includes(d))return 'canAccessAccounts';
  if(['stock_movements','warehouses'].includes(d))return 'canAccessInventory';
  if(['settings_info'].includes(d))return 'canAccessSettings';
  if(['trash_info'].includes(d))return 'canAccessTrash';
  if(['restaurant_tables'].includes(d))return 'canAccessRestaurantTables';
  if(['restaurant_orders'].includes(d))return 'canAccessRestaurantWaiter';
  return '';
}

async function handleCallback(chatId, data, env) {
  if (data === 'login_help') return askForLoginFile(chatId);
  const session = await getSession(chatId, env);
  if (!session) return askForLoginFile(chatId);
  const requiredPermission = permissionForCallback(data);
  if (requiredPermission && !hasPerm(session, requiredPermission)) {
    return sendMessage(chatId, '⛔ ليس لديك صلاحية لتنفيذ هذه العملية.', mainMenuButton());
  }
  if (data === 'menu') { await setState(chatId, 'IDLE', {}, env); return showMainMenu(chatId, session); }
  if (data === 'logout') return logout(chatId, env);
  if (data === 'dashboard') return showDashboard(chatId, session);
  if (data === 'account') return showAccount(chatId, session);
  if (data === 'more') return showMoreMenu(chatId, session);
  if (data === 'held_invoices') return showHeldInvoices(chatId, session);
  if (data === 'transfers_history') return showTransfersHistory(chatId, session);
  if (data === 'stock_movements') return showStockMovements(chatId, session);
  if (data === 'warehouses') return showWarehouses(chatId, session);
  if (data === 'settings_info') return showSettingsInfo(chatId, session);
  if (data === 'trash_info') return showTrashInfo(chatId, session);
  if (data === 'restaurant_tables') return showRestaurantTables(chatId, session);
  if (data === 'restaurant_orders') return showRestaurantOrders(chatId, session);
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
  if (data === 'customer_new') return beginCustomerCreate(chatId, session, env);
  if (data === 'supplier_new') return beginSupplierCreate(chatId, session, env);
  if (data === 'purchase_new') return beginPurchase(chatId, session, env);
  if (data === 'return_new') return beginReturn(chatId, session, env);
  if (data === 'account_transfer') return beginAccountTransfer(chatId, session, env);
  if (data === 'shift_action') return showShiftAction(chatId, session, env);
  if (data === 'stock_transfer') return beginStockTransfer(chatId, session, env);
  if (data === 'employees') return showEmployees(chatId, session);
  if (data === 'purchase_search') { const st=await getState(chatId,env); await setState(chatId, 'PURCHASE_SEARCH', st.data||{}, env); return sendMessage(chatId, '🔎 اكتب اسم الصنف أو SKU أو الباركود لإضافته للمشتريات:', backButton()); }
  if (data === 'purchase_cart') return showPurchaseCart(chatId, session, env);
  if (data === 'purchase_finish_cash') return finishPurchase(chatId, session, env, 'cash');
  if (data === 'purchase_finish_debt') return finishPurchase(chatId, session, env, 'debt');
  if (data === 'shift_open') { await setState(chatId,'SHIFT_OPEN_AMOUNT',{},env); return sendMessage(chatId,'💵 اكتب العهدة الافتتاحية للصندوق:'); }
  if (data === 'shift_close') { await setState(chatId,'SHIFT_CLOSE_AMOUNT',{},env); return sendMessage(chatId,'💵 اكتب النقد الفعلي الموجود في الصندوق عند الإغلاق:'); }
  if (data === 'return_balance') return finishFullReturn(chatId, session, env, 'customer_balance');
  if (data === 'return_account') return finishFullReturn(chatId, session, env, 'account');
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
  if (data.startsWith('pursupp:')) return choosePurchaseSupplierIndex(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('pprod:')) return choosePurchaseProduct(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('punit:')) return choosePurchaseUnit(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('retinv:')) return chooseReturnInvoice(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('trfrom:')) return chooseTransferFrom(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('trto:')) return chooseTransferTo(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('stfrom:')) return chooseStockTransferFrom(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('stto:')) return chooseStockTransferTo(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('stprod:')) return chooseStockTransferProduct(chatId, session, state, Number(data.split(':')[1]), env);
  if (data.startsWith('stunit:')) return chooseStockTransferUnit(chatId, session, state, Number(data.split(':')[1]), env);
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
  if (state.mode === 'CUSTOMER_NEW_NAME') {
    const name=text.trim(); if(name.length<2)return sendMessage(chatId,'اكتب اسم العميل بشكل صحيح.');
    await setState(chatId,'CUSTOMER_NEW_PHONE',{name},env);
    return sendMessage(chatId,'📱 اكتب رقم هاتف العميل، أو <code>-</code> بدون رقم.');
  }
  if (state.mode === 'CUSTOMER_NEW_PHONE') {
    await setState(chatId,'CUSTOMER_NEW_OPENING',{...state.data,phone:text==='-'?'':text.trim()},env);
    return sendMessage(chatId,'💳 اكتب الرصيد الافتتاحي للعميل.\nموجب = <b>لنا على العميل</b>، سالب = <b>للعميل علينا</b>، أو 0.');
  }
  if (state.mode === 'CUSTOMER_NEW_OPENING') {
    const opening=parseUserNumber(text); if(!Number.isFinite(opening))return sendMessage(chatId,'اكتب رقماً صحيحاً مثل 0 أو 150 أو -50.');
    const row=await createCustomerRemote(session.payload,{...state.data,opening},chatId);
    await setState(chatId,'IDLE',{},env);
    return sendMessage(chatId,`✅ تم إضافة العميل <b>${e(row.name)}</b> ورصيده ${money(row.balance,(await getSettings(session.payload)).currencySymbol||'₪')}.`,mainMenuButton());
  }
  if (state.mode === 'SUPPLIER_NEW_NAME') {
    const name=text.trim(); if(name.length<2)return sendMessage(chatId,'اكتب اسم المورد بشكل صحيح.');
    await setState(chatId,'SUPPLIER_NEW_PHONE',{name},env);
    return sendMessage(chatId,'📱 اكتب رقم هاتف المورد، أو <code>-</code> بدون رقم.');
  }
  if (state.mode === 'SUPPLIER_NEW_PHONE') {
    await setState(chatId,'SUPPLIER_NEW_OPENING',{...state.data,phone:text==='-'?'':text.trim()},env);
    return sendMessage(chatId,'💳 اكتب الرصيد الافتتاحي للمورد.\nموجب = <b>علينا للمورد</b>، سالب = <b>لنا عند المورد</b>، أو 0.');
  }
  if (state.mode === 'SUPPLIER_NEW_OPENING') {
    const opening=parseUserNumber(text); if(!Number.isFinite(opening))return sendMessage(chatId,'اكتب رقماً صحيحاً مثل 0 أو 150 أو -50.');
    const row=await createSupplierRemote(session.payload,{...state.data,opening},chatId);
    await setState(chatId,'IDLE',{},env);
    return sendMessage(chatId,`✅ تم إضافة المورد <b>${e(row.name)}</b> ورصيده ${money(row.balance,(await getSettings(session.payload)).currencySymbol||'₪')}.`,mainMenuButton());
  }
  if (state.mode === 'PURCHASE_SEARCH') {
    const products=await searchProducts(session.payload,text);
    if(!products.length)return sendMessage(chatId,'لا توجد أصناف مطابقة. اكتب كلمة أخرى.',{inline_keyboard:[[btn('🧺 سلة المشتريات','purchase_cart')],[btn('🏠 إلغاء','menu')]]});
    await setState(chatId,'PURCHASE_RESULTS',{...state.data,purchase_product_ids:products.slice(0,15).map(x=>x.id)},env);
    return sendMessage(chatId,'🛍 اختر الصنف لإضافته لفاتورة الشراء:',{inline_keyboard:products.slice(0,15).map((x,i)=>[btn(x.name,`pprod:${i}`)]).concat([[btn('🧺 سلة المشتريات','purchase_cart')],[btn('🏠 إلغاء','menu')]])});
  }
  if (state.mode === 'PURCHASE_QTY') {
    const qty=parseUserNumber(text); if(!(qty>0))return sendMessage(chatId,'اكتب كمية صحيحة أكبر من صفر.');
    await setState(chatId,'PURCHASE_PRICE',{...state.data,purchaseQty:qty},env);
    return sendMessage(chatId,'💵 اكتب سعر شراء الوحدة المختارة:');
  }
  if (state.mode === 'PURCHASE_PRICE') {
    const price=parseUserNumber(text); if(!(price>=0))return sendMessage(chatId,'اكتب سعر شراء صحيحاً.');
    const next=await addPurchaseLineFromState(chatId,state,price,env);
    await setState(chatId,'PURCHASE_BUILD',next,env);
    return showPurchaseCart(chatId,session,env);
  }
  if (state.mode === 'ACCOUNT_TRANSFER_AMOUNT') {
    const amount=parseUserNumber(text); if(!(amount>0))return sendMessage(chatId,'اكتب مبلغاً صحيحاً أكبر من صفر.');
    const tr=await createAccountTransferRemote(session.payload,state.data.fromAccountId,state.data.toAccountId,amount,'تم من بوت تيليجرام',chatId);
    await setState(chatId,'IDLE',{},env);
    return sendMessage(chatId,`✅ تم تحويل <b>${money(tr.amount,(await getSettings(session.payload)).currencySymbol||'₪')}</b> من ${e(tr.fromAccountName)} إلى ${e(tr.toAccountName)}.`,mainMenuButton());
  }
  if (state.mode === 'SHIFT_OPEN_AMOUNT') {
    const amount=parseUserNumber(text); if(!(amount>=0))return sendMessage(chatId,'اكتب مبلغ افتتاحي صحيحاً أو 0.');
    const sh=await openShiftRemote(session.payload,amount,chatId);
    await setState(chatId,'IDLE',{},env);
    return sendMessage(chatId,`✅ تم فتح الوردية رقم <b>${e(sh.shiftNumber)}</b> بعهدة ${money(sh.openingCash,(await getSettings(session.payload)).currencySymbol||'₪')}.`,mainMenuButton());
  }
  if (state.mode === 'SHIFT_CLOSE_AMOUNT') {
    const amount=parseUserNumber(text); if(!(amount>=0))return sendMessage(chatId,'اكتب النقد الفعلي بشكل صحيح.');
    await setState(chatId,'SHIFT_CLOSE_NOTES',{actualCash:amount},env);
    return sendMessage(chatId,'📝 اكتب ملاحظات إغلاق الوردية أو <code>-</code> بدون ملاحظات.');
  }
  if (state.mode === 'SHIFT_CLOSE_NOTES') {
    const sh=await closeShiftRemote(session.payload,state.data.actualCash,text==='-'?'':text,chatId);
    await setState(chatId,'IDLE',{},env);
    const symbol=(await getSettings(session.payload)).currencySymbol||'₪';
    return sendMessage(chatId,`✅ تم إغلاق الوردية.\n💵 الفعلي: ${money(sh.actualCash,symbol)}\n📌 المتوقع: ${money(sh.expectedCash,symbol)}\n⚖️ الفرق: <b>${money(sh.difference,symbol)}</b>`,mainMenuButton());
  }
  if (state.mode === 'STOCK_TRANSFER_QTY') {
    const qty=parseUserNumber(text); if(!(qty>0))return sendMessage(chatId,'اكتب كمية صحيحة أكبر من صفر.');
    const result=await createStockTransferRemote(session.payload,{...state.data,quantity:qty},chatId);
    await setState(chatId,'IDLE',{},env);
    return sendMessage(chatId,`✅ تم تحويل ${qty} ${e(result.unitName)} من ${e(result.fromName)} إلى ${e(result.toName)} للصنف <b>${e(result.productName)}</b>.`,mainMenuButton());
  }

  if (state.mode === 'VOUCHER_AMOUNT') {
    const amount = parseUserNumber(text);
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
    const amount = parseUserNumber(text);
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


async function beginCustomerCreate(chatId,session,env){
  await setState(chatId,'CUSTOMER_NEW_NAME',{},env);
  return sendMessage(chatId,'👤 <b>إضافة عميل جديد</b>\n\nاكتب اسم العميل:');
}

async function createCustomerRemote(payload,data,chatId){
  const now=new Date().toISOString(),id='cust-tg-'+Date.now();
  const opening=Number(data.opening)||0,amount=Math.abs(opening),side=opening>=0?'ours':'theirs';
  const customer={id,name:String(data.name||'').trim(),phone:String(data.phone||'').trim(),address:'',notes:'أضيف من بوت تيليجرام',balance:opening,openingBalanceAmount:amount,openingBalanceSide:side,createdAt:now,deletedAt:null};
  const changes=[chg('customers',id,customer)];
  if(amount>0){changes.push(chg('partner_statements',`stmt-opening-customer-${id}`,{id:`stmt-opening-customer-${id}`,partnerType:'customer',partnerId:id,partnerName:customer.name,date:now,type:'opening',referenceType:'OPENING_BALANCE',referenceId:id,referenceNumber:'OPENING',description:`رصيد افتتاحي للعميل - ${side==='ours'?'لنا':'علينا'}`,debit:opening>0?amount:0,credit:opening<0?amount:0,runningBalance:opening}))}
  await writeBatch(payload,changes,chatId);return customer;
}

async function beginSupplierCreate(chatId,session,env){
  await setState(chatId,'SUPPLIER_NEW_NAME',{},env);
  return sendMessage(chatId,'🏭 <b>إضافة مورد جديد</b>\n\nاكتب اسم المورد:');
}

async function createSupplierRemote(payload,data,chatId){
  const now=new Date().toISOString(),id='supp-tg-'+Date.now();
  const opening=Number(data.opening)||0,amount=Math.abs(opening),side=opening>=0?'theirs':'ours';
  const supplier={id,name:String(data.name||'').trim(),phone:String(data.phone||'').trim(),address:'',notes:'أضيف من بوت تيليجرام',balance:opening,openingBalanceAmount:amount,openingBalanceSide:side,createdAt:now,deletedAt:null};
  const changes=[chg('suppliers',id,supplier)];
  if(amount>0){changes.push(chg('partner_statements',`stmt-opening-supplier-${id}`,{id:`stmt-opening-supplier-${id}`,partnerType:'supplier',partnerId:id,partnerName:supplier.name,date:now,type:'opening',referenceType:'OPENING_BALANCE',referenceId:id,referenceNumber:'OPENING',description:`رصيد افتتاحي للمورد - ${side==='ours'?'لنا':'علينا'}`,debit:opening<0?amount:0,credit:opening>0?amount:0,runningBalance:opening}))}
  await writeBatch(payload,changes,chatId);return supplier;
}

async function beginPurchase(chatId,session,env){
  const suppliers=(await readStore(session.payload,'suppliers')).filter(x=>!x.deletedAt).slice(0,30);
  if(!suppliers.length)return sendMessage(chatId,'لا يوجد موردون. أضف مورداً أولاً.',{inline_keyboard:[[btn('➕ إضافة مورد','supplier_new')],[btn('🏠 الرئيسية','menu')]]});
  await setState(chatId,'PURCHASE_SUPPLIER',{purchase_supplier_ids:suppliers.map(x=>x.id),purchaseCart:[]},env);
  return sendMessage(chatId,'🛍 <b>فاتورة مشتريات جديدة</b>\n\nاختر المورد:',{inline_keyboard:suppliers.map((x,i)=>[btn(x.name,`pursupp:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});
}

async function choosePurchaseSupplierIndex(chatId,session,state,idx,env){
  const id=state.data?.purchase_supplier_ids?.[idx];if(!id)return beginPurchase(chatId,session,env);
  const suppliers=await readStore(session.payload,'suppliers'),supp=suppliers.find(x=>String(x.id)===String(id));if(!supp)return sendMessage(chatId,'المورد غير موجود.',mainMenuButton());
  await setState(chatId,'PURCHASE_SEARCH',{...state.data,supplierId:supp.id,supplierName:supp.name,purchaseCart:state.data?.purchaseCart||[]},env);
  return sendMessage(chatId,`🏭 المورد: <b>${e(supp.name)}</b>\n\n🔎 اكتب اسم الصنف أو الباركود لإضافته:`);
}

async function choosePurchaseProduct(chatId,session,state,idx,env){
  const id=state.data?.purchase_product_ids?.[idx];if(!id)return sendMessage(chatId,'الصنف غير موجود.',backButton());
  const products=await readStore(session.payload,'products'),p=products.find(x=>String(x.id)===String(id));if(!p)return sendMessage(chatId,'الصنف غير موجود.',backButton());
  const units=Array.isArray(p.units)&&p.units.length?p.units:[{id:p.baseUnitId||'base',name:p.baseUnitName||'وحدة',conversionToBase:1,purchasePrice:num(p.costPrice),costPrice:num(p.costPrice)}];
  await setState(chatId,'PURCHASE_UNIT',{...state.data,selectedPurchaseProductId:p.id,purchase_unit_ids:units.map(u=>u.id)},env);
  return sendMessage(chatId,`📦 <b>${e(p.name)}</b>\nاختر وحدة الشراء:`,{inline_keyboard:units.slice(0,20).map((u,i)=>[btn(u.name||'وحدة',`punit:${i}`)]).concat([[btn('🧺 السلة','purchase_cart')],[btn('🏠 إلغاء','menu')]])});
}

async function choosePurchaseUnit(chatId,session,state,idx,env){
  const unitId=state.data?.purchase_unit_ids?.[idx];if(!unitId)return sendMessage(chatId,'الوحدة غير موجودة.',backButton());
  await setState(chatId,'PURCHASE_QTY',{...state.data,selectedPurchaseUnitId:unitId},env);
  return sendMessage(chatId,'🔢 اكتب الكمية المشتراة:');
}

async function addPurchaseLineFromState(chatId,state,price,env){
  const data={...state.data};const productId=data.selectedPurchaseProductId,unitId=data.selectedPurchaseUnitId,qty=Number(data.purchaseQty)||0;
  const session=await getSession(chatId,env);if(!session)throw new Error('انتهت جلسة الدخول.');
  const products=await readStore(session.payload,'products'),p=products.find(x=>String(x.id)===String(productId));if(!p)throw new Error('الصنف غير موجود.');
  const units=Array.isArray(p.units)&&p.units.length?p.units:[{id:p.baseUnitId||'base',name:p.baseUnitName||'وحدة',conversionToBase:1}];const u=units.find(x=>String(x.id)===String(unitId))||units[0];
  const factor=Math.max(0.00000001,num(u.conversionToBase||u.multiplier)||1);const line={productId:p.id,productName:p.name,unitId:u.id,unitName:u.name||p.baseUnitName||'وحدة',quantity:qty,conversionFactor:factor,baseQuantity:qty*factor,unitPrice:Number(price)||0,total:qty*(Number(price)||0),expiryDate:''};
  const cart=Array.isArray(data.purchaseCart)?[...data.purchaseCart]:[];cart.push(line);
  return {...data,purchaseCart:cart,selectedPurchaseProductId:null,selectedPurchaseUnitId:null,purchaseQty:null,purchase_product_ids:[],purchase_unit_ids:[]};
}

async function showPurchaseCart(chatId,session,env){
  const st=await getState(chatId,env),cart=Array.isArray(st.data?.purchaseCart)?st.data.purchaseCart:[],settings=await getSettings(session.payload),cur=settings.currencySymbol||'₪';
  if(!cart.length)return sendMessage(chatId,'🧺 سلة المشتريات فارغة.',{inline_keyboard:[[btn('🔎 إضافة صنف','purchase_search')],[btn('🏠 إلغاء','menu')]]});
  const total=cart.reduce((a,x)=>a+num(x.total),0);const lines=cart.map((x,i)=>`${i+1}. ${e(x.productName)} — ${num(x.quantity)} ${e(x.unitName)} × ${money(x.unitPrice,cur)} = <b>${money(x.total,cur)}</b>`).join('\n');
  return sendMessage(chatId,`🧺 <b>سلة المشتريات</b>\n🏭 ${e(st.data?.supplierName||'')}\n\n${lines}\n\n💰 الإجمالي: <b>${money(total,cur)}</b>`,{inline_keyboard:[[btn('➕ إضافة صنف','purchase_search')],[btn('💵 شراء نقدي','purchase_finish_cash'),btn('🧾 شراء آجل','purchase_finish_debt')],[btn('🏠 إلغاء','menu')]]});
}

async function finishPurchase(chatId,session,env,paymentType){
  const st=await getState(chatId,env),cart=st.data?.purchaseCart||[];if(!cart.length)return showPurchaseCart(chatId,session,env);
  await sendMessage(chatId,'⏳ جاري حفظ فاتورة المشتريات وتحديث المخزون...');
  try{const inv=await createPurchaseRemote(session.payload,{supplierId:st.data.supplierId,supplierName:st.data.supplierName,items:cart,paymentType},chatId);await setState(chatId,'IDLE',{},env);return sendMessage(chatId,formatInvoiceNotification({...inv,type:'purchase'},session.payload.companyName),mainMenuButton())}catch(error){return sendMessage(chatId,`❌ تعذر حفظ المشتريات:\n${e(String(error?.message||error))}`,{inline_keyboard:[[btn('🧺 العودة للسلة','purchase_cart')],[btn('🏠 الرئيسية','menu')]]})}
}

async function createPurchaseRemote(payload,data,chatId){
  const [settings,warehouses,products,stock,suppliers,accounts]=await Promise.all([getSettings(payload),readStore(payload,'warehouses'),readStore(payload,'products'),readStore(payload,'stock'),readStore(payload,'suppliers'),readStore(payload,'accounts')]);
  const now=new Date().toISOString(),purchaseDate=now,invoiceNumber=`PUR-${Date.now().toString().slice(-6)}`,invoiceId='pur-'+Date.now(),syncId='pur-'+Date.now();
  const targetWarehouse=warehouses.find(w=>String(w.id)===String(settings.activeWarehouseId))||warehouses.find(w=>w.isDefault)||warehouses[0];if(!targetWarehouse)throw new Error('لا يوجد مخزن متاح.');
  const supplier=suppliers.find(x=>String(x.id)===String(data.supplierId));if(!supplier)throw new Error('المورد غير موجود.');
  const items=(data.items||[]).filter(x=>x.productId&&num(x.quantity)>0);if(!items.length)throw new Error('سلة المشتريات فارغة.');
  const subtotal=items.reduce((a,x)=>a+num(x.total),0),grandTotal=subtotal;const account=accounts.find(x=>x.isDefault)||accounts[0];if(data.paymentType==='cash'&&!account)throw new Error('لا يوجد صندوق أو حساب مالي افتراضي.');
  const paidAmount=data.paymentType==='cash'?grandTotal:0,remaining=Math.max(0,grandTotal-paidAmount),payments=data.paymentType==='cash'?[{accountId:account.id,method:account.type||'cash',amount:grandTotal}]:[];
  const invoice={id:invoiceId,invoiceNumber,supplierInvoiceNumber:'',date:purchaseDate,supplierId:supplier.id,supplierName:supplier.name,warehouseId:targetWarehouse.id,warehouseName:targetWarehouse.name||'المخزن',items:items.map((x,i)=>({id:`pur-it-${Date.now()}-${i}`,...x})),subtotal,discountType:'fixed',discountValue:0,discountTotal:0,taxTotal:0,grandTotal,paidAmount,remainingAmount:remaining,paymentType:data.paymentType,payments,notes:'تمت من بوت تيليجرام',syncId,isSynced:false,createdAt:now};
  const productCopies=products.map(p=>({...p,fifoBatches:Array.isArray(p.fifoBatches)?p.fifoBatches.map(b=>({...b})):[]})),stockRows=stock.map(x=>({...x})),moves=[],changes=[chg('purchases',invoice.id,invoice)];
  for(const item of items){const pi=productCopies.findIndex(p=>String(p.id)===String(item.productId));if(pi<0)continue;const si=stockRows.findIndex(x=>String(x.productId)===String(item.productId)&&String(x.warehouseId)===String(targetWarehouse.id));const current=si>=0?num(stockRows[si].baseQuantity):0,totalCurrent=stockRows.filter(x=>String(x.productId)===String(item.productId)).reduce((a,x)=>a+Math.max(0,num(x.baseQuantity)),0),baseQty=Math.max(0,num(item.baseQuantity)),newQty=current+baseQty;
    const currentCost=num(productCopies[pi].costPrice),unitCost=(num(item.unitPrice))/Math.max(0.00000001,num(item.conversionFactor)||1);let batches=productCopies[pi].fifoBatches||[];if(current>0&&!batches.some(b=>(String(b.warehouseId)===String(targetWarehouse.id)||!b.warehouseId)&&num(b.remainingBaseQty)>0))batches.push({id:`legacy-${item.productId}-${targetWarehouse.id}`,purchaseId:'legacy',warehouseId:targetWarehouse.id,receivedAt:'2000-01-01T00:00:00.000Z',expiryDate:productCopies[pi].expiryDate||'',unitCost:currentCost,remainingBaseQty:current});batches.push({id:`batch-${invoice.id}-${item.productId}-${Math.random().toString(36).slice(2,6)}`,purchaseId:invoice.id,warehouseId:targetWarehouse.id,receivedAt:purchaseDate,expiryDate:item.expiryDate||productCopies[pi].expiryDate||'',unitCost,remainingBaseQty:baseQty});const totalUnits=Math.max(0,totalCurrent)+baseQty,newWAC=totalUnits>0?((Math.max(0,totalCurrent)*currentCost)+(baseQty*unitCost))/totalUnits:unitCost;productCopies[pi]={...productCopies[pi],costPrice:parseFloat(newWAC.toFixed(4)),fifoBatches:batches,updatedAt:now};
    const nextStock=si>=0?{...stockRows[si],baseQuantity:newQty,updatedAt:now}:{productId:item.productId,warehouseId:targetWarehouse.id,baseQuantity:newQty,updatedAt:now};if(si>=0)stockRows[si]=nextStock;else stockRows.push(nextStock);moves.push({id:'mov-'+Math.random().toString(36).slice(2,9),date:purchaseDate,productId:item.productId,productName:item.productName,warehouseId:targetWarehouse.id,warehouseName:targetWarehouse.name||'المخزن',type:'purchase',unitName:item.unitName,quantityInUnit:item.quantity,conversionFactor:item.conversionFactor,baseQuantityChange:baseQty,newBaseBalance:newQty,referenceId:invoice.id,referenceType:'PURCHASE',userId:payload.account?.id||'',userName:payload.account?.name||'Telegram'});
  }
  for(const p of productCopies){const old=products.find(x=>String(x.id)===String(p.id));if(old&&JSON.stringify(old)!==JSON.stringify(p))changes.push(chg('products',p.id,p));}
  for(const st of stockRows){const old=stock.find(x=>String(x.productId)===String(st.productId)&&String(x.warehouseId)===String(st.warehouseId));if(!old||num(old.baseQuantity)!==num(st.baseQuantity))changes.push(chg('stock',JSON.stringify([st.productId,st.warehouseId]),st));}
  moves.forEach(m=>changes.push(chg('stock_movements',m.id,m)));
  if(data.paymentType==='cash')changes.push(chg('accounts',account.id,{...account,balance:num(account.balance)-grandTotal}));
  if(remaining>0){const nb=num(supplier.balance)+remaining;changes.push(chg('suppliers',supplier.id,{...supplier,balance:nb}));const stmt={id:'stmt-'+Date.now(),date:purchaseDate,type:'purchase',partyType:'supplier',partnerId:supplier.id,partnerName:supplier.name,referenceNumber:invoiceNumber,description:`فاتورة مشتريات رقم ${invoiceNumber}`,debit:0,credit:remaining,runningBalance:nb};changes.push(chg('partner_statements',stmt.id,stmt));}
  await writeBatch(payload,changes,chatId);return invoice;
}

async function beginReturn(chatId,session,env){
  const rows=(await readStore(session.payload,'invoices')).filter(x=>x.type==='sale').sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)).slice(0,15);if(!rows.length)return sendMessage(chatId,'لا توجد فواتير مبيعات لإرجاعها.',mainMenuButton());
  await setState(chatId,'RETURN_PICK',{return_invoice_ids:rows.map(x=>x.id)},env);return sendMessage(chatId,'↩️ <b>اختر فاتورة لعمل مرتجع كامل</b>:',{inline_keyboard:rows.map((x,i)=>[btn(`${x.invoiceNumber} • ${x.customerName||'عميل'} • ${num(x.grandTotal).toFixed(2)}`,`retinv:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});
}

async function chooseReturnInvoice(chatId,session,state,idx,env){
  const id=state.data?.return_invoice_ids?.[idx];if(!id)return beginReturn(chatId,session,env);const rows=await readStore(session.payload,'invoices'),inv=rows.find(x=>String(x.id)===String(id));if(!inv)return sendMessage(chatId,'الفاتورة غير موجودة.',mainMenuButton());
  await setState(chatId,'RETURN_MODE',{...state.data,returnInvoiceId:id},env);const buttons=[];if(inv.customerId&&inv.customerId!=='cust-walkin')buttons.push([btn('💳 إضافة المرتجع لرصيد العميل','return_balance')]);buttons.push([btn('💵 رد المبلغ من الصندوق','return_account')],[btn('🏠 إلغاء','menu')]);return sendMessage(chatId,formatInvoiceNotification(inv,session.payload.companyName)+'\n\n↩️ اختر طريقة رد قيمة المرتجع الكامل:',{inline_keyboard:buttons});
}

async function finishFullReturn(chatId,session,env,mode){
  const st=await getState(chatId,env),id=st.data?.returnInvoiceId;if(!id)return beginReturn(chatId,session,env);await sendMessage(chatId,'⏳ جاري تسجيل المرتجع وتحديث المخزون...');
  try{const ret=await createFullReturnRemote(session.payload,id,mode,chatId);await setState(chatId,'IDLE',{},env);return sendMessage(chatId,formatInvoiceNotification(ret,session.payload.companyName),mainMenuButton())}catch(error){return sendMessage(chatId,`❌ ${e(String(error?.message||error))}`,mainMenuButton())}
}

async function createFullReturnRemote(payload,originalId,mode,chatId){
  const [invoices,stock,accounts,shifts,customers,warehouses]=await Promise.all([readStore(payload,'invoices'),readStore(payload,'stock'),readStore(payload,'accounts'),readStore(payload,'shifts'),readStore(payload,'customers'),readStore(payload,'warehouses')]);const original=invoices.find(x=>String(x.id)===String(originalId));if(!original||original.type!=='sale')throw new Error('الفاتورة الأصلية غير موجودة.');
  const now=new Date().toISOString(),returnNumber=`RET-${Date.now().toString().slice(-6)}`,refundTotal=num(original.grandTotal),items=(original.items||[]).map(x=>({...x,id:'ret-item-'+Math.random().toString(36).slice(2,9),total:num(x.total)}));const account=accounts.find(x=>x.isDefault)||accounts[0],activeShift=shifts.find(x=>String(x.status).toLowerCase()==='open'),customer=customers.find(x=>String(x.id)===String(original.customerId));if(mode==='account'&&!account)throw new Error('لا يوجد صندوق أو حساب مالي للرد.');
  const ret={id:'ret-'+Date.now(),invoiceNumber:returnNumber,type:'return',date:now,customerId:original.customerId,customerName:original.customerName,cashierId:payload.account?.id||'',cashierName:payload.account?.name||'Telegram',shiftId:activeShift?.id,branchId:original.branchId,warehouseId:original.warehouseId,items,subtotal:refundTotal,lineDiscountTotal:0,invoiceDiscountType:'fixed',invoiceDiscountValue:0,invoiceDiscountAmount:0,discountTotal:0,taxTotal:0,roundingAdjustment:0,grandTotal:refundTotal,paidAmount:refundTotal,remainingAmount:0,changeAmount:0,paymentType:mode==='customer_balance'?'customer_balance':'cash',refundMode:mode,payments:mode==='account'?[{method:account.type==='cash'?'cash':'account',amount:refundTotal,accountId:account.id,accountName:account.name}]:[],status:'completed',originalInvoiceId:original.id,notes:'مرتجع كامل من بوت تيليجرام',syncId:'ret-'+Date.now(),isSynced:false,createdAt:now};
  const changes=[chg('invoices',ret.id,ret)],stockRows=stock.map(x=>({...x}));for(const item of items){const idx=stockRows.findIndex(s=>String(s.productId)===String(item.productId)&&String(s.warehouseId)===String(original.warehouseId)),cur=idx>=0?num(stockRows[idx].baseQuantity):0,base=num(item.baseQuantity)||num(item.quantity)*(num(item.conversionFactor)||1),next=cur+base,row=idx>=0?{...stockRows[idx],baseQuantity:next,updatedAt:now}:{productId:item.productId,warehouseId:original.warehouseId,baseQuantity:next,updatedAt:now};if(idx>=0)stockRows[idx]=row;else stockRows.push(row);changes.push(chg('stock',JSON.stringify([item.productId,original.warehouseId]),row));const mov={id:'mov-'+Math.random().toString(36).slice(2,9),date:now,productId:item.productId,productName:item.productName,warehouseId:original.warehouseId,warehouseName:warehouses.find(w=>String(w.id)===String(original.warehouseId))?.name||'المخزن',type:'return',unitName:item.unitName,quantityInUnit:item.quantity,conversionFactor:item.conversionFactor,baseQuantityChange:base,newBaseBalance:next,referenceId:ret.id,referenceType:'RETURN',userId:payload.account?.id||'',userName:payload.account?.name||'Telegram'};changes.push(chg('stock_movements',mov.id,mov));}
  if(mode==='customer_balance'){if(!customer)throw new Error('العميل غير موجود لإضافة المرتجع إلى رصيده.');const nb=num(customer.balance)-refundTotal;changes.push(chg('customers',customer.id,{...customer,balance:nb}));const stmt={id:'stmt-ret-'+Date.now(),partnerType:'customer',partnerId:customer.id,partnerName:customer.name,date:now,referenceType:'SALES_RETURN',referenceId:ret.id,referenceNumber:returnNumber,description:`مرتجع مبيعات ${returnNumber}`,debit:0,credit:refundTotal,runningBalance:nb};changes.push(chg('partner_statements',stmt.id,stmt));}else{changes.push(chg('accounts',account.id,{...account,balance:num(account.balance)-refundTotal}));if(activeShift&&account.type==='cash')changes.push(chg('shifts',activeShift.id,{...activeShift,totalCashReturns:num(activeShift.totalCashReturns)+refundTotal,expectedCash:num(activeShift.expectedCash)-refundTotal}));}
  await writeBatch(payload,changes,chatId);return ret;
}

async function beginAccountTransfer(chatId,session,env){
  const rows=await readStore(session.payload,'accounts');if(rows.length<2)return sendMessage(chatId,'يجب وجود حسابين ماليين على الأقل.',mainMenuButton());await setState(chatId,'ACCOUNT_TRANSFER_FROM',{account_ids:rows.map(x=>x.id)},env);return sendMessage(chatId,'🔄 اختر الحساب المصدر:',{inline_keyboard:rows.map((x,i)=>[btn(`${x.name} • ${num(x.balance).toFixed(2)}`,`trfrom:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});
}
async function chooseTransferFrom(chatId,session,state,idx,env){const id=state.data?.account_ids?.[idx];if(!id)return beginAccountTransfer(chatId,session,env);const rows=await readStore(session.payload,'accounts'),targets=rows.filter(x=>String(x.id)!==String(id));await setState(chatId,'ACCOUNT_TRANSFER_TO',{...state.data,fromAccountId:id,to_account_ids:targets.map(x=>x.id)},env);return sendMessage(chatId,'➡️ اختر الحساب المستلم:',{inline_keyboard:targets.map((x,i)=>[btn(x.name,`trto:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});}
async function chooseTransferTo(chatId,session,state,idx,env){const id=state.data?.to_account_ids?.[idx];if(!id)return beginAccountTransfer(chatId,session,env);await setState(chatId,'ACCOUNT_TRANSFER_AMOUNT',{...state.data,toAccountId:id},env);return sendMessage(chatId,'💵 اكتب مبلغ التحويل:');}
async function createAccountTransferRemote(payload,fromId,toId,amount,notes,chatId){const accounts=await readStore(payload,'accounts'),from=accounts.find(x=>String(x.id)===String(fromId)),to=accounts.find(x=>String(x.id)===String(toId));if(!from||!to)throw new Error('الحساب غير موجود.');if(num(from.balance)<amount)throw new Error('الرصيد في الحساب المصدر غير كافٍ.');const now=new Date().toISOString(),tr={id:'trans-'+Date.now(),date:now,fromAccountId:from.id,fromAccountName:from.name,toAccountId:to.id,toAccountName:to.name,amount,notes,userId:payload.account?.id||'',userName:payload.account?.name||'Telegram'};await writeBatch(payload,[chg('accounts',from.id,{...from,balance:num(from.balance)-amount}),chg('accounts',to.id,{...to,balance:num(to.balance)+amount}),chg('transfers',tr.id,tr)],chatId);return tr;}

async function showShiftAction(chatId,session,env){const rows=await readStore(session.payload,'shifts'),active=rows.find(x=>String(x.status).toLowerCase()==='open'),s=await getSettings(session.payload);if(active)return sendMessage(chatId,`🕐 <b>الوردية المفتوحة #${e(active.shiftNumber||active.id)}</b>\nالعهدة: ${money(active.openingCash,s.currencySymbol||'₪')}\nالمتوقع: <b>${money(active.expectedCash,s.currencySymbol||'₪')}</b>`,{inline_keyboard:[[btn('🔒 إغلاق الوردية','shift_close')],[btn('🏠 الرئيسية','menu')]]});return sendMessage(chatId,'🕐 لا توجد وردية مفتوحة.',{inline_keyboard:[[btn('🔓 فتح وردية','shift_open')],[btn('🏠 الرئيسية','menu')]]});}
async function openShiftRemote(payload,openingCash,chatId){const shifts=await readStore(payload,'shifts');if(shifts.some(x=>String(x.status).toLowerCase()==='open'))throw new Error('يوجد وردية مفتوحة بالفعل.');const last=shifts.reduce((m,x)=>Math.max(m,Math.trunc(num(x.shiftNumber))),0),now=new Date().toISOString(),sh={id:'shift-'+Date.now(),shiftNumber:last+1,cashierId:payload.account?.id||'',cashierName:payload.account?.name||'Telegram',startTime:now,openingCash:Math.max(0,openingCash),totalCashSales:0,totalOtherSales:0,totalCashReturns:0,totalCashExpenses:0,expectedCash:Math.max(0,openingCash),actualCash:0,difference:0,status:'open'};await writeBatch(payload,[chg('shifts',sh.id,sh)],chatId);return sh;}
async function closeShiftRemote(payload,actualCash,notes,chatId){const shifts=await readStore(payload,'shifts'),active=shifts.find(x=>String(x.status).toLowerCase()==='open');if(!active)throw new Error('لا توجد وردية مفتوحة.');const expected=num(active.expectedCash),actual=Math.max(0,num(actualCash)),closed={...active,endTime:new Date().toISOString(),actualCash:actual,difference:actual-expected,status:'closed',notes};await writeBatch(payload,[chg('shifts',active.id,closed)],chatId);return closed;}

async function beginStockTransfer(chatId,session,env){const wh=await readStore(session.payload,'warehouses');if(wh.length<2)return sendMessage(chatId,'يجب وجود مخزنين على الأقل للتحويل.',mainMenuButton());await setState(chatId,'STOCK_TRANSFER_FROM',{warehouse_ids:wh.map(x=>x.id)},env);return sendMessage(chatId,'🔁 اختر المخزن المصدر:',{inline_keyboard:wh.map((x,i)=>[btn(x.name,`stfrom:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});}
async function chooseStockTransferFrom(chatId,session,state,idx,env){const id=state.data?.warehouse_ids?.[idx];if(!id)return beginStockTransfer(chatId,session,env);const wh=await readStore(session.payload,'warehouses'),targets=wh.filter(x=>String(x.id)!==String(id));await setState(chatId,'STOCK_TRANSFER_TO',{...state.data,fromWarehouseId:id,to_warehouse_ids:targets.map(x=>x.id)},env);return sendMessage(chatId,'➡️ اختر المخزن المستلم:',{inline_keyboard:targets.map((x,i)=>[btn(x.name,`stto:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});}
async function chooseStockTransferTo(chatId,session,state,idx,env){const id=state.data?.to_warehouse_ids?.[idx];if(!id)return beginStockTransfer(chatId,session,env);const products=(await readStore(session.payload,'products')).filter(x=>!x.deletedAt).slice(0,30);await setState(chatId,'STOCK_TRANSFER_PRODUCT',{...state.data,toWarehouseId:id,stock_product_ids:products.map(x=>x.id)},env);return sendMessage(chatId,'📦 اختر الصنف المراد تحويله:',{inline_keyboard:products.map((x,i)=>[btn(x.name,`stprod:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});}
async function chooseStockTransferProduct(chatId,session,state,idx,env){const id=state.data?.stock_product_ids?.[idx];if(!id)return beginStockTransfer(chatId,session,env);const products=await readStore(session.payload,'products'),p=products.find(x=>String(x.id)===String(id));if(!p)return sendMessage(chatId,'الصنف غير موجود.',mainMenuButton());const units=Array.isArray(p.units)&&p.units.length?p.units:[{id:p.baseUnitId||'base',name:p.baseUnitName||'وحدة',conversionToBase:1}];await setState(chatId,'STOCK_TRANSFER_UNIT',{...state.data,stockProductId:id,stock_unit_ids:units.map(x=>x.id)},env);return sendMessage(chatId,`📦 ${e(p.name)}\nاختر الوحدة:`,{inline_keyboard:units.map((x,i)=>[btn(x.name||'وحدة',`stunit:${i}`)]).concat([[btn('🏠 إلغاء','menu')]])});}
async function chooseStockTransferUnit(chatId,session,state,idx,env){const id=state.data?.stock_unit_ids?.[idx];if(!id)return beginStockTransfer(chatId,session,env);await setState(chatId,'STOCK_TRANSFER_QTY',{...state.data,stockUnitId:id},env);return sendMessage(chatId,'🔢 اكتب الكمية المراد تحويلها:');}
async function createStockTransferRemote(payload,data,chatId){const [products,stock,warehouses,settings]=await Promise.all([readStore(payload,'products'),readStore(payload,'stock'),readStore(payload,'warehouses'),getSettings(payload)]),p=products.find(x=>String(x.id)===String(data.stockProductId));if(!p)throw new Error('الصنف غير موجود.');const units=Array.isArray(p.units)&&p.units.length?p.units:[{id:p.baseUnitId||'base',name:p.baseUnitName||'وحدة',conversionToBase:1}],u=units.find(x=>String(x.id)===String(data.stockUnitId))||units[0],base=num(data.quantity)*(num(u.conversionToBase)||1),from=warehouses.find(x=>String(x.id)===String(data.fromWarehouseId)),to=warehouses.find(x=>String(x.id)===String(data.toWarehouseId));if(!from||!to)throw new Error('المخزن غير موجود.');const fromRow=stock.find(x=>String(x.productId)===String(p.id)&&String(x.warehouseId)===String(from.id))||{productId:p.id,warehouseId:from.id,baseQuantity:0},toRow=stock.find(x=>String(x.productId)===String(p.id)&&String(x.warehouseId)===String(to.id))||{productId:p.id,warehouseId:to.id,baseQuantity:0};if(!settings.allowNegativeStock&&num(fromRow.baseQuantity)<base)throw new Error('الكمية المطلوبة أكبر من المتوفر بالمخزن المصدر.');const now=new Date().toISOString(),newFrom=num(fromRow.baseQuantity)-base,newTo=num(toRow.baseQuantity)+base,out={id:'mov-'+Date.now()+'-out',date:now,productId:p.id,productName:p.name,warehouseId:from.id,warehouseName:from.name,type:'transfer_out',unitName:u.name,quantityInUnit:num(data.quantity),conversionFactor:num(u.conversionToBase)||1,baseQuantityChange:-base,newBaseBalance:newFrom,userId:payload.account?.id||'',userName:payload.account?.name||'Telegram',notes:`تحويل إلى ${to.name} من بوت تيليجرام`},inn={...out,id:'mov-'+Date.now()+'-in',warehouseId:to.id,warehouseName:to.name,type:'transfer_in',baseQuantityChange:base,newBaseBalance:newTo,notes:`تحويل من ${from.name} من بوت تيليجرام`};await writeBatch(payload,[chg('stock',JSON.stringify([p.id,from.id]),{...fromRow,baseQuantity:newFrom,updatedAt:now}),chg('stock',JSON.stringify([p.id,to.id]),{...toRow,baseQuantity:newTo,updatedAt:now}),chg('stock_movements',out.id,out),chg('stock_movements',inn.id,inn)],chatId);return{productName:p.name,unitName:u.name,fromName:from.name,toName:to.name};}

async function showEmployees(chatId,session){const rows=(await readStore(session.payload,'employees')).filter(x=>x.active!==false&&!x.deletedAt).slice(0,30);return sendMessage(chatId,`👨‍💼 <b>الموظفون</b>\n\n${rows.length?rows.map(x=>`• ${e(x.name||x.displayName||'موظف')} — ${e(x.roleName||x.role||'')}`).join('\n'):'لا يوجد موظفون.'}`,mainMenuButton());}


async function showMoreMenu(chatId,session){
  const rows=[];
  if(hasPerm(session,'canAccessSales'))rows.push([btn('⏸ الفواتير المعلقة','held_invoices')]);
  if(hasPerm(session,'canAccessAccounts'))rows.push([btn('🔄 سجل التحويلات المالية','transfers_history')]);
  if(hasPerm(session,'canAccessInventory'))rows.push([btn('📚 حركات المخزون','stock_movements'),btn('🏬 المخازن','warehouses')]);
  if(hasPerm(session,'canAccessSettings'))rows.push([btn('⚙️ معلومات الإعدادات','settings_info')]);
  if(hasPerm(session,'canAccessTrash'))rows.push([btn('🗑 سلة المحذوفات','trash_info')]);
  if(hasPerm(session,'canAccessRestaurantTables'))rows.push([btn('🍽 الطاولات','restaurant_tables')]);
  if(hasPerm(session,'canAccessRestaurantWaiter'))rows.push([btn('👨‍🍳 طلبات المطعم','restaurant_orders')]);
  rows.push([btn('🏠 الرئيسية','menu')]);
  return sendMessage(chatId,'📋 <b>مزايا إضافية</b>\n\nاختر القسم:',{inline_keyboard:rows});
}
async function showHeldInvoices(chatId,session){const rows=(await readStore(session.payload,'held_invoices')).filter(x=>!x.deletedAt).slice(0,20);return sendMessage(chatId,`⏸ <b>الفواتير المعلقة</b>\n\n${rows.length?rows.map(x=>`• ${e(x.invoiceNumber||x.id)} — ${e(x.customerName||'عميل')} — ${num(x.grandTotal||x.total).toFixed(2)}`).join('\n'):'لا توجد فواتير معلقة.'}`,mainMenuButton())}
async function showTransfersHistory(chatId,session){const s=await getSettings(session.payload),rows=(await readStore(session.payload,'transfers')).sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)).slice(0,20);return sendMessage(chatId,`🔄 <b>التحويلات المالية</b>\n\n${rows.length?rows.map(x=>`• ${e(x.fromAccountName||'')} ← ${e(x.toAccountName||'')} — ${money(x.amount,s.currencySymbol||'₪')}`).join('\n'):'لا توجد تحويلات.'}`,mainMenuButton())}
async function showStockMovements(chatId,session){const rows=(await readStore(session.payload,'stock_movements')).sort((a,b)=>Date.parse(b.date||0)-Date.parse(a.date||0)).slice(0,25);return sendMessage(chatId,`📚 <b>آخر حركات المخزون</b>\n\n${rows.length?rows.map(x=>`• ${e(x.productName||'صنف')} — ${e(x.type||'')} — ${num(x.baseQuantityChange).toFixed(2)} — ${e(x.warehouseName||'')}`).join('\n'):'لا توجد حركات مخزون.'}`,mainMenuButton())}
async function showWarehouses(chatId,session){const settings=await getSettings(session.payload),rows=await readStore(session.payload,'warehouses');return sendMessage(chatId,`🏬 <b>المخازن</b>\n\n${rows.length?rows.map(x=>`${String(x.id)===String(settings.activeWarehouseId)?'⭐ ':''}${e(x.name)} — ${e(x.code||x.id)}`).join('\n'):'لا توجد مخازن.'}`,mainMenuButton())}
async function showSettingsInfo(chatId,session){const s=await getSettings(session.payload);return sendMessage(chatId,`⚙️ <b>إعدادات أوسكار</b>\n\n🏪 ${e(s.storeName||session.payload.companyName||'')}\n💱 العملة: ${e(s.currencySymbol||'')}\n🏬 المخزن النشط: ${e(s.activeWarehouseId||'')}\n🧾 الضريبة: ${num(s.taxRate).toFixed(2)}%\n📦 البيع بالسالب: ${s.allowNegativeStock?'مسموح':'غير مسموح'}\n🖨 الطابعة: ${e(s.printerWidth||'80mm')}`,mainMenuButton())}
async function showTrashInfo(chatId,session){const [p,c,s,e1]=await Promise.all([readStore(session.payload,'products'),readStore(session.payload,'customers'),readStore(session.payload,'suppliers'),readStore(session.payload,'expenses')]);return sendMessage(chatId,`🗑 <b>سلة المحذوفات</b>\n\n📦 أصناف: ${p.filter(x=>x.deletedAt).length}\n👥 عملاء: ${c.filter(x=>x.deletedAt).length}\n🏭 موردون: ${s.filter(x=>x.deletedAt).length}\n💸 مصروفات: ${e1.filter(x=>x.deletedAt).length}`,mainMenuButton())}
async function showRestaurantTables(chatId,session){const rows=await readStore(session.payload,'restaurant_tables');return sendMessage(chatId,`🍽 <b>الطاولات</b>\n\n${rows.length?rows.slice(0,30).map(x=>`• ${e(x.name||x.tableNumber||x.number||x.id)} — ${e(x.status||'')}${x.currentTotal!=null?` — ${num(x.currentTotal).toFixed(2)}`:''}`).join('\n'):'لا توجد طاولات.'}`,mainMenuButton())}
async function showRestaurantOrders(chatId,session){const rows=(await readStore(session.payload,'restaurant_orders')).sort((a,b)=>Date.parse(b.createdAt||b.date||0)-Date.parse(a.createdAt||a.date||0)).slice(0,20);return sendMessage(chatId,`👨‍🍳 <b>طلبات المطعم</b>\n\n${rows.length?rows.map(x=>`• ${e(x.orderNumber||x.id)} — ${e(x.tableName||x.tableNumber||'')} — ${e(x.status||'')} — ${num(x.total||x.grandTotal).toFixed(2)}`).join('\n'):'لا توجد طلبات.'}`,mainMenuButton())}

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


async function remoteStoreMaxRev(payload,store){
  const db=payload.database||{},table=tursoTable(db),companyId=String(payload.companyId||payload.tenantId||'');
  if(!companyId||!db.databaseURL||!db.authToken)return 0;
  const pre=`oscar/companies/${encodeURIComponent(companyId)}/d/${encodeURIComponent(store)}/`,hi=pre+'\uffff';
  const [r]=await pipeline(db,[{sql:`SELECT COALESCE(MAX(updated_at),0) AS max_rev FROM ${table} WHERE path>=? AND path<?`,args:[pre,hi]}],30000);
  return Number(resultRows(r)[0]?.max_rev||0);
}

async function remoteStoreChanges(payload,store,afterRev=0,limit=40){
  const db=payload.database||{},table=tursoTable(db),companyId=String(payload.companyId||payload.tenantId||'');
  if(!companyId||!db.databaseURL||!db.authToken)return [];
  const pre=`oscar/companies/${encodeURIComponent(companyId)}/d/${encodeURIComponent(store)}/`,hi=pre+'\uffff';
  const [r]=await pipeline(db,[{sql:`SELECT path,payload,deleted,updated_at FROM ${table} WHERE path>=? AND path<? AND updated_at>? ORDER BY updated_at ASC LIMIT ?`,args:[pre,hi,Number(afterRev)||0,Math.max(1,Math.min(100,Number(limit)||40))]}],45000);
  const out=[];
  for(const row of resultRows(r)){
    let env=null;try{env=parseJson(row.payload)}catch(_){env=null}
    const deleted=Number(row.deleted)===1||env?.deleted===true;
    let value=env&&typeof env==='object'&&Object.prototype.hasOwnProperty.call(env,'v')?env.v:env;
    const entityId=decodeURIComponent(String(row.path||'').split('/').pop()||'');
    out.push({rev:Number(row.updated_at||env?.rev||0),deleted,value,deviceId:String(env?.deviceId||''),entityId,path:row.path});
  }
  return out;
}

async function deliveryExists(env,key){const row=await env.DB.prepare('SELECT delivery_key FROM telegram_deliveries WHERE delivery_key=? LIMIT 1').bind(key).first();return !!row}
async function markDelivery(env,key,chatId,companyId,entityType,entityId){try{await env.DB.prepare('INSERT OR IGNORE INTO telegram_deliveries(delivery_key,chat_id,company_id,entity_type,entity_id,sent_at) VALUES(?,?,?,?,?,?)').bind(key,String(chatId),String(companyId),String(entityType),String(entityId),new Date().toISOString()).run()}catch(_){}}

async function deliverEntityToCompany(env,companyId,entity,entityType='invoice',companyName=''){
  const rows=await env.DB.prepare('SELECT * FROM telegram_sessions WHERE company_id=? AND active=1 ORDER BY updated_at DESC').bind(String(companyId)).all();let sent=0;
  for(const row of rows.results||[]){
    let session=null;try{session={...row,payload:JSON.parse(row.payload_json)}}catch(_){continue}
    const isPurchase=entityType==='purchase'||entity?.type==='purchase';
    if(isPurchase&&!hasPerm(session,'canAccessPurchases'))continue;
    if(!isPurchase&&!hasPerm(session,'canAccessSales')&&!hasPerm(session,'canAccessCashier'))continue;
    const entityId=String(entity?.id||entity?.invoiceNumber||Date.now()),key=`push:${row.chat_id}:${companyId}:${entityType}:${entityId}`;
    if(await deliveryExists(env,key))continue;
    try{const msg=await sendMessage(String(row.chat_id),formatInvoiceNotification(isPurchase?{...entity,type:'purchase'}:entity,companyName||row.company_name||''),mainMenuButton());if(msg?.ok){sent++;await markDelivery(env,key,row.chat_id,companyId,entityType,entityId)}}catch(_){}
  }
  return sent;
}

async function pollSessionStore(env,row,store,cursorField,entityType){
  let session;try{session={...row,payload:JSON.parse(row.payload_json)}}catch(_){return}
  const allowed=entityType==='purchase'?hasPerm(session,'canAccessPurchases'):(hasPerm(session,'canAccessSales')||hasPerm(session,'canAccessCashier'));
  let cursor=Number(row[cursorField] ?? 0),maxRev=cursor;
  if(cursor<0){
    try{const initial=await remoteStoreMaxRev(session.payload,store);await env.DB.prepare(`UPDATE telegram_sessions SET ${cursorField}=?,updated_at=? WHERE chat_id=?`).bind(initial,new Date().toISOString(),String(row.chat_id)).run()}catch(_){}
    return;
  }
  let changes=[];try{changes=await remoteStoreChanges(session.payload,store,cursor,50)}catch(error){console.warn('POLL_STORE_ERROR',store,row.company_id,String(error?.message||error));return}
  for(const item of changes){maxRev=Math.max(maxRev,Number(item.rev||0));if(item.deleted||!item.value)continue;if(!allowed)continue;
    // A transaction made from this same Telegram chat was already shown as the command result.
    if(item.deviceId===`TG-${row.chat_id}`)continue;
    const entity=item.value,entityId=String(entity?.id||item.entityId||entity?.invoiceNumber||''),key=`poll:${row.chat_id}:${row.company_id}:${entityType}:${entityId}:${item.rev}`;
    if(await deliveryExists(env,key))continue;
    try{const msg=await sendMessage(String(row.chat_id),formatInvoiceNotification(entityType==='purchase'?{...entity,type:'purchase'}:entity,row.company_name||session.payload.companyName||''),mainMenuButton());if(msg?.ok)await markDelivery(env,key,row.chat_id,row.company_id,entityType,entityId)}catch(error){console.warn('POLL_SEND_ERROR',String(error?.message||error))}
  }
  if(maxRev>cursor){try{await env.DB.prepare(`UPDATE telegram_sessions SET ${cursorField}=?,updated_at=? WHERE chat_id=?`).bind(maxRev,new Date().toISOString(),String(row.chat_id)).run()}catch(_){}}
}

async function pollNewAccountingEvents(env){
  const rows=await env.DB.prepare('SELECT * FROM telegram_sessions WHERE active=1 ORDER BY updated_at DESC').all();
  for(const row of rows.results||[]){
    await pollSessionStore(env,row,'invoices','invoice_cursor','invoice');
    await pollSessionStore(env,row,'purchases','purchase_cursor','purchase');
  }
  // Keep the dedupe table small.
  try{await env.DB.prepare("DELETE FROM telegram_deliveries WHERE sent_at < datetime('now','-30 days')").run()}catch(_){}
}

async function writeBatch(payload,changes,chatId){const db=payload.database||{};const table=tursoTable(db),meta=table+'_syncmeta',companyId=String(payload.companyId||payload.tenantId||'');await ensureRemoteSchema(db);const statements=[{sql:`UPDATE ${meta} SET batch=batch+1 WHERE id=1`,args:[]}];let n=0;for(const c of changes){const rev=Date.now()*1000+(n++%900);const path=`oscar/companies/${encodeURIComponent(companyId)}/d/${encodeURIComponent(c.store)}/${encodeURIComponent(c.key)}`;const envelope={v:c.deleted?null:c.value,deleted:!!c.deleted,rev,deviceId:`TG-${chatId}`,tenantId:companyId};statements.push({sql:`INSERT INTO ${table}(path,payload,deleted,updated_at,sync_batch) VALUES(?,?,?,?,(SELECT batch FROM ${meta} WHERE id=1)) ON CONFLICT(path) DO UPDATE SET payload=excluded.payload,deleted=excluded.deleted,updated_at=excluded.updated_at,sync_batch=excluded.sync_batch WHERE excluded.updated_at>=${table}.updated_at`,args:[path,JSON.stringify(envelope),c.deleted?1:0,rev]})}await pipeline(db,statements,Math.max(30000,changes.length*700));return true}
async function ensureRemoteSchema(db){const table=tursoTable(db),meta=table+'_syncmeta';await pipeline(db,[{sql:`CREATE TABLE IF NOT EXISTS ${table} (path TEXT PRIMARY KEY,payload TEXT,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,sync_batch INTEGER NOT NULL DEFAULT 0)`,args:[]},{sql:`CREATE TABLE IF NOT EXISTS ${meta} (id INTEGER PRIMARY KEY CHECK(id=1),batch INTEGER NOT NULL DEFAULT 0)`,args:[]},{sql:`INSERT OR IGNORE INTO ${meta}(id,batch) VALUES(1,0)`,args:[]}]);try{await pipeline(db,[{sql:`ALTER TABLE ${table} ADD COLUMN sync_batch INTEGER NOT NULL DEFAULT 0`,args:[]}])}catch(e){if(!/duplicate column|already exists/i.test(String(e?.message||e)))throw e}}

async function getSession(chatId,env){
  const row=await env.DB.prepare('SELECT * FROM telegram_sessions WHERE chat_id=? AND active=1').bind(chatId).first();if(!row)return null;
  let session;try{session={...row,payload:normalizeActivationPayload(JSON.parse(row.payload_json))}}catch(_){return null}
  const last=Date.parse(row.verified_at||row.logged_in_at||0)||0;
  if(Date.now()-last>5*60*1000){
    try{
      const verified=await verifyActivationPayload(session.payload);
      if(verified?.account)session.payload.account={...(session.payload.account||{}),...verified.account};
      const now=new Date().toISOString();
      await env.DB.prepare('UPDATE telegram_sessions SET payload_json=?,verification_state=?,verification_message=NULL,verified_at=? WHERE chat_id=?').bind(JSON.stringify(session.payload),'verified',now,String(chatId)).run();
      session.verified_at=now;session.verification_state='verified';
    }catch(error){
      if(isLogicalVerificationError(error)){
        await env.DB.prepare('UPDATE telegram_sessions SET active=0,verification_state=?,verification_message=?,updated_at=? WHERE chat_id=?').bind('invalid',String(error?.message||error).slice(0,500),new Date().toISOString(),String(chatId)).run();
        return null;
      }
      // Temporary network/database failure: keep the last valid local session and retry later.
    }
  }
  return session;
}
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

async function unpackActivationFile(text){
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


function normalizeActivationPayload(payload){
  if(!payload || typeof payload !== 'object') throw new Error('ملف التفعيل غير صالح.');
  const companyId=String(payload.companyId||payload.tenantId||'').trim();
  const account=(payload.account&&typeof payload.account==='object')?{...payload.account}:{};
  const rawDb=(payload.database&&typeof payload.database==='object')?payload.database:{};
  const database={
    databaseURL:String(rawDb.databaseURL||rawDb.url||rawDb.databaseUrl||'').trim(),
    authToken:String(rawDb.authToken||rawDb.token||rawDb.writeToken||'').trim(),
    table:String(rawDb.table||'oscar_rtdb').trim()||'oscar_rtdb'
  };
  const out={...payload,companyId,tenantId:companyId,database,account};
  if(!out.companyKey) out.companyKey=out.activationKey||'';
  if(!out.activationKey) out.activationKey=out.companyKey||'';
  if(!out.rootPath) out.rootPath='oscar/companies';
  if(!out.account.name && out.account.displayName) out.account.name=out.account.displayName;
  return out;
}

function isLogicalVerificationError(error){
  const msg=String(error?.message||error||'');
  return /مفتاح الشركة غير مسجل|لا يطابق|تم إيقاف|انتهت مدة|غير متاح|تم إصدار ملف|الحساب غير موجود|تم إيقاف هذا الحساب|لم يعد مندوباً|مدير الفرع غير متاح|ملف المدير لا يطابق/i.test(msg);
}

function validateActivationPayloadLocally(payload){
  if(!payload||payload.app!==APP_TAG) throw new Error('ملف التفعيل غير صالح.');
  const companyId=String(payload.companyId||payload.tenantId||'').trim();
  if(!companyId) throw new Error('ملف الشركة غير مكتمل.');
  if(payload.status && payload.status!=='active') throw new Error('ملف الشركة غير فعال.');
  if(payload.expiresAt && Date.now()>=new Date(payload.expiresAt).getTime()) throw new Error('انتهت مدة تفعيل الشركة.');
  if(!payload.database?.databaseURL||!payload.database?.authToken) throw new Error('ملف التفعيل لا يحتوي على قاعدة شركة صالحة.');
  if(!payload.account?.id) throw new Error('ملف الدخول لا يحتوي على حساب مستخدم صالح.');
  return {access:{status:'active',endAt:payload.expiresAt||'',companyId},online:false,provisional:true};
}

async function verifyActivationPayloadFlexible(payload){
  try{
    return await verifyActivationPayload(payload);
  }catch(error){
    if(isLogicalVerificationError(error)) throw error;
    const local=validateActivationPayloadLocally(payload);
    return {...local,error:String(error?.message||error)};
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

async function sendMessage(chatId,text,replyMarkup=null){
  const value=String(text??'');
  const parts=[];let cur='';
  for(const line of value.split('\n')){
    const next=cur?cur+'\n'+line:line;
    if(next.length>3600&&cur){parts.push(cur);cur=line.length>3600?line.slice(0,3590)+'…':line}else cur=next;
  }
  if(cur||!parts.length)parts.push(cur||' ');
  let last=null;
  for(let i=0;i<parts.length;i++){
    const body={chat_id:chatId,text:parts[i],parse_mode:'HTML',disable_web_page_preview:true};
    if(replyMarkup&&i===parts.length-1)body.reply_markup=replyMarkup;
    last=await telegram('sendMessage',body);
    if(!last?.ok)break;
  }
  return last;
}
async function telegram(method,data={}){const res=await fetch(`${TG_API}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return res.json()}
function json(data,status=200){return new Response(JSON.stringify(data,null,2),{status,headers:{'Content-Type':'application/json; charset=UTF-8',...corsHeaders()}})}
function corsHeaders(){return{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}}
function e(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function norm(v){return String(v??'').trim().toLowerCase()}
function parseUserNumber(v){
  const ar='٠١٢٣٤٥٦٧٨٩',fa='۰۱۲۳۴۵۶۷۸۹';
  let s=String(v??'').trim().replace(/[٠-٩]/g,c=>String(ar.indexOf(c))).replace(/[۰-۹]/g,c=>String(fa.indexOf(c))).replace(/،/g,'.').replace(/,/g,'.').replace(/\s+/g,'');
  const n=Number(s);return Number.isFinite(n)?n:NaN;
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function money(v,symbol=''){return `${num(v).toFixed(2)}${symbol?` ${e(symbol)}`:''}`}
function chunk(arr,n){const out=[];for(let i=0;i<arr.length;i+=n)out.push(arr.slice(i,i+n));return out}
