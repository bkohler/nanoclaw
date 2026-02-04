import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

export interface OpenAiToolContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const ALLOWED_ROOTS = [
  '/workspace/group',
  '/workspace/project',
  '/workspace/global',
];

function resolveSafePath(inputPath: string): string {
  const basePath = inputPath.startsWith('/')
    ? inputPath
    : path.join('/workspace/group', inputPath);
  const resolved = path.resolve(basePath);

  if (!ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(
      `Access denied: ${inputPath}. Allowed roots: ${ALLOWED_ROOTS.join(', ')}`,
    );
  }

  return resolved;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function validateSchedule(scheduleType: string, scheduleValue: string): string | null {
  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(scheduleValue);
    } catch (err) {
      return `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`;
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      return `Invalid interval: "${scheduleValue}". Must be positive milliseconds (e.g., "300000" for 5 min).`;
    }
  } else if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      return `Invalid timestamp: "${scheduleValue}". Use ISO 8601 format like "2026-02-01T15:30:00".`;
    }
  }

  return null;
}

function truncateOutput(text: string, max = 12000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

function listFiles(dir: string, recursive: boolean, maxEntries = 2000): string[] {
  const entries: string[] = [];
  const stack = [dir];

  while (stack.length > 0 && entries.length < maxEntries) {
    const current = stack.pop() as string;
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of dirEntries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) stack.push(fullPath);
      } else if (entry.isFile()) {
        entries.push(fullPath);
        if (entries.length >= maxEntries) break;
      }
    }
  }

  return entries;
}

function searchFiles(
  root: string,
  pattern: string,
  maxResults: number,
  caseSensitive: boolean,
): string {
  const results: string[] = [];
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return `Invalid regex pattern: ${pattern}`;
  }
  const files = listFiles(root, true, 5000);

  for (const filePath of files) {
    if (results.length >= maxResults) break;
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        results.push(`${filePath}:${i + 1}:${lines[i]}`);
        if (results.length >= maxResults) break;
      }
    }
  }

  return results.join('\n');
}

export function getOpenAiTools() {
  return [
    {
      type: 'function',
      name: 'send_message',
      description:
        'Send a message to the current WhatsApp group. Use this to proactively share information or updates.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message text to send' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'schedule_task',
      description:
        'Schedule a recurring or one-time task. The task will run as a full agent with access to tools. Use context_mode "group" for tasks needing conversation context; "isolated" for self-contained tasks.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the agent should do when the task runs.' },
          schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
          schedule_value: { type: 'string', description: 'cron: "0 9 * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00"' },
          context_mode: { type: 'string', enum: ['group', 'isolated'], default: 'group' },
          target_group: { type: 'string', description: 'Target group folder (main only). Defaults to current group.' },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_tasks',
      description:
        "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      type: 'function',
      name: 'pause_task',
      description: 'Pause a scheduled task. It will not run until resumed.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to pause' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'resume_task',
      description: 'Resume a paused task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to resume' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to cancel' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'register_group',
      description:
        'Register a new WhatsApp group so the agent can respond to messages there. Main group only.',
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string', description: 'The WhatsApp JID (e.g., "120363336345536173@g.us")' },
          name: { type: 'string', description: 'Display name for the group' },
          folder: { type: 'string', description: 'Folder name (lowercase, hyphens)' },
          trigger: { type: 'string', description: 'Trigger word (e.g., "@Andy")' },
        },
        required: ['jid', 'name', 'folder', 'trigger'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a text file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (absolute or relative to /workspace/group)' },
          max_bytes: { type: 'number', description: 'Maximum bytes to read (default 200000)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'write_file',
      description: 'Write or append text to a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file (absolute or relative to /workspace/group)' },
          content: { type: 'string', description: 'Text content to write' },
          mode: { type: 'string', enum: ['overwrite', 'append'], default: 'overwrite' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_files',
      description: 'List files in a directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (absolute or relative to /workspace/group)' },
          recursive: { type: 'boolean', description: 'List files recursively' },
          max_entries: { type: 'number', description: 'Maximum files to return (default 2000)' },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'search_files',
      description: 'Search files for a regex pattern.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Root directory (absolute or relative to /workspace/group)' },
          pattern: { type: 'string', description: 'Regex pattern' },
          max_results: { type: 'number', description: 'Maximum matches (default 50)' },
          case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default false)' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  ];
}

