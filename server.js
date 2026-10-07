const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

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
// Перевірка Telegram Mini App
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

    try {
        return JSON.parse(userData);
    } catch {
        return null;
    }
}

// ==========================================
// Перевірка сервера + БД
// ==========================================

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');

        res.json({
            ok: true,
            database: 'connected'
        });

    } catch (error) {
        console.error('DATABASE ERROR:', error);

        res.status(500).json({
            ok: false,
            database: 'error'
        });
    }
});

// ==========================================
// Отримати поточне завдання
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
        // Перевіряємо, чи користувач уже існує
        // ------------------------------------------

        const existingUser = await pool.query(
            `
            SELECT
                u.id,
                u.telegram_id,
                u.username,
                u.admin_id,
                u.task_id,
                u.completed_tasks,
                a.name AS admin_name,
                a.photo AS admin_photo,
                t.task_text
            FROM users u
            LEFT JOIN admins a
                ON a.id = u.admin_id
            LEFT JOIN tasks t
                ON t.id = u.task_id
            WHERE u.telegram_id = $1
            `,
            [telegramId]
        );

        // ------------------------------------------
        // Користувач уже є
        // ------------------------------------------

        if (existingUser.rows.length > 0) {
            const user = existingUser.rows[0];

            return res.json({
                existing: true,

                completed: user.task_id === null,

                completedCount: user.completed_tasks.length,

                totalTasks: 5,

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
        // НОВИЙ КОРИСТУВАЧ
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
        // Перше випадкове завдання
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
                task_id,
                completed_tasks
            )
            VALUES ($1, $2, $3, $4, '{}')
            `,
            [
                telegramId,
                username,
                selectedAdmin.id,
                selectedTask.id
            ]
        );

        // ------------------------------------------
        // Повертаємо адміна + завдання
        // ------------------------------------------

        res.json({
            existing: false,

            completed: false,

            completedCount: 0,

            totalTasks: 5,

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
// ЗАВДАННЯ ВИКОНАНО
// ==========================================

app.post('/api/task/complete', async (req, res) => {
    const client = await pool.connect();

    try {
        const { initData } = req.body;

        const telegramUser = validateTelegramInitData(initData);

        if (!telegramUser) {
            return res.status(401).json({
                error: 'Невірні дані Telegram'
            });
        }

        const telegramId = telegramUser.id;

        await client.query('BEGIN');

        // ------------------------------------------
        // Знаходимо користувача
        // ------------------------------------------

        const userResult = await client.query(
            `
            SELECT
                id,
                admin_id,
                task_id,
                completed_tasks
            FROM users
            WHERE telegram_id = $1
            FOR UPDATE
            `,
            [telegramId]
        );

        if (userResult.rows.length === 0) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Користувача не знайдено'
            });
        }

        const user = userResult.rows[0];

        // ------------------------------------------
        // Якщо всі завдання вже виконані
        // ------------------------------------------

        if (user.task_id === null) {
            await client.query('ROLLBACK');

            return res.json({
                completed: true,
                completedCount: user.completed_tasks.length,
                totalTasks: 5,
                task: null
            });
        }

        // ------------------------------------------
        // Додаємо поточне завдання до виконаних
        // ------------------------------------------

        let completedTasks = Array.isArray(user.completed_tasks)
            ? user.completed_tasks
            : [];

        if (!completedTasks.includes(user.task_id)) {
            completedTasks.push(user.task_id);
        }

        // ------------------------------------------
        // Шукаємо наступне НЕВИКОНАНЕ завдання
        // ------------------------------------------

        const nextTaskResult = await client.query(
            `
            SELECT id, task_text
            FROM tasks
            WHERE admin_id = $1
              AND active = TRUE
              AND NOT (id = ANY($2::integer[]))
            ORDER BY RANDOM()
            LIMIT 1
            `,
            [
                user.admin_id,
                completedTasks
            ]
        );

        // ------------------------------------------
        // Більше завдань немає
        // ------------------------------------------

        if (nextTaskResult.rows.length === 0) {

            await client.query(
                `
                UPDATE users
                SET
                    task_id = NULL,
                    completed_tasks = $1
                WHERE id = $2
                `,
                [
                    completedTasks,
                    user.id
                ]
            );

            await client.query('COMMIT');

            return res.json({
                completed: true,
                completedCount: completedTasks.length,
                totalTasks: 5,
                task: null
            });
        }

        // ------------------------------------------
        // Є наступне завдання
        // ------------------------------------------

        const nextTask = nextTaskResult.rows[0];

        await client.query(
            `
            UPDATE users
            SET
                task_id = $1,
                completed_tasks = $2
            WHERE id = $3
            `,
            [
                nextTask.id,
                completedTasks,
                user.id
            ]
        );

        await client.query('COMMIT');

        res.json({
            completed: false,
            completedCount: completedTasks.length,
            totalTasks: 5,
            task: {
                id: nextTask.id,
                text: nextTask.task_text
            }
        });

    } catch (error) {

        await client.query('ROLLBACK');

        console.error('COMPLETE TASK ERROR:', error);

        res.status(500).json({
            error: 'Помилка сервера'
        });

    } finally {
        client.release();
    }
});

// ==========================================
// Запуск сервера
// ==========================================

app.listen(PORT, () => {
    console.log(
        `Halloween Mini App server running on port ${PORT}`
    );
});
