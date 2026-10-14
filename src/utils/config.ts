import path from 'path';
import fs from 'fs';
import os from 'os';
import dotenv from 'dotenv';

// Potential config locations
const packageEnv = path.resolve(__dirname, '..', '..', '.env');
const cwdEnv = path.resolve(process.cwd(), '.env');
const userConfigDir = path.join(os.homedir(), '.config', 'mobile-agy');
const userEnv = path.join(userConfigDir, '.env');

// Load environment in priority order: cwd -> package dir -> user config dir
if (fs.existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
} else if (fs.existsSync(packageEnv)) {
    dotenv.config({ path: packageEnv });
} else if (fs.existsSync(userEnv)) {
    dotenv.config({ path: userEnv });
}

export interface AppConfig {
    telegramBotToken: string;
    allowedUserIds: number[];
    workspaceBaseDir: string;
    useTopics: boolean;
    autoApprove: boolean;
    defaultModel?: string;
    dbPath: string;
    idleTimeoutSeconds: number;
}

export function getConfigFilePath(): string {
    if (fs.existsSync(cwdEnv)) return cwdEnv;
    if (fs.existsSync(packageEnv)) return packageEnv;
    if (fs.existsSync(userEnv)) return userEnv;
    return userEnv;
}

export function loadConfig(): AppConfig {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';

    const rawUserIds = process.env.ALLOWED_USER_IDS || '';
    const allowedUserIds = rawUserIds
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id));

    let defaultBase = path.join(os.homedir(), 'Projects');
    if (!fs.existsSync(defaultBase)) {
        defaultBase = path.resolve(__dirname, '..', '..', '..');
    }

    const workspaceBaseDir = process.env.WORKSPACE_BASE_DIR
        ? path.resolve(process.env.WORKSPACE_BASE_DIR)
        : defaultBase;

    if (!fs.existsSync(userConfigDir)) {
        fs.mkdirSync(userConfigDir, { recursive: true });
    }

    const dbPath = process.env.DB_PATH || path.join(userConfigDir, 'antigravity.db');
    const idleTimeoutSeconds = parseInt(process.env.IDLE_TIMEOUT_SECONDS || '300', 10) || 300;

    return {
        telegramBotToken: token,
        allowedUserIds,
        workspaceBaseDir,
        useTopics: process.env.USE_TOPICS !== 'false',
        autoApprove: process.env.AUTO_APPROVE !== 'false',
        defaultModel: process.env.DEFAULT_MODEL || 'gemini-3.8-flash-medium',
        dbPath,
        idleTimeoutSeconds,
    };
}
