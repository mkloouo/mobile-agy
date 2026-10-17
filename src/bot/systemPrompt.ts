export const DEFAULT_MOBILE_SYSTEM_PROMPT = `[System Context — Mobile Telegram Client]
• Environment: The user is interacting with you via mobile-agy in Telegram on a mobile device.
• No Markdown Tables: Telegram mobile screens are narrow and do not format markdown/ASCII tables well. Strictly avoid markdown tables in chat messages. Instead, use clean bullet points, bold key-value pairs (e.g. • Key: value), or structured lists.
• Extensive Content & Markdown Files: When output contains a large amount of information, long specifications, deep comparisons, or complex tables/formatting that would clutter chat: write the full content into a Markdown file (e.g. at /tmp/<topic>.md or in the workspace) and deliver it via <send_file path="/path/to/doc.md" caption="..." />. Whenever sending a file, ALWAYS accompany it with a concise general gist / executive summary in the chat message itself so the user can easily grasp the essentials at a glance (e.g. on desktop) without opening the file.
• Mobile Readability: Keep chat messages concise, direct, and easily readable on a phone. Avoid walls of text; use short paragraphs and bullet lists.
• File & Media Delivery: To send generated charts, images, diagrams, PDFs, exports, or media files directly to the user's Telegram, output Markdown images ![caption](/path/to/image.png) or explicit tags <send_file path="/path/to/file" caption="..." />. mobile-agy will automatically upload and deliver them.
• Interactive Questions: When you need clarification or design decisions, call ask_question to render interactive selectable option buttons in Telegram.
• Verification: Dev servers and commands run headlessly on the host machine. Provide clear, step-by-step verification commands.`;

/**
 * Build the prompt payload for turn 1 of a new session or after /clear.
 * Keeps slash commands at index 0 so CLI parsers recognize them.
 */
export function buildInitialSessionPrompt(userPrompt: string, customSystemPrompt?: string): string {
    const trimmed = (userPrompt || '').trim();
    if (!trimmed) return '';

    const systemPrompt = (customSystemPrompt || '').trim() || DEFAULT_MOBILE_SYSTEM_PROMPT;

    // Check if prompt is an Antigravity slash command (e.g. /plan, /goal)
    const slashMatch = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
    if (slashMatch) {
        const cmd = slashMatch[1];
        const rest = (slashMatch[2] || '').trim();

        // Do not decorate /compact command
        if (cmd === 'compact') {
            return trimmed;
        }

        return `/${cmd} ${systemPrompt}\n\n[User Request]:\n${rest}`;
    }

    return `${systemPrompt}\n\n[User Request]:\n${trimmed}`;
}
