import net from 'net';
import fs from 'fs';
import readline from 'readline';
import { spawn, ChildProcess } from 'child_process';
import Database from 'better-sqlite3';

import { DaemonArgs, DaemonState, parseDaemonArgs, buildAgyArgs, generateTurnId, writeStateFile, safeUnlink } from './sessionDaemonUtils';
import { syncDaemonStateToDb, deleteDaemonSession } from '../database/daemonSessionDb';

let config: DaemonArgs;
try {
    config = parseDaemonArgs(process.argv.slice(2));
} catch (err: any) {
    console.error(err.message || err);
    process.exit(1);
}

let sqliteDb: Database.Database | null = null;
if (config.dbPath) {
    try {
        sqliteDb = new Database(config.dbPath);
        sqliteDb.pragma('journal_mode = WAL');
    } catch (dbErr) {
        console.error('[SessionDaemon] Failed to open SQLite DB:', dbErr);
    }
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
    state.lastActiveAt = Date.now();
    if (sqliteDb) {
        try {
            syncDaemonStateToDb(sqliteDb, state);
        } catch (err) {
            console.error('[SessionDaemon] SQLite save failed:', err);
        }
    }
    writeStateFile(config.statePath, state);
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
            client.write(line, (err) => {
                if (err) connectedClients.delete(client);
            });
        } catch {
            connectedClients.delete(client);
        }
    }
}

safeUnlink(config.socketPath);

let idleTimer: NodeJS.Timeout | null = null;
let agyProc: ChildProcess | null = null;

function log(...args: any[]): void {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [SessionDaemon:${config.sessionId}]`, ...args);
}

function resetIdleTimer(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    if (!state.isBusy) {
        idleTimer = setTimeout(() => {
            log(`Idle timeout (${config.idleTimeoutSeconds}s) reached. Shutting down.`);
            shutdown();
        }, config.idleTimeoutSeconds * 1000);
    }
}

function shutdown(): void {
    log(`Shutdown initiated for daemon PID ${process.pid}`);
    if (idleTimer) clearTimeout(idleTimer);

    if (sqliteDb) {
        try {
            deleteDaemonSession(sqliteDb, config.sessionId);
            sqliteDb.close();
            sqliteDb = null;
        } catch {}
    }

    safeUnlink(config.socketPath);
    safeUnlink(config.statePath);

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
        log('Received SIGINT while idle: shutting down.');
        shutdown();
    } else {
        log('Ignoring SIGINT while busy to allow bot re-attachment.');
    }
});

process.on('SIGTERM', () => {
    log('Received SIGTERM: shutting down.');
    shutdown();
});

// Spawn agy process
const agyArgs = buildAgyArgs(config);
log(`Spawning agy in ${config.workspacePath} with args: ${agyArgs.join(' ')}`);

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

agyProc.on('error', (err) => {
    log('Failed to spawn agy process:', err.message);
    const errMsg = `❌ Failed to spawn agy process: ${err.message}`;
    state.isBusy = false;
    broadcast({
        event: 'result',
        result: {
            status: 'ERROR',
            response: errMsg,
            error: err.message,
            duration_seconds: 0,
            conversation_id: state.conversationId,
        },
    });
    setTimeout(() => {
        shutdown();
    }, 150);
});

state.agyPid = agyProc.pid || 0;
log(`Spawned agy process PID: ${state.agyPid}`);
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
            log(`agy initialized: convId=${event.conversation_id}`);
            saveState();
        } else if (event.event === 'step_update') {
            event.turnId = state.currentTurnId;
            const step = event.step_update;
            if (step?.step_type === 'agent_response' && step.text_delta) {
                state.accumulatedResponse = (state.accumulatedResponse || '') + step.text_delta;
            }
        } else if (event.event === 'result') {
            event.turnId = state.currentTurnId;
            state.isBusy = false;
            const turnDurationSec = state.turnStartTime
                ? Math.max(1, Math.round((Date.now() - state.turnStartTime) / 1000))
                : (event.result?.duration_seconds ? Math.max(1, Math.round(event.result.duration_seconds)) : 0);
            if (event.result) {
                event.result.duration_seconds = turnDurationSec;
                if (!event.result.response && state.accumulatedResponse) {
                    event.result.response = state.accumulatedResponse;
                }
            }
            state.lastResult = {
                ...event.result,
                duration_seconds: turnDurationSec,
                response: event.result?.response || state.accumulatedResponse || '',
            };
            log(`agy turn completed turnId=${state.currentTurnId}: status=${event.result?.status}, duration=${turnDurationSec}s`);
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
    log(`agy exited with code ${code}, signal ${signal}`);
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
        turnId: state.currentTurnId,
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
    socket.on('error', (err) => {
        connectedClients.delete(socket);
        log('Socket client error:', err.message);
    });

    socket.on('close', () => {
        connectedClients.delete(socket);
        log(`Bot disconnected from Unix socket. Remaining clients: ${connectedClients.size}, isBusy: ${state.isBusy}`);
        resetIdleTimer();
    });

    connectedClients.add(socket);
    log(`Bot connected to Unix socket. Total clients: ${connectedClients.size}`);

    // Send hello handshake with current state, recent events history, and active accumulated response
    socket.write(JSON.stringify({
        event: 'daemon_hello',
        state,
        currentTurnId: state.currentTurnId,
        history: recentEvents,
        accumulatedResponse: state.isBusy ? (state.accumulatedResponse || '') : '',
    }) + '\n', (err) => {
        if (err) connectedClients.delete(socket);
    });

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
                    state.accumulatedResponse = '';
                    state.currentTurnId = msg.turnId || generateTurnId();
                    state.turnStartTime = Date.now();
                    state.userPrompt = msg.prompt || '';
                    delete state.lastResult;
                    if (msg.statusMessageId) state.statusMessageId = msg.statusMessageId;
                    if (msg.chatId) state.chatId = msg.chatId;
                    if (msg.threadId) state.threadId = msg.threadId;
                    if (idleTimer) clearTimeout(idleTimer);
                    recentEvents.length = 0; // reset history for new turn
                    log(`Received user_prompt turnId=${state.currentTurnId} (len: ${msg.prompt?.length}, statusMsgId: ${msg.statusMessageId}, threadId: ${msg.threadId})`);
                    saveState();

                    const promptPayload = JSON.stringify({ event: 'user', message: { content: msg.prompt } }) + '\n';

                    agyProc?.stdin?.write(promptPayload, 'utf-8');
                    break;
                }

                case 'stop': {
                    log('Received stop command: sending SIGINT to agyProc');
                    if (agyProc && !agyProc.killed) {
                        agyProc.kill('SIGINT');
                    }
                    break;
                }

                case 'restart':
                case 'shutdown': {
                    log(`Received ${msg.action} command: shutting down`);
                    shutdown();
                    break;
                }

                case 'set_telegram_status': {
                    state.statusMessageId = msg.statusMessageId;
                    state.chatId = msg.chatId;
                    state.threadId = msg.threadId;
                    log(`Received set_telegram_status: statusMsgId=${msg.statusMessageId}, chatId=${msg.chatId}`);
                    saveState();
                    break;
                }

                case 'mark_delivered': {
                    state.turnDelivered = true;
                    log('Received mark_delivered: marked turnDelivered=true');
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
            log('Error handling socket command:', err?.message || err);
        }
    });
});

server.listen(config.socketPath, () => {
    log(`Listening on Unix socket ${config.socketPath}`);
    resetIdleTimer();
});
