import Database from 'better-sqlite3';

export interface DaemonSessionRecord {
    channelId: string;
    workspacePath: string;
    conversationId: string;
    model?: string;
    socketPath: string;
    daemonPid: number;
    agyPid: number;
    isBusy: boolean;
    currentTurnId?: string;
    turnStartedAt?: number;
    turnStartTime?: number;
    statusMessageId?: number;
    chatId?: number;
    threadId?: number;
    accumulatedResponse?: string;
    turnDelivered: boolean;
    lastStatus?: string;
    lastDurationSeconds: number;
    createdAt: number;
    updatedAt: number;
}

export function initDaemonSessionTable(db: Database.Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS daemon_sessions (
            channel_id TEXT PRIMARY KEY,
            workspace_path TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            model TEXT,
            socket_path TEXT NOT NULL,
            daemon_pid INTEGER NOT NULL,
            agy_pid INTEGER NOT NULL,
            is_busy INTEGER NOT NULL DEFAULT 0,
            current_turn_id TEXT,
            turn_started_at INTEGER,
            status_message_id INTEGER,
            chat_id INTEGER,
            thread_id INTEGER,
            accumulated_response TEXT DEFAULT '',
            turn_delivered INTEGER NOT NULL DEFAULT 1,
            last_status TEXT,
            last_duration_seconds REAL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
}

export function mapDaemonRow(row: any): DaemonSessionRecord {
    return {
        channelId: row.channel_id,
        workspacePath: row.workspace_path,
        conversationId: row.conversation_id,
        model: row.model || undefined,
        socketPath: row.socket_path,
        daemonPid: row.daemon_pid,
        agyPid: row.agy_pid,
        isBusy: Boolean(row.is_busy),
        currentTurnId: row.current_turn_id || undefined,
        turnStartedAt: row.turn_started_at ? Number(row.turn_started_at) : undefined,
        turnStartTime: row.turn_started_at ? Number(row.turn_started_at) : undefined,
        statusMessageId: row.status_message_id ? Number(row.status_message_id) : undefined,
        chatId: row.chat_id ? Number(row.chat_id) : undefined,
        threadId: row.thread_id ? Number(row.thread_id) : undefined,
        accumulatedResponse: row.accumulated_response || '',
        turnDelivered: Boolean(row.turn_delivered),
        lastStatus: row.last_status || undefined,
        lastDurationSeconds: Number(row.last_duration_seconds || 0),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

export function upsertDaemonSession(db: Database.Database, session: DaemonSessionRecord): void {
    const stmt = db.prepare(`
        INSERT INTO daemon_sessions (
            channel_id, workspace_path, conversation_id, model, socket_path,
            daemon_pid, agy_pid, is_busy, current_turn_id, turn_started_at,
            status_message_id, chat_id, thread_id, accumulated_response, turn_delivered,
            last_status, last_duration_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
            workspace_path = excluded.workspace_path,
            conversation_id = excluded.conversation_id,
            model = excluded.model,
            socket_path = excluded.socket_path,
            daemon_pid = excluded.daemon_pid,
            agy_pid = excluded.agy_pid,
            is_busy = excluded.is_busy,
            current_turn_id = excluded.current_turn_id,
            turn_started_at = excluded.turn_started_at,
            status_message_id = excluded.status_message_id,
            chat_id = excluded.chat_id,
            thread_id = excluded.thread_id,
            accumulated_response = excluded.accumulated_response,
            turn_delivered = excluded.turn_delivered,
            last_status = excluded.last_status,
            last_duration_seconds = excluded.last_duration_seconds,
            updated_at = excluded.updated_at
    `);
    stmt.run(
        session.channelId,
        session.workspacePath,
        session.conversationId,
        session.model ?? null,
        session.socketPath,
        session.daemonPid,
        session.agyPid,
        session.isBusy ? 1 : 0,
        session.currentTurnId ?? null,
        session.turnStartedAt ?? session.turnStartTime ?? null,
        session.statusMessageId ?? null,
        session.chatId ?? null,
        session.threadId ?? null,
        session.accumulatedResponse ?? '',
        session.turnDelivered ? 1 : 0,
        session.lastStatus ?? null,
        session.lastDurationSeconds ?? 0,
        session.createdAt,
        session.updatedAt
    );
}

export function syncDaemonStateToDb(db: Database.Database, state: any): void {
    upsertDaemonSession(db, {
        channelId: state.sessionId,
        workspacePath: state.workspacePath,
        conversationId: state.conversationId,
        model: state.model,
        socketPath: state.socketPath,
        daemonPid: process.pid,
        agyPid: state.agyPid,
        isBusy: state.isBusy,
        currentTurnId: state.currentTurnId,
        turnStartTime: state.turnStartTime,
        statusMessageId: state.statusMessageId,
        chatId: state.chatId,
        threadId: state.threadId,
        accumulatedResponse: state.accumulatedResponse || '',
        turnDelivered: state.turnDelivered ?? true,
        lastStatus: state.lastResult?.status,
        lastDurationSeconds: state.lastResult?.duration_seconds || 0,
        createdAt: state.createdAt,
        updatedAt: Date.now(),
    });
}

export function getDaemonSession(db: Database.Database, channelId: string): DaemonSessionRecord | undefined {
    const row = db.prepare('SELECT * FROM daemon_sessions WHERE channel_id = ?').get(channelId) as any;
    return row ? mapDaemonRow(row) : undefined;
}

export function getRecoverableDaemonSessions(db: Database.Database): DaemonSessionRecord[] {
    const rows = db.prepare('SELECT * FROM daemon_sessions WHERE is_busy = 1 OR turn_delivered = 0').all() as any[];
    return rows.map(mapDaemonRow);
}

export function markDaemonTurnDelivered(db: Database.Database, channelId: string, turnId?: string): void {
    if (turnId) {
        db.prepare('UPDATE daemon_sessions SET turn_delivered = 1, updated_at = ? WHERE channel_id = ? AND current_turn_id = ?')
            .run(Date.now(), channelId, turnId);
    } else {
        db.prepare('UPDATE daemon_sessions SET turn_delivered = 1, updated_at = ? WHERE channel_id = ?')
            .run(Date.now(), channelId);
    }
}

export function deleteDaemonSession(db: Database.Database, channelId: string): void {
    db.prepare('DELETE FROM daemon_sessions WHERE channel_id = ?').run(channelId);
}
