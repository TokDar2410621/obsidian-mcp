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

RULE — "put this file in the cerveau" (or any request to add/save a file) ALWAYS means BOTH, never one without the other:
(a) store the file in the bucket — 'put-file' when you have the bytes (a local path or pasted base64), otherwise 'get-upload-url' and have the user upload; AND
(b) create a NOTE in the vault that summarizes the file and links to it — a short summary, the key points, [[wikilinks]] to related notes (run 'search-cerveau' first), tags, and the bucket key/download link under an "Original" heading.
The bucket keeps the binary; the note makes the knowledge searchable by the RAG. A file in the bucket with no note is invisible; a note with no stored file loses the original. So always do both.

When the user shares a document that is durably important — a contract, an invoice, an ID/admin paper, a project decision or spec, a reference doc, or anything with a deadline — file it into the cerveau as a RICH note, proactively and WITHOUT being asked:
1. Read the document and create a distilled note with 'create-note' in the right folder ('01-raw/docs/' or the relevant project under '05-projects/'): frontmatter (type: document, tags, created), a short summary, and the key facts/figures/dates.
2. Store the original so it stays openable: if you can read its bytes (a local path, or pasted base64), use 'put-file'; otherwise give the user an upload link with 'get-upload-url' (they upload, you get the link). Put that link in the note under an "Original" heading.
3. Weave it into the cerveau: run 'search-cerveau' on the document's content, then add a "Lié à" section that links the most relevant existing notes as [[wikilinks]]. (search-cerveau uses embeddings, so do this even when ask-cerveau is unavailable.)
Then tell the user exactly what you filed and where. Skip ephemeral noise (newsletters, ads, throwaway receipts). When you are unsure whether a document is important enough, ask before filing rather than cluttering the vault.

**IMPORTANT: Objectives (open loops)**

The vault tracks goals as objective notes: frontmatter 'type: objectif', 'statut: ouvert | complet | en-retard | abandonne', optional 'echeance' (YYYY-MM-DD), conditions as checkboxes carrying exact criteria and a proof wikilink. Template: '_templates/objectif.md'. Routed like any note (no dedicated folder); find them by frontmatter, never by location.

RULE — after ANY capture or ingestion into the vault, sweep the open objectives: 'search-vault' for 'type: objectif' + 'statut: ouvert', confront the new info with each unmet condition's criteria. Every criterion verifiable with citable proof: tick the box and fill 'Preuve :' with the [[wikilink]] and the date. Any doubt: propose the tick in '08-auto/_inbox-darius.md' instead — never tick without proof. Deadline passed with open conditions: set 'statut: en-retard'. All conditions ticked: set 'statut: complet'.

Announce only when: a condition was just met (one line), an objective is complete (list the verified criteria — never a bare "you have everything"), a deadline falls within 7 days with open conditions, or a blocker exists. The server also runs a deterministic sweep that stages candidate matches and deadline alerts under '08-auto/_objectifs-propositions.md' — review them, verify criteria, then tick with proof or dismiss.`;
