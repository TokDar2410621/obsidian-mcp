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
When the user shares a document that is durably important — a contract, an invoice, an ID/admin paper, a project decision or spec, a reference doc, or anything with a deadline — file it into the cerveau as a RICH note, proactively and WITHOUT being asked:
1. Read the document and create a distilled note with 'create-note' in the right folder ('01-raw/docs/' or the relevant project under '05-projects/'): frontmatter (type: document, tags, created), a short summary, and the key facts/figures/dates.
2. Store the original so it stays openable: if you can read its bytes (a local path, or pasted base64), use 'put-file'; otherwise give the user an upload link with 'get-upload-url' (they upload, you get the link). Put that link in the note under an "Original" heading.
3. Weave it into the cerveau: run 'search-cerveau' on the document's content, then add a "Lié à" section that links the most relevant existing notes as [[wikilinks]]. (search-cerveau uses embeddings, so do this even when ask-cerveau is unavailable.)
Then tell the user exactly what you filed and where. Skip ephemeral noise (newsletters, ads, throwaway receipts). When you are unsure whether a document is important enough, ask before filing rather than cluttering the vault.`;
