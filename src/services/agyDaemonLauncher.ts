import net from 'net';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { logger } from '../utils/logger';
import { loadConfig } from '../utils/config';
import { TurnOptions } from './agyStreamService';

export interface SessionPaths {
    socketPath: string;
    statePath: string;
    hash: string;
}

export function getSessionPaths(sessionId: string): SessionPaths {
    const hash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    return {
        socketPath: `/tmp/magy_${hash}.sock`,
        statePath: `/tmp/magy_${hash}.json`,
        hash,
    };
}

export function tryConnectSocket(socketPath: string): Promise<net.Socket | null> {
    return new Promise((resolve) => {
        if (!fs.existsSync(socketPath)) {
            logger.debug(`[AgyStream] Unix socket not found: ${socketPath}`);
            return resolve(null);
        }

        logger.info(`[AgyStream] Connecting to Unix socket: ${socketPath}`);
        const socket = net.createConnection(socketPath, () => {
            logger.info(`[AgyStream] Connected to Unix socket: ${socketPath}`);
            resolve(socket);
        });

        socket.once('error', (err) => {
            logger.warn(`[AgyStream] Unix socket connection failed (${socketPath}): ${err.message}`);
            socket.destroy();
            resolve(null);
        });
    });
}

export function waitForSocket(socketPath: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();

        const check = () => {
            if (fs.existsSync(socketPath)) {
                const socket = net.createConnection(socketPath, () => {
                    logger.info(`[AgyStream] Connected to newly created Unix socket: ${socketPath}`);
                    resolve(socket);
                });

                socket.once('error', () => {
                    socket.destroy();
                    if (Date.now() - startTime > timeoutMs) {
                        reject(new Error(`Timed out waiting for socket ${socketPath}`));
                    } else {
                        setTimeout(check, 100);
                    }
                });
                return;
            }

            if (Date.now() - startTime > timeoutMs) {
                reject(new Error(`Timed out waiting for socket file ${socketPath} to appear`));
            } else {
                setTimeout(check, 100);
            }
        };

        check();
    });
}

export async function launchDaemonProcess(
    sessionId: string,
    paths: SessionPaths,
    options: TurnOptions,
    idleTimeoutSeconds: number
): Promise<void> {
    let daemonScript = path.resolve(__dirname, 'sessionDaemon.js');
    if (!fs.existsSync(daemonScript)) {
        daemonScript = path.resolve(__dirname, '..', '..', 'dist', 'services', 'sessionDaemon.js');
    }

    if (!fs.existsSync(daemonScript)) {
        throw new Error(`sessionDaemon.js not found at ${daemonScript}. Did you run npm run build?`);
    }

    const logPath = paths.statePath.replace(/\.json$/, '.log');
    logger.info(`[AgyStream] Spawning detached sessionDaemon for session ${sessionId} (log: ${logPath})`);

    const dbPath = loadConfig().dbPath;
    const daemonArgs = [
        daemonScript,
        '--socket', paths.socketPath,
        '--state', paths.statePath,
        '--session', sessionId,
        '--workspace', options.workspacePath,
        '--conv', options.conversationId || '',
        '--autoApprove', String(options.autoApprove ?? true),
        '--model', options.model || '',
        '--idle', String(idleTimeoutSeconds),
        '--db', dbPath,
    ];

    if (process.platform === 'win32') {
        const daemonProcess = spawn(process.execPath, daemonArgs, {
            detached: true,
            stdio: 'ignore',
        });
        daemonProcess.unref();
    } else {
        const cmd = `("${process.execPath}" ${daemonArgs.map((a) => JSON.stringify(a)).join(' ')} </dev/null >>${JSON.stringify(logPath)} 2>&1) &`;
        const launcher = spawn('/bin/sh', ['-c', cmd], {
            detached: true,
            stdio: 'ignore',
        });
        launcher.unref();
    }
}
