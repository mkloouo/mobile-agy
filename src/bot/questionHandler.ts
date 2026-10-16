import { Context, InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import { BotServices } from './types';
import { AskQuestionItem, parseQuestions, findRecentAskQuestion } from './questionParser';
import { escapeHtml } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export * from './questionParser';
export * from './questionCallbacks';

export interface ActiveQuestionSession {
    id: string;
    channelKey: string;
    chatId: number;
    threadId?: number;
    workspacePath: string;
    questions: AskQuestionItem[];
    currentQuestionIndex: number;
    selectedIndices: Set<number>;
    customOptions?: string[];
    deselectedCustomIndices?: Set<number>;
    answers: string[];
    messageId?: number;
    customPromptMsgId?: number;
    awaitingCustomInput?: boolean;
    createdAt: number;
}

// In-memory store for active question sessions with 1-hour TTL
const activeSessions = new Map<string, ActiveQuestionSession>();

export function getActiveQuestionSessions(): Map<string, ActiveQuestionSession> {
    return activeSessions;
}

function cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [id, s] of activeSessions.entries()) {
        if (now - s.createdAt > 3600 * 1000) {
            activeSessions.delete(id);
        }
    }
}

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export function buildQuestionUI(session: ActiveQuestionSession): { text: string; keyboard: InlineKeyboard } {
    const qIndex = session.currentQuestionIndex;
    const currentQ = session.questions[qIndex];
    const totalQ = session.questions.length;

    const prefix = totalQ > 1 ? `<b>[Question ${qIndex + 1}/${totalQ}]</b>\n\n` : '';
    let text = `${prefix}❓ <b>${escapeHtml(currentQ.question)}</b>\n\n`;

    currentQ.options.forEach((opt, idx) => {
        const numBadge = NUMBER_EMOJIS[idx] || `${idx + 1}.`;
        text += `${numBadge} ${escapeHtml(opt)}\n`;
    });

    const customOpts = session.customOptions || [];
    if (customOpts.length > 0) {
        text += '\n<b>Custom options:</b>\n';
        customOpts.forEach((cOpt) => {
            text += `✍️ ${escapeHtml(cOpt)}\n`;
        });
    }

    if (currentQ.is_multi_select) {
        text += '\n<i>(Multi-select: toggle options then click Submit)</i>';
    }

    const keyboard = new InlineKeyboard();

    if (currentQ.is_multi_select) {
        currentQ.options.forEach((opt, idx) => {
            const isChecked = session.selectedIndices.has(idx);
            const checkMark = isChecked ? '☑️' : '◻️';
            let label = opt.trim();
            if (label.length > 32) label = label.slice(0, 29) + '...';
            keyboard.text(`${checkMark} ${label}`, `q_toggle:${session.id}:${idx}`).row();
        });

        customOpts.forEach((cOpt, cIdx) => {
            const isChecked = !session.deselectedCustomIndices?.has(cIdx);
            const checkMark = isChecked ? '☑️' : '◻️';
            let label = cOpt.trim();
            if (label.length > 30) label = label.slice(0, 27) + '...';
            keyboard.text(`${checkMark} ✍️ ${label}`, `q_toggle_c:${session.id}:${cIdx}`).row();
        });

        keyboard.text('✍️ Your option', `q_custom:${session.id}`).row();

        const selectedCount = session.selectedIndices.size + (customOpts.length - (session.deselectedCustomIndices?.size || 0));
        keyboard
            .text(`✅ Submit (${selectedCount})`, `q_submit:${session.id}`)
            .text('⏭️ Skip', `q_skip:${session.id}`);
    } else {
        currentQ.options.forEach((opt, idx) => {
            const numBadge = NUMBER_EMOJIS[idx] || `${idx + 1}.`;
            let label = opt.trim();
            if (label.length > 34) label = label.slice(0, 31) + '...';
            keyboard.text(`${numBadge} ${label}`, `q_select:${session.id}:${idx}`).row();
        });

        keyboard.text('✍️ Your option', `q_custom:${session.id}`).row();
        keyboard.text('⏭️ Skip question', `q_skip:${session.id}`);
    }

    return { text: text.trim(), keyboard };
}

export async function clearCustomPrompt(session: ActiveQuestionSession, services: BotServices): Promise<void> {
    if (session.customPromptMsgId) {
        try {
            await services.bot.api.deleteMessage(session.chatId, session.customPromptMsgId);
        } catch {}
        session.customPromptMsgId = undefined;
    }
    session.awaitingCustomInput = false;
}

