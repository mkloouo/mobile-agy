#!/usr/bin/env node
import { Command } from 'commander';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadConfig, getConfigFilePath } from '../utils/config';
import { createBot } from '../bot';
import { logger } from '../utils/logger';

const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
let version = '1.0.0';
try {
    if (fs.existsSync(pkgPath)) {
        version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || version;
    }
} catch {}

const program = new Command();

program
    .name('mobile-agy')
    .description('Mobile-friendly Telegram interface for Antigravity CLI')
    .version(version);

program
    .command('start')
    .description('Start the Telegram bot daemon')
    .action(async () => {
        const config = loadConfig();
        if (!config.telegramBotToken) {
            console.error('\n❌ Error: TELEGRAM_BOT_TOKEN is missing!');
            console.log('Run `mobile-agy setup` or create a `.env` file with your token.\n');
            process.exit(1);
        }

        logger.info('Starting Mobile-Friendly Antigravity Telegram Bot...');
        logger.info(`Workspace Base Dir: ${config.workspaceBaseDir}`);
        logger.info(`Allowed User IDs: ${config.allowedUserIds.length > 0 ? config.allowedUserIds.join(', ') : 'All (Unrestricted)'}`);

        const { bot, agyService } = createBot(config);

        // Graceful shutdown
        const gracefulShutdown = async (signal: string) => {
            logger.info(`Received ${signal}. Gracefully stopping bot...`);
            try {
                bot.stop();
            } catch {}

            if (agyService.hasBusySessions()) {
                logger.info('[Shutdown] In-flight turn detected. Allowing up to 2.5s for delivery buffer flush...');
                await new Promise((r) => setTimeout(r, 2500));
            }

            agyService.disconnectAll();
            process.exit(0);
        };

        process.once('SIGINT', () => { gracefulShutdown('SIGINT'); });
        process.once('SIGTERM', () => { gracefulShutdown('SIGTERM'); });

        await bot.start({
            onStart: (botInfo) => {
                console.log(`\n✅ Bot @${botInfo.username} is running and listening for messages!\n`);
            },
        });
    });

program
    .command('setup')
    .description('Interactive setup wizard to configure .env')
    .action(async () => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const question = (q: string): Promise<string> => {
            return new Promise((resolve) => rl.question(q, resolve));
        };

        console.log('\n--- Antigravity Telegram Remote Setup Wizard ---\n');

        const token = await question('1. Enter your Telegram Bot Token (from @BotFather): ');
        const userIds = await question('2. Enter allowed Telegram user IDs (comma-separated, leave blank for all): ');
        const defaultBase = path.join(os.homedir(), 'Projects');
        const baseDir = await question(`3. Workspace projects directory (default: ${defaultBase}): `);

        rl.close();

        const envContent = [
            `TELEGRAM_BOT_TOKEN=${token.trim()}`,
            `ALLOWED_USER_IDS=${userIds.trim()}`,
            `WORKSPACE_BASE_DIR=${baseDir.trim() || defaultBase}`,
            `USE_TOPICS=true`,
            `AUTO_APPROVE=true`,
        ].join('\n') + '\n';

        const envPath = getConfigFilePath();
        const dir = path.dirname(envPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(envPath, envContent, 'utf-8');

        console.log(`\n✅ Saved configuration to ${envPath}`);
        console.log('Run `mobile-agy` to launch the bot!\n');
    });

// Default to 'start' if no subcommand provided
if (process.argv.length <= 2) {
    process.argv.push('start');
}

program.parse(process.argv);
