const DEFAULT_BOT_TOKEN = "8743553964:AAFdDUy2isOSdgvc50ltCDrSVvlK9dOSu2U";
const BOT_VERSION = '5.2.0-oscar-accounting-force-ui';
const CASHIER_PRODUCT_ID = 'saas_cashier_bot';
const MASTER_TURSO_URL = 'libsql://mezan-homworkhhh76-rgb.aws-ap-northeast-1.turso.io';
const DEFAULT_MASTER_TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODgyMzU2OTIsImlkIjoiMDFhMDViMjctMWMwMS03YWNiLTlkZDUtNzc0YjBmZjhjMDEzIiwia2lkIjoicVgzS01DZ0pwQnp3eGo1Tzl2SHhaWUJGem9sTWFsa24tTU5JOTRlMTl6YyIsInJpZCI6IjVkNjRiOWQxLTVmOTAtNGVhNC04N2NkLTY4MGJjYjUzZGViMyJ9.UCbYQXjam0ax427SR6oBjy-vtjGl2XCVoBFIa6CSt-M4zhkTldObEcfTonAB3rVxx2T0KJun8z9C2DzhK0zsDA';
const DEFAULT_ADMIN_USERNAME = 'PUPGG_PAY';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup')) {
        await ensureDb(env);
        const setup = await setupWebhook(url.origin, env);
        return json({ ok: !!setup.webhook?.ok, version: BOT_VERSION, ...setup });
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        await ensureDb(env);
        const cfg = await getConfig(env);
        const counts = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) c FROM store_products').first(),
          env.DB.prepare('SELECT COUNT(*) c FROM store_payment_methods').first(),
          env.DB.prepare("SELECT COUNT(*) c FROM store_orders WHERE status='pending'").first(),
        ]);
        return json({ ok:true, version:BOT_VERSION, store:cfg.store_name, admin_chat_id:cfg.owner_chat_id || null, products:+(counts[0]?.c||0), payment_methods:+(counts[1]?.c||0), pending_orders:+(counts[2]?.c||0) });
      }
      if (request.method === 'POST' && ['/webhook','/','/telegram','/bot'].includes(url.pathname)) {
        let update;
        try { update = await request.json(); } catch { return new Response('OK'); }
        const task = processUpdateSafe(update, env);
        const isStart = String(update?.message?.text || '').trim() === '/start';
        if (isStart) await task; else ctx.waitUntil(task);
        return new Response('OK');
      }
      return new Response('Not Found', { status:404 });
    } catch (err) {
      console.error('WORKER_FATAL', err);
      return json({ ok:false, error:String(err?.message || err), version:BOT_VERSION }, 500);
    }
  }
};

function token(env){ return String(env?.BOT_TOKEN || DEFAULT_BOT_TOKEN).trim(); }
function tgUrl(env){ return `https://api.telegram.org/bot${token(env)}`; }
function now(){ return new Date().toISOString(); }
function id(prefix='id'){ return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0,8)}`; }
function e(v){ return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function money(v){ const n=Number(v); return Number.isFinite(n) ? n.toFixed(2) : '0.00'; }
function cleanUsername(v){ return String(v||'').replace(/^@/,'').trim(); }
function corsHeaders(){ return {'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'}; }
function json(data,status=200){ return new Response(JSON.stringify(data,null,2),{status,headers:{'content-type':'application/json; charset=utf-8',...corsHeaders()}}); }

async function telegram(env, method, body={}){
  const res = await fetch(`${tgUrl(env)}/${method}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  let data={ok:false}; try{ data=await res.json(); }catch{}
  if(!res.ok || !data?.ok) console.warn('TG_API', method, data?.description || res.status);
  return data;
}

async function setupWebhook(origin, env){
  const webhookUrl = `${String(origin).replace(/\/$/,'')}/webhook`;
  const bot = await telegram(env,'getMe',{});
  const webhook = bot?.ok ? await telegram(env,'setWebhook',{url:webhookUrl,allowed_updates:['message','callback_query'],drop_pending_updates:false}) : {ok:false};
  const commands = bot?.ok ? await telegram(env,'setMyCommands',{commands:[
    {command:'start',description:'فتح متجر أوسكار'},
    {command:'shop',description:'تصفح البرامج'},
    {command:'orders',description:'طلباتي'},
    {command:'cashier',description:'فتح أوسكار المحاسبي'},
    {command:'accounting',description:'برنامج أوسكار المحاسبي'},
    {command:'version',description:'إظهار إصدار البوت'},
    {command:'admin',description:'لوحة الإدارة'},
  ]}) : {ok:false};
  return {webhookUrl,bot,webhook,commands};
}

