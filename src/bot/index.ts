import { Bot, Context, InlineKeyboard } from 'grammy';
import { AppConfig } from '../utils/config';
import { DatabaseManager } from '../database/db';
import { WorkspaceService } from '../services/workspaceService';
import { TelegramTopicManager } from '../services/telegramTopicManager';
import { AgyStreamService } from '../services/agyStreamService';
import { formatForTelegram, splitTelegramHtml } from '../utils/telegramFormatter';
import { downloadTelegramPhoto } from '../utils/imageHandler';
import { logger } from '../utils/logger';

export function createBot(config: AppConfig) {
    const bot = new Bot(config.telegramBotToken);
    const db = new DatabaseManager(config.dbPath);
    const workspaceService = new WorkspaceService(config.workspaceBaseDir);
    const agyService = new AgyStreamService();

    // Whitelist Authorization Middleware
    bot.use(async (ctx, next) => {
        if (config.allowedUserIds.length > 0) {
            const userId = ctx.from?.id;
            if (!userId || !config.allowedUserIds.includes(userId)) {
                logger.warn(`[Auth] Blocked unauthorized message from user ${userId} (${ctx.from?.username})`);
                if (ctx.chat?.type === 'private') {
                    await ctx.reply('⛔ You are not authorized to use this bot.');
                }
                return;
            }
        }
        await next();
    });

    /**
     * Resolve the channel key (combines chatId + topicId)
     */
    function getChannelKey(ctx: Context): string {
        const chatId = ctx.chat?.id;
        const threadId = ctx.message?.message_thread_id || (ctx.callbackQuery?.message as any)?.message_thread_id;
        return threadId ? `${chatId}:${threadId}` : `${chatId}`;
    }

    /**
     * Resolve workspace path for current context
     */
    function resolveWorkspace(channelKey: string): string {
        const boundPath = db.getWorkspaceBinding(channelKey);
        if (boundPath && workspaceService.exists(boundPath)) {
            return workspaceService.getWorkspacePath(boundPath);
        }
        // Default to workspace base directory
        return workspaceService.getBaseDir();
    }

    // Command: /start or /help
    bot.command(['start', 'help'], async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);

        const helpText = `
<b>🤖 Antigravity CLI Mobile Remote</b>

<b>Current Workspace:</b> <code>${ws}</code>
<b>Active Conversation:</b> <code>${session?.conversationId || 'None (New)'}</code>

<b>Commands:</b>
/projects - View and switch project workspaces
/new - Start a fresh conversation in this topic
/stop - Stop current running task
/status - Show execution status and conversation info
/help - Show this guide

Send any text or screenshot to prompt Antigravity!
        `.trim();

        await ctx.reply(helpText, { parse_mode: 'HTML' });
    });

    // Command: /status
    bot.command('status', async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const ws = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);
        const isRunning = agyService.isBusy(channelKey);

        const statusMsg = `
<b>📊 Session Status</b>
• <b>Workspace:</b> <code>${ws}</code>
• <b>Conversation:</b> <code>${session?.conversationId || 'Fresh'}</code>
• <b>Status:</b> ${isRunning ? '⚙️ Running task' : '💤 Idle'}
        `.trim();

        await ctx.reply(statusMsg, { parse_mode: 'HTML' });
    });

    // Command: /stop
    bot.command('stop', async (ctx) => {
        const channelKey = getChannelKey(ctx);
        const stopped = agyService.stopSession(channelKey);
        if (stopped) {
            await ctx.reply('🛑 Stopped active task.');
        } else {
            await ctx.reply('No task is currently running in this topic.');
        }
    });

    // Command: /new
    bot.command('new', async (ctx) => {
        const channelKey = getChannelKey(ctx);
        agyService.stopSession(channelKey);
        db.deleteSession(channelKey);
        await ctx.reply('✨ Started a fresh conversation. Next message will create a new session.');
    });

    // Command: /projects
    bot.command('projects', async (ctx) => {
        const workspaces = workspaceService.scanWorkspaces();
        if (workspaces.length === 0) {
            return ctx.reply(`No subdirectories found in <code>${workspaceService.getBaseDir()}</code>`, {
                parse_mode: 'HTML',
            });
        }

        const keyboard = new InlineKeyboard();
        for (let i = 0; i < workspaces.length; i++) {
            const ws = workspaces[i];
            keyboard.text(`📁 ${ws}`, `select_ws:${ws}`);
            if (i % 2 === 1) keyboard.row();
        }

        await ctx.reply('<b>Select a workspace:</b>', {
            reply_markup: keyboard,
            parse_mode: 'HTML',
        });
    });

    // Handle project selection callback
    bot.callbackQuery(/^select_ws:(.+)$/, async (ctx) => {
        const wsName = ctx.match[1];
        const channelKey = getChannelKey(ctx);

        try {
            const fullPath = workspaceService.resolveWorkspace(wsName);
            const threadId = (ctx.callbackQuery.message as any)?.message_thread_id;

            db.bindWorkspace(channelKey, wsName, threadId);
            db.deleteSession(channelKey); // Reset conversation for new workspace

            await ctx.answerCallbackQuery({ text: `Switched to ${wsName}` });
            await ctx.editMessageText(
                `✅ Switched to workspace: <b>${wsName}</b>\nPath: <code>${fullPath}</code>\n\nStarted a fresh conversation. Send a message to begin.`,
                { parse_mode: 'HTML' }
            );
        } catch (err: any) {
            await ctx.answerCallbackQuery({ text: 'Error switching workspace' });
            await ctx.reply(`Failed to switch: ${err.message}`);
        }
    });

    // Handle incoming messages (Text and Photos)
    bot.on(['message:text', 'message:photo'], async (ctx) => {
        const channelKey = getChannelKey(ctx);

        if (agyService.isBusy(channelKey)) {
            await ctx.reply('⏳ Antigravity is busy running another task. Use /stop to cancel it.');
            return;
        }

        let userPrompt = ctx.message.text || ctx.message.caption || '';

        // If photo attached, download it and append path to prompt
        if (ctx.message.photo && ctx.message.photo.length > 0) {
            const largestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
            try {
                const localPath = await downloadTelegramPhoto(ctx.api, largestPhoto.file_id);
                userPrompt = `${userPrompt}\n[Attached user screenshot: ${localPath}]`.trim();
            } catch (err: any) {
                logger.error('[Bot] Failed to download photo:', err);
                await ctx.reply('⚠️ Warning: Failed to download attached image.');
            }
        }

        if (!userPrompt) {
            return;
        }

        const workspacePath = resolveWorkspace(channelKey);
        const session = db.getSession(channelKey);

        const threadId = ctx.message.message_thread_id;
        const initialStatus = await ctx.reply('🧠 <i>Antigravity is thinking...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        let lastEditTime = Date.now();
        let lastRenderedText = '';
        let activeToolName: string | null = null;

        const updateTelegramStatus = async (force: boolean = false) => {
            const now = Date.now();
            if (!force && now - lastEditTime < 1500) {
                return; // Throttle to avoid Telegram rate limits
            }
            lastEditTime = now;

            let displayText = lastRenderedText.trim();
            if (activeToolName) {
                displayText += `\n\n⚙️ <i>Executing: ${activeToolName}...</i>`;
            }

            if (!displayText) {
                displayText = '🧠 <i>Antigravity is working...</i>';
            }

            try {
                const formatted = formatForTelegram(displayText);
                // Keep within 4000 chars for live edits
                const truncated = formatted.length > 4000 ? formatted.slice(-4000) : formatted;
                await ctx.api.editMessageText(
                    ctx.chat.id,
                    initialStatus.message_id,
                    truncated,
                    { parse_mode: 'HTML' }
                );
            } catch (err: any) {
                // Ignore harmless "message is not modified" errors from Telegram
                if (!err.message?.includes('message is not modified')) {
                    logger.debug('[Bot] editMessageText error:', err.message);
                }
            }
        };

        try {
            const result = await agyService.executeTurn(channelKey, {
                workspacePath,
                conversationId: session?.conversationId,
                prompt: userPrompt,
                autoApprove: config.autoApprove,
                model: config.defaultModel,
                onInit: (convId) => {
                    db.saveSession(channelKey, workspacePath, convId, threadId);
                },
                onDelta: (_delta, fullText) => {
                    lastRenderedText = fullText;
                    updateTelegramStatus(false);
                },
                onToolCall: (toolName, _params) => {
                    activeToolName = toolName;
                    updateTelegramStatus(false);
                },
                onToolDone: (_toolName, _output) => {
                    activeToolName = null;
                    updateTelegramStatus(false);
                },
            });

            // Save conversation ID
            if (result.conversationId) {
                db.saveSession(channelKey, workspacePath, result.conversationId, threadId);
            }

            // Final delivery
            const finalResponse = result.response || lastRenderedText || '<i>Done.</i>';
            const formatted = formatForTelegram(finalResponse);
            const chunks = splitTelegramHtml(formatted);

            // Edit the initial message with the first chunk
            await ctx.api.editMessageText(
                ctx.chat.id,
                initialStatus.message_id,
                chunks[0],
                { parse_mode: 'HTML' }
            );

            // Send remaining chunks as subsequent messages if response is long
            for (let i = 1; i < chunks.length; i++) {
                await ctx.reply(chunks[i], {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            }

        } catch (err: any) {
            logger.error('[Bot] Execution error:', err);
            await ctx.api.editMessageText(
                ctx.chat.id,
                initialStatus.message_id,
                `❌ <b>Error:</b> ${err?.message || err}`,
                { parse_mode: 'HTML' }
            );
        }
    });

    return { bot, db };
}
