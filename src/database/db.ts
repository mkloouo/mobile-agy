import Database from 'better-sqlite3';
import { logger } from '../utils/logger';
import { loadConfig } from '../utils/config';
import {
    DaemonSessionRecord,
    initDaemonSessionTable,
    upsertDaemonSession,
    getDaemonSession,
    getRecoverableDaemonSessions,
    markDaemonTurnDelivered,
    deleteDaemonSession,
} from './daemonSessionDb';
import {
    QueuedMessageRecord,
    initQueuedMessageTable,
    enqueueMessage,
    getQueuedMessages,
    popNextQueuedMessage,
    popQueuedMessageById,
    getQueuedMessageById,
    deleteQueuedMessage,
    updateQueuedPrompt,
    updateQueuedStatusMsgId,
    findQueuedMessageByUserMsgId,
    clearQueue,
    getDistinctQueuedChannels,
} from './queuedMessageDb';

export { DaemonSessionRecord, QueuedMessageRecord };

let dbInstance: DatabaseManager | null = null;

export function getDatabase(dbPath?: string): DatabaseManager {
    if (!dbInstance) {
        const resolvedPath = dbPath || loadConfig().dbPath;
        dbInstance = new DatabaseManager(resolvedPath);
    }
    return dbInstance;
}

export function setDatabase(db: DatabaseManager | null): void {
    dbInstance = db;
}

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
        dbInstance = this;
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

        `);

        initQueuedMessageTable(this.db);
        initDaemonSessionTable(this.db);

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
                topic_id = COALESCE(excluded.topic_id, chat_sessions.topic_id)
        `);
        stmt.run(channelId, workspacePath, conversationId, topicId ?? null);
    }

    public recordTurnUsage(channelId: string, stats: UsageStats): void {
        // Ensure chat_sessions row exists so token usage is never dropped
        this.db.prepare(`
            INSERT INTO chat_sessions (channel_id, workspace_path, conversation_id)
            VALUES (?, '', '')
            ON CONFLICT(channel_id) DO NOTHING
        `).run(channelId);

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
            channelId
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
                topic_id = COALESCE(excluded.topic_id, workspace_bindings.topic_id)
        `);
        stmt.run(channelId, workspacePath, topicId ?? null);
    }

    // Message Queue (persists across PM2 restarts)
    public enqueueMessage(channelId: string, chatId: number, threadId: number | undefined, statusMsgId: number, prompt: string, userMsgId?: number): number {
        return enqueueMessage(this.db, channelId, chatId, threadId, statusMsgId, prompt, userMsgId);
    }

    public getQueuedMessages(channelId: string): QueuedMessageRecord[] {
        return getQueuedMessages(this.db, channelId);
    }

    public popNextQueuedMessage(channelId: string): QueuedMessageRecord | undefined {
        return popNextQueuedMessage(this.db, channelId);
    }

    public popQueuedMessageById(id: number): QueuedMessageRecord | undefined {
        return popQueuedMessageById(this.db, id);
    }

    public getQueuedMessageById(id: number): QueuedMessageRecord | undefined {
        return getQueuedMessageById(this.db, id);
    }

    public deleteQueuedMessage(id: number): boolean {
        return deleteQueuedMessage(this.db, id);
    }

    public updateQueuedPrompt(id: number, prompt: string): boolean {
        return updateQueuedPrompt(this.db, id, prompt);
    }

    public updateQueuedStatusMsgId(id: number, statusMsgId: number): boolean {
        return updateQueuedStatusMsgId(this.db, id, statusMsgId);
    }

    public findQueuedMessageByUserMsgId(channelId: string, userMsgId: number, chatId?: number): QueuedMessageRecord | undefined {
        return findQueuedMessageByUserMsgId(this.db, channelId, userMsgId, chatId);
    }

    public clearQueue(channelId: string): number {
        return clearQueue(this.db, channelId);
    }

    public getDistinctQueuedChannels(): string[] {
        return getDistinctQueuedChannels(this.db);
    }

    // Daemon Sessions (persisted runner state)
    public upsertDaemonSession(session: DaemonSessionRecord): void {
        upsertDaemonSession(this.db, session);
    }

    public getDaemonSession(channelId: string): DaemonSessionRecord | undefined {
        return getDaemonSession(this.db, channelId);
    }

    public getRecoverableDaemonSessions(): DaemonSessionRecord[] {
        return getRecoverableDaemonSessions(this.db);
    }

    public markDaemonTurnDelivered(channelId: string, turnId?: string): void {
        markDaemonTurnDelivered(this.db, channelId, turnId);
    }

    public deleteDaemonSession(channelId: string): void {
        deleteDaemonSession(this.db, channelId);
    }

    public close(): void {
        if (dbInstance === this) {
            dbInstance = null;
        }
        this.db.close();
    }
}
