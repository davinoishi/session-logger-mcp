# Session Logger MCP

An MCP server that saves and queries LLM chat conversations to structured log files.

## Features

- **save_conversation**: Save the current conversation to a JSONL log file
- **query_logs**: Search saved conversations by session ID, user ID, keyword, or date range
- **list_sessions**: View all saved sessions with summary information

## Installation

1. Install dependencies:
```bash
npm install
```

2. Configure in Claude Desktop or Claude Code:

Add to your MCP settings file:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "session-logger": {
      "command": "node",
      "args": ["/Users/davinoishi/Documents/Projects-AI/session-logger-mcp/index.js"]
    }
  }
}
```

**Claude Code** (`~/.config/claude-code/mcp_config.json`):
```json
{
  "mcpServers": {
    "session-logger": {
      "command": "node",
      "args": ["/Users/davinoishi/Documents/Projects-AI/session-logger-mcp/index.js"]
    }
  }
}
```

3. Restart Claude Desktop or Claude Code

## Usage

### Save a conversation

Simply ask Claude:
```
Save this conversation
```

Claude will use the `save_conversation` tool to log the entire conversation to a JSONL file.

### Query logs

```
Search my logs for conversations about "python"
```

```
Show me all sessions from today
```

### List sessions

```
List my recent chat sessions
```

## Log Storage

Logs are stored in: `~/.session-logger-mcp/logs/`

Format: `YYYY-MM-DD.jsonl`

Each log entry contains:
- timestamp
- session_id
- user_id (if provided)
- role (user/assistant)
- message content
- token count
- model info
- metadata

## Log Rotation

Log files automatically rotate when they exceed 10MB.
