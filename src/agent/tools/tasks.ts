import fs from 'node:fs';
import path from 'node:path';
import * as chrono from 'chrono-node';
import type { ToolHandler } from './registry.js';
import type { ConflictDetector } from '../../editing/conflict-detector.js';
import { localDateString } from '../../utils/date.js';
import { resolveVaultPath } from '../../utils/paths.js';

export function createTaskTools(vaultPath: string, conflictDetector?: ConflictDetector): ToolHandler[] {
  return [
    {
      definition: {
        name: 'task_list',
        description: 'List tasks from diary and planning notes. Returns tasks with their status (checked/unchecked).',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['all', 'pending', 'completed'], description: 'Filter by task status' },
            project: { type: 'string', description: 'Filter by project mention' },
            days: { type: 'number', description: 'How many days of diary history to scan (default 90)' },
          },
        },
      },
      execute: async (args) => {
        const tasks: Array<{ text: string; completed: boolean; source: string; date?: string }> = [];
        const diaryDir = path.join(vaultPath, 'Memory', 'Daily');

        if (!fs.existsSync(diaryDir)) return JSON.stringify(tasks);

        const windowDays = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : 90;
        const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, windowDays);

        for (const file of files) {
          const content = fs.readFileSync(path.join(diaryDir, file), 'utf-8');
          const date = file.replace('.md', '');
          const taskRegex = /^- \[([ x])\] (.+)$/gm;
          let match;
          while ((match = taskRegex.exec(content)) !== null) {
            const completed = match[1] === 'x';
            const text = match[2];

            if (args.status === 'pending' && completed) continue;
            if (args.status === 'completed' && !completed) continue;
            if (args.project && !text.toLowerCase().includes((args.project as string).toLowerCase())) continue;

            tasks.push({ text, completed, source: `Memory/Daily/${file}`, date });
          }
        }

        return JSON.stringify(tasks);
      },
    },
    {
      definition: {
        name: 'task_add',
        description: "Add a task to today's diary note. Creates the diary note if it doesn't exist. Triggers safe edit flow.",
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Task description' },
            deadline: { type: 'string', description: 'Optional deadline (ISO date or natural language)' },
            project: { type: 'string', description: 'Optional project association' },
          },
          required: ['description'],
        },
      },
      execute: async (args) => {
        const today = localDateString();
        const diaryPath = `Memory/Daily/${today}.md`;
        const fullPath = resolveVaultPath(vaultPath, diaryPath);
        const exists = fs.existsSync(fullPath);

        let content: string;
        if (exists) {
          content = fs.readFileSync(fullPath, 'utf-8');
          conflictDetector?.recordFileRead(fullPath, content);
        } else {
          content = `---\ndate: ${today}\ntype: daily-diary\n---\n\n# ${today}\n\n## Tasks\n`;
        }

        let taskLine = `- [ ] ${args.description}`;
        if (args.deadline) {
          const raw = String(args.deadline);
          const parsed = chrono.parseDate(raw, new Date(), { forwardDate: true });
          const iso = parsed
            ? `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
            : raw;
          taskLine += ` (due: ${iso})`;
        }
        if (args.project) taskLine += ` [${args.project}]`;

        // Find Tasks section or append
        const tasksIdx = content.indexOf('## Tasks');
        if (tasksIdx !== -1) {
          const sectionLineEnd = content.indexOf('\n', tasksIdx);
          const insertIdx = sectionLineEnd === -1 ? content.length : sectionLineEnd + 1;
          content = content.slice(0, insertIdx) + taskLine + '\n' + content.slice(insertIdx);
        } else {
          content += `\n## Tasks\n${taskLine}\n`;
        }

        return JSON.stringify({
          type: 'pending_edit',
          path: fullPath,
          newContent: content,
          operation: exists ? 'update' : 'create',
        });
      },
    },
    {
      definition: {
        name: 'task_complete',
        description: 'Mark a task as completed in the diary. Searches recent diary notes for matching task text.',
        parameters: {
          type: 'object',
          properties: {
            task_description: { type: 'string', description: 'Text of the task to mark complete (partial match supported)' },
            days: { type: 'number', description: 'How many days of diary history to scan (default 90)' },
          },
          required: ['task_description'],
        },
      },
      execute: async (args) => {
        const diaryDir = path.join(vaultPath, 'Memory', 'Daily');
        if (!fs.existsSync(diaryDir)) {
          return JSON.stringify({ error: 'No diary notes found' });
        }

        const search = (args.task_description as string).toLowerCase();
        const windowDays = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : 90;
        const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, windowDays);

        for (const file of files) {
          const fullPath = resolveVaultPath(vaultPath, path.join('Memory', 'Daily', file));
          const content = fs.readFileSync(fullPath, 'utf-8');
          const taskRegex = /^(- \[) \] (.+)$/gm;
          let match;

          while ((match = taskRegex.exec(content)) !== null) {
            if (match[2].toLowerCase().includes(search)) {
              const newContent = content.slice(0, match.index) +
                `- [x] ${match[2]}` +
                content.slice(match.index + match[0].length);
              conflictDetector?.recordFileRead(fullPath, content);

              return JSON.stringify({
                type: 'pending_edit',
                path: fullPath,
                newContent,
                operation: 'update',
              });
            }
          }
        }

        return JSON.stringify({ error: `Task not found matching: "${args.task_description}"` });
      },
    },
    {
      definition: {
        name: 'task_agenda',
        description:
          "Build a daily agenda of pending tasks bucketed by deadline (overdue, due today, due soon, no deadline). " +
          "By default returns the agenda as data for the agent to read out. Pass write=true to also persist it as a " +
          "'Today's Agenda' note (Memory/Agenda.md) so it is visible in Obsidian; that path triggers the safe edit flow.",
        parameters: {
          type: 'object',
          properties: {
            horizon_days: { type: 'number', description: 'Lookahead window for "due soon" tasks (default 7)' },
            days: { type: 'number', description: 'How many days of diary history to scan (default 90)' },
            write: { type: 'boolean', description: "Also write the agenda to Memory/Agenda.md (default false)" },
          },
        },
      },
      execute: async (args) => {
        const today = localDateString();
        const horizonDays = typeof args.horizon_days === 'number' && args.horizon_days > 0 ? Math.floor(args.horizon_days) : 7;
        const horizonDate = new Date();
        horizonDate.setDate(horizonDate.getDate() + horizonDays);
        const horizon = localDateString(horizonDate);

        type AgendaItem = { text: string; due: string | null; source: string };
        const agenda = { overdue: [] as AgendaItem[], today: [] as AgendaItem[], soon: [] as AgendaItem[], no_deadline: [] as AgendaItem[] };

        const diaryDir = path.join(vaultPath, 'Memory', 'Daily');
        if (fs.existsSync(diaryDir)) {
          const windowDays = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : 90;
          const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, windowDays);

          for (const file of files) {
            const content = fs.readFileSync(path.join(diaryDir, file), 'utf-8');
            const source = `Memory/Daily/${file}`;
            // Only unchecked (pending) tasks belong on an agenda.
            const taskRegex = /^- \[ \] (.+)$/gm;
            let match;
            while ((match = taskRegex.exec(content)) !== null) {
              const text = match[1];
              const due = parseDueDate(text);
              const item: AgendaItem = { text, due, source };
              if (due === null) agenda.no_deadline.push(item);
              else if (due < today) agenda.overdue.push(item);
              else if (due === today) agenda.today.push(item);
              else if (due <= horizon) agenda.soon.push(item);
              // Tasks dated beyond the horizon are not yet actionable; omit them.
            }
          }
        }

        if (!args.write) {
          return JSON.stringify({ date: today, horizon_days: horizonDays, ...agenda });
        }

        const agendaPath = 'Memory/Agenda.md';
        const fullPath = resolveVaultPath(vaultPath, agendaPath);
        const exists = fs.existsSync(fullPath);
        if (exists) {
          conflictDetector?.recordFileRead(fullPath, fs.readFileSync(fullPath, 'utf-8'));
        }

        const newContent = renderAgendaNote(today, horizonDays, agenda);
        return JSON.stringify({
          type: 'pending_edit',
          path: fullPath,
          newContent,
          operation: exists ? 'update' : 'create',
        });
      },
    },
  ];
}

