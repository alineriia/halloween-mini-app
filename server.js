const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const app = express();
const PORT = process.env.PORT || 10000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false });
app.use(express.json());
app.use(express.static(__dirname));
function validateTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData), hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (calculatedHash.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calculatedHash,"hex"), Buffer.from(hash,"hex"))) return null;
    const userRaw = params.get("user");
    return userRaw ? JSON.parse(userRaw) : null;
  } catch (e) { console.error("Telegram initData validation error:", e); return null; }
}
async function getUserFromTelegram(req) { return validateTelegramInitData(req.headers["x-telegram-init-data"]); }
app.get("/api/health", async (req,res) => { try { await pool.query("SELECT 1"); res.json({ok:true,database:"connected"}); } catch(e) { console.error(e); res.status(500).json({ok:false,database:"error"}); } });
app.post("/api/task", async (req,res) => {
  const telegramUser = await getUserFromTelegram(req);
  if (!telegramUser) return res.status(401).json({error:"Unauthorized",message:"Invalid Telegram initData"});
  const client = await pool.connect();
  try {
    const existing = await client.query(`SELECT u.telegram_id,u.username,u.admin_id,u.task_id,u.completed_tasks,a.name AS admin_name,a.photo AS admin_photo,t.task_text FROM users u LEFT JOIN admins a ON a.id=u.admin_id LEFT JOIN tasks t ON t.id=u.task_id WHERE u.telegram_id=$1`, [telegramUser.id]);
    if (existing.rows.length) {
      const u=existing.rows[0];
      if (!u.task_id) return res.json({success:true,completed:true,completedCount:u.completed_tasks.length,totalTasks:5});
      return res.json({success:true,completed:false,admin:{id:u.admin_id,name:u.admin_name,photo:u.admin_photo},task:{id:u.task_id,text:u.task_text},completedCount:u.completed_tasks.length,totalTasks:5});
    }
    const r=await client.query(`SELECT tasks.id,tasks.task_text,admins.id AS admin_id,admins.name AS admin_name,admins.photo AS admin_photo FROM tasks JOIN admins ON admins.id=tasks.admin_id WHERE tasks.active=TRUE AND admins.active=TRUE ORDER BY RANDOM() LIMIT 1`);
    if (!r.rows.length) return res.status(500).json({error:"No active tasks available"});
    const t=r.rows[0];
    await client.query(`INSERT INTO users(telegram_id,username,admin_id,task_id,completed_tasks) VALUES($1,$2,$3,$4,'{}')`,[telegramUser.id,telegramUser.username||null,t.admin_id,t.id]);
    res.json({success:true,completed:false,admin:{id:t.admin_id,name:t.admin_name,photo:t.admin_photo},task:{id:t.id,text:t.task_text},completedCount:0,totalTasks:5});
  } catch(e) { console.error("POST /api/task error:",e); res.status(500).json({error:"Server error"}); } finally { client.release(); }
});
app.post("/api/task/complete", async (req,res) => {
  const telegramUser=await getUserFromTelegram(req);
  if (!telegramUser) return res.status(401).json({error:"Unauthorized",message:"Invalid Telegram initData"});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const r=await client.query(`SELECT id,telegram_id,admin_id,task_id,completed_tasks FROM users WHERE telegram_id=$1 FOR UPDATE`,[telegramUser.id]);
    if (!r.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({error:"User not found"}); }
    const u=r.rows[0];
    if (!u.task_id) { await client.query("COMMIT"); return res.json({success:true,completed:true,completedCount:u.completed_tasks.length,totalTasks:5}); }
    const completedTasks=Array.from(new Set([...(u.completed_tasks||[]),u.task_id]));
    if (completedTasks.length>=5) {
      await client.query(`UPDATE users SET completed_tasks=$1,task_id=NULL WHERE id=$2`,[completedTasks,u.id]);
      await client.query("COMMIT");
      return res.json({success:true,completed:true,completedCount:5,totalTasks:5});
    }
    // NEW: next task is selected from ALL active admins, not the current admin.
    const next=await client.query(`SELECT tasks.id,tasks.task_text,admins.id AS admin_id,admins.name AS admin_name,admins.photo AS admin_photo FROM tasks JOIN admins ON admins.id=tasks.admin_id WHERE tasks.active=TRUE AND admins.active=TRUE AND NOT(tasks.id=ANY($1::int[])) ORDER BY RANDOM() LIMIT 1`,[completedTasks]);
    if (!next.rows.length) {
      await client.query(`UPDATE users SET completed_tasks=$1,task_id=NULL WHERE id=$2`,[completedTasks,u.id]);
      await client.query("COMMIT");
      return res.json({success:true,completed:true,completedCount:completedTasks.length,totalTasks:5});
    }
    const t=next.rows[0];
    await client.query(`UPDATE users SET admin_id=$1,task_id=$2,completed_tasks=$3 WHERE id=$4`,[t.admin_id,t.id,completedTasks,u.id]);
    await client.query("COMMIT");
    res.json({success:true,completed:false,admin:{id:t.admin_id,name:t.admin_name,photo:t.admin_photo},task:{id:t.id,text:t.task_text},completedCount:completedTasks.length,totalTasks:5});
  } catch(e) { try { await client.query("ROLLBACK"); } catch(_){} console.error("POST /api/task/complete error:",e); res.status(500).json({error:"Server error"}); } finally { client.release(); }
});
app.listen(PORT,()=>console.log(`Halloween Mini App server running on port ${PORT}`));
