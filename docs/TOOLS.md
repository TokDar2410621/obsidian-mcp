# Tool Reference

Complete documentation for all 24 MCP tools provided by the Obsidian MCP Server.

## Table of Contents

- [File Operations](#file-operations)
- [Directory Operations](#directory-operations)
- [Search](#search)
- [Retrieval (RAG)](#retrieval-rag)
- [Synapses (thinking)](#synapses-thinking)
- [Tag Management](#tag-management)
- [Journal Logging](#journal-logging)

## File Operations

### read-note

Read the contents of a note file.

#### Parameters

- `path` (string, required) - Path to the note file (e.g., "folder/note.md")

#### Example

```
"Read my project note at Projects/MCP-Server.md"
```

---

### read-notes

Read multiple notes in a single request for improved efficiency.

#### Parameters

- `paths` (array of strings, required) - Array of note file paths

#### Features

- Handles partial success (returns successful reads even if some files fail)
- More efficient than multiple `read-note` calls

#### Example

```
"Read all my daily notes from Journal/2024-01.md, Journal/2024-02.md, and Journal/2024-03.md"
```

---

### create-note

Create a new note with content.

#### Parameters

- `path` (string, required) - Path for the new note
- `content` (string, required) - Content of the note
- `overwrite` (boolean, optional, default: false) - Overwrite if file exists

#### Features

- Automatically creates parent directories if needed
- Fails if file exists (unless overwrite is true)

#### Example

```
"Create a new meeting note in Work/Meetings/2024-01-15.md with the standup agenda"
```

---

### edit-note

Replace the entire content of an existing note.

#### Parameters

- `path` (string, required) - Path to the note to edit
- `content` (string, required) - New content (replaces entire file)

#### Example

```
"Replace the content of my README.md with an updated version"
```

---

### delete-note

Permanently delete a note file from the vault.

#### Parameters

- `path` (string, required) - Path to the file to delete
- `confirm` (boolean, required) - Must be true to confirm deletion

#### Example

```
"Delete the old draft at Drafts/old-ideas.md"
```

---

### move-note

Move a note to a different directory or rename it.

#### Parameters

- `source_path` (string, required) - Current path of the file
- `destination_path` (string, required) - New path for the file
- `overwrite` (boolean, optional, default: false) - Overwrite if destination exists

#### Example

```
"Move Work/temp.md to Archive/2024/temp.md"
```

---

### append-content

Append content to the end of an existing note, or create a new note if it doesn't exist.

#### Parameters

- `path` (string, required) - Path to the file
- `content` (string, required) - Content to append
- `create_if_missing` (boolean, optional, default: true) - Create file if it doesn't exist
- `newline` (boolean, optional, default: true) - Add newline before content

#### Example

```
"Add a new task to my TODO.md: '- Review pull requests'"
```

---

### patch-content

Insert or update content at specific locations using semantic anchors.

#### Parameters

- `path` (string, required) - Path to the file
- `content` (string, required) - Content to insert
- `anchor_type` (string, required) - Type of anchor: "heading", "block", "frontmatter", or "text_match"
- `anchor_value` (string, required) - The anchor to match (heading name, block ID, frontmatter key, or text content)
- `position` (string, required) - Where to insert: "before", "after", or "replace"
- `create_if_missing` (boolean, optional, default: true) - Create file if missing

#### Anchor Types

#### heading

Matches Markdown headings (e.g., `## Section Title`).

#### Example

```
"Add a new section after the '## Introduction' heading"
```

#### block

Matches Obsidian block identifiers (e.g., `^block-id`).

#### Example

```
"Insert content after the paragraph with ^important-note"
```

#### frontmatter

Updates YAML frontmatter key-value pairs. Creates frontmatter if it doesn't exist. Position is always 'replace'.

#### Example

```
"Update the tags in the frontmatter to include 'project' and 'active'"
```

#### text_match

Matches exact text content (single-line or multi-line). **Recommended for precise targeting.**

#### Features

- Multi-line support: Use `\n` to match multiple consecutive lines for uniqueness
- Ambiguity detection: Fails with helpful error if pattern matches multiple locations
- Error guidance: Shows all match locations with context
- Exact whitespace matching (preserves spaces, tabs, indentation)

#### Example

```
"Insert a note after the paragraph that says 'This is important'"
```

#### When to use text_match

- Need precise content matching without relying on line numbers
- Same text appears multiple times (add surrounding lines for uniqueness)
- Want to ensure match is still valid even if file content changes

---

### apply-diff-patch

Apply a unified diff patch to a file using standard diff format.

#### Parameters

- `path` (string, required) - Path to the file to patch
- `diff` (string, required) - Unified diff patch in standard format

#### Features

- Supports multi-hunk diffs (multiple changes in one patch)
- Strict matching (no fuzz) - patch must match current file content exactly
- Standard unified diff format (same as git diff)

#### Example diff format

```
@@ -10,3 +10,3 @@
 Context line before
-Old content to replace
+New content here
 Context line after
```

#### When to use

- You have a unified diff patch from another source or tool
- Want to make multiple precise changes at specific line numbers
- Prefer standard diff format over anchor-based patching
- LLM naturally generated changes in diff format

#### Comparison with patch-content

- `patch-content` uses semantic anchors (headings, blocks, text patterns) - better when file structure changes
- `apply-diff-patch` uses line numbers - better for precise, multiple edits at known locations

---

## Directory Operations

### create-directory

Create a new directory in the vault.

#### Parameters

- `path` (string, required) - Path for the new directory
- `recursive` (boolean, optional, default: true) - Create parent directories

#### Example

```
"Create a new folder structure: Projects/2024/Q1"
```

---

### list-files-in-vault

List all files in the vault root.

#### Parameters

- `file_types` (array of strings, optional) - Filter by file extensions (e.g., ["md", "pdf"])
- `include_directories` (boolean, optional, default: false) - Include directories in results
- `recursive` (boolean, optional, default: true) - List files recursively

#### Example

```
"Show me all markdown files in my vault"
```

---

### list-files-in-dir

List files in a specific directory.

#### Parameters

- `path` (string, required) - Directory path to list
- `file_types` (array of strings, optional) - Filter by file extensions
- `include_directories` (boolean, optional, default: false) - Include directories in results
- `recursive` (boolean, optional, default: true) - List files recursively

#### Example

```
"List all PDFs in my Resources folder"
```

---

## Search

### search-vault

Fuzzy or exact search across vault filenames and content with relevance scoring.

#### Parameters

- `query` (string, required) - Search query string
- `exact` (boolean, optional, default: false) - Use exact substring matching instead of fuzzy search
- `file_types` (array of strings, optional, default: ["md"]) - Filter by file extensions
- `limit` (number, optional, default: 50) - Maximum number of results
- `path_filter` (string, optional) - Filter results by path pattern

#### Features

- Fuzzy search powered by fuse.js with relevance scoring
- Optional exact substring matching
- Context lines around matches
- File type filtering
- Path pattern filtering

#### Examples

Fuzzy search:

```
"Find all my notes about machine learning"
```

Exact search:

```
"Search for the exact phrase 'TODO: review this'"
```

Search in specific folder:

```
"Search my Projects folder for anything about deployment"
```

---

## Tag Management

### add-tags

Add tags to a note (frontmatter or inline).

#### Parameters

- `path` (string, required) - Path to the note
- `tags` (array of strings, required) - Tags to add (without # prefix)
- `location` (string, optional, default: "frontmatter") - Where to add tags: "frontmatter", "inline", or "both"
- `deduplicate` (boolean, optional, default: true) - Remove duplicate tags

#### Example

```
"Add the tags 'project' and 'urgent' to my meeting note"
```

---

### remove-tags

Remove tags from a note.

#### Parameters

- `path` (string, required) - Path to the note
- `tags` (array of strings, required) - Tags to remove (without # prefix)
- `location` (string, optional, default: "both") - Where to remove from: "frontmatter", "inline", or "both"

#### Example

```
"Remove the 'draft' tag from my completed article"
```

---

### rename-tag

Rename a tag across all notes in the vault.

#### Parameters

- `old_tag` (string, required) - Tag to rename (without # prefix)
- `new_tag` (string, required) - New tag name (without # prefix)
- `case_sensitive` (boolean, optional, default: false) - Case-sensitive matching
- `dry_run` (boolean, optional, default: false) - Preview changes without applying

#### Features

- Updates both frontmatter and inline tags
- Works across all notes in vault
- Dry run mode to preview changes

#### Example

```
"Rename all 'todo' tags to 'task' across my vault"
```

---

### manage-tags

List, count, or merge tags across the vault.

#### Parameters

- `action` (string, required) - Action to perform: "list", "count", or "merge"
- `tag` (string, optional) - Tag to operate on (for count action)
- `merge_into` (string, optional) - Target tag for merge action
- `include_nested` (boolean, optional, default: true) - Include nested tags
- `sort_by` (string, optional, default: "name") - Sort results by: "name" or "count"

#### Actions

#### list

List all tags in the vault with usage counts.

#### Example

```
"Show me all the tags I'm using in my vault"
```

#### count

Count usage of a specific tag.

#### Example

```
"How many notes use the 'project' tag?"
```

#### merge

Merge multiple tags into a single tag.

#### Example

```
"Merge my 'todo' and 'task' tags into a single 'task' tag"
```

---

## Journal Logging

### log-journal-entry

Automatically log work to today's journal entry.

#### Parameters

- `activity_type` (string, required) - Type of activity: "development", "research", "writing", "planning", "learning", or "problem-solving"
- `summary` (string, required) - 1-2 sentence summary of the work
- `key_topics` (array of strings, required) - 2-4 main topics/technologies involved
- `outputs` (array of strings, optional) - Concrete deliverables or artifacts created
- `project` (string, optional) - Related project for linking (e.g., "Projects/Obsidian MCP")

#### Features

- Auto-creates journal from template if it doesn't exist
- Adds timestamped entries to configured section
- Links to related projects
- Formatted with activity type, topics, and outputs

#### Configuration (in .env)

- `JOURNAL_PATH_TEMPLATE` - Path template with `{{date}}` placeholder (e.g., "Journal/{{date}}.md")
- `JOURNAL_DATE_FORMAT` - Date format for template expansion (e.g., "YYYY-MM-DD")
- `JOURNAL_ACTIVITY_SECTION` - Heading for journal entries (e.g., "## Activity")
- `JOURNAL_FILE_TEMPLATE` - Template file for new journals (e.g., "Templates/daily-note.md")

#### Example

```
"Log today's work: I implemented OAuth for the MCP server using TypeScript and AWS Lambda"
```

This will create an entry like:

```markdown
### 14:30 - Development

Implemented OAuth for the MCP server using TypeScript and AWS Lambda.

**Topics**: TypeScript, AWS Lambda, OAuth
**Outputs**:

- OAuth 2.0 flow with PKCE
- DynamoDB session storage
- Lambda handler implementation
```

## Retrieval (RAG)

Semantic retrieval over the vault using OpenAI embeddings + a local in-memory
vector index, with answer generation by Claude. These tools are **optional** —
they are registered only when `OPENAI_API_KEY` is set (and `ask-cerveau`
additionally requires `ANTHROPIC_API_KEY`). Available in HTTP/stdio modes only.
See the RAG section of `.env.example` for configuration.

---

### search-cerveau

Semantic search across the vault — finds notes by meaning (embeddings),
complementing the keyword-based `search-vault`. Returns ranked note chunks.

#### Parameters

- `query` (string, required) - Natural-language query
- `top_k` (number, optional, default: 8, max: 30) - Number of chunks to return
- `folder` (string, optional) - Restrict to a path prefix (e.g. `05-projects/`)
- `tags` (array of strings, optional) - Restrict to notes with any of these frontmatter tags

#### Output

- `results` - Ranked array of `{ path, wikilink, heading, tags, score, excerpt }`
- `total` (number) - Number of results

#### Example

```
"Find notes about the Redis dual-database pattern"
```

---

### ask-cerveau

Answer a question using the knowledge in the vault (full RAG). Retrieves the
most relevant notes semantically, then has Claude write a grounded answer with
`[[wikilink]]` citations to the source notes.

#### Parameters

- `question` (string, required) - Question to answer from the vault
- `top_k` (number, optional, default: 8, max: 30) - Chunks to retrieve as context
- `folder` (string, optional) - Restrict retrieval to a path prefix
- `tags` (array of strings, optional) - Restrict retrieval to notes with any of these tags

#### Output

- `answer` (string) - Grounded answer with inline `[[wikilink]]` citations
- `citations` - Array of `{ path, wikilink, heading, score, excerpt }` for the notes used
- `used_chunks` (number) - How many chunks were sent to the model as context

#### Example

```
"What did I decide about Stripe Connect for the SendMeNow project?"
```

#### Reindexing

The embedding index builds on first boot and updates incrementally. Configure a
GitHub push webhook to `POST /webhook/github` (with `GITHUB_WEBHOOK_SECRET`) to
re-embed changed notes automatically on every push.

## Synapses (thinking)

Synapses reuses the RAG embedding index to compare notes **to each other** (not
to a query), surfacing connections the vault leaves implicit. All four tools are
read-only — propose-only, they never edit notes — and are registered only when
both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are set. A weekly cron can also
write a `00-synapses.md` digest into the vault (see `SYNAPSES_*` in `.env.example`).
Each analysis is bounded to a single LLM call.

---

### suggest-links

Find pairs of notes that are semantically related but not yet linked by a
wikilink, prioritising cross-project ("invisible") connections.

#### Parameters

- `folder` (string, optional) - Restrict to notes whose path starts with this prefix
- `top_k` (number, optional, default: 12, max: 30) - Maximum suggestions to return

#### Output

- `suggestions` - Array of `{ a, b, score, reason, liaison }` (a/b are note paths)
- `total` (number)

#### Example

```
"Quels liens manquent dans mon cerveau ?"
```

---

### audit-coherence

Detect coherence problems across the vault: decisions/specs that contradict each
other, notes that make others stale, and near-duplicate notes to merge.

#### Parameters

- `folder` (string, optional) - Restrict to notes whose path starts with this prefix

#### Output

- `issues` - Array of `{ type, a, b, score, explanation }` where `type` is `contradiction` | `stale` | `duplicate`
- `total` (number)

#### Example

```
"Y a-t-il des décisions qui se contredisent dans mes notes ?"
```

---

### find-themes

Cluster the vault by meaning and name the emergent themes that cut across
projects, flagging clusters forming mostly from recent captures/daily notes.

#### Parameters

- `folder` (string, optional) - Restrict to notes whose path starts with this prefix
- `min_cluster_size` (number, optional, default: 3) - Minimum notes per theme

#### Output

- `themes` - Array of `{ name, summary, notes, emerging }`
- `total` (number)

#### Example

```
"Quels thèmes émergent dans mon cerveau en ce moment ?"
```

---

### cerveau-digest

Run all three analyses and return a single Markdown digest of the vault. Read-only —
it does not write the digest note (the weekly cron does that).

#### Parameters

_None._

#### Output

- `markdown` (string) - The rendered digest

#### Example

```
"Fais-moi le bilan Synapses de mon cerveau."
```
