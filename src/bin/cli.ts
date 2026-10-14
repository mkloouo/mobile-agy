import { Command } from 'commander';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../utils/config';
import { createBot } from '../bot';
import { logger } from '../utils/logger';

const program = new Command();

program
    .name('mobile-friendly-agy')
    .description('Mobile-friendly Telegram interface for Antigravity CLI')
    .version('0.1.0');

program
    .command('start')
    .description('Start the Telegram bot daemon')
    .action(async () => {
        const config = loadConfig();
        if (!config.telegramBotToken) {
            console.error('\n❌ Error: TELEGRAM_BOT_TOKEN is missing!');
            console.log('Run `npm run start -- setup` or create a `.env` file with your token.\n');
            process.exit(1);
        }

        logger.info('Starting Mobile-Friendly Antigravity Telegram Bot...');
        logger.info(`Workspace Base Dir: ${config.workspaceBaseDir}`);
        logger.info(`Allowed User IDs: ${config.allowedUserIds.length > 0 ? config.allowedUserIds.join(', ') : 'All (Unrestricted)'}`);

        const { bot } = createBot(config);

        // Graceful shutdown
        process.once('SIGINT', () => {
            logger.info('Stopping bot...');
            bot.stop();
            process.exit(0);
        });
        process.once('SIGTERM', () => {
            logger.info('Stopping bot...');
            bot.stop();
            process.exit(0);
        });

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
        const defaultBase = path.resolve(process.cwd(), '..');
        const baseDir = await question(`3. Workspace projects directory (default: ${defaultBase}): `);

        rl.close();

        const envContent = [
            `TELEGRAM_BOT_TOKEN=${token.trim()}`,
            `ALLOWED_USER_IDS=${userIds.trim()}`,
            `WORKSPACE_BASE_DIR=${baseDir.trim() || defaultBase}`,
            `USE_TOPICS=true`,
            `AUTO_APPROVE=true`,
        ].join('\n') + '\n';

        const envPath = path.resolve(process.cwd(), '.env');
        fs.writeFileSync(envPath, envContent, 'utf-8');

        console.log(`\n✅ Saved configuration to ${envPath}`);
        console.log('Run `npm start` or `npm run dev` to launch the bot!\n');
    });

program.parse(process.argv);
