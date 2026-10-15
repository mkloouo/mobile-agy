import Database from 'better-sqlite3';

export interface QueuedMessageRecord {
    id: number;
    channelId: string;
    chatId: number;
    threadId?: number;
    statusMsgId: number;
    userMsgId?: number;
    prompt: string;
    createdAt: string;
}

export function initQueuedMessageTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS queued_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL,
            chat_id INTEGER NOT NULL,
            thread_id INTEGER,
            status_msg_id INTEGER NOT NULL,
            user_msg_id INTEGER,
            prompt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    try {
        db.exec('ALTER TABLE queued_messages ADD COLUMN user_msg_id INTEGER');
    } catch {}
}

function mapQueuedRow(row: any): QueuedMessageRecord {
    return {
        id: Number(row.id),
        channelId: String(row.channel_id),
        chatId: Number(row.chat_id),
        threadId: row.thread_id ? Number(row.thread_id) : undefined,
        statusMsgId: Number(row.status_msg_id),
        userMsgId: row.user_msg_id ? Number(row.user_msg_id) : undefined,
        prompt: String(row.prompt),
        createdAt: String(row.created_at),
    };
}

export function enqueueMessage(
    db: Database.Database,
    channelId: string,
    chatId: number,
    threadId: number | undefined,
    statusMsgId: number,
    prompt: string,
    userMsgId?: number
): number {
    const stmt = db.prepare(`
        INSERT INTO queued_messages (channel_id, chat_id, thread_id, status_msg_id, user_msg_id, prompt)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(channelId, chatId, threadId ?? null, statusMsgId, userMsgId ?? null, prompt);
    return Number(info.lastInsertRowid);
}

export function getQueuedMessages(db: Database.Database, channelId: string): QueuedMessageRecord[] {
    const rows = db.prepare(`
        SELECT id, channel_id, chat_id, thread_id, status_msg_id, user_msg_id, prompt, created_at
        FROM queued_messages
        WHERE channel_id = ?
        ORDER BY id ASC
    `).all(channelId) as any[];
    return rows.map(mapQueuedRow);
}

export function popNextQueuedMessage(db: Database.Database, channelId: string): QueuedMessageRecord | undefined {
    const popTx = db.transaction(() => {
        const row = db.prepare(`
            SELECT id, channel_id, chat_id, thread_id, status_msg_id, user_msg_id, prompt, created_at
            FROM queued_messages
            WHERE channel_id = ?
            ORDER BY id ASC
            LIMIT 1
        `).get(channelId) as any;

        if (row) {
            db.prepare('DELETE FROM queued_messages WHERE id = ?').run(row.id);
            return mapQueuedRow(row);
        }
        return undefined;
    });
    return popTx();
}

export function popQueuedMessageById(db: Database.Database, id: number): QueuedMessageRecord | undefined {
    const popTx = db.transaction(() => {
        const row = db.prepare(`
            SELECT id, channel_id, chat_id, thread_id, status_msg_id, user_msg_id, prompt, created_at
            FROM queued_messages
            WHERE id = ?
        `).get(id) as any;

        if (row) {
            db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id);
            return mapQueuedRow(row);
        }
        return undefined;
    });
    return popTx();
}

export function getQueuedMessageById(db: Database.Database, id: number): QueuedMessageRecord | undefined {
    const row = db.prepare(`
        SELECT id, channel_id, chat_id, thread_id, status_msg_id, user_msg_id, prompt, created_at
        FROM queued_messages
        WHERE id = ?
    `).get(id) as any;
    return row ? mapQueuedRow(row) : undefined;
}

export function deleteQueuedMessage(db: Database.Database, id: number): boolean {
    const stmt = db.prepare('DELETE FROM queued_messages WHERE id = ?');
    return stmt.run(id).changes > 0;
}

export function updateQueuedPrompt(db: Database.Database, id: number, prompt: string): boolean {
    const stmt = db.prepare('UPDATE queued_messages SET prompt = ? WHERE id = ?');
    return stmt.run(prompt, id).changes > 0;
}

export function updateQueuedStatusMsgId(db: Database.Database, id: number, statusMsgId: number): boolean {
    const stmt = db.prepare('UPDATE queued_messages SET status_msg_id = ? WHERE id = ?');
    return stmt.run(statusMsgId, id).changes > 0;
}

export function findQueuedMessageByUserMsgId(db: Database.Database, channelId: string, userMsgId: number): QueuedMessageRecord | undefined {
    const row = db.prepare(`
        SELECT id, channel_id, chat_id, thread_id, status_msg_id, user_msg_id, prompt, created_at
        FROM queued_messages
        WHERE channel_id = ? AND user_msg_id = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(channelId, userMsgId) as any;
    return row ? mapQueuedRow(row) : undefined;
}

export function clearQueue(db: Database.Database, channelId: string): number {
    const stmt = db.prepare('DELETE FROM queued_messages WHERE channel_id = ?');
    return stmt.run(channelId).changes;
}

export function getDistinctQueuedChannels(db: Database.Database): string[] {
    const rows = db.prepare('SELECT DISTINCT channel_id FROM queued_messages ORDER BY id ASC').all() as any[];
    return rows.map((r) => r.channel_id);
}
