import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Load .env if present
dotenv.config();

export interface AppConfig {
    telegramBotToken: string;
    allowedUserIds: number[];
    workspaceBaseDir: string;
    useTopics: boolean;
    autoApprove: boolean;
    defaultModel?: string;
    dbPath: string;
}

export function loadConfig(): AppConfig {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
        console.warn('[Config] Warning: TELEGRAM_BOT_TOKEN is not set in environment or .env');
    }

    const rawUserIds = process.env.ALLOWED_USER_IDS || '';
    const allowedUserIds = rawUserIds
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id));

    const workspaceBaseDir = process.env.WORKSPACE_BASE_DIR
        ? path.resolve(process.env.WORKSPACE_BASE_DIR)
        : path.resolve(process.cwd(), '..');

    const dbDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = process.env.DB_PATH || path.join(dbDir, 'antigravity.db');

    return {
        telegramBotToken: token,
        allowedUserIds,
        workspaceBaseDir,
        useTopics: process.env.USE_TOPICS !== 'false',
        autoApprove: process.env.AUTO_APPROVE !== 'false',
        defaultModel: process.env.DEFAULT_MODEL,
        dbPath,
    };
}
