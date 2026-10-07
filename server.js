const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.static(__dirname));

function validateTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash.length !== hash.length ||
        !crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(hash, "hex"))) {
      return null;
    }

    const userRaw = params.get("user");
    if (!userRaw) return null;
    return JSON.parse(userRaw);
  } catch (error) {
    console.error("Telegram initData validation error:", error);
    return null;
  }
}

async function getUserFromTelegram(req) {
  // Supports both ways of sending initData.
  const initData = req.headers["x-telegram-init-data"] || req.body?.initData;
  return validateTelegramInitData(initData);
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({ ok: false, database: "error" });
  }
});

app.post("/api/task", async (req, res) => {
  const telegramUser = await getUserFromTelegram(req);
  if (!telegramUser) return res.status(401).json({ error: "Unauthorized", message: "Invalid Telegram initData" });

  const client = await pool.connect();
  try {
    const existing = await client.query(`
      SELECT u.telegram_id, u.username, u.admin_id, u.task_id, u.completed_tasks,
             a.name AS admin_name, a.photo AS admin_photo, t.task_text
      FROM users u
      LEFT JOIN admins a ON a.id = u.admin_id
      LEFT JOIN tasks t ON t.id = u.task_id
      WHERE u.telegram_id = $1
    `, [telegramUser.id]);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (!user.task_id) return res.json({ success: true, completed: true, completedCount: user.completed_tasks.length, totalTasks: 5 });
      return res.json({
        success: true, completed: false,
        admin: { id: user.admin_id, name: user.admin_name, photo: user.admin_photo },
        task: { id: user.task_id, text: user.task_text },
        completedCount: user.completed_tasks.length, totalTasks: 5
      });
    }

    const firstTask = await client.query(`
      SELECT tasks.id, tasks.task_text,
             admins.id AS admin_id, admins.name AS admin_name, admins.photo AS admin_photo
      FROM tasks JOIN admins ON admins.id = tasks.admin_id
      WHERE tasks.active = TRUE AND admins.active = TRUE
      ORDER BY RANDOM() LIMIT 1
    `);

    if (!firstTask.rows.length) return res.status(500).json({ error: "No active tasks available" });
    const task = firstTask.rows[0];

    await client.query(`
      INSERT INTO users (telegram_id, username, admin_id, task_id, completed_tasks)
      VALUES ($1, $2, $3, $4, '{}')
    `, [telegramUser.id, telegramUser.username || null, task.admin_id, task.id]);

    res.json({
      success: true, completed: false,
      admin: { id: task.admin_id, name: task.admin_name, photo: task.admin_photo },
      task: { id: task.id, text: task.task_text },
      completedCount: 0, totalTasks: 5
    });
  } catch (error) {
    console.error("POST /api/task error:", error);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

app.post("/api/task/complete", async (req, res) => {
  const telegramUser = await getUserFromTelegram(req);
  if (!telegramUser) return res.status(401).json({ error: "Unauthorized", message: "Invalid Telegram initData" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userResult = await client.query(`
      SELECT id, telegram_id, admin_id, task_id, completed_tasks
      FROM users WHERE telegram_id = $1 FOR UPDATE
    `, [telegramUser.id]);

    if (!userResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const user = userResult.rows[0];
    if (!user.task_id) {
      await client.query("COMMIT");
      return res.json({ success: true, completed: true, completedCount: user.completed_tasks.length, totalTasks: 5 });
    }

    const completedTasks = Array.from(new Set([...(user.completed_tasks || []), user.task_id]));

    if (completedTasks.length >= 5) {
      await client.query(`UPDATE users SET completed_tasks = $1, task_id = NULL WHERE id = $2`, [completedTasks, user.id]);
      await client.query("COMMIT");
      return res.json({ success: true, completed: true, completedCount: 5, totalTasks: 5 });
    }

    // NEW LOGIC: choose the next task from ALL active admins, not the current admin.
    const nextTaskResult = await client.query(`
      SELECT tasks.id, tasks.task_text,
             admins.id AS admin_id, admins.name AS admin_name, admins.photo AS admin_photo
      FROM tasks JOIN admins ON admins.id = tasks.admin_id
      WHERE tasks.active = TRUE
        AND admins.active = TRUE
        AND NOT (tasks.id = ANY($1::int[]))
      ORDER BY RANDOM() LIMIT 1
    `, [completedTasks]);

    if (!nextTaskResult.rows.length) {
      await client.query(`UPDATE users SET completed_tasks = $1, task_id = NULL WHERE id = $2`, [completedTasks, user.id]);
      await client.query("COMMIT");
      return res.json({ success: true, completed: true, completedCount: completedTasks.length, totalTasks: 5 });
    }

    const nextTask = nextTaskResult.rows[0];

    await client.query(`
      UPDATE users
      SET admin_id = $1, task_id = $2, completed_tasks = $3
      WHERE id = $4
    `, [nextTask.admin_id, nextTask.id, completedTasks, user.id]);

    await client.query("COMMIT");

    res.json({
      success: true, completed: false,
      admin: { id: nextTask.admin_id, name: nextTask.admin_name, photo: nextTask.admin_photo },
      task: { id: nextTask.id, text: nextTask.task_text },
      completedCount: completedTasks.length, totalTasks: 5
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("POST /api/task/complete error:", error);
    res.status(500).json({ error: "Server error" });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => console.log(`Halloween Mini App server running on port ${PORT}`));
