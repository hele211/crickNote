import fs from 'node:fs';
import path from 'node:path';
import type { ToolHandler } from './registry.js';

export function createTaskTools(vaultPath: string): ToolHandler[] {
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
          },
        },
      },
      execute: async (args) => {
        const tasks: Array<{ text: string; completed: boolean; source: string; date?: string }> = [];
        const diaryDir = path.join(vaultPath, 'Memory', 'Daily');

        if (!fs.existsSync(diaryDir)) return JSON.stringify(tasks);

        const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 14);

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
        const today = new Date().toISOString().split('T')[0];
        const diaryPath = `Memory/Daily/${today}.md`;
        const fullPath = path.join(vaultPath, diaryPath);

        let content: string;
        if (fs.existsSync(fullPath)) {
          content = fs.readFileSync(fullPath, 'utf-8');
        } else {
          content = `---\ndate: ${today}\ntype: daily-diary\n---\n\n# ${today}\n\n## Tasks\n`;
        }

        let taskLine = `- [ ] ${args.description}`;
        if (args.deadline) taskLine += ` (due: ${args.deadline})`;
        if (args.project) taskLine += ` [${args.project}]`;

        // Find Tasks section or append
        const tasksIdx = content.indexOf('## Tasks');
        if (tasksIdx !== -1) {
          const insertIdx = content.indexOf('\n', tasksIdx) + 1;
          content = content.slice(0, insertIdx) + taskLine + '\n' + content.slice(insertIdx);
        } else {
          content += `\n## Tasks\n${taskLine}\n`;
        }

        return JSON.stringify({
          type: 'pending_edit',
          path: diaryPath,
          newContent: content,
          operation: fs.existsSync(fullPath) ? 'update' : 'create',
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
        const files = fs.readdirSync(diaryDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 14);

        for (const file of files) {
          const fullPath = path.join(diaryDir, file);
          const content = fs.readFileSync(fullPath, 'utf-8');
          const taskRegex = /^(- \[) \] (.+)$/gm;
          let match;

          while ((match = taskRegex.exec(content)) !== null) {
            if (match[2].toLowerCase().includes(search)) {
              const newContent = content.slice(0, match.index) +
                `- [x] ${match[2]}` +
                content.slice(match.index + match[0].length);

              return JSON.stringify({
                type: 'pending_edit',
                path: `Memory/Daily/${file}`,
                newContent,
                operation: 'update',
              });
            }
          }
        }

        return JSON.stringify({ error: `Task not found matching: "${args.task_description}"` });
      },
    },
  ];
}
