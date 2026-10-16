import fs from 'fs';
import { Context, InlineKeyboard } from 'grammy';
import { BotServices } from './types';
import { handleShellCommand } from './shell';
import { handleMediaGroupMessage } from './mediaGroup';
import { handlePastedText } from './pasteBatcher';
import { downloadTelegramPhoto, downloadTelegramFile } from '../utils/imageHandler';
import { escapeHtml, formatPromptQuote } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export const ANTIGRAVITY_SLASH_COMMANDS = new Set([
    'plan',
    'goal',
    'learn',
    'grill-me',
    'boost',
    'browser',
    'schedule',
    'teamwork-preview',
    'compact',
    'caveman',
    'ponytail',
    'review',
    'audit',
    'help',
    'debt',
    'gain',
    'btw',
]);

export function isAllowedSlashCommand(cmdName: string): boolean {
    if (ANTIGRAVITY_SLASH_COMMANDS.has(cmdName)) return true;
    if (cmdName.startsWith('ponytail-') || cmdName.startsWith('agy-') || cmdName.startsWith('antigravity-')) {
        return true;
    }
    return false;
}

async function dispatchPrompt(ctx: Context, initialPrompt: string, services: BotServices): Promise<void> {
    const threadId = ctx.message?.message_thread_id;
    let userPrompt = initialPrompt;

    // Context from replied-to message (if user used Telegram reply)
    const replyTo = ctx.message?.reply_to_message;
    if (replyTo) {
        const replyText = replyTo.text || replyTo.caption || '';
        const isBot = replyTo.from?.is_bot;
        const senderName = isBot ? 'Antigravity' : (replyTo.from?.first_name || 'User');

        if (replyTo.photo && replyTo.photo.length > 0 && (!ctx.message?.photo || ctx.message.photo.length === 0)) {
            const largestPhoto = replyTo.photo[replyTo.photo.length - 1];
            try {
                const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
                userPrompt = `${userPrompt}\n[Attached screenshot from replied message: ${localPath}]`.trim();
            } catch (err: any) {
                logger.debug('[Bot] Could not download photo from replied message:', err);
            }
        }

        if (replyText.trim()) {
            let quoted = replyText.trim();
            if (quoted.length > 2000) {
                quoted = quoted.slice(0, 1000) + '\n... [truncated] ...\n' + quoted.slice(-800);
            }
            userPrompt = `[In reply to ${senderName}]:\n"""\n${quoted}\n"""\n\n${userPrompt}`;
        }
    }

    if (!userPrompt.trim()) {
        return;
    }

    const channelKey = services.getChannelKey(ctx);

    if (services.agyService.isBusy(channelKey)) {
        const queue = services.db.getQueuedMessages(channelKey);
        const queuePos = queue.length + 1;
        const userMsgId = ctx.message?.message_id;

        const queueId = services.db.enqueueMessage(
            channelKey,
            ctx.chat!.id,
            threadId,
            0,
            userPrompt,
            userMsgId
        );

        const keyboard = new InlineKeyboard()
            .text('⚡ Force Now', `q_force:${queueId}`)
            .text('🗑️ Delete', `q_del:${queueId}`)
            .row()
            .text('📋 Show Queue', 'show_queue');

        const preview = userPrompt.length > 50 ? `${userPrompt.slice(0, 47)}...` : userPrompt;

        const queuedMsg = await ctx.reply(
            `📥 <b>Queued (#${queuePos})</b> — will run automatically when current task finishes.\n\n<code>${escapeHtml(preview)}</code>`,
            { parse_mode: 'HTML', message_thread_id: threadId, reply_markup: keyboard }
        );

        services.db.updateQueuedStatusMsgId(queueId, queuedMsg.message_id);
        return;
    }

    const workspacePath = services.resolveWorkspace(channelKey);

    const quoteHeader = formatPromptQuote(userPrompt);
    const initialStatus = await ctx.reply(`${quoteHeader}🧠 <i>Antigravity is thinking...</i>`, {
        parse_mode: 'HTML',
        message_thread_id: threadId,
    });

    services.executeTurnWithStatus(
        channelKey,
        workspacePath,
        userPrompt,
        ctx.chat!.id,
        threadId,
        initialStatus.message_id
    ).catch((err) => {
        logger.error('[Bot] Execution error:', err);
    });
}

