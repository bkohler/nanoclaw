/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from './ipc-mcp.js';
import { getOpenAiTools, runOpenAiTool } from './openai-tools.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  provider?: 'claude' | 'openai';
  openaiModel?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  // sessions-index.json is in the same directory as the transcript
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function readFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function buildOpenAiInstructions(input: ContainerInput): string {
  const globalPath = input.isMain
    ? '/workspace/project/groups/global/CLAUDE.md'
    : '/workspace/global/CLAUDE.md';
  const groupPath = '/workspace/group/CLAUDE.md';

  const globalMemory = readFileIfExists(globalPath);
  const groupMemory = readFileIfExists(groupPath);

  const sections: string[] = [
    'You are a helpful assistant for NanoClaw. Use tools when needed, and keep responses concise.',
    'If asked to remember something, write it to the appropriate memory file using write_file.',
    'Memory files: /workspace/group/CLAUDE.md (group). Global memory is /workspace/project/groups/global/CLAUDE.md for main, or /workspace/global/CLAUDE.md for non-main (read-only).',
  ];

  if (globalMemory) {
    sections.push(`Global memory (read-only for non-main):\n${globalMemory}`);
  }
  if (groupMemory) {
    sections.push(`Group memory:\n${groupMemory}`);
  }

  return sections.join('\n\n');
}

function extractOpenAiOutputText(response: any): string | null {
  if (response?.output_text && typeof response.output_text === 'string') {
    return response.output_text;
  }

  if (!Array.isArray(response?.output)) return null;
  const parts: string[] = [];
  for (const item of response.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content?.type === 'output_text' && typeof content.text === 'string') {
          parts.push(content.text);
        }
        if (content?.type === 'text' && typeof content.text === 'string') {
          parts.push(content.text);
        }
      }
    }
  }
  return parts.length ? parts.join('') : null;
}

async function openAiRequest(body: Record<string, unknown>): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function runOpenAiAgent(
  input: ContainerInput,
  prompt: string,
): Promise<{ result: string | null; newSessionId?: string }> {
  const model = input.openaiModel || process.env.OPENAI_MODEL;
  if (!model) {
    throw new Error('OPENAI_MODEL is required when LLM_PROVIDER=openai');
  }

  const tools = [{ type: 'web_search' }, ...getOpenAiTools()];
  const instructions = buildOpenAiInstructions(input);

  let response = await openAiRequest({
    model,
    input: prompt,
    tools,
    instructions,
    previous_response_id: input.sessionId,
  });

  let guard = 0;
  while (guard < 8) {
    const toolCalls = Array.isArray(response?.output)
      ? response.output.filter((item: any) => item?.type === 'function_call')
      : [];

    if (!toolCalls.length) break;

    const toolOutputs = [];
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }

      const result = await runOpenAiTool(call.name, args, {
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        isMain: input.isMain,
      });

      toolOutputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: result.output,
      });
    }

    response = await openAiRequest({
      model,
      input: toolOutputs,
      tools,
      instructions,
      previous_response_id: response.id,
    });

    guard += 1;
  }

  return {
    result: extractOpenAiOutputText(response),
    newSessionId: response?.id,
  };
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__nanoclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  try {
    const provider = input.provider || process.env.LLM_PROVIDER || 'claude';

    if (provider === 'openai') {
      log('Starting OpenAI provider...');
      const output = await runOpenAiAgent(input, prompt);
      result = output.result;
      newSessionId = output.newSessionId;
    } else {
      log('Starting Claude provider...');

      for await (const message of query({
        prompt,
        options: {
          cwd: '/workspace/group',
          resume: input.sessionId,
          allowedTools: [
            'Bash',
            'Read', 'Write', 'Edit', 'Glob', 'Grep',
            'WebSearch', 'WebFetch',
            'mcp__nanoclaw__*'
          ],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project'],
          mcpServers: {
            nanoclaw: ipcMcp
          },
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook()] }]
          }
        }
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          newSessionId = message.session_id;
          log(`Session initialized: ${newSessionId}`);
        }

        if ('result' in message && message.result) {
          result = message.result as string;
        }
      }
    }

    log('Agent completed successfully');
    writeOutput({
      status: 'success',
      result,
      newSessionId
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
