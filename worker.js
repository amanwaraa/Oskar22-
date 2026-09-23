const DEFAULT_BOT_TOKEN = "8743553964:AAFdDUy2isOSdgvc50ltCDrSVvlK9dOSu2U";
const BOT_VERSION = '4.0.0-oscar-p2p-store';
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
  const cfg = await env.DB.prepare('SELECT id FROM store_config WHERE id=1').first();
  if(!cfg) await env.DB.prepare(`INSERT INTO store_config(id,store_name,welcome_text,support_username,owner_username,owner_chat_id,banner_file_id,updated_at) VALUES(1,?,?,?,?,?,?,?)`)
    .bind('متجر أوسكار البرمجي','اختر البرنامج المناسب لك وادفع بالطريقة التي تناسبك، ثم أرسل إثبات الدفع وسيتم مراجعة طلبك.',DEFAULT_ADMIN_USERNAME,DEFAULT_ADMIN_USERNAME,null,null,now()).run();
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

function userKeyboard(){ return {keyboard:[[{text:'🛍 تصفح البرامج'},{text:'📦 طلباتي'}],[{text:'💳 طرق الدفع'},{text:'☎️ الدعم'}]],resize_keyboard:true,is_persistent:true}; }
function adminKeyboard(){ return {keyboard:[[{text:'🛡 لوحة الإدارة'},{text:'🛍 واجهة المتجر'}],[{text:'📦 البرامج'},{text:'💳 طرق الدفع'}],[{text:'🧾 الطلبات'},{text:'⚙️ إعدادات المتجر'}]],resize_keyboard:true,is_persistent:true}; }
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

  if(text==='/start'||text==='🏠 الرئيسية'||text==='🛍 واجهة المتجر') return showHome(env,chatId,msg.from,admin);
  if(text==='/shop'||text==='🛍 تصفح البرامج') return showProducts(env,chatId,0,admin);
  if(text==='/orders'||text==='📦 طلباتي') return showMyOrders(env,chatId,admin);
  if(text==='💳 طرق الدفع' && !admin) return showPaymentMethods(env,chatId,false);
  if(text==='☎️ الدعم') return showSupport(env,chatId,admin);
  if((text==='/admin'||text==='🛡 لوحة الإدارة') && admin) return showAdminHome(env,chatId);
  if(text==='📦 البرامج' && admin) return adminProducts(env,chatId);
  if(text==='💳 طرق الدفع' && admin) return adminPayments(env,chatId);
  if(text==='🧾 الطلبات' && admin) return adminOrders(env,chatId);
  if(text==='⚙️ إعدادات المتجر' && admin) return adminSettings(env,chatId);
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
  const cfg=await getConfig(env); const name=e(from?.first_name||'صديقي');
  const text=`👋 <b>أهلاً ${name}</b>\n\n<b>${e(cfg.store_name)}</b>\n${e(cfg.welcome_text)}\n\n✨ اختر من الأزرار أسفل الشاشة.`;
  const kb=admin?adminKeyboard():userKeyboard();
  if(cfg.banner_file_id) return sendPhoto(env,chatId,cfg.banner_file_id,text,ik([[{text:'🛍 تصفح البرامج',callback_data:'shop:0'}],[{text:'💬 الدعم',url:`https://t.me/${cleanUsername(cfg.support_username||DEFAULT_ADMIN_USERNAME)}`}]]));
  return sendMessage(env,chatId,text,kb);
}

async function showProducts(env,chatId,index=0,admin=false){
  const rows=await env.DB.prepare('SELECT * FROM store_products WHERE active=1 ORDER BY sort_order ASC, created_at ASC').all();
  const products=rows.results||[];
  if(!products.length) return sendMessage(env,chatId,'🛍 <b>البرامج</b>\n\nلا توجد برامج مضافة حالياً.',admin?adminKeyboard():userKeyboard());
  const i=Math.max(0,Math.min(Number(index)||0,products.length-1)); const p=products[i];
  const cap=`✨ <b>${e(p.name)}</b>\n\n${e(p.description||'')}\n\n💰 <b>${money(p.price)} ${e(p.currency)}</b>\n📦 البرنامج ${i+1} من ${products.length}`;
  const nav=[]; if(i>0) nav.push({text:'◀️ السابق',callback_data:`shop:${i-1}`}); if(i<products.length-1) nav.push({text:'التالي ▶️',callback_data:`shop:${i+1}`});
  const buttons=[[{text:'🛒 شراء الآن',callback_data:`buy:${p.id}`}]]; if(nav.length) buttons.push(nav); buttons.push([{text:'🏠 الرئيسية',callback_data:'home'}]);
  if(p.photo_file_id) return sendPhoto(env,chatId,p.photo_file_id,cap,ik(buttons));
  return sendMessage(env,chatId,cap,ik(buttons));
}

