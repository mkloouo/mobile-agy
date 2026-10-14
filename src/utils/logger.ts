export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
    currentLevel = level;
}

export const logger = {
    debug: (...args: any[]) => {
        if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.debug) {
            console.log(`[DEBUG] [${new Date().toISOString()}]`, ...args);
        }
    },
    info: (...args: any[]) => {
        if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.info) {
            console.log(`[INFO] [${new Date().toISOString()}]`, ...args);
        }
    },
    warn: (...args: any[]) => {
        if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.warn) {
            console.warn(`[WARN] [${new Date().toISOString()}]`, ...args);
        }
    },
    error: (...args: any[]) => {
        if (LOG_LEVELS[currentLevel] <= LOG_LEVELS.error) {
            console.error(`[ERROR] [${new Date().toISOString()}]`, ...args);
        }
    },
};