async function ensureDb(env){
  if(!env?.DB) throw new Error('D1 binding DB is missing');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS store_config (
      id INTEGER PRIMARY KEY CHECK(id=1),
      store_name TEXT NOT NULL DEFAULT 'Oscar Software Store',
      welcome_text TEXT NOT NULL DEFAULT 'اختر البرنامج المناسب لك وادفع بالطريقة التي تناسبك، ثم أرسل إثبات الدفع وسيتم مراجعة طلبك.',
      support_username TEXT NOT NULL DEFAULT 'PUPGG_PAY',
      owner_username TEXT NOT NULL DEFAULT 'PUPGG_PAY',
      owner_chat_id TEXT,
      banner_file_id TEXT,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS store_products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '₪',
      photo_file_id TEXT,
      delivery_text TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS store_payment_methods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      photo_file_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS store_orders (
      id TEXT PRIMARY KEY,
      order_code TEXT NOT NULL UNIQUE,
      user_chat_id TEXT NOT NULL,
      username TEXT,
      customer_name TEXT,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      payment_method_id TEXT NOT NULL,
      payment_method_name TEXT NOT NULL,
      proof_type TEXT,
      proof_file_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS store_states (
      chat_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'IDLE',
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_store_orders_user ON store_orders(user_chat_id,created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_store_orders_status ON store_orders(status,created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_store_products_active ON store_products(active,sort_order)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_store_payments_active ON store_payment_methods(active,sort_order)')
  ]);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS saas_accounts (
      id TEXT PRIMARY KEY,
      owner_chat_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL,
      telegram_username TEXT,
      status TEXT NOT NULL DEFAULT 'trial',
      trial_started_at TEXT NOT NULL,
      trial_ends_at TEXT NOT NULL,
      subscription_ends_at TEXT,
      current_plan_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS saas_sessions (
      chat_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      logged_in_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS saas_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      days INTEGER NOT NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT '₪',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS saas_subscription_orders (
      id TEXT PRIMARY KEY,
      order_code TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      user_chat_id TEXT NOT NULL,
      username TEXT,
      customer_name TEXT,
      plan_id TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      plan_days INTEGER NOT NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      payment_method_id TEXT NOT NULL,
      payment_method_name TEXT NOT NULL,
      proof_type TEXT,
      proof_file_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_products (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, sku TEXT,
      sale_price REAL NOT NULL DEFAULT 0, avg_cost REAL NOT NULL DEFAULT 0,
      stock REAL NOT NULL DEFAULT 0, reorder_level REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'حبة', active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_customers (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT,
      balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_suppliers (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT,
      balance REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_sales (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, invoice_no TEXT NOT NULL,
      customer_id TEXT, customer_name TEXT NOT NULL, total REAL NOT NULL,
      paid REAL NOT NULL, remaining REAL NOT NULL, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_sale_items (
      id TEXT PRIMARY KEY, sale_id TEXT NOT NULL, account_id TEXT NOT NULL,
      product_id TEXT NOT NULL, product_name TEXT NOT NULL, qty REAL NOT NULL,
      unit_price REAL NOT NULL, total REAL NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_purchases (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, purchase_no TEXT NOT NULL,
      supplier_id TEXT, supplier_name TEXT NOT NULL, total REAL NOT NULL,
      paid REAL NOT NULL, remaining REAL NOT NULL, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_purchase_items (
      id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL, account_id TEXT NOT NULL,
      product_id TEXT NOT NULL, product_name TEXT NOT NULL, qty REAL NOT NULL,
      unit_cost REAL NOT NULL, total REAL NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_expenses (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, category TEXT NOT NULL,
      note TEXT, amount REAL NOT NULL, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_cash_moves (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
      amount REAL NOT NULL, ref_id TEXT, note TEXT, created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS pos_vouchers (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, voucher_no TEXT NOT NULL,
      voucher_type TEXT NOT NULL, party_type TEXT, party_id TEXT, party_name TEXT,
      amount REAL NOT NULL, note TEXT, created_at TEXT NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_saas_orders_status ON saas_subscription_orders(status,created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pos_products_account ON pos_products(account_id,name)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pos_sales_account ON pos_sales(account_id,created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pos_purchases_account ON pos_purchases(account_id,created_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_pos_vouchers_account ON pos_vouchers(account_id,created_at)')
  ]);
  const cfg = await env.DB.prepare('SELECT id FROM store_config WHERE id=1').first();
  if(!cfg) await env.DB.prepare(`INSERT INTO store_config(id,store_name,welcome_text,support_username,owner_username,owner_chat_id,banner_file_id,updated_at) VALUES(1,?,?,?,?,?,?,?)`)
    .bind('متجر أوسكار البرمجي','اختر البرنامج المناسب لك وادفع بالطريقة التي تناسبك، ثم أرسل إثبات الدفع وسيتم مراجعة طلبك.',DEFAULT_ADMIN_USERNAME,DEFAULT_ADMIN_USERNAME,null,null,now()).run();
  const t=now();
  await env.DB.prepare(`INSERT INTO store_products(id,name,description,price,currency,photo_file_id,delivery_text,active,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,NULL,?,1,-100,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,price=excluded.price,currency=excluded.currency,delivery_text=excluded.delivery_text,active=1,sort_order=-100,updated_at=excluded.updated_at`)
    .bind(CASHIER_PRODUCT_ID,'🧮 أوسكار المحاسبي — كاشير وERP داخل تيليجرام','برنامج محاسبة وتشغيل كامل داخل تيليجرام: كاشير ومبيعات ومشتريات ومخزون وأصناف وعملاء وموردون وحسابات وصندوق وسندات قبض وصرف ومصروفات وتقارير. تجربة مجانية 24 ساعة، وبعدها اشتراك بالمدة والسعر الذي تحدده الإدارة.',0,'حسب الخطة','أنشئ حسابك وابدأ تجربة أوسكار المحاسبي لمدة 24 ساعة.',t,t).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO saas_plans(id,name,days,price,currency,active,sort_order,created_at,updated_at) VALUES('plan_month','اشتراك شهر',30,0,'₪',1,10,?,?)`).bind(t,t).run();
  await env.DB.prepare(`INSERT OR IGNORE INTO saas_plans(id,name,days,price,currency,active,sort_order,created_at,updated_at) VALUES('plan_year','اشتراك سنة',365,0,'₪',1,20,?,?)`).bind(t,t).run();
}

async function getConfig(env){ return await env.DB.prepare('SELECT * FROM store_config WHERE id=1').first(); }
async function setConfigField(env, field, value){
  const allowed = new Set(['store_name','welcome_text','support_username','owner_username','owner_chat_id','banner_file_id']);
  if(!allowed.has(field)) throw new Error('invalid config field');
  await env.DB.prepare(`UPDATE store_config SET ${field}=?, updated_at=? WHERE id=1`).bind(value,now()).run();
}

async function getState(env, chatId){
  const row=await env.DB.prepare('SELECT * FROM store_states WHERE chat_id=?').bind(String(chatId)).first();
  if(!row) return {mode:'IDLE',data:{}};
  let data={}; try{data=JSON.parse(row.data_json||'{}')}catch{}
  return {mode:row.mode||'IDLE',data};
}
async function setState(env, chatId, mode='IDLE', data={}){
  await env.DB.prepare(`INSERT INTO store_states(chat_id,mode,data_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET mode=excluded.mode,data_json=excluded.data_json,updated_at=excluded.updated_at`)
    .bind(String(chatId),mode,JSON.stringify(data||{}),now()).run();
}
async function clearState(env,chatId){ await setState(env,chatId,'IDLE',{}); }

function userKeyboard(){ return {keyboard:[[{text:'🧮 أوسكار المحاسبي'},{text:'🛍 تصفح البرامج'}],[{text:'📦 طلباتي'},{text:'💳 طرق الدفع'}],[{text:'☎️ الدعم'}]],resize_keyboard:true,is_persistent:true}; }
function adminKeyboard(){ return {keyboard:[[{text:'🛡 لوحة الإدارة'},{text:'🛍 واجهة المتجر'}],[{text:'🧮 فتح البرنامج المحاسبي'},{text:'📦 البرامج'}],[{text:'💳 طرق الدفع'},{text:'🧾 الطلبات'}],[{text:'💵 طلبات الاشتراك'},{text:'💎 خطط الاشتراك'}],[{text:'👤 حسابات المحاسبة'},{text:'🏢 الشركات'}],[{text:'⚙️ إعدادات المتجر'}]],resize_keyboard:true,is_persistent:true}; }
function cancelKeyboard(isAdmin=false){ return {keyboard:[[{text:'❌ إلغاء'}],[{text:isAdmin?'🛡 لوحة الإدارة':'🏠 الرئيسية'}]],resize_keyboard:true}; }
function ik(rows){ return {inline_keyboard:rows}; }

async function sendMessage(env,chatId,text,replyMarkup){ return telegram(env,'sendMessage',{chat_id:String(chatId),text,parse_mode:'HTML',disable_web_page_preview:true,reply_markup:replyMarkup||undefined}); }
async function sendPhoto(env,chatId,photo,caption,replyMarkup){ return telegram(env,'sendPhoto',{chat_id:String(chatId),photo,caption,parse_mode:'HTML',reply_markup:replyMarkup||undefined}); }
async function editMessage(env,chatId,messageId,text,replyMarkup){ return telegram(env,'editMessageText',{chat_id:String(chatId),message_id:messageId,text,parse_mode:'HTML',disable_web_page_preview:true,reply_markup:replyMarkup||undefined}); }

async function processUpdateSafe(update, env){
  try{ await ensureDb(env); await processUpdate(update,env); }
  catch(err){ console.error('UPDATE_ERROR',err); const cid=String(update?.message?.chat?.id||update?.callback_query?.message?.chat?.id||''); if(cid) try{await sendMessage(env,cid,'⚠️ حصل خطأ مؤقت. جرّب مرة ثانية.');}catch{} }
}

async function processUpdate(update,env){
  if(update?.callback_query){
    const q=update.callback_query; await telegram(env,'answerCallbackQuery',{callback_query_id:q.id}).catch?.(()=>{});
    const chatId=String(q.message?.chat?.id||q.from?.id||'');
    if(!chatId) return;
    await maybeClaimAdmin(env,q.from,chatId);
    return handleCallback(env,chatId,String(q.data||''),q);
  }
  const msg=update?.message; if(!msg) return;
  const chatId=String(msg.chat?.id||''); if(!chatId) return;
  await maybeClaimAdmin(env,msg.from,chatId);
  const admin=await isAdmin(env,chatId,msg.from);
  const text=String(msg.text||'').trim();

  if(text==='/version') return sendMessage(env,chatId,`✅ الإصدار العامل الآن: <code>${BOT_VERSION}</code>`,admin?adminKeyboard():userKeyboard());
  if(text==='/start'||text==='🏠 الرئيسية') return showHome(env,chatId,msg.from,admin);
  if(text==='🛍 واجهة المتجر') return showStorefront(env,chatId,msg.from);
  if(text==='/shop'||text==='🛍 تصفح البرامج') return showProducts(env,chatId,0,admin);
  if(text==='/orders'||text==='📦 طلباتي') return showMyOrders(env,chatId,admin);
  if(text==='/cashier'||text==='/accounting'||text==='💼 حساب الكاشير'||text==='🧮 أوسكار المحاسبي'||text==='🧮 فتح البرنامج المحاسبي') return openCashierAccount(env,chatId,msg.from);
  if(text==='💎 الاشتراك') return showSubscriptionPlans(env,chatId);
  if(text==='🚪 خروج الكاشير') return logoutCashier(env,chatId,msg.from);
  if(text==='🧾 بيع') return posStartSale(env,chatId);
  if(text==='📦 الأصناف') return posProducts(env,chatId);
  if(text==='👥 العملاء') return posCustomers(env,chatId);
  if(text==='🚚 الموردون') return posSuppliers(env,chatId);
  if(text==='🛒 مشتريات') return posStartPurchase(env,chatId);
  if(text==='💸 مصروف'||text==='💸 المصروفات') return posStartExpense(env,chatId);
  if(text==='💰 الصندوق'||text==='💼 الحسابات') return posAccounts(env,chatId);
  if(text==='📚 المخزون') return posInventorySummary(env,chatId);
  if(text==='🧾 سند قبض') return posStartVoucher(env,chatId,'receipt');
  if(text==='💸 سند صرف') return posStartVoucher(env,chatId,'payment');
  if(text==='📊 تقرير اليوم'||text==='📊 التقارير') return posReportsMenu(env,chatId);

  if(text==='💳 طرق الدفع' && !admin) return showPaymentMethods(env,chatId,false);
  if(text==='☎️ الدعم') return showSupport(env,chatId,admin);
  if((text==='/admin'||text==='🛡 لوحة الإدارة') && admin) return showAdminHome(env,chatId);
  if(text==='📦 البرامج' && admin) return adminProducts(env,chatId);
  if(text==='💳 طرق الدفع' && admin) return adminPayments(env,chatId);
  if(text==='🧾 الطلبات' && admin) return adminOrders(env,chatId);
  if(text==='⚙️ إعدادات المتجر' && admin) return adminSettings(env,chatId);
  if(text==='💎 خطط الاشتراك' && admin) return adminPlans(env,chatId);
  if((text==='👤 حسابات الكاشير'||text==='👤 حسابات المحاسبة') && admin) return adminSaasAccounts(env,chatId);
  if(text==='🏢 الشركات' && admin) return adminSaasAccounts(env,chatId,true);
  if(text==='💵 طلبات الاشتراك' && admin) return adminSubscriptionOrders(env,chatId);

  if(text==='❌ إلغاء'){ await clearState(env,chatId); return admin?showAdminHome(env,chatId):showHome(env,chatId,msg.from,false); }

  const state=await getState(env,chatId);
  if(state.mode!=='IDLE') return handleState(env,chatId,msg,state,admin);

  return admin ? showAdminHome(env,chatId) : showHome(env,chatId,msg.from,false);
}

async function maybeClaimAdmin(env,from,chatId){
  const cfg=await getConfig(env); if(cfg.owner_chat_id) return;
  const expected=cleanUsername(cfg.owner_username||DEFAULT_ADMIN_USERNAME).toLowerCase();
  const actual=cleanUsername(from?.username).toLowerCase();
  if(expected && actual===expected) await setConfigField(env,'owner_chat_id',String(chatId));
}
async function isAdmin(env,chatId,from){
  const cfg=await getConfig(env);
  if(cfg.owner_chat_id && String(cfg.owner_chat_id)===String(chatId)) return true;
  const expected=cleanUsername(cfg.owner_username||DEFAULT_ADMIN_USERNAME).toLowerCase();
  return !cfg.owner_chat_id && expected && cleanUsername(from?.username).toLowerCase()===expected;
}

async function showHome(env,chatId,from,admin=false){
  await clearState(env,chatId);
  if(admin) return showAdminHome(env,chatId);
  return showStorefront(env,chatId,from);
}

async function showStorefront(env,chatId,from){
  await clearState(env,chatId);
  const cfg=await getConfig(env); const name=e(from?.first_name||'صديقي');
  const text=`👋 <b>أهلاً ${name}</b>

<b>${e(cfg.store_name)}</b>
${e(cfg.welcome_text)}

🧮 <b>أوسكار المحاسبي</b>
كاشير + مبيعات + مشتريات + مخزون + عملاء + موردين + حسابات + صندوق + سندات + مصروفات + تقارير.

🎁 تجربة مجانية 24 ساعة ثم اشتراك بالمدة والسعر الذي تحدده الإدارة.

<code>${BOT_VERSION}</code>`;
  // Always push a fresh reply keyboard so an old Telegram keyboard cannot remain cached on screen.
  if(cfg.banner_file_id){
    await sendPhoto(env,chatId,cfg.banner_file_id,text,ik([[{text:'🧮 فتح أوسكار المحاسبي',callback_data:'saas:landing'}],[{text:'🛍 تصفح البرامج',callback_data:'shop:0'}],[{text:'☎️ الدعم',url:`https://t.me/${cleanUsername(cfg.support_username||DEFAULT_ADMIN_USERNAME)}`}]]));
    return sendMessage(env,chatId,'🧮 <b>أوسكار المحاسبي جاهز</b> — اضغط الزر أسفل الشاشة لبدء تجربة 24 ساعة أو تسجيل الدخول.',userKeyboard());
  }
  return sendMessage(env,chatId,text,userKeyboard());
}
async function showProducts(env,chatId,index=0,admin=false){
  const rows=await env.DB.prepare('SELECT * FROM store_products WHERE active=1 ORDER BY sort_order ASC, created_at ASC').all();
  const products=rows.results||[];
  if(!products.length) return sendMessage(env,chatId,'🛍 <b>البرامج</b>\n\nلا توجد برامج مضافة حالياً.',admin?adminKeyboard():userKeyboard());
  const i=Math.max(0,Math.min(Number(index)||0,products.length-1)); const p=products[i];
  const priceLine=String(p.id)===CASHIER_PRODUCT_ID?'🎁 <b>تجربة مجانية 24 ساعة</b> • 💎 الاشتراك حسب الخطة':`💰 <b>${money(p.price)} ${e(p.currency)}</b>`;
  const cap=`✨ <b>${e(p.name)}</b>\n\n${e(p.description||'')}\n\n${priceLine}\n📦 البرنامج ${i+1} من ${products.length}`;
  const nav=[]; if(i>0) nav.push({text:'◀️ السابق',callback_data:`shop:${i-1}`}); if(i<products.length-1) nav.push({text:'التالي ▶️',callback_data:`shop:${i+1}`});
  const buttons=[[{text:'🛒 شراء الآن',callback_data:`buy:${p.id}`}]]; if(nav.length) buttons.push(nav); buttons.push([{text:'🏠 الرئيسية',callback_data:'home'}]);
  if(p.photo_file_id) return sendPhoto(env,chatId,p.photo_file_id,cap,ik(buttons));
  return sendMessage(env,chatId,cap,ik(buttons));
}

async function showPaymentMethods(env,chatId,admin=false){
  const rows=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE active=1 ORDER BY sort_order ASC, created_at ASC').all();
  const methods=rows.results||[];
  if(!methods.length) return sendMessage(env,chatId,'💳 لا توجد طرق دفع متاحة حالياً.',admin?adminKeyboard():userKeyboard());
  await sendMessage(env,chatId,'💳 <b>طرق الدفع المتاحة</b>

تم تحسين العرض بحيث تظهر صورة كل طريقة دفع داخل الرسالة نفسها، وتحتها أزرار شفافة أنيقة بدل الاكتفاء بملصق أو رمز صغير داخل الزر.',admin?adminKeyboard():userKeyboard());
  for(let i=0;i<methods.length;i++){
    const m=methods[i];
    const txt=`💳 <b>${e(m.name)}</b>
${m.details?`
${e(m.details)}`:''}

📍 الطريقة ${i+1} من ${methods.length}`;
    const buttons=admin
      ? ik([[{text:'عرض / تعديل',callback_data:`payment:view:${m.id}`}],[{text:'رجوع',callback_data:'home'}]])
      : ik([[{text:'عرض البيانات',callback_data:`payview:${m.id}`}],[{text:'الرئيسية',callback_data:'home'}]]);
    if(m.photo_file_id) await sendPhoto(env,chatId,m.photo_file_id,txt,buttons);
    else await sendMessage(env,chatId,txt,buttons);
  }
}

async function showSupport(env,chatId,admin=false){
  const cfg=await getConfig(env); const u=cleanUsername(cfg.support_username||DEFAULT_ADMIN_USERNAME);
  return sendMessage(env,chatId,`☎️ <b>الدعم والمبيعات</b>\n\nللتواصل المباشر مع صاحب المتجر:\n@${e(u)}`,ik([[{text:'💬 فتح المحادثة',url:`https://t.me/${u}`}],[{text:'🏠 الرئيسية',callback_data:'home'}]]));
}

async function beginBuy(env,chatId,productId){
  if(String(productId)===CASHIER_PRODUCT_ID) return cashierProductLanding(env,chatId);
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=? AND active=1').bind(productId).first();
  if(!p) return sendMessage(env,chatId,'⚠️ هذا البرنامج غير متاح حالياً.',userKeyboard());
  const rows=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE active=1 ORDER BY sort_order ASC,created_at ASC').all();
  const methods=rows.results||[];
  if(!methods.length) return sendMessage(env,chatId,'⚠️ لا توجد طريقة دفع مفعلة حالياً. تواصل مع الدعم.',userKeyboard());
  await sendMessage(env,chatId,`🛒 <b>شراء ${e(p.name)}</b>
💰 السعر: <b>${money(p.price)} ${e(p.currency)}</b>

اختر طريقة الدفع من البطاقات التالية. الآن ستظهر صورة كل طريقة دفع نفسها داخل الرسالة، وتحتها زر شفاف لاختيارها.`,userKeyboard());
  for(let i=0;i<methods.length;i++){
    const m=methods[i];
    const txt=`💳 <b>${e(m.name)}</b>
${m.details?`
${e(m.details)}`:''}

🛍 للبرنامج: <b>${e(p.name)}</b>
💰 المطلوب: <b>${money(p.price)} ${e(p.currency)}</b>
📍 الطريقة ${i+1} من ${methods.length}`;
    const buttons=ik([[{text:'اختيار هذه الطريقة',callback_data:`choosepay:${productId}:${m.id}`}],[{text:'رجوع للبرامج',callback_data:'shop:0'}]]);
    if(m.photo_file_id) await sendPhoto(env,chatId,m.photo_file_id,txt,buttons);
    else await sendMessage(env,chatId,txt,buttons);
  }
}

async function showCheckout(env,chatId,productId,methodId){
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=? AND active=1').bind(productId).first();
  const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=? AND active=1').bind(methodId).first();
  if(!p||!m) return sendMessage(env,chatId,'⚠️ البرنامج أو طريقة الدفع غير متاحة الآن.',userKeyboard());
  await setState(env,chatId,'AWAIT_PROOF',{product_id:p.id,payment_method_id:m.id});
  const text=`💳 <b>${e(m.name)}</b>\n\n${e(m.details)}\n\n🛍 البرنامج: <b>${e(p.name)}</b>\n💰 المطلوب: <b>${money(p.price)} ${e(p.currency)}</b>\n\nبعد الدفع اضغط الزر ثم أرسل <b>صورة إثبات الدفع</b>.`;
  const buttons=ik([[{text:'إرسال إثبات الدفع',callback_data:`proof:${p.id}:${m.id}`}],[{text:'إلغاء',callback_data:'home'}]]);
  if(m.photo_file_id) return sendPhoto(env,chatId,m.photo_file_id,text,buttons);
  return sendMessage(env,chatId,text,buttons);
}

async function showMyOrders(env,chatId,admin=false){
  const rows=await env.DB.prepare('SELECT * FROM store_orders WHERE user_chat_id=? ORDER BY created_at DESC LIMIT 10').bind(String(chatId)).all();
  const list=rows.results||[]; if(!list.length) return sendMessage(env,chatId,'📦 <b>طلباتي</b>\n\nلا توجد طلبات حتى الآن.',admin?adminKeyboard():userKeyboard());
  const lines=list.map(o=>`${statusEmoji(o.status)} <b>${e(o.order_code)}</b> — ${e(o.product_name)}\n💰 ${money(o.price)} ${e(o.currency)} • ${statusText(o.status)}`);
  return sendMessage(env,chatId,`📦 <b>آخر طلباتك</b>\n\n${lines.join('\n\n')}`,admin?adminKeyboard():userKeyboard());
}
function statusEmoji(s){ return s==='approved'?'✅':s==='rejected'?'❌':'⏳'; }
function statusText(s){ return s==='approved'?'تم تأكيد الدفع':s==='rejected'?'مرفوض':'قيد المراجعة'; }

async function handleProof(env,chatId,msg,state){
  let type='',fileId='';
  if(msg.photo?.length){ type='photo'; fileId=msg.photo[msg.photo.length-1].file_id; }
  else if(msg.document){ type='document'; fileId=msg.document.file_id; }
  if(!fileId) return sendMessage(env,chatId,'📸 أرسل صورة أو ملف إثبات الدفع الآن.',cancelKeyboard(false));
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=?').bind(state.data.product_id).first();
  const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=?').bind(state.data.payment_method_id).first();
  if(!p||!m){ await clearState(env,chatId); return sendMessage(env,chatId,'⚠️ تعذر إكمال الطلب. ابدأ الشراء من جديد.',userKeyboard()); }
  const orderId=id('ord'); const orderCode=`P2P-${String(Date.now()).slice(-6)}`; const username=cleanUsername(msg.from?.username); const customer=[msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' ').trim();
  await env.DB.prepare(`INSERT INTO store_orders(id,order_code,user_chat_id,username,customer_name,product_id,product_name,price,currency,payment_method_id,payment_method_name,proof_type,proof_file_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`)
    .bind(orderId,orderCode,String(chatId),username,customer,p.id,p.name,Number(p.price||0),p.currency,m.id,m.name,type,fileId,now(),now()).run();
  await clearState(env,chatId);
  await sendMessage(env,chatId,`✅ <b>تم استلام إثبات الدفع</b>\n\nرقم الطلب: <code>${orderCode}</code>\nالبرنامج: <b>${e(p.name)}</b>\nالمبلغ: <b>${money(p.price)} ${e(p.currency)}</b>\n\n⏳ سيتم مراجعة التحويل وإشعارك هنا.`,userKeyboard());
  await notifyAdminOrder(env,{id:orderId,order_code:orderCode,user_chat_id:String(chatId),username,customer_name:customer,product_name:p.name,price:p.price,currency:p.currency,payment_method_name:m.name,proof_type:type,proof_file_id:fileId});
}

async function notifyAdminOrder(env,o){
  const cfg=await getConfig(env); const admin=String(cfg.owner_chat_id||''); if(!admin) return false;
  const cap=`🆕 <b>طلب دفع P2P جديد</b>\n\n🧾 <b>${e(o.order_code)}</b>\n👤 ${e(o.customer_name||'-')}${o.username?` (@${e(o.username)})`:''}\n🛍 ${e(o.product_name)}\n💰 <b>${money(o.price)} ${e(o.currency)}</b>\n💳 ${e(o.payment_method_name)}\n\nراجع الإثبات ثم اختر الإجراء:`;
  const buttons=ik([[{text:'✅ تأكيد الدفع',callback_data:`order:approve:${o.id}`}],[{text:'❌ رفض',callback_data:`order:reject:${o.id}`}]]);
  if(o.proof_type==='photo') return sendPhoto(env,admin,o.proof_file_id,cap,buttons);
  await telegram(env,'sendDocument',{chat_id:admin,document:o.proof_file_id,caption:cap,parse_mode:'HTML',reply_markup:buttons}); return true;
}

async function handleCallback(env,chatId,data,q){
  const admin=await isAdmin(env,chatId,q.from);
  if(data==='home') return showHome(env,chatId,q.from,admin);
  if(data.startsWith('shop:')) return showProducts(env,chatId,Number(data.split(':')[1]||0),admin);
  if(data.startsWith('buy:')) return beginBuy(env,chatId,data.slice(4));
  if(data.startsWith('payview:')) return paymentMethodView(env,chatId,data.slice(8),admin);
  if(data.startsWith('choosepay:')){ const [,pid,mid]=data.split(':'); return showCheckout(env,chatId,pid,mid); }
  if(data.startsWith('proof:')){ const [,pid,mid]=data.split(':'); await setState(env,chatId,'AWAIT_PROOF',{product_id:pid,payment_method_id:mid}); return sendMessage(env,chatId,'📸 <b>أرسل الآن صورة إثبات الدفع</b>\n\nيفضل أن يظهر المبلغ ورقم/اسم الحساب بوضوح.',cancelKeyboard(false)); }
  if(data==='saas:landing') return cashierProductLanding(env,chatId);
  if(data==='saas:trial') return beginTrialRegistration(env,chatId);
  if(data==='saas:login') return beginCashierLogin(env,chatId);
  if(data==='saas:dashboard') return showCashierDashboard(env,chatId);
  if(data==='saas:plans') return showSubscriptionPlans(env,chatId);
  if(data.startsWith('saas:plan:')) return beginSaasPlanPurchase(env,chatId,data.slice(10));
  if(data.startsWith('saas:pay:')){ const parts=data.split(':'); return showSaasCheckout(env,chatId,parts[2],parts[3]); }
  if(data.startsWith('saas:proof:')){ const parts=data.split(':'); await setState(env,chatId,'SAAS_AWAIT_PROOF',{plan_id:parts[2],payment_method_id:parts[3]}); return sendMessage(env,chatId,'📸 <b>أرسل الآن صورة إثبات دفع الاشتراك</b>\n\nسيصل الطلب للإدارة للمراجعة.',cancelKeyboard(false)); }
  if(data==='pos:report:today') return posDailyReport(env,chatId);
  if(data==='pos:report:sales') return posRecentSales(env,chatId);
  if(data==='pos:report:purchases') return posRecentPurchases(env,chatId);
  if(data==='pos:report:balances') return posBalances(env,chatId);
  if(data.startsWith('pos:customer:')) return posSaleChooseCustomer(env,chatId,data.slice(13));
  if(data.startsWith('pos:add:')) return posSaleAdd(env,chatId,data.slice(8),1);
  if(data.startsWith('pos:sub:')) return posSaleAdd(env,chatId,data.slice(8),-1);
  if(data==='pos:checkout') return posSaleCheckout(env,chatId);
  if(data==='pos:pay:cash') return posFinalizeSale(env,chatId,'cash');
  if(data==='pos:pay:credit') return posFinalizeSale(env,chatId,'credit');
  if(data==='pos:pay:partial') return posAskPartial(env,chatId);
  if(data==='pos:product:add') return posBeginAddProduct(env,chatId);
  if(data==='pos:customer:add') return posBeginAddCustomer(env,chatId);
  if(data==='pos:supplier:add') return posBeginAddSupplier(env,chatId);
  if(data.startsWith('pos:pursupplier:')) return posPurchaseChooseSupplier(env,chatId,data.slice(16));
  if(data.startsWith('pos:purproduct:')) return posPurchaseChooseProduct(env,chatId,data.slice(15));

  if(admin){
    if(data==='admin:plans') return adminPlans(env,chatId);
    if(data==='admin:plan:add'){ await setState(env,chatId,'ADMIN_PLAN_NAME',{}); return sendMessage(env,chatId,'💎 أرسل اسم الخطة، مثال: اشتراك 3 أشهر',cancelKeyboard(true)); }
    if(data.startsWith('admin:plan:toggle:')) return adminPlanToggle(env,chatId,data.slice(18));
    if(data.startsWith('admin:plan:delete:')) return adminPlanDelete(env,chatId,data.slice(18));
    if(data==='admin:saas_accounts') return adminSaasAccounts(env,chatId);
    if(data==='admin:saas_add'){ await setState(env,chatId,'ADMIN_SAAS_COMPANY',{}); return sendMessage(env,chatId,'🏢 أرسل اسم الشركة الجديدة:',cancelKeyboard(true)); }
    if(data.startsWith('admin:saas:view:')) return adminSaasAccountView(env,chatId,data.slice(16));
    if(data.startsWith('admin:saas:adddays:')){ await setState(env,chatId,'ADMIN_SAAS_ADD_DAYS',{account_id:data.slice(19)}); return sendMessage(env,chatId,'📅 أرسل عدد الأيام التي تريد إضافتها للحساب:',cancelKeyboard(true)); }
    if(data==='admin:saas_orders') return adminSubscriptionOrders(env,chatId);
    if(data.startsWith('saasorder:approve:')) return approveSaasOrder(env,chatId,data.slice(18));
    if(data.startsWith('saasorder:reject:')){ await setState(env,chatId,'ADMIN_SAAS_REJECT',{order_id:data.slice(17)}); return sendMessage(env,chatId,'❌ أرسل سبب الرفض أو - بدون سبب:',cancelKeyboard(true)); }
    if(data.startsWith('saasorder:view:')) return adminSaasOrderView(env,chatId,data.slice(15));
    if(data==='admin:products') return adminProducts(env,chatId);
    if(data==='admin:payments') return adminPayments(env,chatId);
    if(data==='admin:orders') return adminOrders(env,chatId);
    if(data==='admin:settings') return adminSettings(env,chatId);
    if(data==='product:add'){ await setState(env,chatId,'ADMIN_PRODUCT_NAME',{}); return sendMessage(env,chatId,'➕ <b>إضافة برنامج</b>\n\nأرسل اسم البرنامج:',cancelKeyboard(true)); }
    if(data.startsWith('product:view:')) return adminProductView(env,chatId,data.slice(13));
    if(data.startsWith('product:toggle:')) return adminProductToggle(env,chatId,data.slice(15));
    if(data.startsWith('product:delete:')) return adminProductDelete(env,chatId,data.slice(15));
    if(data.startsWith('product:edit:')) return adminProductEditMenu(env,chatId,data.slice(13));
    if(data.startsWith('product:field:')){ const [, , field, pid]=data.split(':'); return startProductFieldEdit(env,chatId,pid,field); }
    if(data==='payment:add'){ await setState(env,chatId,'ADMIN_PAYMENT_NAME',{}); return sendMessage(env,chatId,'➕ <b>إضافة طريقة دفع</b>\n\nأرسل اسم الطريقة، مثال: محفظة / تحويل بنكي / جوال باي:',cancelKeyboard(true)); }
    if(data.startsWith('payment:view:')) return adminPaymentView(env,chatId,data.slice(13));
    if(data.startsWith('payment:toggle:')) return adminPaymentToggle(env,chatId,data.slice(15));
    if(data.startsWith('payment:delete:')) return adminPaymentDelete(env,chatId,data.slice(15));
    if(data.startsWith('payment:edit:')) return adminPaymentEditMenu(env,chatId,data.slice(13));
    if(data.startsWith('payment:field:')){ const [, , field, mid]=data.split(':'); return startPaymentFieldEdit(env,chatId,mid,field); }
    if(data.startsWith('order:approve:')) return approveOrder(env,chatId,data.slice(14));
    if(data.startsWith('order:reject:')){ const oid=data.slice(13); await setState(env,chatId,'ADMIN_REJECT_REASON',{order_id:oid}); return sendMessage(env,chatId,'❌ أرسل سبب رفض الدفع ليصل للمستخدم، أو اكتب <code>-</code> للرفض بدون سبب.',cancelKeyboard(true)); }
    if(data.startsWith('setting:')) return startSettingEdit(env,chatId,data.slice(8));
  }
}

async function paymentMethodView(env,chatId,id,admin=false){
  const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=?').bind(id).first(); if(!m) return;
  const txt=`💳 <b>${e(m.name)}</b>\n\n${e(m.details)}`; const buttons=admin?ik([[{text:'تعديل',callback_data:`payment:edit:${m.id}`}],[{text:'رجوع',callback_data:'admin:payments'}]]):ik([[{text:'الرئيسية',callback_data:'home'}]]);
  if(m.photo_file_id) return sendPhoto(env,chatId,m.photo_file_id,txt,buttons); return sendMessage(env,chatId,txt,buttons);
}

async function showAdminHome(env,chatId){
  await clearState(env,chatId); const cfg=await getConfig(env);
  const pending=await env.DB.prepare("SELECT COUNT(*) c FROM store_orders WHERE status='pending'").first();
  const sp=await env.DB.prepare("SELECT COUNT(*) c FROM saas_subscription_orders WHERE status='pending'").first();
  const ac=await env.DB.prepare('SELECT COUNT(*) c FROM saas_accounts').first();
  return sendMessage(env,chatId,`🛡 <b>لوحة إدارة ${e(cfg.store_name)}</b>\n\n🧾 طلبات برامج: <b>${Number(pending?.c||0)}</b>\n💵 طلبات اشتراك: <b>${Number(sp?.c||0)}</b>\n🏢 شركات المحاسبة: <b>${Number(ac?.c||0)}</b>\n\nاختر القسم من الأزرار أسفل الشاشة.`,adminKeyboard());
}
async function adminProducts(env,chatId){
  const rows=await env.DB.prepare('SELECT * FROM store_products ORDER BY sort_order ASC,created_at DESC').all();
  const buttons=[[{text:'➕ إضافة برنامج جديد',callback_data:'product:add'}]];
  for(const p of rows.results||[]) buttons.push([{text:`${p.active?'🟢':'⚪'} ${p.name} — ${money(p.price)} ${p.currency}`,callback_data:`product:view:${p.id}`}]);
  buttons.push([{text:'🛡 لوحة الإدارة',callback_data:'home'}]);
  return sendMessage(env,chatId,'📦 <b>إدارة البرامج</b>\n\nأضف برامجك وعدّل السعر والصورة والوصف وحالة الظهور.',ik(buttons));
}
async function adminProductView(env,chatId,pid){
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=?').bind(pid).first(); if(!p) return adminProducts(env,chatId);
  const txt=`📦 <b>${e(p.name)}</b>\n\n${e(p.description)}\n\n💰 ${money(p.price)} ${e(p.currency)}\n👁 ${p.active?'ظاهر للمستخدمين':'مخفي'}\n📨 رسالة ما بعد التأكيد: ${e(p.delivery_text||'غير محددة')}`;
  const buttons=ik([[{text:'✏️ تعديل',callback_data:`product:edit:${pid}`}],[{text:p.active?'🙈 إخفاء':'👁 إظهار',callback_data:`product:toggle:${pid}`}],[{text:'🗑 حذف',callback_data:`product:delete:${pid}`}],[{text:'↩️ رجوع',callback_data:'admin:products'}]]);
  if(p.photo_file_id) return sendPhoto(env,chatId,p.photo_file_id,txt,buttons); return sendMessage(env,chatId,txt,buttons);
}
async function adminProductEditMenu(env,chatId,pid){ return sendMessage(env,chatId,'✏️ <b>اختر ما تريد تعديله:</b>',ik([[{text:'الاسم',callback_data:`product:field:name:${pid}`},{text:'السعر',callback_data:`product:field:price:${pid}`}],[{text:'الوصف',callback_data:`product:field:description:${pid}`}],[{text:'الصورة',callback_data:`product:field:photo:${pid}`}],[{text:'رسالة بعد الدفع',callback_data:`product:field:delivery:${pid}`}],[{text:'↩️ رجوع',callback_data:`product:view:${pid}`}]])); }
async function startProductFieldEdit(env,chatId,pid,field){ await setState(env,chatId,'ADMIN_PRODUCT_EDIT',{product_id:pid,field}); const prompt=field==='photo'?'📷 أرسل صورة البرنامج الجديدة.':field==='price'?'💰 أرسل السعر الجديد. مثال: <code>195</code>':field==='name'?'📝 أرسل الاسم الجديد.':field==='delivery'?'📨 أرسل الرسالة التي تصل للمستخدم بعد تأكيد الدفع.':'📝 أرسل الوصف الجديد.'; return sendMessage(env,chatId,prompt,cancelKeyboard(true)); }
async function adminProductToggle(env,chatId,pid){ await env.DB.prepare('UPDATE store_products SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?').bind(now(),pid).run(); return adminProductView(env,chatId,pid); }
async function adminProductDelete(env,chatId,pid){ await env.DB.prepare('DELETE FROM store_products WHERE id=?').bind(pid).run(); return adminProducts(env,chatId); }

async function adminPayments(env,chatId){
  const rows=await env.DB.prepare('SELECT * FROM store_payment_methods ORDER BY sort_order ASC,created_at DESC').all(); const buttons=[[{text:'➕ إضافة طريقة دفع',callback_data:'payment:add'}]];
  for(const m of rows.results||[]) buttons.push([{text:`${m.active?'🟢':'⚪'} ${m.name}`,callback_data:`payment:view:${m.id}`}]); buttons.push([{text:'🛡 لوحة الإدارة',callback_data:'home'}]);
  return sendMessage(env,chatId,'💳 <b>إدارة طرق الدفع</b>\n\nيمكنك تغيير الاسم، بيانات التحويل، الصورة، وإظهار أو إخفاء الطريقة.',ik(buttons));
}
async function adminPaymentView(env,chatId,mid){
  const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=?').bind(mid).first(); if(!m) return adminPayments(env,chatId);
  const txt=`💳 <b>${e(m.name)}</b>\n\n${e(m.details)}\n\n👁 ${m.active?'ظاهرة للمستخدمين':'مخفية'}`;
  const buttons=ik([[{text:'✏️ تعديل',callback_data:`payment:edit:${mid}`}],[{text:m.active?'🙈 إخفاء':'👁 إظهار',callback_data:`payment:toggle:${mid}`}],[{text:'🗑 حذف',callback_data:`payment:delete:${mid}`}],[{text:'↩️ رجوع',callback_data:'admin:payments'}]]);
  if(m.photo_file_id) return sendPhoto(env,chatId,m.photo_file_id,txt,buttons); return sendMessage(env,chatId,txt,buttons);
}
async function adminPaymentEditMenu(env,chatId,mid){ return sendMessage(env,chatId,'✏️ <b>اختر ما تريد تعديله:</b>',ik([[{text:'الاسم',callback_data:`payment:field:name:${mid}`}],[{text:'بيانات الدفع',callback_data:`payment:field:details:${mid}`}],[{text:'الصورة',callback_data:`payment:field:photo:${mid}`}],[{text:'↩️ رجوع',callback_data:`payment:view:${mid}`}]])); }
async function startPaymentFieldEdit(env,chatId,mid,field){ await setState(env,chatId,'ADMIN_PAYMENT_EDIT',{payment_id:mid,field}); return sendMessage(env,chatId,field==='photo'?'📷 أرسل صورة طريقة الدفع الجديدة.':field==='name'?'📝 أرسل الاسم الجديد.':'📝 أرسل بيانات الدفع الجديدة بالكامل.\nمثال: الاسم / الرقم / المحفظة / التعليمات.',cancelKeyboard(true)); }
async function adminPaymentToggle(env,chatId,mid){ await env.DB.prepare('UPDATE store_payment_methods SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?').bind(now(),mid).run(); return adminPaymentView(env,chatId,mid); }
async function adminPaymentDelete(env,chatId,mid){ await env.DB.prepare('DELETE FROM store_payment_methods WHERE id=?').bind(mid).run(); return adminPayments(env,chatId); }

async function adminOrders(env,chatId){
  const rows=await env.DB.prepare('SELECT * FROM store_orders ORDER BY created_at DESC LIMIT 20').all(); const list=rows.results||[];
  if(!list.length) return sendMessage(env,chatId,'🧾 لا توجد طلبات حتى الآن.',adminKeyboard());
  const buttons=list.map(o=>[{text:`${statusEmoji(o.status)} ${o.order_code} • ${o.product_name}`,callback_data:`adminorder:${o.id}`}]);
  // callback adminorder handled inline below using generic state-free function
  buttons.push([{text:'🛡 لوحة الإدارة',callback_data:'home'}]);
  return sendMessage(env,chatId,'🧾 <b>آخر الطلبات</b>\n\nاضغط على الطلب لمراجعته:',ik(buttons));
}
async function adminOrderView(env,chatId,oid){
  const o=await env.DB.prepare('SELECT * FROM store_orders WHERE id=?').bind(oid).first(); if(!o) return adminOrders(env,chatId);
  const txt=`🧾 <b>${e(o.order_code)}</b>\n👤 ${e(o.customer_name||'-')}${o.username?` (@${e(o.username)})`:''}\n🛍 ${e(o.product_name)}\n💰 ${money(o.price)} ${e(o.currency)}\n💳 ${e(o.payment_method_name)}\n📌 الحالة: <b>${statusText(o.status)}</b>${o.admin_note?`\n📝 ${e(o.admin_note)}`:''}`;
  const buttons=[]; if(o.status==='pending') buttons.push([{text:'✅ تأكيد الدفع',callback_data:`order:approve:${o.id}`}],[{text:'❌ رفض',callback_data:`order:reject:${o.id}`}]); buttons.push([{text:'↩️ رجوع',callback_data:'admin:orders'}]);
  if(o.proof_file_id && o.proof_type==='photo') return sendPhoto(env,chatId,o.proof_file_id,txt,ik(buttons));
  return sendMessage(env,chatId,txt,ik(buttons));
}
async function approveOrder(env,chatId,oid){
  const o=await env.DB.prepare('SELECT * FROM store_orders WHERE id=?').bind(oid).first(); if(!o) return;
  if(o.status!=='pending') return adminOrderView(env,chatId,oid);
  await env.DB.prepare("UPDATE store_orders SET status='approved',admin_note='',updated_at=? WHERE id=?").bind(now(),oid).run();
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=?').bind(o.product_id).first();
  let text=`✅ <b>تم تأكيد دفعتك</b>\n\nالطلب: <code>${e(o.order_code)}</code>\nالبرنامج: <b>${e(o.product_name)}</b>\nالمبلغ: <b>${money(o.price)} ${e(o.currency)}</b>`;
  if(p?.delivery_text) text+=`\n\n🎁 <b>تفاصيل الاستلام:</b>\n${e(p.delivery_text)}`;
  await sendMessage(env,o.user_chat_id,text,userKeyboard());
  await sendMessage(env,chatId,`✅ تم تأكيد ${e(o.order_code)} وإشعار العميل.`,adminKeyboard());
}
async function rejectOrder(env,chatId,oid,reason){
  const o=await env.DB.prepare('SELECT * FROM store_orders WHERE id=?').bind(oid).first(); if(!o) return;
  await env.DB.prepare("UPDATE store_orders SET status='rejected',admin_note=?,updated_at=? WHERE id=?").bind(reason==='-'?'':reason,now(),oid).run();
  await sendMessage(env,o.user_chat_id,`❌ <b>لم يتم اعتماد الدفع</b>\n\nالطلب: <code>${e(o.order_code)}</code>${reason&&reason!=='-'?`\nالسبب: ${e(reason)}`:''}\n\nيمكنك التواصل مع الدعم إذا احتجت مساعدة.`,userKeyboard());
  return sendMessage(env,chatId,`❌ تم رفض ${e(o.order_code)} وإشعار العميل.`,adminKeyboard());
}

async function adminSettings(env,chatId){
  const cfg=await getConfig(env);
  return sendMessage(env,chatId,`⚙️ <b>إعدادات المتجر</b>\n\n🏪 ${e(cfg.store_name)}\n☎️ @${e(cleanUsername(cfg.support_username))}\n🖼 ${cfg.banner_file_id?'صورة الواجهة محددة':'بدون صورة واجهة'}`,ik([[{text:'🏪 اسم المتجر',callback_data:'setting:store_name'}],[{text:'📝 رسالة الترحيب',callback_data:'setting:welcome_text'}],[{text:'☎️ حساب الدعم',callback_data:'setting:support_username'}],[{text:'🖼 صورة الواجهة',callback_data:'setting:banner'}],[{text:'🛡 لوحة الإدارة',callback_data:'home'}]]));
}
async function startSettingEdit(env,chatId,field){
  const mode=field==='banner'?'ADMIN_SETTING_BANNER':'ADMIN_SETTING_TEXT'; await setState(env,chatId,mode,{field});
  const prompt=field==='store_name'?'🏪 أرسل اسم المتجر الجديد.':field==='welcome_text'?'📝 أرسل رسالة الترحيب الجديدة.':field==='support_username'?'☎️ أرسل يوزر الدعم بدون أو مع @.':'🖼 أرسل صورة واجهة المتجر الجديدة.';
  return sendMessage(env,chatId,prompt,cancelKeyboard(true));
}

async function handleState(env,chatId,msg,state,admin){
  const text=String(msg.text||'').trim(); if(text==='❌ إلغاء'){ await clearState(env,chatId); return admin?showAdminHome(env,chatId):showHome(env,chatId,msg.from,false); }
  if(state.mode==='AWAIT_PROOF') return handleProof(env,chatId,msg,state);
  if(state.mode.startsWith('SAAS_')||state.mode.startsWith('POS_')) return handleSaasState(env,chatId,msg,state,admin);
  if(admin && (state.mode.startsWith('ADMIN_PLAN_')||state.mode.startsWith('ADMIN_SAAS_'))) return handleSaasAdminState(env,chatId,msg,state);
  if(!admin){ await clearState(env,chatId); return showHome(env,chatId,msg.from,false); }

  if(state.mode==='ADMIN_PRODUCT_NAME'){
    if(!text) return sendMessage(env,chatId,'أرسل اسم البرنامج.',cancelKeyboard(true)); await setState(env,chatId,'ADMIN_PRODUCT_DESC',{name:text}); return sendMessage(env,chatId,'📝 أرسل وصف البرنامج:',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PRODUCT_DESC'){
    if(!text) return sendMessage(env,chatId,'أرسل الوصف.',cancelKeyboard(true)); await setState(env,chatId,'ADMIN_PRODUCT_PRICE',{...state.data,description:text}); return sendMessage(env,chatId,'💰 أرسل السعر فقط، مثال: <code>195</code>',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PRODUCT_PRICE'){
    const price=Number(String(text).replace(',','.')); if(!Number.isFinite(price)||price<0) return sendMessage(env,chatId,'⚠️ السعر غير صحيح. أرسل رقماً فقط.',cancelKeyboard(true)); await setState(env,chatId,'ADMIN_PRODUCT_CURRENCY',{...state.data,price}); return sendMessage(env,chatId,'💱 أرسل رمز العملة، مثال: <code>₪</code> أو <code>EGP</code> أو <code>$</code>',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PRODUCT_CURRENCY'){
    if(!text) return; await setState(env,chatId,'ADMIN_PRODUCT_PHOTO',{...state.data,currency:text}); return sendMessage(env,chatId,'🖼 أرسل صورة البرنامج الآن، أو اكتب <code>تخطي</code>.',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PRODUCT_PHOTO'){
    let photo=''; if(msg.photo?.length) photo=msg.photo[msg.photo.length-1].file_id; else if(text!=='تخطي') return sendMessage(env,chatId,'أرسل صورة أو اكتب تخطي.',cancelKeyboard(true));
    await setState(env,chatId,'ADMIN_PRODUCT_DELIVERY',{...state.data,photo_file_id:photo}); return sendMessage(env,chatId,'🎁 أرسل رسالة الاستلام التي ستصل للعميل بعد اعتماد الدفع، أو اكتب <code>تخطي</code>.',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PRODUCT_DELIVERY'){
    const d=state.data; const pid=id('prd'); await env.DB.prepare(`INSERT INTO store_products(id,name,description,price,currency,photo_file_id,delivery_text,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,0,?,?)`).bind(pid,d.name,d.description,Number(d.price||0),d.currency,d.photo_file_id||null,text==='تخطي'?'':text,now(),now()).run(); await clearState(env,chatId); return sendMessage(env,chatId,'✅ تم إضافة البرنامج بنجاح.',adminKeyboard()).then(()=>adminProductView(env,chatId,pid));
  }
  if(state.mode==='ADMIN_PRODUCT_EDIT'){
    const {product_id,field}=state.data; if(field==='photo'){ if(!msg.photo?.length) return sendMessage(env,chatId,'📷 أرسل صورة.',cancelKeyboard(true)); await env.DB.prepare('UPDATE store_products SET photo_file_id=?,updated_at=? WHERE id=?').bind(msg.photo[msg.photo.length-1].file_id,now(),product_id).run(); }
    else if(field==='price'){ const price=Number(String(text).replace(',','.')); if(!Number.isFinite(price)||price<0) return sendMessage(env,chatId,'⚠️ السعر غير صحيح.',cancelKeyboard(true)); await env.DB.prepare('UPDATE store_products SET price=?,updated_at=? WHERE id=?').bind(price,now(),product_id).run(); }
    else { const col=field==='delivery'?'delivery_text':field; if(!['name','description','delivery_text'].includes(col)) return; await env.DB.prepare(`UPDATE store_products SET ${col}=?,updated_at=? WHERE id=?`).bind(text,now(),product_id).run(); }
    await clearState(env,chatId); return adminProductView(env,chatId,product_id);
  }
  if(state.mode==='ADMIN_PAYMENT_NAME'){
    if(!text) return; await setState(env,chatId,'ADMIN_PAYMENT_DETAILS',{name:text}); return sendMessage(env,chatId,'📝 أرسل بيانات الدفع التي سيشاهدها العميل بالكامل:\nمثال: اسم المحفظة، الرقم، اسم المستلم، الملاحظات.',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PAYMENT_DETAILS'){
    if(!text) return; await setState(env,chatId,'ADMIN_PAYMENT_PHOTO',{...state.data,details:text}); return sendMessage(env,chatId,'🖼 أرسل صورة طريقة الدفع / QR / الحساب، أو اكتب <code>تخطي</code>.',cancelKeyboard(true));
  }
  if(state.mode==='ADMIN_PAYMENT_PHOTO'){
    let photo=''; if(msg.photo?.length) photo=msg.photo[msg.photo.length-1].file_id; else if(text!=='تخطي') return sendMessage(env,chatId,'أرسل صورة أو اكتب تخطي.',cancelKeyboard(true)); const mid=id('pay'); await env.DB.prepare(`INSERT INTO store_payment_methods(id,name,details,photo_file_id,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?)`).bind(mid,state.data.name,state.data.details,photo||null,now(),now()).run(); await clearState(env,chatId); return sendMessage(env,chatId,'✅ تم إضافة طريقة الدفع.',adminKeyboard()).then(()=>adminPaymentView(env,chatId,mid));
  }
  if(state.mode==='ADMIN_PAYMENT_EDIT'){
    const {payment_id,field}=state.data; if(field==='photo'){ if(!msg.photo?.length) return sendMessage(env,chatId,'📷 أرسل صورة.',cancelKeyboard(true)); await env.DB.prepare('UPDATE store_payment_methods SET photo_file_id=?,updated_at=? WHERE id=?').bind(msg.photo[msg.photo.length-1].file_id,now(),payment_id).run(); }
    else { const col=field==='details'?'details':'name'; await env.DB.prepare(`UPDATE store_payment_methods SET ${col}=?,updated_at=? WHERE id=?`).bind(text,now(),payment_id).run(); } await clearState(env,chatId); return adminPaymentView(env,chatId,payment_id);
  }
  if(state.mode==='ADMIN_REJECT_REASON'){ const oid=state.data.order_id; await clearState(env,chatId); return rejectOrder(env,chatId,oid,text||'-'); }
  if(state.mode==='ADMIN_SETTING_TEXT'){
    const field=state.data.field; let value=text; if(field==='support_username') value=cleanUsername(value); if(!value) return sendMessage(env,chatId,'القيمة لا يمكن أن تكون فارغة.',cancelKeyboard(true)); await setConfigField(env,field,value); await clearState(env,chatId); return adminSettings(env,chatId);
  }
  if(state.mode==='ADMIN_SETTING_BANNER'){
    if(!msg.photo?.length) return sendMessage(env,chatId,'🖼 أرسل صورة.',cancelKeyboard(true)); await setConfigField(env,'banner_file_id',msg.photo[msg.photo.length-1].file_id); await clearState(env,chatId); return adminSettings(env,chatId);
  }
}


// =========================
// Oscar Accounting SaaS v5.1
// =========================
function cashierKeyboard(){ return {keyboard:[[{text:'🧾 بيع'},{text:'🛒 مشتريات'}],[{text:'📦 الأصناف'},{text:'📚 المخزون'}],[{text:'👥 العملاء'},{text:'🚚 الموردون'}],[{text:'💼 الحسابات'},{text:'🧾 سند قبض'}],[{text:'💸 سند صرف'},{text:'💸 المصروفات'}],[{text:'📊 التقارير'},{text:'💎 الاشتراك'}],[{text:'🚪 خروج الكاشير'}]],resize_keyboard:true,is_persistent:true}; }
function addHoursIso(hours){ const d=new Date(Date.now()+Number(hours||0)*3600000); return d.toISOString(); }
function addDaysFrom(base,days){ const d=new Date(base||Date.now()); d.setUTCDate(d.getUTCDate()+Number(days||0)); return d.toISOString(); }
function b64u(bytes){ let s=''; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unb64u(str){ const s=String(str||'').replace(/-/g,'+').replace(/_/g,'/'); const pad=s+'==='.slice((s.length+3)%4); return Uint8Array.from(atob(pad),c=>c.charCodeAt(0)); }
async function hashPassword(password,saltB64=''){
  const enc=new TextEncoder(); const salt=saltB64?unb64u(saltB64):crypto.getRandomValues(new Uint8Array(16));
  const km=await crypto.subtle.importKey('raw',enc.encode(String(password)),{name:'PBKDF2'},false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:120000},km,256);
  return {salt:b64u(salt),hash:b64u(new Uint8Array(bits))};
}
async function verifyPassword(password,salt,hash){ const h=await hashPassword(password,salt); return h.hash===hash; }
async function currentSaasAccount(env,chatId){
  let ses=await env.DB.prepare('SELECT account_id FROM saas_sessions WHERE chat_id=?').bind(String(chatId)).first();
  if(ses?.account_id) return env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(ses.account_id).first();
  const own=await env.DB.prepare('SELECT * FROM saas_accounts WHERE owner_chat_id=?').bind(String(chatId)).first();
  if(own){ await env.DB.prepare('INSERT OR REPLACE INTO saas_sessions(chat_id,account_id,logged_in_at) VALUES(?,?,?)').bind(String(chatId),own.id,now()).run(); return own; }
  return null;
}
function saasAccess(a){
  if(!a) return {active:false,label:'غير مسجل'}; const t=Date.now();
  const sub=a.subscription_ends_at?Date.parse(a.subscription_ends_at):0; if(sub>t) return {active:true,label:'اشتراك فعال',until:a.subscription_ends_at};
  const tr=a.trial_ends_at?Date.parse(a.trial_ends_at):0; if(tr>t) return {active:true,label:'تجربة مجانية',until:a.trial_ends_at};
  return {active:false,label:'منتهي',until:a.subscription_ends_at||a.trial_ends_at};
}
async function requireSaas(env,chatId){ const a=await currentSaasAccount(env,chatId); if(!a){ await cashierProductLanding(env,chatId); return null; } const st=saasAccess(a); if(!st.active){ await sendMessage(env,chatId,`⛔ <b>انتهت مدة الحساب</b>\n\n🏢 ${e(a.company_name)}\nيمكنك تجديد الاشتراك بدون فقد أي بيانات.`,{inline_keyboard:[[{text:'تجديد الاشتراك',callback_data:'saas:plans'}],[{text:'الرئيسية',callback_data:'home'}]]}); return null; } return a; }
async function openCashierAccount(env,chatId,from){ const a=await currentSaasAccount(env,chatId); if(a) return showCashierDashboard(env,chatId); return cashierProductLanding(env,chatId); }
async function cashierProductLanding(env,chatId){
  const a=await currentSaasAccount(env,chatId); if(a) return showCashierDashboard(env,chatId);
  return sendMessage(env,chatId,'🧮 <b>أوسكار المحاسبي</b>\n\nبرنامج محاسبة وتشغيل كامل داخل تيليجرام: كاشير ومبيعات ومشتريات وأصناف ومخزون وعملاء وموردون وحسابات وصندوق وسندات قبض وصرف ومصروفات وتقارير.\n\n🎁 <b>تجربة مجانية 24 ساعة</b> لمرة واحدة، وبعدها اختر المدة والسعر من الخطط التي يحددها الأدمن.\n\nتسجيل الدخول يكون باسم المستخدم وكلمة المرور فقط.',{inline_keyboard:[[{text:'بدء تجربة 24 ساعة',callback_data:'saas:trial'}],[{text:'تسجيل الدخول',callback_data:'saas:login'}],[{text:'خطط الاشتراك',callback_data:'saas:plans'}],[{text:'رجوع للمتجر',callback_data:'home'}]]});
}
async function beginTrialRegistration(env,chatId){ const exists=await env.DB.prepare('SELECT id FROM saas_accounts WHERE owner_chat_id=?').bind(String(chatId)).first(); if(exists) return showCashierDashboard(env,chatId); await setState(env,chatId,'SAAS_REG_USERNAME',{}); return sendMessage(env,chatId,'👤 <b>إنشاء حساب تجريبي</b>\n\nاكتب اسم مستخدم للحساب. استخدم حروفاً إنجليزية أو أرقاماً و _ فقط.',cancelKeyboard(false)); }
async function beginCashierLogin(env,chatId){ await setState(env,chatId,'SAAS_LOGIN_USERNAME',{}); return sendMessage(env,chatId,'🔐 أرسل اسم المستخدم:',cancelKeyboard(false)); }
async function logoutCashier(env,chatId,from){ await env.DB.prepare('DELETE FROM saas_sessions WHERE chat_id=?').bind(String(chatId)).run(); await clearState(env,chatId); return showHome(env,chatId,from,false); }
async function showCashierDashboard(env,chatId){
  const a=await currentSaasAccount(env,chatId); if(!a) return cashierProductLanding(env,chatId); const st=saasAccess(a);
  const counts=await Promise.all([env.DB.prepare('SELECT COUNT(*) c FROM pos_products WHERE account_id=? AND active=1').bind(a.id).first(),env.DB.prepare('SELECT COUNT(*) c FROM pos_customers WHERE account_id=?').bind(a.id).first(),env.DB.prepare('SELECT COUNT(*) c FROM pos_suppliers WHERE account_id=?').bind(a.id).first()]);
  const until=st.until?String(st.until).replace('T',' ').slice(0,16):'—';
  return sendMessage(env,chatId,`💼 <b>${e(a.company_name)}</b>\n\n👤 ${e(a.username)}\n📌 الحالة: <b>${e(st.label)}</b>\n⏳ حتى: <code>${e(until)}</code>\n\n📦 الأصناف: <b>${Number(counts[0]?.c||0)}</b>\n👥 العملاء: <b>${Number(counts[1]?.c||0)}</b>\n🚚 الموردون: <b>${Number(counts[2]?.c||0)}</b>\n\nاختر من لوحة أوسكار المحاسبي أسفل الشاشة.`,st.active?cashierKeyboard():userKeyboard());
}
async function showSubscriptionPlans(env,chatId){
  const a=await currentSaasAccount(env,chatId); const rows=await env.DB.prepare('SELECT * FROM saas_plans WHERE active=1 ORDER BY sort_order,days').all(); const plans=rows.results||[];
  if(!plans.length) return sendMessage(env,chatId,'💎 لا توجد خطط اشتراك مفعلة حالياً. تواصل مع الدعم.',a?cashierKeyboard():userKeyboard());
  const buttons=plans.map(p=>[{text:`${p.name} • ${p.days} يوم • ${money(p.price)} ${p.currency}`,callback_data:`saas:plan:${p.id}`}]); buttons.push([{text:'رجوع',callback_data:a?'saas:dashboard':'saas:landing'}]);
  return sendMessage(env,chatId,'💎 <b>خطط أوسكار المحاسبي</b>\n\nاختر المدة المناسبة. يمكنك الشراء أثناء الفترة التجريبية، وعند اعتماد الدفع يتفعّل الاشتراك مباشرة.',ik(buttons));
}
async function beginSaasPlanPurchase(env,chatId,planId){
  const a=await currentSaasAccount(env,chatId); if(!a) return sendMessage(env,chatId,'🔐 أنشئ حساباً تجريبياً أو سجل الدخول أولاً.',ik([[{text:'إنشاء حساب',callback_data:'saas:trial'}],[{text:'تسجيل الدخول',callback_data:'saas:login'}]]));
  const p=await env.DB.prepare('SELECT * FROM saas_plans WHERE id=? AND active=1').bind(planId).first(); if(!p) return showSubscriptionPlans(env,chatId);
  const rows=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE active=1 ORDER BY sort_order,created_at').all(); const ms=rows.results||[]; if(!ms.length) return sendMessage(env,chatId,'⚠️ لا توجد طريقة دفع مفعلة حالياً.',cashierKeyboard());
  await sendMessage(env,chatId,`💎 <b>${e(p.name)}</b>\n📅 ${p.days} يوم\n💰 <b>${money(p.price)} ${e(p.currency)}</b>\n\nاختر طريقة الدفع من الصور التالية:`);
  for(const m of ms){ const cap=`💳 <b>${e(m.name)}</b>\n${m.details?`\n${e(m.details)}`:''}\n\n💎 ${e(p.name)} • ${money(p.price)} ${e(p.currency)}`; const kb=ik([[{text:'اختيار هذه الطريقة',callback_data:`saas:pay:${p.id}:${m.id}`}]]); if(m.photo_file_id) await sendPhoto(env,chatId,m.photo_file_id,cap,kb); else await sendMessage(env,chatId,cap,kb); }
}
async function showSaasCheckout(env,chatId,planId,methodId){
  const a=await currentSaasAccount(env,chatId); if(!a) return cashierProductLanding(env,chatId); const p=await env.DB.prepare('SELECT * FROM saas_plans WHERE id=? AND active=1').bind(planId).first(); const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=? AND active=1').bind(methodId).first(); if(!p||!m) return showSubscriptionPlans(env,chatId);
  const txt=`💳 <b>${e(m.name)}</b>\n\n${e(m.details||'')}\n\n🏢 الحساب: <b>${e(a.company_name)}</b>\n💎 الخطة: <b>${e(p.name)}</b>\n📅 ${p.days} يوم\n💰 المطلوب: <b>${money(p.price)} ${e(p.currency)}</b>\n\nبعد التحويل أرسل صورة إثبات الدفع.`;
  const kb=ik([[{text:'إرسال إثبات الدفع',callback_data:`saas:proof:${p.id}:${m.id}`}],[{text:'إلغاء',callback_data:'saas:dashboard'}]]); if(m.photo_file_id) return sendPhoto(env,chatId,m.photo_file_id,txt,kb); return sendMessage(env,chatId,txt,kb);
}
async function handleSaasProof(env,chatId,msg,state){
  let proof_type='',proof_file_id=''; if(msg.photo?.length){proof_type='photo';proof_file_id=msg.photo[msg.photo.length-1].file_id;} else if(msg.document){proof_type='document';proof_file_id=msg.document.file_id;} if(!proof_file_id) return sendMessage(env,chatId,'📸 أرسل صورة أو ملف إثبات الدفع.',cancelKeyboard(false));
  const a=await currentSaasAccount(env,chatId); const p=await env.DB.prepare('SELECT * FROM saas_plans WHERE id=?').bind(state.data.plan_id).first(); const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=?').bind(state.data.payment_method_id).first(); if(!a||!p||!m){ await clearState(env,chatId); return cashierProductLanding(env,chatId); }
  const oid=id('sub'),code=`SUB-${String(Date.now()).slice(-7)}`; await env.DB.prepare(`INSERT INTO saas_subscription_orders(id,order_code,account_id,user_chat_id,username,customer_name,plan_id,plan_name,plan_days,price,currency,payment_method_id,payment_method_name,proof_type,proof_file_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).bind(oid,code,a.id,String(chatId),cleanUsername(msg.from?.username),[msg.from?.first_name,msg.from?.last_name].filter(Boolean).join(' '),p.id,p.name,p.days,p.price,p.currency,m.id,m.name,proof_type,proof_file_id,now(),now()).run(); await clearState(env,chatId);
  await sendMessage(env,chatId,`⏳ <b>تم استلام طلب الاشتراك</b>\n\nرقم الطلب: <code>${code}</code>\nالخطة: ${e(p.name)}\nالمبلغ: <b>${money(p.price)} ${e(p.currency)}</b>\n\nسيتم تفعيل الحساب تلقائياً فور موافقة الإدارة.`,cashierKeyboard()); await notifyAdminSaasOrder(env,{id:oid,order_code:code,account:a,plan:p,method:m,proof_type,proof_file_id,msg});
}
async function notifyAdminSaasOrder(env,o){ const cfg=await getConfig(env); if(!cfg.owner_chat_id)return; const cap=`💵 <b>طلب اشتراك أوسكار المحاسبي جديد</b>\n\n🧾 ${e(o.order_code)}\n🏢 ${e(o.account.company_name)}\n👤 ${e(o.account.username)}\n💎 ${e(o.plan.name)} — ${o.plan.days} يوم\n💰 <b>${money(o.plan.price)} ${e(o.plan.currency)}</b>\n💳 ${e(o.method.name)}\n\nراجع الإثبات:`; const kb=ik([[{text:'تأكيد وتفعيل',callback_data:`saasorder:approve:${o.id}`}],[{text:'رفض',callback_data:`saasorder:reject:${o.id}`}]]); if(o.proof_type==='photo')return sendPhoto(env,cfg.owner_chat_id,o.proof_file_id,cap,kb); return telegram(env,'sendDocument',{chat_id:String(cfg.owner_chat_id),document:o.proof_file_id,caption:cap,parse_mode:'HTML',reply_markup:kb}); }
async function approveSaasOrder(env,chatId,oid){
  const o=await env.DB.prepare('SELECT * FROM saas_subscription_orders WHERE id=?').bind(oid).first(); if(!o)return adminSubscriptionOrders(env,chatId); if(o.status!=='pending')return adminSaasOrderView(env,chatId,oid); const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(o.account_id).first(); if(!a)return;
  const cur=a.subscription_ends_at&&Date.parse(a.subscription_ends_at)>Date.now()?a.subscription_ends_at:new Date().toISOString(); const end=addDaysFrom(cur,o.plan_days); await env.DB.batch([env.DB.prepare("UPDATE saas_subscription_orders SET status='approved',updated_at=? WHERE id=?").bind(now(),oid),env.DB.prepare("UPDATE saas_accounts SET status='active',subscription_ends_at=?,current_plan_name=?,updated_at=? WHERE id=?").bind(end,o.plan_name,now(),a.id)]); const updated={...a,status:'active',subscription_ends_at:end,current_plan_name:o.plan_name}; await syncSaasCompanyToMaster(env,updated).catch(()=>{}); await sendMessage(env,o.user_chat_id,`✅ <b>تم تأكيد الدفع وتفعيل حسابك</b>\n\n🏢 ${e(a.company_name)}\n💎 ${e(o.plan_name)}\n📅 صالح حتى: <code>${e(end.replace('T',' ').slice(0,16))}</code>\n\nيمكنك استخدام أوسكار المحاسبي الآن.`,cashierKeyboard()); return sendMessage(env,chatId,`✅ تم تفعيل ${e(a.company_name)} حتى ${e(end.slice(0,10))}.`,adminKeyboard());
}
async function rejectSaasOrder(env,chatId,oid,reason){ const o=await env.DB.prepare('SELECT * FROM saas_subscription_orders WHERE id=?').bind(oid).first(); if(!o)return; await env.DB.prepare("UPDATE saas_subscription_orders SET status='rejected',admin_note=?,updated_at=? WHERE id=?").bind(reason==='-'?'':reason,now(),oid).run(); await sendMessage(env,o.user_chat_id,`❌ <b>لم يتم اعتماد دفع الاشتراك</b>\n\nالطلب: <code>${e(o.order_code)}</code>${reason&&reason!=='-'?`\nالسبب: ${e(reason)}`:''}`,cashierKeyboard()); return sendMessage(env,chatId,'تم رفض الطلب وإشعار المستخدم.',adminKeyboard()); }

async function handleSaasState(env,chatId,msg,state,admin){
  const text=String(msg.text||'').trim(); if(text==='❌ إلغاء'){await clearState(env,chatId);return openCashierAccount(env,chatId,msg.from);} if(state.mode==='SAAS_AWAIT_PROOF')return handleSaasProof(env,chatId,msg,state);
  if(state.mode==='SAAS_REG_USERNAME'){ if(!/^[A-Za-z0-9_]{4,30}$/.test(text))return sendMessage(env,chatId,'اسم المستخدم يجب أن يكون 4-30 من حروف إنجليزية/أرقام/_ فقط.',cancelKeyboard(false)); const ex=await env.DB.prepare('SELECT id FROM saas_accounts WHERE username=? COLLATE NOCASE').bind(text).first(); if(ex)return sendMessage(env,chatId,'هذا الاسم مستخدم. اختر اسماً آخر.',cancelKeyboard(false)); await setState(env,chatId,'SAAS_REG_PASSWORD',{username:text}); return sendMessage(env,chatId,'🔑 أرسل كلمة مرور لا تقل عن 6 أحرف. سيتم حذف رسالتها بعد قراءتها.',cancelKeyboard(false)); }
  if(state.mode==='SAAS_REG_PASSWORD'){ if(text.length<6)return sendMessage(env,chatId,'كلمة المرور قصيرة. استخدم 6 أحرف على الأقل.',cancelKeyboard(false)); try{if(msg.message_id)await telegram(env,'deleteMessage',{chat_id:String(chatId),message_id:msg.message_id});}catch{} const hp=await hashPassword(text); await setState(env,chatId,'SAAS_REG_COMPANY',{...state.data,password_salt:hp.salt,password_hash:hp.hash}); return sendMessage(env,chatId,'🏢 أرسل اسم المحل أو الشركة:',cancelKeyboard(false)); }
  if(state.mode==='SAAS_REG_COMPANY'){ if(text.length<2)return sendMessage(env,chatId,'أرسل اسم شركة صحيح.',cancelKeyboard(false)); const aid=id('acc'),start=now(),end=addHoursIso(24); try{await env.DB.prepare(`INSERT INTO saas_accounts(id,owner_chat_id,username,password_salt,password_hash,company_name,telegram_username,status,trial_started_at,trial_ends_at,subscription_ends_at,current_plan_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'trial',?,?,NULL,NULL,?,?)`).bind(aid,String(chatId),state.data.username,state.data.password_salt,state.data.password_hash,text,cleanUsername(msg.from?.username),start,end,start,start).run();}catch(err){return sendMessage(env,chatId,'تعذر إنشاء الحساب؛ اسم المستخدم قد يكون مستخدماً.',userKeyboard());} await env.DB.prepare('INSERT OR REPLACE INTO saas_sessions(chat_id,account_id,logged_in_at) VALUES(?,?,?)').bind(String(chatId),aid,now()).run(); await clearState(env,chatId); const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(aid).first(); await syncSaasCompanyToMaster(env,a).catch(()=>{}); await sendMessage(env,chatId,`🎉 <b>تم إنشاء التجربة المجانية</b>\n\n🏢 ${e(text)}\n👤 ${e(state.data.username)}\n⏱ المدة: 24 ساعة\n\nيمكنك الشراء في أي وقت من زر الاشتراك.`,cashierKeyboard()); return showCashierDashboard(env,chatId); }
  if(state.mode==='SAAS_LOGIN_USERNAME'){ const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE username=? COLLATE NOCASE').bind(text).first(); if(!a)return sendMessage(env,chatId,'اسم المستخدم غير موجود.',cancelKeyboard(false)); await setState(env,chatId,'SAAS_LOGIN_PASSWORD',{account_id:a.id}); return sendMessage(env,chatId,'🔑 أرسل كلمة المرور:',cancelKeyboard(false)); }
  if(state.mode==='SAAS_LOGIN_PASSWORD'){ try{if(msg.message_id)await telegram(env,'deleteMessage',{chat_id:String(chatId),message_id:msg.message_id});}catch{} const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(state.data.account_id).first(); if(!a||!(await verifyPassword(text,a.password_salt,a.password_hash)))return sendMessage(env,chatId,'كلمة المرور غير صحيحة.',cancelKeyboard(false)); await env.DB.prepare('INSERT OR REPLACE INTO saas_sessions(chat_id,account_id,logged_in_at) VALUES(?,?,?)').bind(String(chatId),a.id,now()).run(); await clearState(env,chatId); return showCashierDashboard(env,chatId); }
  if(state.mode==='POS_PRODUCT_NAME'){ if(!text)return; await setState(env,chatId,'POS_PRODUCT_PRICE',{name:text}); return sendMessage(env,chatId,'💰 أرسل سعر البيع:',cancelKeyboard(false)); }
  if(state.mode==='POS_PRODUCT_PRICE'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'أرسل سعراً صحيحاً.',cancelKeyboard(false)); await setState(env,chatId,'POS_PRODUCT_COST',{...state.data,sale_price:v}); return sendMessage(env,chatId,'💵 أرسل التكلفة الحالية:',cancelKeyboard(false)); }
  if(state.mode==='POS_PRODUCT_COST'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'أرسل تكلفة صحيحة.',cancelKeyboard(false)); await setState(env,chatId,'POS_PRODUCT_STOCK',{...state.data,avg_cost:v}); return sendMessage(env,chatId,'📦 أرسل الرصيد الافتتاحي للمخزون:',cancelKeyboard(false)); }
  if(state.mode==='POS_PRODUCT_STOCK'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'أرسل كمية صحيحة.',cancelKeyboard(false)); const a=await requireSaas(env,chatId); if(!a)return; const d=state.data; await env.DB.prepare(`INSERT INTO pos_products(id,account_id,name,sale_price,avg_cost,stock,unit,active,created_at,updated_at) VALUES(?,?,?,?,?,?,'حبة',1,?,?)`).bind(id('prd'),a.id,d.name,d.sale_price,d.avg_cost,v,now(),now()).run(); await clearState(env,chatId); return posProducts(env,chatId); }
  if(state.mode==='POS_CUSTOMER_NAME'){ if(!text)return; await setState(env,chatId,'POS_CUSTOMER_PHONE',{name:text}); return sendMessage(env,chatId,'📱 أرسل الهاتف أو - للتخطي:',cancelKeyboard(false)); }
  if(state.mode==='POS_CUSTOMER_PHONE'){ await setState(env,chatId,'POS_CUSTOMER_BALANCE',{...state.data,phone:text==='-'?'':text}); return sendMessage(env,chatId,'💰 أرسل الرصيد الافتتاحي (موجب = عليه، سالب = له):',cancelKeyboard(false)); }
  if(state.mode==='POS_CUSTOMER_BALANCE'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v))return sendMessage(env,chatId,'أرسل رقماً صحيحاً.',cancelKeyboard(false)); const a=await requireSaas(env,chatId); if(!a)return; await env.DB.prepare('INSERT INTO pos_customers(id,account_id,name,phone,balance,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id('cus'),a.id,state.data.name,state.data.phone,v,now(),now()).run(); await clearState(env,chatId); return posCustomers(env,chatId); }
  if(state.mode==='POS_SUPPLIER_NAME'){ if(!text)return; await setState(env,chatId,'POS_SUPPLIER_PHONE',{name:text}); return sendMessage(env,chatId,'📱 أرسل الهاتف أو - للتخطي:',cancelKeyboard(false)); }
  if(state.mode==='POS_SUPPLIER_PHONE'){ await setState(env,chatId,'POS_SUPPLIER_BALANCE',{...state.data,phone:text==='-'?'':text}); return sendMessage(env,chatId,'💰 أرسل الرصيد الافتتاحي (موجب = علينا):',cancelKeyboard(false)); }
  if(state.mode==='POS_SUPPLIER_BALANCE'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v))return sendMessage(env,chatId,'أرسل رقماً صحيحاً.',cancelKeyboard(false)); const a=await requireSaas(env,chatId); if(!a)return; await env.DB.prepare('INSERT INTO pos_suppliers(id,account_id,name,phone,balance,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id('sup'),a.id,state.data.name,state.data.phone,v,now(),now()).run(); await clearState(env,chatId); return posSuppliers(env,chatId); }
  if(state.mode==='POS_SALE_PARTIAL'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'أرسل مبلغاً صحيحاً.',cancelKeyboard(false)); return posFinalizeSale(env,chatId,'partial',v); }
  if(state.mode==='POS_PUR_QTY'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<=0)return sendMessage(env,chatId,'أرسل كمية أكبر من صفر.',cancelKeyboard(false)); await setState(env,chatId,'POS_PUR_COST',{...state.data,qty:v}); return sendMessage(env,chatId,'💵 أرسل سعر شراء الوحدة:',cancelKeyboard(false)); }
  if(state.mode==='POS_PUR_COST'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'أرسل سعراً صحيحاً.',cancelKeyboard(false)); await setState(env,chatId,'POS_PUR_PAID',{...state.data,cost:v}); const total=v*Number(state.data.qty); return sendMessage(env,chatId,`💰 الإجمالي ${money(total)}. أرسل المدفوع الآن:`,cancelKeyboard(false)); }
  if(state.mode==='POS_PUR_PAID'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'أرسل مبلغاً صحيحاً.',cancelKeyboard(false)); return posFinalizePurchase(env,chatId,{...state.data,paid:v}); }
  if(state.mode==='POS_EXP_CATEGORY'){ if(!text)return; await setState(env,chatId,'POS_EXP_NOTE',{category:text}); return sendMessage(env,chatId,'📝 أرسل البيان/الملاحظة:',cancelKeyboard(false)); }
  if(state.mode==='POS_EXP_NOTE'){ await setState(env,chatId,'POS_EXP_AMOUNT',{...state.data,note:text}); return sendMessage(env,chatId,'💰 أرسل مبلغ المصروف:',cancelKeyboard(false)); }
  if(state.mode==='POS_EXP_AMOUNT'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<=0)return sendMessage(env,chatId,'أرسل مبلغاً صحيحاً.',cancelKeyboard(false)); const a=await requireSaas(env,chatId); if(!a)return; const eid=id('exp'); await env.DB.batch([env.DB.prepare('INSERT INTO pos_expenses(id,account_id,category,note,amount,created_at) VALUES(?,?,?,?,?,?)').bind(eid,a.id,state.data.category,state.data.note,v,now()),env.DB.prepare("INSERT INTO pos_cash_moves(id,account_id,kind,amount,ref_id,note,created_at) VALUES(?,?,'expense',?,?,?,?)").bind(id('cash'),a.id,-v,eid,state.data.note,now())]); await clearState(env,chatId); return sendMessage(env,chatId,'✅ تم تسجيل المصروف.',cashierKeyboard()); }  if(state.mode==='POS_VOUCHER_AMOUNT'){ const v=Number(text.replace(',','.')); if(!Number.isFinite(v)||v<=0)return sendMessage(env,chatId,'أرسل مبلغاً صحيحاً.',cancelKeyboard(false)); await setState(env,chatId,'POS_VOUCHER_PARTY',{...state.data,amount:v}); return sendMessage(env,chatId,'👤 أرسل اسم العميل / المورد / الجهة:',cancelKeyboard(false)); }
  if(state.mode==='POS_VOUCHER_PARTY'){ if(!text)return sendMessage(env,chatId,'أرسل اسم الجهة.',cancelKeyboard(false)); await setState(env,chatId,'POS_VOUCHER_NOTE',{...state.data,party_name:text}); return sendMessage(env,chatId,'📝 أرسل البيان أو الملاحظة، أو - للتخطي:',cancelKeyboard(false)); }
  if(state.mode==='POS_VOUCHER_NOTE'){ const a=await requireSaas(env,chatId); if(!a)return; const type=state.data.voucher_type==='payment'?'payment':'receipt'; const vid=id('vou'),no=`${type==='receipt'?'R':'P'}-${String(Date.now()).slice(-7)}`,amount=Number(state.data.amount); const signed=type==='receipt'?amount:-amount; await env.DB.batch([env.DB.prepare('INSERT INTO pos_vouchers(id,account_id,voucher_no,voucher_type,party_name,amount,note,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(vid,a.id,no,type,state.data.party_name,amount,text==='-'?'':text,now()),env.DB.prepare('INSERT INTO pos_cash_moves(id,account_id,kind,amount,ref_id,note,created_at) VALUES(?,?,?,?,?,?,?)').bind(id('cash'),a.id,type,signed,vid,`${type==='receipt'?'قبض من':'صرف إلى'} ${state.data.party_name}`,now())]); await clearState(env,chatId); return sendMessage(env,chatId,`✅ <b>تم حفظ ${type==='receipt'?'سند القبض':'سند الصرف'}</b>\n\n🔢 ${e(no)}\n👤 ${e(state.data.party_name)}\n💰 ${money(amount)}`,cashierKeyboard()); }
}

async function posProducts(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const rows=await env.DB.prepare('SELECT * FROM pos_products WHERE account_id=? AND active=1 ORDER BY name LIMIT 50').bind(a.id).all(); const list=(rows.results||[]).map((p,i)=>`${i+1}. <b>${e(p.name)}</b> — ${money(p.sale_price)}\n   مخزون: ${Number(p.stock)} ${e(p.unit)} • تكلفة: ${money(p.avg_cost)}`).join('\n\n'); return sendMessage(env,chatId,`📦 <b>الأصناف</b>\n\n${list||'لا توجد أصناف بعد.'}`,ik([[{text:'إضافة صنف',callback_data:'pos:product:add'}],[{text:'لوحة الكاشير',callback_data:'saas:dashboard'}]])); }
async function posBeginAddProduct(env,chatId){ if(!(await requireSaas(env,chatId)))return; await setState(env,chatId,'POS_PRODUCT_NAME',{}); return sendMessage(env,chatId,'➕ أرسل اسم الصنف:',cancelKeyboard(false)); }
async function posCustomers(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const rows=await env.DB.prepare('SELECT * FROM pos_customers WHERE account_id=? ORDER BY name LIMIT 50').bind(a.id).all(); const list=(rows.results||[]).map((x,i)=>`${i+1}. <b>${e(x.name)}</b>${x.phone?` • ${e(x.phone)}`:''}\n   الرصيد: ${money(x.balance)}`).join('\n\n'); return sendMessage(env,chatId,`👥 <b>العملاء</b>\n\n${list||'لا يوجد عملاء.'}`,ik([[{text:'إضافة عميل',callback_data:'pos:customer:add'}],[{text:'لوحة الكاشير',callback_data:'saas:dashboard'}]])); }
async function posBeginAddCustomer(env,chatId){ if(!(await requireSaas(env,chatId)))return; await setState(env,chatId,'POS_CUSTOMER_NAME',{}); return sendMessage(env,chatId,'➕ أرسل اسم العميل:',cancelKeyboard(false)); }
async function posSuppliers(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const rows=await env.DB.prepare('SELECT * FROM pos_suppliers WHERE account_id=? ORDER BY name LIMIT 50').bind(a.id).all(); const list=(rows.results||[]).map((x,i)=>`${i+1}. <b>${e(x.name)}</b>${x.phone?` • ${e(x.phone)}`:''}\n   الرصيد: ${money(x.balance)}`).join('\n\n'); return sendMessage(env,chatId,`🚚 <b>الموردون</b>\n\n${list||'لا يوجد موردون.'}`,ik([[{text:'إضافة مورد',callback_data:'pos:supplier:add'}],[{text:'لوحة الكاشير',callback_data:'saas:dashboard'}]])); }
async function posBeginAddSupplier(env,chatId){ if(!(await requireSaas(env,chatId)))return; await setState(env,chatId,'POS_SUPPLIER_NAME',{}); return sendMessage(env,chatId,'➕ أرسل اسم المورد:',cancelKeyboard(false)); }
async function posStartSale(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const cs=await env.DB.prepare('SELECT * FROM pos_customers WHERE account_id=? ORDER BY name LIMIT 20').bind(a.id).all(); const btns=[[{text:'عميل نقدي',callback_data:'pos:customer:cash'}],...(cs.results||[]).map(c=>[{text:c.name,callback_data:`pos:customer:${c.id}`}])]; await setState(env,chatId,'POS_SALE_CART',{cart:{},customer_id:'',customer_name:'عميل نقدي'}); return sendMessage(env,chatId,'🧾 <b>فاتورة بيع جديدة</b>\n\nاختر العميل أولاً:',ik(btns)); }
async function posSaleChooseCustomer(env,chatId,cid){ const a=await requireSaas(env,chatId); if(!a)return; const state=await getState(env,chatId); if(state.mode!=='POS_SALE_CART')await setState(env,chatId,'POS_SALE_CART',{cart:{}}); let name='عميل نقدي',idv=''; if(cid!=='cash'){const c=await env.DB.prepare('SELECT * FROM pos_customers WHERE id=? AND account_id=?').bind(cid,a.id).first(); if(c){name=c.name;idv=c.id;}} const st=await getState(env,chatId); await setState(env,chatId,'POS_SALE_CART',{...st.data,customer_id:idv,customer_name:name,cart:st.data.cart||{}}); return posShowSaleCart(env,chatId); }
async function posShowSaleCart(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const st=await getState(env,chatId); if(st.mode!=='POS_SALE_CART')return posStartSale(env,chatId); const ps=await env.DB.prepare('SELECT * FROM pos_products WHERE account_id=? AND active=1 ORDER BY name LIMIT 30').bind(a.id).all(); const cart=st.data.cart||{}; let total=0; const lines=[]; for(const p of ps.results||[]){const q=Number(cart[p.id]||0); if(q>0){const lt=q*Number(p.sale_price);total+=lt;lines.push(`${e(p.name)} × ${q} = <b>${money(lt)}</b>`);}} const buttons=[]; for(const p of ps.results||[]){buttons.push([{text:`➕ ${p.name} (${money(p.sale_price)})`,callback_data:`pos:add:${p.id}`},{text:'➖',callback_data:`pos:sub:${p.id}`}]);} if(total>0)buttons.push([{text:`إتمام البيع • ${money(total)}`,callback_data:'pos:checkout'}]); buttons.push([{text:'إلغاء',callback_data:'saas:dashboard'}]); return sendMessage(env,chatId,`🧾 <b>فاتورة بيع</b>\n👤 ${e(st.data.customer_name||'عميل نقدي')}\n\n${lines.join('\n')||'السلة فارغة'}\n\n💰 الإجمالي: <b>${money(total)}</b>\n\nاضغط + لإضافة الصنف و - للتقليل.`,ik(buttons)); }
async function posSaleAdd(env,chatId,pid,delta){ const a=await requireSaas(env,chatId); if(!a)return; const st=await getState(env,chatId); if(st.mode!=='POS_SALE_CART')return posStartSale(env,chatId); const p=await env.DB.prepare('SELECT * FROM pos_products WHERE id=? AND account_id=? AND active=1').bind(pid,a.id).first(); if(!p)return posShowSaleCart(env,chatId); const cart={...(st.data.cart||{})}; cart[pid]=Math.max(0,Number(cart[pid]||0)+Number(delta)); await setState(env,chatId,'POS_SALE_CART',{...st.data,cart}); return posShowSaleCart(env,chatId); }
async function posSaleCheckout(env,chatId){ const st=await getState(env,chatId); if(st.mode!=='POS_SALE_CART')return posStartSale(env,chatId); return sendMessage(env,chatId,'💳 اختر طريقة التحصيل:',ik([[{text:'نقدي كامل',callback_data:'pos:pay:cash'}],[{text:'دفع جزئي',callback_data:'pos:pay:partial'}],[{text:'آجل كامل',callback_data:'pos:pay:credit'}]])); }
async function posAskPartial(env,chatId){ const st=await getState(env,chatId); if(st.mode!=='POS_SALE_CART')return; await setState(env,chatId,'POS_SALE_PARTIAL',st.data); return sendMessage(env,chatId,'💵 أرسل المبلغ المدفوع:',cancelKeyboard(false)); }
async function posFinalizeSale(env,chatId,mode,partial=0){ const a=await requireSaas(env,chatId); if(!a)return; const st=await getState(env,chatId); if(!['POS_SALE_CART','POS_SALE_PARTIAL'].includes(st.mode))return posStartSale(env,chatId); const cart=st.data.cart||{},ids=Object.keys(cart).filter(k=>Number(cart[k])>0); if(!ids.length)return posShowSaleCart(env,chatId); const placeholders=ids.map(()=>'?').join(','); const rows=await env.DB.prepare(`SELECT * FROM pos_products WHERE account_id=? AND id IN (${placeholders})`).bind(a.id,...ids).all(); let total=0; const items=[]; for(const p of rows.results||[]){const q=Number(cart[p.id]||0); if(q<=0)continue; if(Number(p.stock)<q)return sendMessage(env,chatId,`⚠️ مخزون ${e(p.name)} غير كافٍ. المتاح ${Number(p.stock)}.`,cashierKeyboard()); const lt=q*Number(p.sale_price); total+=lt;items.push({p,q,lt});} let paid=mode==='cash'?total:mode==='credit'?0:Number(partial||0); paid=Math.max(0,Math.min(total,paid)); const rem=total-paid,sid=id('sale'),inv=`S-${String(Date.now()).slice(-7)}`; const stm=[env.DB.prepare('INSERT INTO pos_sales(id,account_id,invoice_no,customer_id,customer_name,total,paid,remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(sid,a.id,inv,st.data.customer_id||null,st.data.customer_name||'عميل نقدي',total,paid,rem,now())]; for(const it of items){stm.push(env.DB.prepare('INSERT INTO pos_sale_items(id,sale_id,account_id,product_id,product_name,qty,unit_price,total) VALUES(?,?,?,?,?,?,?,?)').bind(id('si'),sid,a.id,it.p.id,it.p.name,it.q,it.p.sale_price,it.lt)); stm.push(env.DB.prepare('UPDATE pos_products SET stock=stock-?,updated_at=? WHERE id=? AND account_id=?').bind(it.q,now(),it.p.id,a.id));} if(st.data.customer_id&&rem>0)stm.push(env.DB.prepare('UPDATE pos_customers SET balance=balance+?,updated_at=? WHERE id=? AND account_id=?').bind(rem,now(),st.data.customer_id,a.id)); if(paid>0)stm.push(env.DB.prepare("INSERT INTO pos_cash_moves(id,account_id,kind,amount,ref_id,note,created_at) VALUES(?,?,'sale',?,?,?,?)").bind(id('cash'),a.id,paid,sid,`بيع ${inv}`,now())); await env.DB.batch(stm); await clearState(env,chatId); return sendMessage(env,chatId,`✅ <b>تم حفظ الفاتورة</b>\n\n🔢 ${e(inv)}\n👤 ${e(st.data.customer_name||'عميل نقدي')}\n💰 الإجمالي: <b>${money(total)}</b>\n💵 المدفوع: ${money(paid)}\n🧾 المتبقي: ${money(rem)}`,cashierKeyboard()); }
async function posStartPurchase(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const ss=await env.DB.prepare('SELECT * FROM pos_suppliers WHERE account_id=? ORDER BY name LIMIT 20').bind(a.id).all(); const btns=[[{text:'مورد نقدي',callback_data:'pos:pursupplier:cash'}],...(ss.results||[]).map(x=>[{text:x.name,callback_data:`pos:pursupplier:${x.id}`}])]; await setState(env,chatId,'POS_PUR_SELECT_SUPPLIER',{}); return sendMessage(env,chatId,'🛒 <b>مشتريات جديدة</b>\nاختر المورد:',ik(btns)); }
async function posPurchaseChooseSupplier(env,chatId,sid){ const a=await requireSaas(env,chatId); if(!a)return; let supplier_id='',supplier_name='مورد نقدي'; if(sid!=='cash'){const sp=await env.DB.prepare('SELECT * FROM pos_suppliers WHERE id=? AND account_id=?').bind(sid,a.id).first(); if(sp){supplier_id=sp.id;supplier_name=sp.name;}} const ps=await env.DB.prepare('SELECT * FROM pos_products WHERE account_id=? AND active=1 ORDER BY name LIMIT 30').bind(a.id).all(); await setState(env,chatId,'POS_PUR_SELECT_PRODUCT',{supplier_id,supplier_name}); const btns=(ps.results||[]).map(p=>[{text:p.name,callback_data:`pos:purproduct:${p.id}`}]); return sendMessage(env,chatId,`🚚 ${e(supplier_name)}\nاختر الصنف الذي ستشتريه:`,ik(btns)); }
async function posPurchaseChooseProduct(env,chatId,pid){ const a=await requireSaas(env,chatId); if(!a)return; const st=await getState(env,chatId); const p=await env.DB.prepare('SELECT * FROM pos_products WHERE id=? AND account_id=?').bind(pid,a.id).first(); if(!p)return posStartPurchase(env,chatId); await setState(env,chatId,'POS_PUR_QTY',{...st.data,product_id:p.id,product_name:p.name}); return sendMessage(env,chatId,`📦 ${e(p.name)}\nأرسل الكمية:`,cancelKeyboard(false)); }
async function posFinalizePurchase(env,chatId,d){ const a=await requireSaas(env,chatId); if(!a)return; const p=await env.DB.prepare('SELECT * FROM pos_products WHERE id=? AND account_id=?').bind(d.product_id,a.id).first(); if(!p)return; const qty=Number(d.qty),cost=Number(d.cost),total=qty*cost,paid=Math.max(0,Math.min(total,Number(d.paid||0))),rem=total-paid,pid=id('pur'),no=`P-${String(Date.now()).slice(-7)}`,oldStock=Number(p.stock||0),oldCost=Number(p.avg_cost||0),newStock=oldStock+qty,newCost=newStock>0?((oldStock*oldCost)+(qty*cost))/newStock:cost; const stm=[env.DB.prepare('INSERT INTO pos_purchases(id,account_id,purchase_no,supplier_id,supplier_name,total,paid,remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(pid,a.id,no,d.supplier_id||null,d.supplier_name||'مورد نقدي',total,paid,rem,now()),env.DB.prepare('INSERT INTO pos_purchase_items(id,purchase_id,account_id,product_id,product_name,qty,unit_cost,total) VALUES(?,?,?,?,?,?,?,?)').bind(id('pi'),pid,a.id,p.id,p.name,qty,cost,total),env.DB.prepare('UPDATE pos_products SET stock=?,avg_cost=?,updated_at=? WHERE id=? AND account_id=?').bind(newStock,newCost,now(),p.id,a.id)]; if(d.supplier_id&&rem>0)stm.push(env.DB.prepare('UPDATE pos_suppliers SET balance=balance+?,updated_at=? WHERE id=? AND account_id=?').bind(rem,now(),d.supplier_id,a.id)); if(paid>0)stm.push(env.DB.prepare("INSERT INTO pos_cash_moves(id,account_id,kind,amount,ref_id,note,created_at) VALUES(?,?,'purchase',?,?,?,?)").bind(id('cash'),a.id,-paid,pid,`شراء ${no}`,now())); await env.DB.batch(stm); await clearState(env,chatId); return sendMessage(env,chatId,`✅ <b>تم تسجيل المشتريات</b>\n\n🔢 ${e(no)}\n🚚 ${e(d.supplier_name)}\n📦 ${e(p.name)} × ${qty}\n💰 الإجمالي ${money(total)}\n💵 المدفوع ${money(paid)}\n🧾 المتبقي ${money(rem)}`,cashierKeyboard()); }
async function posStartExpense(env,chatId){ if(!(await requireSaas(env,chatId)))return; await setState(env,chatId,'POS_EXP_CATEGORY',{}); return sendMessage(env,chatId,'💸 أرسل نوع المصروف، مثال: تشغيل / مواصلات / إيجار:',cancelKeyboard(false)); }
async function posCash(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const r=await env.DB.prepare('SELECT COALESCE(SUM(amount),0) balance,COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) ins,COALESCE(SUM(CASE WHEN amount<0 THEN -amount ELSE 0 END),0) outs FROM pos_cash_moves WHERE account_id=?').bind(a.id).first(); return sendMessage(env,chatId,`💰 <b>الصندوق</b>\n\n⬆️ الداخل: ${money(r?.ins)}\n⬇️ الخارج: ${money(r?.outs)}\n💵 الرصيد: <b>${money(r?.balance)}</b>`,cashierKeyboard()); }
async function posDailyReport(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const start=new Date(); start.setHours(0,0,0,0); const iso=start.toISOString(); const [s,p,x,l]=await Promise.all([env.DB.prepare('SELECT COALESCE(SUM(total),0) total,COALESCE(SUM(paid),0) paid,COUNT(*) c FROM pos_sales WHERE account_id=? AND created_at>=?').bind(a.id,iso).first(),env.DB.prepare('SELECT COALESCE(SUM(total),0) total,COUNT(*) c FROM pos_purchases WHERE account_id=? AND created_at>=?').bind(a.id,iso).first(),env.DB.prepare('SELECT COALESCE(SUM(amount),0) total,COUNT(*) c FROM pos_expenses WHERE account_id=? AND created_at>=?').bind(a.id,iso).first(),env.DB.prepare('SELECT COUNT(*) c FROM pos_products WHERE account_id=? AND stock<=reorder_level').bind(a.id).first()]); return sendMessage(env,chatId,`📊 <b>تقرير اليوم</b>\n\n🧾 المبيعات: ${money(s?.total)} (${Number(s?.c||0)} فاتورة)\n💵 المحصل: ${money(s?.paid)}\n🛒 المشتريات: ${money(p?.total)} (${Number(p?.c||0)})\n💸 المصروفات: ${money(x?.total)} (${Number(x?.c||0)})\n⚠️ أصناف منخفضة: ${Number(l?.c||0)}`,cashierKeyboard()); }


async function posInventorySummary(env,chatId){
  const a=await requireSaas(env,chatId); if(!a)return;
  const r=await env.DB.prepare('SELECT COUNT(*) c,COALESCE(SUM(stock),0) qty,COALESCE(SUM(stock*avg_cost),0) cost_value,COALESCE(SUM(stock*sale_price),0) sale_value,COALESCE(SUM(CASE WHEN stock<=reorder_level THEN 1 ELSE 0 END),0) low FROM pos_products WHERE account_id=? AND active=1').bind(a.id).first();
  return sendMessage(env,chatId,`📚 <b>ملخص المخزون</b>\n\n📦 عدد الأصناف: <b>${Number(r?.c||0)}</b>\n🔢 إجمالي الكميات: <b>${Number(r?.qty||0)}</b>\n💵 قيمة المخزون بالتكلفة: <b>${money(r?.cost_value)}</b>\n💰 قيمة المخزون بسعر البيع: <b>${money(r?.sale_value)}</b>\n⚠️ منخفض المخزون: <b>${Number(r?.low||0)}</b>`,cashierKeyboard());
}
async function posAccounts(env,chatId){
  const a=await requireSaas(env,chatId); if(!a)return;
  const [cash,cu,su,rec,pay]=await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(amount),0) v FROM pos_cash_moves WHERE account_id=?').bind(a.id).first(),
    env.DB.prepare('SELECT COALESCE(SUM(balance),0) v FROM pos_customers WHERE account_id=?').bind(a.id).first(),
    env.DB.prepare('SELECT COALESCE(SUM(balance),0) v FROM pos_suppliers WHERE account_id=?').bind(a.id).first(),
    env.DB.prepare("SELECT COALESCE(SUM(amount),0) v FROM pos_vouchers WHERE account_id=? AND voucher_type='receipt'").bind(a.id).first(),
    env.DB.prepare("SELECT COALESCE(SUM(amount),0) v FROM pos_vouchers WHERE account_id=? AND voucher_type='payment'").bind(a.id).first()
  ]);
  return sendMessage(env,chatId,`💼 <b>الحسابات</b>\n\n💰 رصيد الصندوق: <b>${money(cash?.v)}</b>\n👥 أرصدة العملاء: <b>${money(cu?.v)}</b>\n🚚 أرصدة الموردين: <b>${money(su?.v)}</b>\n🧾 إجمالي سندات القبض: ${money(rec?.v)}\n💸 إجمالي سندات الصرف: ${money(pay?.v)}`,cashierKeyboard());
}
async function posStartVoucher(env,chatId,type){
  if(!(await requireSaas(env,chatId)))return;
  const label=type==='receipt'?'سند قبض':'سند صرف';
  await setState(env,chatId,'POS_VOUCHER_AMOUNT',{voucher_type:type});
  return sendMessage(env,chatId,`${type==='receipt'?'🧾':'💸'} <b>${label}</b>\n\nأرسل المبلغ:`,cancelKeyboard(false));
}
async function posReportsMenu(env,chatId){
  const a=await requireSaas(env,chatId); if(!a)return;
  const buttons=ik([[{text:'تقرير اليوم',callback_data:'pos:report:today'}],[{text:'آخر فواتير البيع',callback_data:'pos:report:sales'}],[{text:'آخر المشتريات',callback_data:'pos:report:purchases'}],[{text:'أرصدة العملاء والموردين',callback_data:'pos:report:balances'}],[{text:'لوحة المحاسبة',callback_data:'saas:dashboard'}]]);
  return sendMessage(env,chatId,'📊 <b>التقارير</b>\n\nاختر التقرير المطلوب:',buttons);
}
async function posRecentSales(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const rows=await env.DB.prepare('SELECT * FROM pos_sales WHERE account_id=? ORDER BY created_at DESC LIMIT 15').bind(a.id).all(); const list=(rows.results||[]).map(x=>`🧾 <b>${e(x.invoice_no)}</b> • ${e(x.customer_name)}\n💰 ${money(x.total)} • مدفوع ${money(x.paid)} • متبقي ${money(x.remaining)}`).join('\n\n'); return sendMessage(env,chatId,`📋 <b>آخر فواتير البيع</b>\n\n${list||'لا توجد فواتير.'}`,cashierKeyboard()); }
async function posRecentPurchases(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const rows=await env.DB.prepare('SELECT * FROM pos_purchases WHERE account_id=? ORDER BY created_at DESC LIMIT 15').bind(a.id).all(); const list=(rows.results||[]).map(x=>`🛒 <b>${e(x.purchase_no)}</b> • ${e(x.supplier_name)}\n💰 ${money(x.total)} • مدفوع ${money(x.paid)} • متبقي ${money(x.remaining)}`).join('\n\n'); return sendMessage(env,chatId,`📋 <b>آخر المشتريات</b>\n\n${list||'لا توجد مشتريات.'}`,cashierKeyboard()); }
async function posBalances(env,chatId){ const a=await requireSaas(env,chatId); if(!a)return; const [cs,ss]=await Promise.all([env.DB.prepare('SELECT name,balance FROM pos_customers WHERE account_id=? AND balance<>0 ORDER BY ABS(balance) DESC LIMIT 20').bind(a.id).all(),env.DB.prepare('SELECT name,balance FROM pos_suppliers WHERE account_id=? AND balance<>0 ORDER BY ABS(balance) DESC LIMIT 20').bind(a.id).all()]); const cl=(cs.results||[]).map(x=>`• ${e(x.name)}: <b>${money(x.balance)}</b>`).join('\n')||'لا توجد أرصدة'; const sl=(ss.results||[]).map(x=>`• ${e(x.name)}: <b>${money(x.balance)}</b>`).join('\n')||'لا توجد أرصدة'; return sendMessage(env,chatId,`👥 <b>أرصدة العملاء</b>\n${cl}\n\n🚚 <b>أرصدة الموردين</b>\n${sl}`,cashierKeyboard()); }

async function adminPlans(env,chatId){ const rows=await env.DB.prepare('SELECT * FROM saas_plans ORDER BY sort_order,days').all(); const bs=[[{text:'إضافة خطة',callback_data:'admin:plan:add'}]]; for(const p of rows.results||[])bs.push([{text:`${p.active?'🟢':'⚪'} ${p.name} • ${p.days} يوم • ${money(p.price)} ${p.currency}`,callback_data:`admin:plan:toggle:${p.id}`}],[{text:`حذف ${p.name}`,callback_data:`admin:plan:delete:${p.id}`}]); bs.push([{text:'لوحة الإدارة',callback_data:'home'}]); return sendMessage(env,chatId,'💎 <b>خطط الاشتراك</b>\n\nالضغط على الخطة يفعّل/يوقف ظهورها.',ik(bs)); }
async function adminPlanToggle(env,chatId,pid){ await env.DB.prepare('UPDATE saas_plans SET active=CASE active WHEN 1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?').bind(now(),pid).run(); return adminPlans(env,chatId); }
async function adminPlanDelete(env,chatId,pid){ if(['plan_month','plan_year'].includes(pid)){await env.DB.prepare('UPDATE saas_plans SET active=0,updated_at=? WHERE id=?').bind(now(),pid).run();}else await env.DB.prepare('DELETE FROM saas_plans WHERE id=?').bind(pid).run(); return adminPlans(env,chatId); }
async function adminSaasAccounts(env,chatId,companiesLabel=false){ const rows=await env.DB.prepare('SELECT * FROM saas_accounts ORDER BY created_at DESC LIMIT 50').all(); const bs=[[{text:'إنشاء شركة يدوياً',callback_data:'admin:saas_add'}]]; for(const a of rows.results||[]){const st=saasAccess(a);bs.push([{text:`${st.active?'🟢':'🔴'} ${a.company_name} • ${a.username}`,callback_data:`admin:saas:view:${a.id}`}]);} bs.push([{text:'لوحة الإدارة',callback_data:'home'}]); return sendMessage(env,chatId,`🏢 <b>${companiesLabel?'الشركات المسجلة':'حسابات أوسكار المحاسبي'}</b>\n\nإجمالي: ${Number((rows.results||[]).length)}`,ik(bs)); }
async function adminSaasAccountView(env,chatId,aid){ const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(aid).first(); if(!a)return adminSaasAccounts(env,chatId); const st=saasAccess(a); const until=st.until?st.until.replace('T',' ').slice(0,16):'—'; return sendMessage(env,chatId,`🏢 <b>${e(a.company_name)}</b>\n👤 ${e(a.username)}\n📌 ${e(st.label)}\n⏳ حتى: ${e(until)}\n💎 ${e(a.current_plan_name||'بدون خطة مدفوعة')}\n🆔 <code>${e(a.id)}</code>`,ik([[{text:'إضافة أيام',callback_data:`admin:saas:adddays:${a.id}`}],[{text:'رجوع',callback_data:'admin:saas_accounts'}]])); }
async function adminSubscriptionOrders(env,chatId){ const rows=await env.DB.prepare('SELECT * FROM saas_subscription_orders ORDER BY created_at DESC LIMIT 50').all(); const bs=(rows.results||[]).map(o=>[{text:`${statusEmoji(o.status)} ${o.order_code} • ${o.plan_name}`,callback_data:`saasorder:view:${o.id}`}]); bs.unshift([{text:'الحسابات',callback_data:'admin:saas_accounts'}]); bs.push([{text:'لوحة الإدارة',callback_data:'home'}]); return sendMessage(env,chatId,`💵 <b>طلبات اشتراك أوسكار المحاسبي</b>\n\n${(rows.results||[]).length?'اختر طلباً لعرضه.':'لا توجد طلبات.'}`,ik(bs)); }
async function adminSaasOrderView(env,chatId,oid){ const o=await env.DB.prepare('SELECT * FROM saas_subscription_orders WHERE id=?').bind(oid).first(); if(!o)return adminSubscriptionOrders(env,chatId); const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(o.account_id).first(); const bs=[]; if(o.status==='pending')bs.push([{text:'تأكيد وتفعيل',callback_data:`saasorder:approve:${o.id}`}],[{text:'رفض',callback_data:`saasorder:reject:${o.id}`}]); bs.push([{text:'رجوع',callback_data:'admin:saas_orders'}]); const txt=`💵 <b>${e(o.order_code)}</b>\n🏢 ${e(a?.company_name||'-')}\n👤 ${e(a?.username||'-')}\n💎 ${e(o.plan_name)} • ${o.plan_days} يوم\n💰 ${money(o.price)} ${e(o.currency)}\n💳 ${e(o.payment_method_name)}\n📌 ${statusText(o.status)}`; if(o.proof_type==='photo'&&o.proof_file_id)return sendPhoto(env,chatId,o.proof_file_id,txt,ik(bs)); return sendMessage(env,chatId,txt,ik(bs)); }
async function handleSaasAdminState(env,chatId,msg,state){ const text=String(msg.text||'').trim(); if(text==='❌ إلغاء'){await clearState(env,chatId);return showAdminHome(env,chatId);} if(state.mode==='ADMIN_PLAN_NAME'){if(!text)return;await setState(env,chatId,'ADMIN_PLAN_DAYS',{name:text});return sendMessage(env,chatId,'📅 أرسل عدد الأيام، مثال 30 أو 365:',cancelKeyboard(true));} if(state.mode==='ADMIN_PLAN_DAYS'){const d=parseInt(text,10);if(!Number.isFinite(d)||d<1||d>3650)return sendMessage(env,chatId,'عدد الأيام بين 1 و3650.',cancelKeyboard(true));await setState(env,chatId,'ADMIN_PLAN_PRICE',{...state.data,days:d});return sendMessage(env,chatId,'💰 أرسل السعر:',cancelKeyboard(true));} if(state.mode==='ADMIN_PLAN_PRICE'){const v=Number(text.replace(',','.'));if(!Number.isFinite(v)||v<0)return sendMessage(env,chatId,'سعر غير صحيح.',cancelKeyboard(true));await setState(env,chatId,'ADMIN_PLAN_CURRENCY',{...state.data,price:v});return sendMessage(env,chatId,'💱 أرسل العملة مثل ₪ أو EGP أو $:',cancelKeyboard(true));} if(state.mode==='ADMIN_PLAN_CURRENCY'){const d=state.data;await env.DB.prepare('INSERT INTO saas_plans(id,name,days,price,currency,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,1,0,?,?)').bind(id('plan'),d.name,d.days,d.price,text||'₪',now(),now()).run();await clearState(env,chatId);return adminPlans(env,chatId);} if(state.mode==='ADMIN_SAAS_ADD_DAYS'){const d=parseInt(text,10);if(!Number.isFinite(d)||d<1||d>3650)return sendMessage(env,chatId,'أرسل عدداً بين 1 و3650.',cancelKeyboard(true));const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(state.data.account_id).first();if(!a)return;const base=a.subscription_ends_at&&Date.parse(a.subscription_ends_at)>Date.now()?a.subscription_ends_at:new Date().toISOString(),end=addDaysFrom(base,d);await env.DB.prepare("UPDATE saas_accounts SET status='active',subscription_ends_at=?,current_plan_name=?,updated_at=? WHERE id=?").bind(end,`إضافة يدوية ${d} يوم`,now(),a.id).run();await clearState(env,chatId);const u={...a,status:'active',subscription_ends_at:end,current_plan_name:`إضافة يدوية ${d} يوم`};await syncSaasCompanyToMaster(env,u).catch(()=>{});await sendMessage(env,a.owner_chat_id,`🎁 أضافت الإدارة ${d} يوم إلى حسابك.\nصالح حتى: ${e(end.slice(0,10))}`,cashierKeyboard());return adminSaasAccountView(env,chatId,a.id);} if(state.mode==='ADMIN_SAAS_REJECT'){const oid=state.data.order_id;await clearState(env,chatId);return rejectSaasOrder(env,chatId,oid,text||'-');} if(state.mode==='ADMIN_SAAS_COMPANY'){if(!text)return;await setState(env,chatId,'ADMIN_SAAS_USERNAME',{company_name:text});return sendMessage(env,chatId,'👤 أرسل اسم مستخدم للحساب:',cancelKeyboard(true));} if(state.mode==='ADMIN_SAAS_USERNAME'){if(!/^[A-Za-z0-9_]{4,30}$/.test(text))return sendMessage(env,chatId,'اسم مستخدم غير صالح.',cancelKeyboard(true));const ex=await env.DB.prepare('SELECT id FROM saas_accounts WHERE username=? COLLATE NOCASE').bind(text).first();if(ex)return sendMessage(env,chatId,'الاسم مستخدم.',cancelKeyboard(true));await setState(env,chatId,'ADMIN_SAAS_PASSWORD',{...state.data,username:text});return sendMessage(env,chatId,'🔑 أرسل كلمة المرور:',cancelKeyboard(true));} if(state.mode==='ADMIN_SAAS_PASSWORD'){if(text.length<6)return sendMessage(env,chatId,'6 أحرف على الأقل.',cancelKeyboard(true));try{if(msg.message_id)await telegram(env,'deleteMessage',{chat_id:String(chatId),message_id:msg.message_id});}catch{}const hp=await hashPassword(text);await setState(env,chatId,'ADMIN_SAAS_DAYS',{...state.data,password_salt:hp.salt,password_hash:hp.hash});return sendMessage(env,chatId,'📅 أرسل مدة التفعيل بالأيام، أو 0 لتجربة 24 ساعة:',cancelKeyboard(true));} if(state.mode==='ADMIN_SAAS_DAYS'){const d=parseInt(text,10);if(!Number.isFinite(d)||d<0||d>3650)return sendMessage(env,chatId,'أرسل 0 إلى 3650.',cancelKeyboard(true));const aid=id('acc'),start=now(),trial=addHoursIso(24),sub=d>0?addDaysFrom(start,d):null;await env.DB.prepare(`INSERT INTO saas_accounts(id,owner_chat_id,username,password_salt,password_hash,company_name,telegram_username,status,trial_started_at,trial_ends_at,subscription_ends_at,current_plan_name,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`).bind(aid,`ADMIN-${aid}`,state.data.username,state.data.password_salt,state.data.password_hash,state.data.company_name,d>0?'active':'trial',start,trial,sub,d>0?`تفعيل يدوي ${d} يوم`:null,start,start).run();await clearState(env,chatId);const a=await env.DB.prepare('SELECT * FROM saas_accounts WHERE id=?').bind(aid).first();await syncSaasCompanyToMaster(env,a).catch(()=>{});await sendMessage(env,chatId,`✅ تم إنشاء الشركة.\n🏢 ${e(a.company_name)}\n👤 ${e(a.username)}\n${d>0?`📅 ${d} يوم`:'🎁 تجربة 24 ساعة'}`,adminKeyboard());return adminSaasAccountView(env,chatId,a.id);} }

function masterSqlUrl(){ return MASTER_TURSO_URL.replace(/^libsql:\/\//i,'https://').replace(/\/+$/,'')+'/v2/pipeline'; }
function masterToken(env){ return String(env?.MASTER_TURSO_TOKEN||DEFAULT_MASTER_TURSO_TOKEN||'').trim(); }
function sqlArg(v){ if(v===null||v===undefined)return{type:'null'}; if(typeof v==='number')return Number.isInteger(v)?{type:'integer',value:String(v)}:{type:'float',value:v}; return{type:'text',value:String(v)}; }
async function masterExec(env,sql,args=[]){ const tk=masterToken(env); if(!tk)throw new Error('MASTER_TURSO_TOKEN missing'); const res=await fetch(masterSqlUrl(),{method:'POST',headers:{Authorization:`Bearer ${tk}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{type:'execute',stmt:{sql,args:args.map(sqlArg)}},{type:'close'}]})}); const tx=await res.text(); if(!res.ok)throw new Error(`Turso ${res.status}: ${tx.slice(0,160)}`); const d=JSON.parse(tx); const item=d?.results?.[0]; if(!item||item.type!=='ok')throw new Error(item?.error?.message||'Turso SQL error'); return item.response?.result; }
async function ensureMasterSaas(env){ await masterExec(env,`CREATE TABLE IF NOT EXISTS bot_saas_companies (account_id TEXT PRIMARY KEY, company_name TEXT NOT NULL, username TEXT NOT NULL, telegram_chat_id TEXT, status TEXT NOT NULL, trial_ends_at TEXT, subscription_ends_at TEXT, current_plan_name TEXT, updated_at TEXT NOT NULL)`); }
async function syncSaasCompanyToMaster(env,a){ await ensureMasterSaas(env); await masterExec(env,`INSERT INTO bot_saas_companies(account_id,company_name,username,telegram_chat_id,status,trial_ends_at,subscription_ends_at,current_plan_name,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET company_name=excluded.company_name,username=excluded.username,telegram_chat_id=excluded.telegram_chat_id,status=excluded.status,trial_ends_at=excluded.trial_ends_at,subscription_ends_at=excluded.subscription_ends_at,current_plan_name=excluded.current_plan_name,updated_at=excluded.updated_at`,[a.id,a.company_name,a.username,a.owner_chat_id,a.status,a.trial_ends_at,a.subscription_ends_at,a.current_plan_name,now()]); }

// Extend callbacks for order detail without bloating the main dispatcher.
const _handleCallback = handleCallback;
handleCallback = async function(env,chatId,data,q){
  const admin=await isAdmin(env,chatId,q.from);
  if(admin && data.startsWith('adminorder:')) return adminOrderView(env,chatId,data.slice(11));
  return _handleCallback(env,chatId,data,q);
};