export async function handleIncomingMessage(ctx: Context, services: BotServices): Promise<void> {
    const threadId = ctx.message?.message_thread_id;
    const isGeneral = !threadId || threadId === 1;

    // RULE 1: No chatting directly in General chat
    if (ctx.chat?.type === 'supergroup' && isGeneral) {
        const keyboard = new InlineKeyboard()
            .text('📁 Browse Projects', 'cmd_projects')
            .text('📜 Existing Chats', 'cmd_chats');

        await ctx.reply(
            '⚠️ <b>Chatting in General is disabled.</b>\n\n' +
            'Every conversation must have its own topic:\n' +
            '• <code>/agy_new &lt;title&gt;</code> - Create a new topic & chat\n' +
            '• <code>/agy_projects</code> - Pick a project workspace\n' +
            '• <code>/agy_chats</code> - Assign an existing chat to a topic',
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
        return;
    }

    const rawText = ctx.message?.text || ctx.message?.caption || '';

    // Direct shell execution: ! <command> (e.g. ! echo hello, ! git status, ! nr start)
    if (rawText.startsWith('!')) {
        await handleShellCommand(ctx, rawText, services);
        return;
    }

    // RULE 2: Catch unrecognized slash commands so they don't get sent to Antigravity CLI as heavy prompts!
    if (rawText.startsWith('/')) {
        const cmdMatch = rawText.match(/^\/([a-zA-Z0-9_-]+)/);
        const cmdName = cmdMatch ? cmdMatch[1].toLowerCase() : '';

        if (!isAllowedSlashCommand(cmdName)) {
            const cmd = rawText.split(/[\s@]/)[0];
            await ctx.reply(
                `❓ Unknown command: <code>${escapeHtml(cmd)}</code>\n\nUse /agy_help to see all available commands.`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
            return;
        }
    }

    // Handle Telegram media groups / albums (e.g. sending 9 photos in batch)
    const mediaGroupId = ctx.message?.media_group_id;
    if (mediaGroupId && ctx.message?.photo && ctx.message.photo.length > 0) {
        await handleMediaGroupMessage(ctx, mediaGroupId, services);
        return;
    }

    // Handle Document / File uploads (e.g. large .log, .txt, .json files)
    if (ctx.message?.document) {
        const doc = ctx.message.document;
        try {
            const localPath = await downloadTelegramFile(ctx.api, doc.file_id, doc.file_name);
            const stats = fs.statSync(localPath);
            let docPrompt: string;

            if (stats.size <= 50 * 1024) {
                const content = fs.readFileSync(localPath, 'utf-8');
                docPrompt = `[Uploaded document: ${doc.file_name || 'file'}]\n\`\`\`\n${content}\n\`\`\`\n\n${rawText}`.trim();
            } else {
                docPrompt = `[Attached local file: ${localPath}] (${doc.file_name || 'file'}, ${Math.round(stats.size / 1024)} KB)\n${rawText || 'Please inspect and analyze this file.'}`.trim();
            }

            await dispatchPrompt(ctx, docPrompt, services);
            return;
        } catch (err: any) {
            logger.error('[Bot] Failed to download document:', err);
            await ctx.reply('⚠️ Warning: Failed to download attached document.');
            return;
        }
    }

    // If single photo attached, download it and append path to prompt
    if (ctx.message?.photo && ctx.message.photo.length > 0) {
        const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
        let photoPrompt = rawText;
        try {
            const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
            photoPrompt = `${photoPrompt}\n[Attached user screenshot: ${localPath}]`.trim();
        } catch (err: any) {
            logger.error('[Bot] Failed to download photo:', err);
            await ctx.reply('⚠️ Warning: Failed to download attached image.');
        }
        await dispatchPrompt(ctx, photoPrompt, services);
        return;
    }

    if (!rawText.trim()) {
        return;
    }

    // Debounce and batch rapid text pastes (split by Telegram into multiple 4KB chunks)
    const wasBuffered = handlePastedText(ctx, rawText, services, async (combinedText, dispatchCtx) => {
        await dispatchPrompt(dispatchCtx, combinedText, services);
    });

    if (wasBuffered) {
        return;
    }

    await dispatchPrompt(ctx, rawText, services);
}

export async function handleEditedMessage(ctx: Context, services: BotServices): Promise<void> {
    const channelKey = services.getChannelKey(ctx);
    const newText = ctx.editedMessage?.text?.trim();
    const userMsgId = ctx.editedMessage?.message_id;
    const chatId = ctx.chat?.id;

    if (!newText || !userMsgId) return;

    const queuedItem = services.db.findQueuedMessageByUserMsgId(channelKey, userMsgId, chatId);
    if (!queuedItem) return;

    services.db.updateQueuedPrompt(queuedItem.id, newText);
    logger.info(`[Queue] Updated prompt for queued item #${queuedItem.id} from edited message ${userMsgId}`);

    const preview = newText.length > 50 ? `${newText.slice(0, 47)}...` : newText;
    const keyboard = new InlineKeyboard()
        .text('⚡ Force Now', `q_force:${queuedItem.id}`)
        .text('🗑️ Delete', `q_del:${queuedItem.id}`)
        .row()
        .text('📋 Show Queue', 'show_queue');

    try {
        await ctx.api.editMessageText(
            queuedItem.chatId,
            queuedItem.statusMsgId,
            `📥 <b>Queued (#${queuedItem.id})</b> <i>(edited)</i> — will run automatically when current task finishes.\n\n<code>${escapeHtml(preview)}</code>`,
            { parse_mode: 'HTML', reply_markup: keyboard }
        );
    } catch {}
}

export function registerMessageHandlers(services: BotServices): void {
    services.bot.on(['message:text', 'message:photo', 'message:document'], (ctx) => {
        handleIncomingMessage(ctx, services).catch((err) => {
            logger.error('[Bot] Unhandled error in concurrent message handler:', err);
        });
    });

    services.bot.on('edited_message:text', (ctx) => {
        handleEditedMessage(ctx, services).catch((err) => {
            logger.error('[Bot] Unhandled error in edited message handler:', err);
        });
    });
}
