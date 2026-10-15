import net from 'net';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawn, ChildProcess } from 'child_process';

import { DaemonArgs, DaemonState, parseDaemonArgs, buildAgyArgs } from './sessionDaemonUtils';

let config: DaemonArgs;
try {
    config = parseDaemonArgs(process.argv.slice(2));
} catch (err: any) {
    console.error(err.message || err);
    process.exit(1);
}

const state: DaemonState = {
    sessionId: config.sessionId,
    socketPath: config.socketPath,
    statePath: config.statePath,
    daemonPid: process.pid,
    agyPid: 0,
    workspacePath: config.workspacePath,
    conversationId: config.conversationId,
    model: config.model,
    isBusy: false,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
};

function saveState(): void {
    try {
        state.lastActiveAt = Date.now();
        fs.writeFileSync(config.statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        console.error('[SessionDaemon] Failed to write state file:', err);
    }
}

// Ring buffer of recent events for replay on reconnect
const recentEvents: any[] = [];
const MAX_RECENT_EVENTS = 100;

function pushEvent(event: any): void {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RECENT_EVENTS) {
        recentEvents.shift();
    }
}

// Active connected clients (mobile-agy processes)
const connectedClients = new Set<net.Socket>();

function broadcast(data: any): void {
    const line = JSON.stringify(data) + '\n';
    for (const client of connectedClients) {
        try {
            client.write(line);
        } catch {
            connectedClients.delete(client);
        }
    }
}

// Clean up stale socket file before listening
if (fs.existsSync(config.socketPath)) {
    try {
        fs.unlinkSync(config.socketPath);
    } catch {}
}

let idleTimer: NodeJS.Timeout | null = null;
let agyProc: ChildProcess | null = null;

function resetIdleTimer(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    if (!state.isBusy) {
        idleTimer = setTimeout(() => {
            console.log(`[SessionDaemon] Idle timeout (${config.idleTimeoutSeconds}s) reached. Shutting down.`);
            shutdown();
        }, config.idleTimeoutSeconds * 1000);
    }
}

function shutdown(): void {
    if (idleTimer) clearTimeout(idleTimer);

    try {
        if (fs.existsSync(config.socketPath)) fs.unlinkSync(config.socketPath);
    } catch {}

    try {
        if (fs.existsSync(config.statePath)) fs.unlinkSync(config.statePath);
    } catch {}

    if (agyProc && !agyProc.killed) {
        agyProc.kill('SIGTERM');
    }

    process.exit(0);
}

// Daemon signal handlers: ignore SIGHUP; on SIGINT/SIGTERM, only shut down if idle!
// If busy running a turn, survive so that the restarted bot process can re-attach.
process.on('SIGHUP', () => {});

process.on('SIGINT', () => {
    if (!state.isBusy) {
        shutdown();
    } else {
        console.log('[SessionDaemon] Ignoring SIGINT while busy to allow bot re-attachment.');
    }
});

process.on('SIGTERM', () => {
    if (!state.isBusy) {
        shutdown();
    } else {
        console.log('[SessionDaemon] Ignoring SIGTERM while busy to allow bot re-attachment.');
    }
});

// Spawn agy process
const agyArgs = buildAgyArgs(config);

agyProc = spawn('agy', agyArgs, {
    cwd: config.workspacePath,
    detached: process.platform !== 'win32',
    env: {
        ...process.env,
        MOBILE_AGY_DAEMON_PID: String(process.pid),
        MOBILE_AGY_WORKSPACE: config.workspacePath,
        PAGER: 'cat',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
});

state.agyPid = agyProc.pid || 0;
saveState();

let stderrBuffer = '';

agyProc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    stderrBuffer += text;
    if (stderrBuffer.length > 50000) {
        stderrBuffer = stderrBuffer.slice(-25000);
    }
});

const rlOut = readline.createInterface({
    input: agyProc.stdout!,
    crlfDelay: Infinity,
});