/** Extract a YYYY-MM-DD deadline from a task line's "(due: ...)" annotation, or null. */
function parseDueDate(text: string): string | null {
  const match = text.match(/\(due:\s*([^)]+)\)/);
  if (!match) return null;
  const raw = match[1].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = chrono.parseDate(raw, new Date(), { forwardDate: true });
  return parsed ? localDateString(parsed) : null;
}

/** Render the agenda as a Markdown dashboard note (plain bullets, never task checkboxes). */
function renderAgendaNote(
  today: string,
  horizonDays: number,
  agenda: { overdue: Array<{ text: string; source: string }>; today: Array<{ text: string; source: string }>; soon: Array<{ text: string; source: string }>; no_deadline: Array<{ text: string; source: string }> },
): string {
  const section = (heading: string, items: Array<{ text: string; source: string }>): string => {
    const lines = items.length > 0 ? items.map(i => `- ${i.text} — ${i.source}`).join('\n') : '- (none)';
    return `## ${heading}\n${lines}\n`;
  };
  return [
    '---',
    'type: agenda',
    `generated: ${today}`,
    '---',
    '',
    `# Today's Agenda — ${today}`,
    '',
    section('Overdue', agenda.overdue),
    section('Due today', agenda.today),
    section(`Due in next ${horizonDays} days`, agenda.soon),
    section('No deadline', agenda.no_deadline),
  ].join('\n');
}
