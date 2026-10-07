const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// PostgreSQL
// ==========================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ==========================================
// Middleware
// ==========================================

app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// Перевірка Telegram Mini App initData
// ==========================================

function validateTelegramInitData(initData) {
    const botToken = process.env.BOT_TOKEN;

    if (!botToken || !initData) {
        return null;
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if (!hash) {
        return null;
    }

    params.delete('hash');

    const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

    const calculatedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) {
        return null;
    }

    const userData = params.get('user');

    if (!userData) {
        return null;
    }

    return JSON.parse(userData);
}

// ==========================================
// Тест сервера
// ==========================================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');

        res.json({
            ok: true,
            database: 'connected'
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            ok: false,
            database: 'error'
        });
    }
});

// ==========================================
// Отримати завдання користувача
// ==========================================

app.post('/api/task', async (req, res) => {

    try {

        const { initData } = req.body;

        const telegramUser = validateTelegramInitData(initData);

        if (!telegramUser) {
            return res.status(401).json({
                error: 'Невірні дані Telegram'
            });
        }

        const telegramId = telegramUser.id;
        const username = telegramUser.username || null;

        // ------------------------------------------
        // Чи є вже цей користувач?
        // ------------------------------------------

        const existingUser = await pool.query(
            `
            SELECT
                users.id,
                users.telegram_id,
                users.username,
                users.admin_id,
                users.task_id,
                admins.name AS admin_name,
                admins.photo AS admin_photo,
                tasks.task_text
            FROM users
            LEFT JOIN admins
                ON admins.id = users.admin_id
            LEFT JOIN tasks
                ON tasks.id = users.task_id
            WHERE users.telegram_id = $1
            `,
            [telegramId]
        );

        // ------------------------------------------
        // Користувач вже існує
        // ------------------------------------------

        if (existingUser.rows.length > 0) {

            const user = existingUser.rows[0];

            return res.json({
                existing: true,
                completed: !user.task_id,
                admin: user.admin_id
                    ? {
                        id: user.admin_id,
                        name: user.admin_name,
                        photo: user.admin_photo
                    }
                    : null,
                task: user.task_id
                    ? {
                        id: user.task_id,
                        text: user.task_text
                    }
                    : null
            });
        }

        // ------------------------------------------
        // Новий користувач
        // ------------------------------------------

        const adminsResult = await pool.query(
            `
            SELECT id, name, photo
            FROM admins
            WHERE active = TRUE
            ORDER BY RANDOM()
            LIMIT 1
            `
        );

        if (adminsResult.rows.length === 0) {
            return res.status(500).json({
                error: 'Немає доступних адмінів'
            });
        }

        const selectedAdmin = adminsResult.rows[0];

        // ------------------------------------------
        // Вибираємо перше випадкове завдання
        // ------------------------------------------

        const taskResult = await pool.query(
            `
            SELECT id, task_text
            FROM tasks
            WHERE admin_id = $1
              AND active = TRUE
            ORDER BY RANDOM()
            LIMIT 1
            `,
            [selectedAdmin.id]
        );

        if (taskResult.rows.length === 0) {
            return res.status(500).json({
                error: 'У цього адміна немає завдань'
            });
        }

        const selectedTask = taskResult.rows[0];

        // ------------------------------------------
        // Зберігаємо користувача
        // ------------------------------------------

        await pool.query(
            `
            INSERT INTO users (
                telegram_id,
                username,
                admin_id,
                task_id
            )
            VALUES ($1, $2, $3, $4)
            `,
            [
                telegramId,
                username,
                selectedAdmin.id,
                selectedTask.id
            ]
        );

        // ------------------------------------------
        // Відповідь
        // ------------------------------------------

        res.json({
            existing: false,
            completed: false,
            admin: {
                id: selectedAdmin.id,
                name: selectedAdmin.name,
                photo: selectedAdmin.photo
            },
            task: {
                id: selectedTask.id,
                text: selectedTask.task_text
            }
        });

    } catch (error) {

        console.error('TASK ERROR:', error);

        res.status(500).json({
            error: 'Помилка сервера'
        });
    }
});


// ==========================================
// Завдання виконано
// ==========================================

app.post('/api/task/complete', async (req, res) => {

    try {

        const { initData } = req.body;

        const telegramUser = validateTelegramInitData(initData);

        if (!telegramUser) {
            return res.status(401).json({
                error: 'Невірні дані Telegram'
            });
        }

        const telegramId = telegramUser.id;

        // Тут додамо логіку наступного завдання
        // після того, як перевіримо підключення.

        res.json({
            ok: true,
            message: 'Кнопка працює'
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: 'Помилка сервера'
        });
    }
});


// ==========================================
// Запуск
// ==========================================

app.listen(PORT, () => {
    console.log(`Halloween Mini App server running on port ${PORT}`);
});
