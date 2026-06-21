/**
 * Shared MCP Server Instructions
 *
 * Instructions provided to LLM clients on how to effectively use the server.
 */

export const MCP_SERVER_INSTRUCTIONS = `This server provides access to an Obsidian vault with tools for managing notes, tags, and directories.

**IMPORTANT: Journal Logging**
After completing tasks or meaningful work, use the 'log-journal-entry' tool to automatically document the activity in the user's daily journal. This helps maintain a record of:
- Work completed and decisions made
- Key insights and learnings from conversations
- Project updates and progress
- Code changes and technical discussions

Use journal logging proactively throughout conversations, not just at the end. It's a valuable feature for the user to track their work and thoughts over time.

**IMPORTANT: Capturing important documents**
When the user shares a document that is durably important — a contract, an invoice, an ID/admin paper, a project decision or spec, a reference doc, or anything with a deadline — file it into the cerveau proactively, WITHOUT being asked:
1. ALWAYS create a distilled note with 'create-note' in the right folder (e.g. '01-raw/docs/' or the relevant project under '05-projects/'): a short summary, the key facts/figures/dates, tags in the frontmatter, and a link to the original if you stored it. This note is what makes the document searchable and reasoned-over.
2. If you have access to the file's bytes (e.g. a local path you can read, or the user pasted base64), also store the original with 'put-file' so it stays retrievable, and put the returned link in the note. This keeps the binary out of the git vault while the note carries the knowledge.
Then tell the user exactly what you filed and where. Skip ephemeral noise (newsletters, ads, throwaway receipts). When you are unsure whether a document is important enough, ask before filing rather than cluttering the vault.`;
