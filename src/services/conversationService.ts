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

export interface SearchResult {
    items: ConversationSummary[];
    totalCount: number;
    totalPages: number;
    page: number;
}

export class ConversationService {
    private readonly dbPath: string;

    constructor() {
        this.dbPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    }

    public search(query: string = '', page: number = 0, pageSize: number = 6): SearchResult {
        if (!fs.existsSync(this.dbPath)) {
            logger.warn(`[ConversationService] Database not found at ${this.dbPath}`);
            return { items: [], totalCount: 0, totalPages: 0, page: 0 };
        }

        try {
            const db = new Database(this.dbPath, { readonly: true });
            const trimmed = query.trim();
            const sqlFilter = trimmed ? `WHERE title LIKE ? OR workspace_uris LIKE ?` : '';
            const params = trimmed ? [`%${trimmed}%`, `%${trimmed}%`] : [];

            const countStmt = db.prepare(`SELECT COUNT(*) as count FROM conversation_summaries ${sqlFilter}`);
            const countRow = countStmt.get(...params) as any;
            const totalCount = countRow ? countRow.count : 0;
            const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
            const safePage = Math.max(0, Math.min(page, totalPages - 1));

            const offset = safePage * pageSize;
            const stmt = db.prepare(`
                SELECT conversation_id, title, workspace_uris, datetime(last_modified_time) as last_modified
                FROM conversation_summaries
                ${sqlFilter}
                ORDER BY last_modified_time DESC
                LIMIT ? OFFSET ?
            `);
            const rows = stmt.all(...params, pageSize, offset) as any[];
            db.close();

            const items = rows.map((row) => {
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

            return { items, totalCount, totalPages, page: safePage };
        } catch (err: any) {
            logger.error('[ConversationService] Error searching conversation summaries:', err?.message || err);
            return { items: [], totalCount: 0, totalPages: 0, page: 0 };
        }
    }

    public listRecent(limit: number = 6): ConversationSummary[] {
        return this.search('', 0, limit).items;
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
