import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export interface ChatSession {
    id: number;
    channelId: string;
    workspacePath: string;
    conversationId: string;
    topicId?: number;
    createdAt: string;
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
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS workspace_bindings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL UNIQUE,
                workspace_path TEXT NOT NULL,
                topic_id INTEGER,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
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
        };
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

    public close(): void {
        this.db.close();
    }
}