async function showPaymentMethods(env,chatId,admin=false){
  const rows=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE active=1 ORDER BY sort_order ASC, created_at ASC').all();
  if(!(rows.results||[]).length) return sendMessage(env,chatId,'💳 لا توجد طرق دفع متاحة حالياً.',admin?adminKeyboard():userKeyboard());
  const buttons=(rows.results||[]).map(m=>[{text:`💳 ${m.name}`,callback_data:`payview:${m.id}`}]); buttons.push([{text:'🏠 الرئيسية',callback_data:'home'}]);
  return sendMessage(env,chatId,'💳 <b>طرق الدفع المتاحة</b>\n\nاختر طريقة لعرض بياناتها:',ik(buttons));
}

async function showSupport(env,chatId,admin=false){
  const cfg=await getConfig(env); const u=cleanUsername(cfg.support_username||DEFAULT_ADMIN_USERNAME);
  return sendMessage(env,chatId,`☎️ <b>الدعم والمبيعات</b>\n\nللتواصل المباشر مع صاحب المتجر:\n@${e(u)}`,ik([[{text:'💬 فتح المحادثة',url:`https://t.me/${u}`}],[{text:'🏠 الرئيسية',callback_data:'home'}]]));
}

async function beginBuy(env,chatId,productId){
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=? AND active=1').bind(productId).first();
  if(!p) return sendMessage(env,chatId,'⚠️ هذا البرنامج غير متاح حالياً.',userKeyboard());
  const rows=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE active=1 ORDER BY sort_order ASC,created_at ASC').all();
  const methods=rows.results||[];
  if(!methods.length) return sendMessage(env,chatId,'⚠️ لا توجد طريقة دفع مفعلة حالياً. تواصل مع الدعم.',userKeyboard());
  const buttons=methods.map(m=>[{text:`💳 ${m.name}`,callback_data:`choosepay:${productId}:${m.id}`}]); buttons.push([{text:'↩️ رجوع للبرامج',callback_data:'shop:0'}]);
  return sendMessage(env,chatId,`🛒 <b>شراء ${e(p.name)}</b>\n💰 السعر: <b>${money(p.price)} ${e(p.currency)}</b>\n\nاختر طريقة الدفع:`,ik(buttons));
}

async function showCheckout(env,chatId,productId,methodId){
  const p=await env.DB.prepare('SELECT * FROM store_products WHERE id=? AND active=1').bind(productId).first();
  const m=await env.DB.prepare('SELECT * FROM store_payment_methods WHERE id=? AND active=1').bind(methodId).first();
  if(!p||!m) return sendMessage(env,chatId,'⚠️ البرنامج أو طريقة الدفع غير متاحة الآن.',userKeyboard());
  await setState(env,chatId,'AWAIT_PROOF',{product_id:p.id,payment_method_id:m.id});
  const text=`💳 <b>${e(m.name)}</b>\n\n${e(m.details)}\n\n🛍 البرنامج: <b>${e(p.name)}</b>\n💰 المطلوب: <b>${money(p.price)} ${e(p.currency)}</b>\n\nبعد الدفع اضغط الزر ثم أرسل <b>صورة إثبات الدفع</b>.`;
  const buttons=ik([[{text:'✅ دفعت — إرسال الإثبات',callback_data:`proof:${p.id}:${m.id}`}],[{text:'❌ إلغاء',callback_data:'home'}]]);
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
  if(admin){
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
  const txt=`💳 <b>${e(m.name)}</b>\n\n${e(m.details)}`; const buttons=admin?ik([[{text:'✏️ تعديل',callback_data:`payment:edit:${m.id}`}],[{text:'↩️ رجوع',callback_data:'admin:payments'}]]):ik([[{text:'🏠 الرئيسية',callback_data:'home'}]]);
  if(m.photo_file_id) return sendPhoto(env,chatId,m.photo_file_id,txt,buttons); return sendMessage(env,chatId,txt,buttons);
}

async function showAdminHome(env,chatId){
  await clearState(env,chatId); const cfg=await getConfig(env);
  const pending=await env.DB.prepare("SELECT COUNT(*) c FROM store_orders WHERE status='pending'").first();
  return sendMessage(env,chatId,`🛡 <b>لوحة إدارة ${e(cfg.store_name)}</b>\n\n🧾 طلبات بانتظار المراجعة: <b>${Number(pending?.c||0)}</b>\n\nاختر القسم من الأزرار أسفل الشاشة.`,adminKeyboard());
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

// Extend callbacks for order detail without bloating the main dispatcher.
const _handleCallback = handleCallback;
handleCallback = async function(env,chatId,data,q){
  const admin=await isAdmin(env,chatId,q.from);
  if(admin && data.startsWith('adminorder:')) return adminOrderView(env,chatId,data.slice(11));
  return _handleCallback(env,chatId,data,q);
};