export function findSessionForCustomInput(
    channelKey: string,
    replyToMsgId?: number
): ActiveQuestionSession | undefined {
    if (replyToMsgId) {
        for (const session of activeSessions.values()) {
            if (session.messageId === replyToMsgId || session.customPromptMsgId === replyToMsgId) {
                return session;
            }
        }
    }
    for (const session of activeSessions.values()) {
        if (session.channelKey === channelKey && session.awaitingCustomInput) {
            return session;
        }
    }
    return undefined;
}

export async function handleQuestionCustomInput(ctx: Context, services: BotServices): Promise<boolean> {
    const rawText = ctx.message?.text || ctx.message?.caption;
    if (!rawText || !rawText.trim()) return false;
    if (rawText.trim().startsWith('/')) return false;

    const channelKey = services.getChannelKey(ctx);
    const replyToMsgId = ctx.message?.reply_to_message?.message_id;

    const session = findSessionForCustomInput(channelKey, replyToMsgId);
    if (!session) return false;

    await clearCustomPrompt(session, services);
    const customText = rawText.trim();
    const currentQ = session.questions[session.currentQuestionIndex];

    if (currentQ.is_multi_select) {
        if (!session.customOptions) session.customOptions = [];
        session.customOptions.push(customText);

        const { text, keyboard } = buildQuestionUI(session);
        if (session.messageId) {
            try {
                await services.bot.api.editMessageText(
                    session.chatId,
                    session.messageId,
                    text,
                    { parse_mode: 'HTML', reply_markup: keyboard }
                );
            } catch {}
        }
        return true;
    }

    session.answers.push(customText);

    if (session.currentQuestionIndex + 1 < session.questions.length) {
        session.currentQuestionIndex++;
        session.selectedIndices.clear();
        session.customOptions = [];
        session.deselectedCustomIndices?.clear();
        const { text, keyboard } = buildQuestionUI(session);
        if (session.messageId) {
            try {
                await services.bot.api.editMessageText(
                    session.chatId,
                    session.messageId,
                    text,
                    { parse_mode: 'HTML', reply_markup: keyboard }
                );
            } catch {}
        }
    } else {
        await finalizeAnswer(session, services);
    }

    return true;
}

export async function presentQuestion(
    services: BotServices,
    channelKey: string,
    workspacePath: string,
    chatId: number,
    threadId: number | undefined,
    params: any
): Promise<number | undefined> {
    cleanupExpiredSessions();
    const questions = parseQuestions(params);
    if (questions.length === 0) return undefined;

    const id = crypto.randomBytes(4).toString('hex');
    const session: ActiveQuestionSession = {
        id,
        channelKey,
        chatId,
        threadId,
        workspacePath,
        questions,
        currentQuestionIndex: 0,
        selectedIndices: new Set<number>(),
        answers: [],
        createdAt: Date.now(),
    };

    activeSessions.set(id, session);
    const { text, keyboard } = buildQuestionUI(session);

    try {
        const msg = await services.bot.api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            message_thread_id: threadId,
            reply_markup: keyboard,
        });
        session.messageId = msg.message_id;
        return msg.message_id;
    } catch (err: any) {
        logger.error('[QuestionHandler] Failed to send question message:', err);
        activeSessions.delete(id);
        return undefined;
    }
}

export async function finalizeAnswer(session: ActiveQuestionSession, services: BotServices): Promise<void> {
    activeSessions.delete(session.id);
    await clearCustomPrompt(session, services);

    const formattedAnswers = session.answers
        .map((ans, idx) => session.questions.length > 1 ? `A${idx + 1}: ${ans}` : `A1: ${ans}`)
        .join('\n');

    const summaryText = session.answers
        .map((ans, idx) => {
            const q = session.questions[idx];
            return `❓ <b>${escapeHtml(q.question)}</b>\n👉 <i>${escapeHtml(ans)}</i>`;
        })
        .join('\n\n');

    try {
        if (session.messageId) {
            await services.bot.api.editMessageText(
                session.chatId,
                session.messageId,
                `✅ <b>Question answered:</b>\n\n${summaryText}`,
                { parse_mode: 'HTML' }
            );
        }
    } catch {}

    const statusMsg = await services.bot.api.sendMessage(
        session.chatId,
        '🧠 <i>Continuing with your selection...</i>',
        {
            parse_mode: 'HTML',
            message_thread_id: session.threadId,
        }
    );

    services.executeTurnWithStatus(
        session.channelKey,
        session.workspacePath,
        formattedAnswers,
        session.chatId,
        session.threadId,
        statusMsg.message_id
    ).catch((err) => {
        logger.error('[QuestionHandler] Error executing turn with answer:', err);
    });
}