rlOut.on('line', (line) => {
    state.lastActiveAt = Date.now();
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    const trimmed = line.trim();
    if (!trimmed) return;

    try {
        const event = JSON.parse(trimmed);

        if (event.event === 'init' && event.conversation_id) {
            state.conversationId = event.conversation_id;
            saveState();
        } else if (event.event === 'result') {
            state.isBusy = false;
            state.lastResult = event.result;
            saveState();
            resetIdleTimer();
        }

        pushEvent(event);
        broadcast(event);
    } catch {
        // Non-JSON line: often plain text error or warning from agy
        stderrBuffer += (stderrBuffer ? '\n' : '') + trimmed;
        if (stderrBuffer.length > 50000) {
            stderrBuffer = stderrBuffer.slice(-25000);
        }
    }
});

agyProc.on('close', (code, signal) => {
    console.log(`[SessionDaemon] agy exited with code ${code}, signal ${signal}`);
    const isError = (code !== 0 && code !== null) && !signal;
    let errMsg = '';
    if (isError) {
        const cleaned = stderrBuffer.trim();
        errMsg = cleaned
            ? `❌ Antigravity error:\n${cleaned}`
            : `❌ Antigravity process exited with code ${code}`;
    }
    broadcast({
        event: 'result',
        result: {
            status: signal ? 'STOPPED' : (isError ? 'ERROR' : 'SUCCESS'),
            response: signal ? '*Task was stopped.*' : (isError ? errMsg : (state.isBusy ? '*Done.*' : '')),
            duration_seconds: 0,
            conversation_id: state.conversationId,
        },
    });
    // Delay shutdown slightly so broadcast buffer flushes to clients
    setTimeout(() => {
        shutdown();
    }, 150);
});

// Create Unix Domain Socket Server
const server = net.createServer((socket) => {
    connectedClients.add(socket);

    // Send hello handshake with current state and recent events history
    socket.write(JSON.stringify({
        event: 'daemon_hello',
        state,
        history: recentEvents,
    }) + '\n');

    const rlSocket = readline.createInterface({
        input: socket,
        crlfDelay: Infinity,
    });

    rlSocket.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
            const msg = JSON.parse(trimmed);

            switch (msg.action) {
                case 'user_prompt': {
                    state.isBusy = true;
                    state.turnDelivered = false;
                    delete state.lastResult;
                    if (msg.statusMessageId) state.statusMessageId = msg.statusMessageId;
                    if (msg.chatId) state.chatId = msg.chatId;
                    if (msg.threadId) state.threadId = msg.threadId;
                    if (idleTimer) clearTimeout(idleTimer);
                    recentEvents.length = 0; // reset history for new turn
                    saveState();

                    const promptPayload = JSON.stringify({
                        event: 'user',
                        message: {
                            content: msg.prompt,
                        },
                    }) + '\n';

                    agyProc?.stdin?.write(promptPayload, 'utf-8');
                    break;
                }

                case 'stop': {
                    if (agyProc && !agyProc.killed) {
                        agyProc.kill('SIGINT');
                    }
                    break;
                }

                case 'restart':
                case 'shutdown': {
                    shutdown();
                    break;
                }

                case 'set_telegram_status': {
                    state.statusMessageId = msg.statusMessageId;
                    state.chatId = msg.chatId;
                    state.threadId = msg.threadId;
                    saveState();
                    break;
                }

                case 'mark_delivered': {
                    state.turnDelivered = true;
                    saveState();
                    break;
                }

                case 'ping': {
                    socket.write(JSON.stringify({
                        event: 'pong',
                        isBusy: state.isBusy,
                        conversationId: state.conversationId,
                    }) + '\n');
                    break;
                }

                default:
                    break;
            }
        } catch (err: any) {
            console.error('[SessionDaemon] Error handling socket command:', err);
        }
    });

    socket.on('close', () => {
        connectedClients.delete(socket);
        resetIdleTimer();
    });

    socket.on('error', (err) => {
        connectedClients.delete(socket);
    });
});

server.listen(config.socketPath, () => {
    console.log(`[SessionDaemon] Listening on Unix socket ${config.socketPath} for session ${config.sessionId}`);
    resetIdleTimer();
});
