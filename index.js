#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import express from "express";
import cors from "cors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const LOG_DIR = path.join(os.homedir(), ".session-logger-mcp", "logs");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file

// Ensure log directory exists
await fs.mkdir(LOG_DIR, { recursive: true });

class SessionLoggerServer {
  constructor() {
    this.server = new Server(
      {
        name: "session-logger-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "save_conversation",
          description:
            "Save the current conversation to a structured log file. Captures all messages with metadata including timestamps, session ID, and message content.",
          inputSchema: {
            type: "object",
            properties: {
              messages: {
                type: "array",
                description: "Array of conversation messages to save",
                items: {
                  type: "object",
                  properties: {
                    role: {
                      type: "string",
                      enum: ["user", "assistant"],
                      description: "The role of the message sender",
                    },
                    content: {
                      type: "string",
                      description: "The message content",
                    },
                  },
                  required: ["role", "content"],
                },
              },
              session_id: {
                type: "string",
                description: "Optional session identifier. Auto-generated if not provided.",
              },
              user_id: {
                type: "string",
                description: "Optional user identifier",
              },
              metadata: {
                type: "object",
                description: "Optional additional metadata (model, temperature, etc.)",
              },
            },
            required: ["messages"],
          },
        },
        {
          name: "query_logs",
          description:
            "Search and retrieve saved conversation logs by session ID, date range, or keyword pattern.",
          inputSchema: {
            type: "object",
            properties: {
              session_id: {
                type: "string",
                description: "Filter by session ID",
              },
              user_id: {
                type: "string",
                description: "Filter by user ID",
              },
              keyword: {
                type: "string",
                description: "Search for keyword in message content",
              },
              start_date: {
                type: "string",
                description: "Start date in ISO format (e.g., 2025-10-01)",
              },
              end_date: {
                type: "string",
                description: "End date in ISO format (e.g., 2025-10-04)",
              },
              limit: {
                type: "number",
                description: "Maximum number of results to return (default: 50)",
                default: 50,
              },
            },
          },
        },
        {
          name: "list_sessions",
          description:
            "List all saved session IDs with summary information (date, message count, etc.)",
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: "Maximum number of sessions to return (default: 20)",
                default: 20,
              },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "save_conversation") {
        return await this.handleSaveConversation(request.params.arguments);
      } else if (request.params.name === "query_logs") {
        return await this.handleQueryLogs(request.params.arguments);
      } else if (request.params.name === "list_sessions") {
        return await this.handleListSessions(request.params.arguments);
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  async handleSaveConversation(args) {
    try {
      const { messages, session_id, user_id, metadata } = args;
      const sessionId = session_id || this.generateSessionId();
      const timestamp = new Date().toISOString();

      // Create log entries for each message
      const logEntries = messages.map((msg, index) => ({
        timestamp: new Date(Date.now() + index).toISOString(), // Slight offset for ordering
        session_id: sessionId,
        user_id: user_id || null,
        role: msg.role,
        message: msg.content,
        tokens: msg.content.split(/\s+/).length, // Simple word count approximation
        latency_ms: null,
        model: metadata?.model || null,
        metadata: metadata || {},
      }));

      // Determine log file path
      const date = new Date().toISOString().split("T")[0];
      const logFile = path.join(LOG_DIR, `${date}.jsonl`);

      // Append to JSONL file
      const jsonlContent =
        logEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
      await fs.appendFile(logFile, jsonlContent);

      // Check file size and rotate if needed
      await this.rotateLogIfNeeded(logFile);

      return {
        content: [
          {
            type: "text",
            text: `✓ Saved ${messages.length} messages to session ${sessionId}\nLog file: ${logFile}\nTimestamp: ${timestamp}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error saving conversation: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleQueryLogs(args) {
    try {
      const { session_id, user_id, keyword, start_date, end_date, limit = 50 } = args;

      // Get all log files
      const files = await fs.readdir(LOG_DIR);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();

      let results = [];

      // Read and filter logs
      for (const file of jsonlFiles) {
        const filePath = path.join(LOG_DIR, file);
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Apply filters
            if (session_id && entry.session_id !== session_id) continue;
            if (user_id && entry.user_id !== user_id) continue;
            if (keyword && !entry.message.toLowerCase().includes(keyword.toLowerCase()))
              continue;
            if (start_date && entry.timestamp < start_date) continue;
            if (end_date && entry.timestamp > end_date) continue;

            results.push(entry);

            if (results.length >= limit) break;
          } catch (e) {
            // Skip invalid JSON lines
          }
        }

        if (results.length >= limit) break;
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} matching log entries:\n\n${JSON.stringify(
              results,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error querying logs: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleListSessions(args) {
    try {
      const { limit = 20 } = args;

      // Get all log files
      const files = await fs.readdir(LOG_DIR);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort().reverse();

      const sessionMap = new Map();

      // Read logs and aggregate by session
      for (const file of jsonlFiles) {
        const filePath = path.join(LOG_DIR, file);
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const sid = entry.session_id;

            if (!sessionMap.has(sid)) {
              sessionMap.set(sid, {
                session_id: sid,
                first_timestamp: entry.timestamp,
                last_timestamp: entry.timestamp,
                message_count: 0,
                user_id: entry.user_id,
              });
            }

            const session = sessionMap.get(sid);
            session.message_count++;
            session.last_timestamp = entry.timestamp;
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }

      const sessions = Array.from(sessionMap.values())
        .sort((a, b) => b.last_timestamp.localeCompare(a.last_timestamp))
        .slice(0, limit);

      return {
        content: [
          {
            type: "text",
            text: `Found ${sessions.length} sessions:\n\n${JSON.stringify(
              sessions,
              null,
              2
            )}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error listing sessions: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async rotateLogIfNeeded(logFile) {
    try {
      const stats = await fs.stat(logFile);
      if (stats.size > MAX_LOG_SIZE) {
        const timestamp = Date.now();
        const newName = logFile.replace(".jsonl", `.${timestamp}.jsonl`);
        await fs.rename(logFile, newName);
      }
    } catch (error) {
      // File might not exist yet, that's ok
    }
  }

  async run() {
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(cors());
    app.use(express.json());

    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });

    app.post("/sse", async (req, res) => {
      console.error("Client connected via SSE");

      const transport = new SSEServerTransport("/message", res);
      await this.server.connect(transport);

      req.on("close", () => {
        console.error("Client disconnected");
      });
    });

    app.listen(PORT, () => {
      console.error(`Session Logger MCP server running on http://localhost:${PORT}`);
      console.error(`Health check: http://localhost:${PORT}/health`);
      console.error(`SSE endpoint: http://localhost:${PORT}/sse`);
    });
  }
}

const server = new SessionLoggerServer();
server.run().catch(console.error);
