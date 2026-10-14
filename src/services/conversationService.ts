import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface ConversationSummary {
    conversationId: string;
    title: string;
    workspacePath: string;
    lastModified: string;
}

export class ConversationService {
    private readonly dbPath: string;

    constructor() {
        this.dbPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    }

    public listRecent(limit: number = 8): ConversationSummary[] {
        if (!fs.existsSync(this.dbPath)) {
            logger.warn(`[ConversationService] Database not found at ${this.dbPath}`);
            return [];
        }

        try {
            const db = new Database(this.dbPath, { readonly: true });
            const stmt = db.prepare(`
                SELECT conversation_id, title, workspace_uris, datetime(last_modified_time) as last_modified
                FROM conversation_summaries
                ORDER BY last_modified_time DESC
                LIMIT ?
            `);
            const rows = stmt.all(limit) as any[];
            db.close();

            return rows.map((row) => {
                let wsPath = '';
                try {
                    const parsed = JSON.parse(row.workspace_uris);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        wsPath = parsed[0].replace('file://', '');
                    }
                } catch {
                    wsPath = '';
                }

                return {
                    conversationId: row.conversation_id,
                    title: (row.title || 'Untitled Chat').replace(/^"(.*)"$/, '$1'),
                    workspacePath: wsPath,
                    lastModified: row.last_modified,
                };
            });
        } catch (err: any) {
            logger.error('[ConversationService] Error querying conversation summaries:', err?.message || err);
            return [];
        }
    }

    public getSummary(conversationId: string): ConversationSummary | undefined {
        if (!fs.existsSync(this.dbPath)) return undefined;

        try {
            const db = new Database(this.dbPath, { readonly: true });
            const stmt = db.prepare(`
                SELECT conversation_id, title, workspace_uris, datetime(last_modified_time) as last_modified
                FROM conversation_summaries
                WHERE conversation_id = ?
            `);
            const row = stmt.get(conversationId) as any;
            db.close();

            if (!row) return undefined;

            let wsPath = '';
            try {
                const parsed = JSON.parse(row.workspace_uris);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    wsPath = parsed[0].replace('file://', '');
                }
            } catch {
                wsPath = '';
            }

            return {
                conversationId: row.conversation_id,
                title: (row.title || 'Untitled Chat').replace(/^"(.*)"$/, '$1'),
                workspacePath: wsPath,
                lastModified: row.last_modified,
            };
        } catch (err: any) {
            logger.error(`[ConversationService] Error getting summary for ${conversationId}:`, err?.message || err);
            return undefined;
        }
    }
}
