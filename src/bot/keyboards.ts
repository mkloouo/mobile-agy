import { InlineKeyboard } from 'grammy';
import { ConversationSummary, SearchResult } from '../services/conversationService';
import { RunningTask } from '../services/taskManager';
import { escapeHtml } from '../utils/telegramFormatter';
import { AVAILABLE_MODELS } from './types';

export function buildChatsUI(
    convCache: Map<string, ConversationSummary>,
    result: SearchResult,
    query: string
): { text: string; keyboard: InlineKeyboard } {
    const keyboard = new InlineKeyboard();

    if (result.items.length === 0) {
        return {
            text: query
                ? `No conversations found matching "<b>${escapeHtml(query)}</b>".`
                : 'No conversations found in history.',
            keyboard,
        };
    }

    for (const item of result.items) {
        convCache.set(item.conversationId, item);
        const shortId = item.conversationId.slice(0, 8);
        const label = item.title.length > 28 ? `${item.title.slice(0, 25)}...` : item.title;
        keyboard.text(`💬 ${label}`, `assign_chat:${shortId}`).row();
    }

    // Pagination buttons if more than one page
    if (result.totalPages > 1) {
        const prevPage = Math.max(0, result.page - 1);
        const nextPage = Math.min(result.totalPages - 1, result.page + 1);
        const encQuery = encodeURIComponent(query);

        if (result.page > 0) {
            keyboard.text('◀ Prev', `chats_p:${prevPage}:${encQuery}`);
        } else {
            keyboard.text('·', 'noop');
        }

        keyboard.text(`${result.page + 1} / ${result.totalPages}`, 'noop');

        if (result.page < result.totalPages - 1) {
            keyboard.text('Next ▶', `chats_p:${nextPage}:${encQuery}`);
        } else {
            keyboard.text('·', 'noop');
        }
        keyboard.row();
    }

    const titleHeader = query
        ? `<b>Conversations matching "${escapeHtml(query)}" (${result.totalCount}):</b>`
        : `<b>Select an existing conversation to assign to a topic (${result.totalCount} total):</b>`;

    return { text: titleHeader, keyboard };
}

export function buildProjectsUI(workspaces: string[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (let i = 0; i < workspaces.length; i++) {
        const ws = workspaces[i];
        keyboard.text(`📁 ${ws}`, `select_ws:${ws}`);
        if (i % 2 === 1) keyboard.row();
    }
    return keyboard;
}

export function buildModelKeyboard(currentModel: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const m of AVAILABLE_MODELS) {
        const isSelected = m.id === currentModel;
        const prefix = isSelected ? '✓ ' : '';
        keyboard.text(`${prefix}${m.label}`, `set_model:${m.id}`).row();
    }
    return keyboard;
}

export function buildStopKeyboard(runningTasks: RunningTask[]): InlineKeyboard | undefined {
    if (runningTasks.length === 0) return undefined;
    const keyboard = new InlineKeyboard();
    for (const t of runningTasks) {
        keyboard.text(`🛑 Stop ${t.name.split(' ')[0]} (${t.pid})`, `kill_proc:${t.pid}`).row();
    }
    return keyboard;
}