export async function runOpenAiTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: OpenAiToolContext,
): Promise<{ output: string }> {
  const args = rawArgs || {};
  const { chatJid, groupFolder, isMain } = ctx;

  switch (name) {
    case 'send_message': {
      const text = String(args.text || '');
      if (!text) return { output: 'Error: text is required.' };
      const data = {
        type: 'message',
        chatJid,
        text,
        groupFolder,
        timestamp: new Date().toISOString(),
      };
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { output: `Message queued for delivery (${filename})` };
    }

    case 'schedule_task': {
      const prompt = String(args.prompt || '');
      const scheduleType = String(args.schedule_type || '');
      const scheduleValue = String(args.schedule_value || '');
      const contextMode = String(args.context_mode || 'group');
      const targetGroup = isMain && args.target_group
        ? String(args.target_group)
        : groupFolder;

      if (!prompt || !scheduleType || !scheduleValue) {
        return { output: 'Error: prompt, schedule_type, and schedule_value are required.' };
      }

      const validationError = validateSchedule(scheduleType, scheduleValue);
      if (validationError) return { output: validationError };

      const data = {
        type: 'schedule_task',
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        context_mode: contextMode || 'group',
        groupFolder: targetGroup,
        chatJid,
        createdBy: groupFolder,
        timestamp: new Date().toISOString(),
      };
      const filename = writeIpcFile(TASKS_DIR, data);
      return { output: `Task scheduled (${filename}): ${scheduleType} - ${scheduleValue}` };
    }

    case 'list_tasks': {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
      if (!fs.existsSync(tasksFile)) {
        return { output: 'No scheduled tasks found.' };
      }

      try {
        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const tasks = isMain
          ? allTasks
          : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);
        if (!tasks.length) return { output: 'No scheduled tasks found.' };
        const formatted = tasks
          .map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
          )
          .join('\n');
        return { output: `Scheduled tasks:\n${formatted}` };
      } catch (err) {
        return { output: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    case 'pause_task': {
      const taskId = String(args.task_id || '');
      if (!taskId) return { output: 'Error: task_id is required.' };
      writeIpcFile(TASKS_DIR, {
        type: 'pause_task',
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return { output: `Task ${taskId} pause requested.` };
    }

    case 'resume_task': {
      const taskId = String(args.task_id || '');
      if (!taskId) return { output: 'Error: task_id is required.' };
      writeIpcFile(TASKS_DIR, {
        type: 'resume_task',
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return { output: `Task ${taskId} resume requested.` };
    }

    case 'cancel_task': {
      const taskId = String(args.task_id || '');
      if (!taskId) return { output: 'Error: task_id is required.' };
      writeIpcFile(TASKS_DIR, {
        type: 'cancel_task',
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString(),
      });
      return { output: `Task ${taskId} cancellation requested.` };
    }

    case 'register_group': {
      if (!isMain) {
        return { output: 'Only the main group can register new groups.' };
      }
      const jid = String(args.jid || '');
      const name = String(args.name || '');
      const folder = String(args.folder || '');
      const trigger = String(args.trigger || '');

      if (!jid || !name || !folder || !trigger) {
        return { output: 'Error: jid, name, folder, and trigger are required.' };
      }

      writeIpcFile(TASKS_DIR, {
        type: 'register_group',
        jid,
        name,
        folder,
        trigger,
        timestamp: new Date().toISOString(),
      });

      return { output: `Group "${name}" registered. It will start receiving messages immediately.` };
    }

    case 'read_file': {
      const filePath = String(args.path || '');
      const maxBytes = typeof args.max_bytes === 'number' ? args.max_bytes : 200000;
      if (!filePath) return { output: 'Error: path is required.' };
      const resolved = resolveSafePath(filePath);
      const stats = fs.statSync(resolved);
      if (!stats.isFile()) return { output: `Error: not a file: ${resolved}` };
      const data = fs.readFileSync(resolved, { encoding: 'utf-8' });
      const sliced = data.slice(0, maxBytes);
      return { output: truncateOutput(sliced) };
    }

    case 'write_file': {
      const filePath = String(args.path || '');
      const content = String(args.content || '');
      const mode = String(args.mode || 'overwrite');
      if (!filePath) return { output: 'Error: path is required.' };
      const resolved = resolveSafePath(filePath);
      if (!ctx.isMain && resolved.startsWith('/workspace/global')) {
        return { output: 'Error: global memory is read-only outside the main group.' };
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      if (mode === 'append') {
        fs.appendFileSync(resolved, content);
      } else {
        fs.writeFileSync(resolved, content);
      }
      return { output: `Wrote ${content.length} characters to ${resolved}` };
    }

    case 'list_files': {
      const dirPath = String(args.path || '/workspace/group');
      const recursive = Boolean(args.recursive);
      const maxEntries = typeof args.max_entries === 'number' ? args.max_entries : 2000;
      const resolved = resolveSafePath(dirPath);
      const files = listFiles(resolved, recursive, maxEntries);
      if (!files.length) return { output: 'No files found.' };
      return { output: truncateOutput(files.join('\n')) };
    }

    case 'search_files': {
      const dirPath = String(args.path || '/workspace/group');
      const pattern = String(args.pattern || '');
      const maxResults = typeof args.max_results === 'number' ? args.max_results : 50;
      const caseSensitive = Boolean(args.case_sensitive);
      if (!pattern) return { output: 'Error: pattern is required.' };
      const resolved = resolveSafePath(dirPath);
      const matches = searchFiles(resolved, pattern, maxResults, caseSensitive);
      return { output: truncateOutput(matches || 'No matches found.') };
    }

    default:
      return { output: `Error: unknown tool "${name}".` };
  }
}
