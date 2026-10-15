import { exec } from 'child_process';
import { BotServices } from './types';
import { escapeHtml, formatAccountQuota, formatHumanDate } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export function registerUsageCommands(services: BotServices): void {
    const { bot, db, convService } = services;

    // Command: /quota, /agy_usage, /agy_quota - Show overall Antigravity account quota and limits
    bot.command(['quota', 'agy_quota', 'agy_usage'], async (ctx) => {
        const threadId = ctx.message?.message_thread_id;
        const statusMsg = await ctx.reply('⏳ <i>Fetching account quota & usage...</i>', {
            parse_mode: 'HTML',
            message_thread_id: threadId,
        });

        exec('agy --print "/usage"', {
            timeout: 15000,
            env: { ...process.env, PAGER: 'cat' },
        }, async (error, stdout, stderr) => {
            if (error && !stdout) {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    `❌ <b>Failed to fetch account quota:</b> ${escapeHtml(error.message)}`,
                    { parse_mode: 'HTML' }
                );
                return;
            }

            const raw = (stdout || stderr || '').trim();
            const message = formatAccountQuota(raw);

            try {
                await ctx.api.editMessageText(
                    ctx.chat!.id,
                    statusMsg.message_id,
                    message,
                    { parse_mode: 'HTML' }
                );
            } catch (err: any) {
                if (!err.message?.includes('message is not modified')) {
                    logger.error('[Bot] Error editing account usage message:', err);
                }
            }
        });
    });

    // Command: /usage, /tokens, /session_usage - Show current conversation session token statistics
    bot.command(['usage', 'tokens', 'session_usage'], async (ctx) => {
        const channelKey = services.getChannelKey(ctx);
        const session = db.getSession(channelKey);

        if (!session || !session.conversationId) {
            return ctx.reply('No active conversation tracked in this topic yet. Send a prompt to begin.');
        }

        const formatNum = (n: number) => n.toLocaleString();
        const summary = convService.getSummary(session.conversationId);
        const timeSection = summary?.lastModified
            ? `• <b>Last Active:</b> ${formatHumanDate(summary.lastModified)}\n`
            : (session.createdAt ? `• <b>Started:</b> ${formatHumanDate(session.createdAt)}\n` : '');

        const usageText = `
<b>📊 Session Token Usage</b>
• <b>Conversation:</b> <code>${session.conversationId}</code>
${timeSection}• <b>Total Turns:</b> ${formatNum(session.totalTurns || 1)}

<b>Latest Turn:</b>
• <b>Input:</b> ${formatNum(session.lastInputTokens)} tokens
• <b>Output:</b> ${formatNum(session.lastOutputTokens)} tokens
• <b>Thinking:</b> ${formatNum(session.lastThinkingTokens)} tokens
• <b>Cached Context:</b> ${formatNum(session.lastCacheTokens)} tokens
• <b>Turn Total:</b> ${formatNum(session.lastTotalTokens)} tokens
• <b>Execution Time:</b> ${session.lastDurationSeconds.toFixed(1)}s

<b>Session Cumulative:</b>
• <b>Total Input:</b> ${formatNum(session.totalInputTokens)} tokens
• <b>Total Output:</b> ${formatNum(session.totalOutputTokens)} tokens
        `.trim();

        await ctx.reply(usageText, { parse_mode: 'HTML' });
    });
}
