import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cacheTokens: number;
    totalTokens: number;
    durationSeconds: number;
}

export interface ChatSession {
    id: number;
    channelId: string;
    workspacePath: string;
    conversationId: string;
    topicId?: number;
    createdAt: string;
    lastInputTokens: number;
    lastOutputTokens: number;
    lastThinkingTokens: number;
    lastCacheTokens: number;
    lastTotalTokens: number;
    lastDurationSeconds: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTurns: number;
    selectedModel?: string;
}

export class DatabaseManager {
    private readonly db: Database.Database;

    constructor(dbPath: string) {
        logger.info(`[DB] Opening SQLite database at ${dbPath}`);
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.initTables();
    }

    private initTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL UNIQUE,
                workspace_path TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                topic_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_input_tokens INTEGER DEFAULT 0,
                last_output_tokens INTEGER DEFAULT 0,
                last_thinking_tokens INTEGER DEFAULT 0,
                last_cache_tokens INTEGER DEFAULT 0,
                last_total_tokens INTEGER DEFAULT 0,
                last_duration_seconds REAL DEFAULT 0,
                total_input_tokens INTEGER DEFAULT 0,
                total_output_tokens INTEGER DEFAULT 0,
                total_turns INTEGER DEFAULT 0,
                selected_model TEXT
            );

            CREATE TABLE IF NOT EXISTS workspace_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL UNIQUE,
                workspace_path TEXT NOT NULL,
                topic_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS queued_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL,
                chat_id INTEGER NOT NULL,
                thread_id INTEGER,
                status_msg_id INTEGER NOT NULL,
                prompt TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        // Migrations for existing databases
        const columns = [
            'last_input_tokens INTEGER DEFAULT 0',
            'last_output_tokens INTEGER DEFAULT 0',
            'last_thinking_tokens INTEGER DEFAULT 0',
            'last_cache_tokens INTEGER DEFAULT 0',
            'last_total_tokens INTEGER DEFAULT 0',
            'last_duration_seconds REAL DEFAULT 0',
            'total_input_tokens INTEGER DEFAULT 0',
            'total_output_tokens INTEGER DEFAULT 0',
            'total_turns INTEGER DEFAULT 0',
            'selected_model TEXT',
        ];

        for (const col of columns) {
            try {
                this.db.exec(`ALTER TABLE chat_sessions ADD COLUMN ${col};`);
            } catch {
                // Column already exists
            }
        }
    }

    // Sessions
    public getSession(channelId: string): ChatSession | undefined {
        const stmt = this.db.prepare('SELECT * FROM chat_sessions WHERE channel_id = ?');
        const row = stmt.get(channelId) as any;
        if (!row) return undefined;
        return {
            id: row.id,
            channelId: row.channel_id,
            workspacePath: row.workspace_path,
            conversationId: row.conversation_id,
            topicId: row.topic_id,
            createdAt: row.created_at,
            lastInputTokens: row.last_input_tokens || 0,
            lastOutputTokens: row.last_output_tokens || 0,
            lastThinkingTokens: row.last_thinking_tokens || 0,
            lastCacheTokens: row.last_cache_tokens || 0,
            lastTotalTokens: row.last_total_tokens || 0,
            lastDurationSeconds: row.last_duration_seconds || 0,
            totalInputTokens: row.total_input_tokens || 0,
            totalOutputTokens: row.total_output_tokens || 0,
            totalTurns: row.total_turns || 0,
            selectedModel: row.selected_model || undefined,
        };
    }

    public setModel(channelId: string, model: string): void {
        const stmt = this.db.prepare(`
            INSERT INTO chat_sessions (channel_id, workspace_path, conversation_id, selected_model)
            VALUES (?, '', '', ?)
            ON CONFLICT(channel_id) DO UPDATE SET selected_model = excluded.selected_model
        `);
        stmt.run(channelId, model);
    }

    public getModel(channelId: string): string | undefined {
        const stmt = this.db.prepare('SELECT selected_model FROM chat_sessions WHERE channel_id = ?');
        const row = stmt.get(channelId) as any;
        return row?.selected_model || undefined;
    }

    public saveSession(channelId: string, workspacePath: string, conversationId: string, topicId?: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO chat_sessions (channel_id, workspace_path, conversation_id, topic_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET
                workspace_path = excluded.workspace_path,
                conversation_id = excluded.conversation_id,
                topic_id = excluded.topic_id
        `);
        stmt.run(channelId, workspacePath, conversationId, topicId ?? null);
    }

    public recordTurnUsage(channelId: string, stats: UsageStats): void {
        const stmt = this.db.prepare(`
            UPDATE chat_sessions SET
                last_input_tokens = ?,
                last_output_tokens = ?,
                last_thinking_tokens = ?,
                last_cache_tokens = ?,
                last_total_tokens = ?,
                last_duration_seconds = ?,
                total_input_tokens = COALESCE(total_input_tokens, 0) + ?,
                total_output_tokens = COALESCE(total_output_tokens, 0) + ?,
                total_turns = COALESCE(total_turns, 0) + 1
            WHERE channel_id = ?
        `);
        stmt.run(
            stats.inputTokens,
            stats.outputTokens,
            stats.thinkingTokens,
            stats.cacheTokens,
            stats.totalTokens,
            stats.durationSeconds,
            stats.inputTokens,
            stats.outputTokens,
            channelKeyNormalize(channelId)
        );
    }

    public updateConversationId(channelId: string, conversationId: string): void {
        const stmt = this.db.prepare('UPDATE chat_sessions SET conversation_id = ? WHERE channel_id = ?');
        stmt.run(conversationId, channelId);
    }

    public deleteSession(channelId: string): void {
        const stmt = this.db.prepare('DELETE FROM chat_sessions WHERE channel_id = ?');
        stmt.run(channelId);
    }

    // Workspaces
    public getWorkspaceBinding(channelId: string): string | undefined {
        const stmt = this.db.prepare('SELECT workspace_path FROM workspace_bindings WHERE channel_id = ?');
        const row = stmt.get(channelId) as any;
        return row ? row.workspace_path : undefined;
    }

    public bindWorkspace(channelId: string, workspacePath: string, topicId?: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO workspace_bindings (channel_id, workspace_path, topic_id)
            VALUES (?, ?, ?)
            ON CONFLICT(channel_id) DO UPDATE SET
                workspace_path = excluded.workspace_path,
                topic_id = excluded.topic_id
        `);
        stmt.run(channelId, workspacePath, topicId ?? null);
    }

    // Message Queue (persists across PM2 restarts)
    public enqueueMessage(channelId: string, chatId: number, threadId: number | undefined, statusMsgId: number, prompt: string): number {
        const stmt = this.db.prepare(`
            INSERT INTO queued_messages (channel_id, chat_id, thread_id, status_msg_id, prompt)
            VALUES (?, ?, ?, ?, ?)
        `);
        const info = stmt.run(channelId, chatId, threadId ?? null, statusMsgId, prompt);
        return Number(info.lastInsertRowid);
    }

    public getQueuedMessages(channelId: string): QueuedMessageRecord[] {
        const stmt = this.db.prepare(`
            SELECT id, channel_id as channelId, chat_id as chatId, thread_id as threadId,
                   status_msg_id as statusMsgId, prompt, created_at as createdAt
            FROM queued_messages
            WHERE channel_id = ?
            ORDER BY id ASC
        `);
        return stmt.all(channelId) as QueuedMessageRecord[];
    }

    public popNextQueuedMessage(channelId: string): QueuedMessageRecord | undefined {
        const selectStmt = this.db.prepare(`
            SELECT id, channel_id as channelId, chat_id as chatId, thread_id as threadId,
                   status_msg_id as statusMsgId, prompt, created_at as createdAt
            FROM queued_messages
            WHERE channel_id = ?
            ORDER BY id ASC
            LIMIT 1
        `);
        const item = selectStmt.get(channelId) as QueuedMessageRecord | undefined;
        if (item) {
            this.db.prepare('DELETE FROM queued_messages WHERE id = ?').run(item.id);
        }
        return item;
    }

    public clearQueue(channelId: string): number {
        const stmt = this.db.prepare('DELETE FROM queued_messages WHERE channel_id = ?');
        const info = stmt.run(channelId);
        return info.changes;
    }

    public getDistinctQueuedChannels(): string[] {
        const rows = this.db.prepare('SELECT DISTINCT channel_id FROM queued_messages ORDER BY id ASC').all() as any[];
        return rows.map((r) => r.channel_id);
    }

    public close(): void {
        this.db.close();
    }
}

export interface QueuedMessageRecord {
    id: number;
    channelId: string;
    chatId: number;
    threadId?: number;
    statusMsgId: number;
    prompt: string;
    createdAt: string;
}

function channelKeyNormalize(key: string): string {
    return key;
}
