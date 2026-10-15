import { spawn } from 'child_process';
import { Context, InlineKeyboard } from 'grammy';
import { BotServices } from './types';
import { taskManager } from '../services/taskManager';
import { escapeHtml, splitTelegramHtml, stripAnsi } from '../utils/telegramFormatter';
import { logger } from '../utils/logger';

export function formatShellMessage(shellCmd: string, bodyText: string, statusTag: string): string {
    let clean = stripAnsi(bodyText).trim();
    if (!clean) clean = '(no output)';
    if (clean.length > 8000) {
        clean = clean.slice(0, 4000) + '\n\n... [output truncated, ' + clean.length + ' chars total] ...\n\n' + clean.slice(-3000);
    }
    return `⚡ <b>$ ${escapeHtml(shellCmd)}</b>${statusTag}\n<pre><code>${escapeHtml(clean)}</code></pre>`;
}

export async function handleShellCommand(ctx: Context, rawText: string, services: BotServices): Promise<void> {
    const threadId = ctx.message?.message_thread_id;
    const shellCmd = rawText.slice(1).trim();

    if (!shellCmd) {
        await ctx.reply(
            '⚡ <b>Direct Shell Execution</b>\n\n' +
            'Usage: <code>! &lt;command&gt;</code>\n' +
            'Example: <code>! git status</code>, <code>! nr start</code>\n' +
            'Cancel: <code>! kill</code> or <code>/kill</code>',
            { parse_mode: 'HTML', message_thread_id: threadId }
        );
        return;
    }

    const channelKey = services.getChannelKey(ctx);
    const workspacePath = services.resolveWorkspace(channelKey);

    if (shellCmd === 'kill' || shellCmd === 'stop') {
        const runningTasks = await taskManager.getRunningTasks(channelKey, workspacePath);
        const wasAgyBusy = services.agyService.isBusy(channelKey);
        if (wasAgyBusy) services.agyService.stopSession(channelKey);
        for (const t of runningTasks) {
            taskManager.killProcess(t.pid);
        }
        const msg = runningTasks.length > 0 || wasAgyBusy
            ? `🛑 <b>Cancelled:</b>\n${runningTasks.map((t) => `• Stopped <b>${escapeHtml(t.name)}</b> (PID ${t.pid})`).join('\n')}`
            : 'No active command or background server running in this topic.';
        await ctx.reply(msg, { parse_mode: 'HTML', message_thread_id: threadId });
        return;
    }

    let outputBuffer = '';
    let hasExited = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    const child = spawn(process.env.SHELL || '/bin/zsh', ['-i', '-c', shellCmd], {
        cwd: workspacePath,
        detached: true,
        env: { ...process.env, PAGER: 'cat' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pid = child.pid;

    const onData = (chunk: Buffer) => {
        const str = chunk.toString('utf-8');
        outputBuffer += str;
        if (pid) taskManager.appendOutput(pid, str);
        if (outputBuffer.length > 500000) {
            outputBuffer = outputBuffer.slice(-250000);
        }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const stopKeyboard = pid
        ? new InlineKeyboard().text(`🛑 Stop (PID ${pid})`, `kill_proc:${pid}`)
        : undefined;

    let runningTimer: NodeJS.Timeout | null = null;

    // Send initial status message asynchronously
    const statusMsgPromise = ctx.reply(
        `⚡ <code>$ ${escapeHtml(shellCmd)}</code>\n<i>Running${pid ? ` · PID ${pid}` : ''}...</i>`,
        { parse_mode: 'HTML', reply_markup: stopKeyboard, message_thread_id: threadId }
    ).then((msg) => {
        if (pid && !hasExited) {
            taskManager.registerProcess(pid, child, shellCmd, channelKey, workspacePath, ctx.chat!.id, msg.message_id, threadId);

            // Periodically refresh running output if still active after 2.5s
            runningTimer = setInterval(async () => {
                if (hasExited || !pid) {
                    if (runningTimer) clearInterval(runningTimer);
                    return;
                }

                const statusTag = ` [Running · PID ${pid}]`;
                const msgText = formatShellMessage(shellCmd, outputBuffer || '(process running in background...)', statusTag);
                const chunks = splitTelegramHtml(msgText);

                try {
                    await ctx.api.editMessageText(
                        ctx.chat!.id,
                        msg.message_id,
                        chunks[0],
                        { parse_mode: 'HTML', reply_markup: stopKeyboard }
                    );
                } catch (err: any) {
                    logger.debug('[Shell] Failed to edit background status:', err.message);
                }
            }, 3000);
        }
        return msg;
    }).catch((err) => {
        logger.error('[Bot] Failed to send initial shell status message:', err);
        return null;
    });

    const finalizeOutput = async (code: number | null, signal: string | null) => {
        if (hasExited) return;
        hasExited = true;
        exitCode = code;
        exitSignal = signal;
        if (runningTimer) clearInterval(runningTimer);
        if (pid) taskManager.unregisterProcess(pid);

        const statusMsg = await statusMsgPromise;
        const statusTag = exitCode === 0
            ? ''
            : ` [exit ${exitCode !== null ? exitCode : exitSignal || 1}]`;

        const fullMsg = formatShellMessage(shellCmd, outputBuffer, statusTag);
        const chunks = splitTelegramHtml(fullMsg);

        if (!statusMsg) {
            for (const chunk of chunks) {
                try {
                    await ctx.reply(chunk, {
                        parse_mode: 'HTML',
                        message_thread_id: threadId,
                    });
                } catch {
                    await ctx.reply(chunk.replace(/<[^>]+>/g, ''), {
                        message_thread_id: threadId,
                    }).catch(() => {});
                }
            }
            return;
        }

        try {
            await ctx.api.editMessageText(
                ctx.chat!.id,
                statusMsg.message_id,
                chunks[0],
                { parse_mode: 'HTML' }
            );

            for (let i = 1; i < chunks.length; i++) {
                await ctx.reply(chunks[i], {
                    parse_mode: 'HTML',
                    message_thread_id: threadId,
                });
            }
        } catch (editErr: any) {
            logger.warn('[Bot] Failed to edit shell message, falling back to new reply:', editErr.message);
            for (const chunk of chunks) {
                try {
                    await ctx.reply(chunk, {
                        parse_mode: 'HTML',
                        message_thread_id: threadId,
                    });
                } catch {
                    await ctx.reply(chunk.replace(/<[^>]+>/g, ''), {
                        message_thread_id: threadId,
                    });
                }
            }
        }
    };

    child.on('close', (code, signal) => {
        finalizeOutput(code, signal);
    });

    child.on('error', async (err) => {
        if (hasExited) return;
        hasExited = true;
        if (runningTimer) clearInterval(runningTimer);
        if (pid) taskManager.unregisterProcess(pid);

        const statusMsg = await statusMsgPromise;
        const errMsg = `⚡ <b>$ ${escapeHtml(shellCmd)}</b> [Failed to spawn]\n<pre><code>${escapeHtml(err.message)}</code></pre>`;
        if (!statusMsg) {
            await ctx.reply(errMsg, { parse_mode: 'HTML', message_thread_id: threadId }).catch(() => {});
            return;
        }

        try {
            await ctx.api.editMessageText(
                ctx.chat!.id,
                statusMsg.message_id,
                errMsg,
                { parse_mode: 'HTML' }
            );
        } catch {}
    });
}
