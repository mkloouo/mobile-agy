import { Context, InlineKeyboard } from 'grammy';
import { BotServices } from './types';
import { handleShellCommand } from './shell';
import { downloadTelegramPhoto } from '../utils/imageHandler';
import { escapeHtml } from '../utils/telegramFormatter';
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
]);

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

    if (!rawText && (!ctx.message?.photo || ctx.message.photo.length === 0)) {
        return;
    }

    // RULE 2: Catch unrecognized slash commands so they don't get sent to Antigravity CLI as heavy prompts!
    if (rawText.startsWith('/')) {
        const cmdMatch = rawText.match(/^\/([a-zA-Z0-9_-]+)/);
        const cmdName = cmdMatch ? cmdMatch[1].toLowerCase() : '';

        if (!ANTIGRAVITY_SLASH_COMMANDS.has(cmdName)) {
            const cmd = rawText.split(/[\s@]/)[0];
            await ctx.reply(
                `❓ Unknown command: <code>${escapeHtml(cmd)}</code>\n\nUse /agy_help to see all available commands.`,
                { parse_mode: 'HTML', message_thread_id: threadId }
            );
            return;
        }
    }

    // Direct shell execution: ! <command> (e.g. ! echo hello, ! git status, ! nr start)
    if (rawText.startsWith('!')) {
        await handleShellCommand(ctx, rawText, services);
        return;
    }

    let userPrompt = rawText;

    // If photo attached, download it and append path to prompt
    if (ctx.message?.photo && ctx.message.photo.length > 0) {
        const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
        try {
            const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
            userPrompt = `${userPrompt}\n[Attached user screenshot: ${localPath}]`.trim();
        } catch (err: any) {
            logger.error('[Bot] Failed to download photo:', err);
            await ctx.reply('⚠️ Warning: Failed to download attached image.');
        }
    }

    // Context from replied-to message (if user used Telegram reply)
    const replyTo = ctx.message?.reply_to_message;
    if (replyTo) {
        const replyText = replyTo.text || replyTo.caption || '';
        const isBot = replyTo.from?.is_bot;
        const senderName = isBot ? 'Antigravity' : (replyTo.from?.first_name || 'User');

        // If replied message had a photo and current message didn't, download it
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
        const queuedMsg = await ctx.reply(
            `📥 <b>Queued (#${queuePos})</b> — will run automatically when current task finishes.`,
            { parse_mode: 'HTML', message_thread_id: threadId }
        );
        services.db.enqueueMessage(channelKey, ctx.chat!.id, threadId, queuedMsg.message_id, userPrompt);
        return;
    }

    const workspacePath = services.resolveWorkspace(channelKey);

    const initialStatus = await ctx.reply('🧠 <i>Antigravity is thinking...</i>', {
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

export function registerMessageHandlers(services: BotServices): void {
    services.bot.on(['message:text', 'message:photo'], (ctx) => {
        handleIncomingMessage(ctx, services).catch((err) => {
            logger.error('[Bot] Unhandled error in concurrent message handler:', err);
        });
    });
}
