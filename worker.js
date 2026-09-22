const BOT_TOKEN = "8743553964:AAFdDUy2isOSdgvc50ltCDrSVvlK9dOSu2U";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram Bot Worker is running ✅", {
        headers: { "Content-Type": "text/plain; charset=UTF-8" }
      });
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/webhook`;
      const result = await telegram("setWebhook", {
        url: webhookUrl,
        allowed_updates: ["message"],
        drop_pending_updates: false
      });

      return json({
        success: result.ok === true,
        webhook: webhookUrl,
        telegram: result
      });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const webhook = await telegram("getWebhookInfo", {});
      const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first();

      return json({
        status: "running",
        registered_users: Number(count?.count || 0),
        webhook
      });
    }

    if (request.method === "GET" && url.pathname === "/api/users") {
      const result = await env.DB.prepare(`
        SELECT id, chat_id, name, phone, photo_file_id, photo_url, created_at
        FROM users
        ORDER BY id DESC
      `).all();

      return json(result.results || []);
    }

    if (request.method === "POST" && url.pathname === "/api/delete-user") {
      const body = await request.json();
      const chatId = String(body.chat_id || "");

      if (!chatId) return json({ ok: false, error: "chat_id required" }, 400);

      await env.DB.prepare("DELETE FROM users WHERE chat_id = ?").bind(chatId).run();
      await env.DB.prepare("DELETE FROM user_states WHERE chat_id = ?").bind(chatId).run();

      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/send-notification") {
      const body = await request.json();
      const text = String(body.text || "").trim();
      const target = String(body.target || "ALL");

      if (!text) return json({ ok: false, error: "Message is empty" }, 400);

      const formattedText = `🔔 إشعار جديد:\n\n${text}`;

      if (target === "ALL") {
        const users = await env.DB.prepare(`
          SELECT chat_id FROM users ORDER BY id DESC
        `).all();

        let success = 0;
        let failed = 0;

        for (const user of users.results || []) {
          const result = await sendMessage(String(user.chat_id), formattedText);
          if (result?.ok) success++;
          else failed++;
        }

        return json({ ok: true, success, failed, total: success + failed });
      }

      return json(await sendMessage(target, formattedText));
    }

    if (request.method === "GET" && url.pathname === "/photo") {
      const fileId = url.searchParams.get("file_id");
      if (!fileId) return new Response("Missing file_id", { status: 400 });

      try {
        const fileData = await telegram("getFile", { file_id: fileId });

        if (!fileData.ok || !fileData.result?.file_path) {
          return new Response("Telegram image not found", { status: 404 });
        }

        const telegramFileUrl =
          `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;

        const imageResponse = await fetch(telegramFileUrl);
        if (!imageResponse.ok) {
          return new Response("Unable to load image", { status: 502 });
        }

        const headers = new Headers(imageResponse.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Cache-Control", "public, max-age=3600");

        return new Response(imageResponse.body, {
          status: imageResponse.status,
          headers
        });
      } catch (error) {
        console.error(error);
        return new Response("Image error", { status: 500 });
      }
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();

        if (update.message) {
          ctx.waitUntil(processMessage(update.message, env, url.origin));
        }

        return new Response("OK");
      } catch (error) {
        console.error("Webhook error:", error);
        return new Response("OK");
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function processMessage(msg, env, origin) {
  const chatId = String(msg.chat.id);
  const text = msg.text ? msg.text.trim() : "";
  const firstName = msg.from?.first_name || "مستخدم";

  let stateRow = await env.DB.prepare(`
    SELECT state, temp_name, temp_phone
    FROM user_states
    WHERE chat_id = ?
  `).bind(chatId).first();

  if (!stateRow) {
    await saveState(env, chatId, "IDLE", null, null);
    stateRow = { state: "IDLE", temp_name: null, temp_phone: null };
  }

  if (text === "/start" || text === "📝 تسجيل جديد") {
    await saveState(env, chatId, "WAITING_NAME", null, null);

    await sendMessage(
      chatId,
      `أهلاً بك يا ${firstName}! 👋\n\n📋 يرجى إرسال اسمك الثلاثي:`,
      { remove_keyboard: true }
    );
    return;
  }

  if (stateRow.state === "WAITING_NAME") {
    if (!text) {
      await sendMessage(chatId, "⚠️ يرجى إرسال اسمك الثلاثي كنص.");
      return;
    }

    await saveState(env, chatId, "WAITING_PHONE", text, null);

    await sendMessage(
      chatId,
      `أهلاً ${text} 👋\n\n📱 أرسل رقم جوالك الآن، أو اضغط الزر بالأسفل:`,
      {
        keyboard: [[{
          text: "📱 مشاركة رقم الجوال تلقائياً",
          request_contact: true
        }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    );
    return;
  }

  if (stateRow.state === "WAITING_PHONE") {
    const phone = msg.contact?.phone_number || text;

    if (!phone) {
      await sendMessage(chatId, "⚠️ يرجى إرسال رقم الجوال.");
      return;
    }

    await saveState(env, chatId, "WAITING_PHOTO", stateRow.temp_name, phone);

    await sendMessage(
      chatId,
      "ممتاز ✅\n\n📷 الآن أرسل صورتك الشخصية:",
      { remove_keyboard: true }
    );
    return;
  }

  if (stateRow.state === "WAITING_PHOTO") {
    if (!msg.photo || msg.photo.length === 0) {
      await sendMessage(chatId, "📷 يرجى إرسال صورة شخصية.");
      return;
    }

    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;
    const photoUrl = `${origin}/photo?file_id=${encodeURIComponent(fileId)}`;

    await env.DB.prepare(`
      INSERT INTO users (
        chat_id, name, phone, photo_file_id, photo_url, created_at
      )
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id)
      DO UPDATE SET
        name = excluded.name,
        phone = excluded.phone,
        photo_file_id = excluded.photo_file_id,
        photo_url = excluded.photo_url,
        created_at = CURRENT_TIMESTAMP
    `).bind(
      chatId,
      stateRow.temp_name,
      stateRow.temp_phone,
      fileId,
      photoUrl
    ).run();

    await saveState(env, chatId, "IDLE", null, null);

    await sendMessage(
      chatId,
      `✅ تم التسجيل بنجاح!\n\n👤 الاسم:\n${stateRow.temp_name}\n\n📞 رقم الجوال:\n${stateRow.temp_phone}`,
      {
        keyboard: [[{ text: "📝 تسجيل جديد" }]],
        resize_keyboard: true
      }
    );
    return;
  }

  await sendMessage(
    chatId,
    `أهلاً بك 👋\n\nاضغط على زر "📝 تسجيل جديد" للبدء.`,
    {
      keyboard: [[{ text: "📝 تسجيل جديد" }]],
      resize_keyboard: true
    }
  );
}

async function saveState(env, chatId, state, tempName, tempPhone) {
  await env.DB.prepare(`
    INSERT INTO user_states (
      chat_id, state, temp_name, temp_phone, updated_at
    )
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id)
    DO UPDATE SET
      state = excluded.state,
      temp_name = excluded.temp_name,
      temp_phone = excluded.temp_phone,
      updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, state, tempName, tempPhone).run();
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return await telegram("sendMessage", body);
}

async function telegram(method, data = {}) {
  const response = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });

  return await response.json();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
