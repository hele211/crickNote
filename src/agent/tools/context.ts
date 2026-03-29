import fs from 'node:fs';
import path from 'node:path';
import type { ToolHandler } from './registry.js';

export function createContextTools(vaultPath: string): ToolHandler[] {
  return [
    {
      definition: {
        name: 'get_today_diary',
        description: "Read today's daily diary note from Memory/Daily/.",
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        const today = new Date().toISOString().split('T')[0];
        const diaryPath = path.join(vaultPath, 'Memory', 'Daily', `${today}.md`);

        if (!fs.existsSync(diaryPath)) {
          return JSON.stringify({ exists: false, date: today, message: 'No diary entry for today yet.' });
        }

        return JSON.stringify({
          exists: true,
          date: today,
          content: fs.readFileSync(diaryPath, 'utf-8'),
        });
      },
    },
    {
      definition: {
        name: 'get_week_plan',
        description: "Read this week's planning note from Memory/Weekly/.",
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => {
        const now = new Date();
        const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
        const year = d.getUTCFullYear();

        const weekFile = `${year}-W${String(weekNum).padStart(2, '0')}.md`;
        const weekPath = path.join(vaultPath, 'Memory', 'Weekly', weekFile);

        if (!fs.existsSync(weekPath)) {
          return JSON.stringify({ exists: false, week: weekFile, message: 'No weekly plan for this week yet.' });
        }

        return JSON.stringify({
          exists: true,
          week: weekFile,
          content: fs.readFileSync(weekPath, 'utf-8'),
        });
      },
    },
  ];
}
