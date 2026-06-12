---
name: cricknote-reminders
description: Use when the user wants a CrickNote task or planned experiment pushed to Apple Reminders or Calendar on macOS, or wants reminders kept in sync with their diary tasks.
---

# Reminders & calendar push (macOS)

One-way push from the vault to Apple Reminders/Calendar. The vault stays the
source of truth; there is no automatic sync back.

## Push a task to Reminders
1. Add the task in the vault first:
   `cricknote tool task_add '{"description":"order ECL substrate","deadline":"2026-12-12","project":"P003"}'`
   (the deadline is normalized to ISO).
2. Check for an existing reminder to avoid duplicates:
   `osascript -e 'tell application "Reminders" to return name of every reminder whose name contains "order ECL substrate"'`
3. If none, create one with a locale-safe date (build the date object, do not
   parse a locale string):
   ```bash
   osascript <<'EOF'
   set dueDate to current date
   set year of dueDate to 2026
   set month of dueDate to 12
   set day of dueDate to 12
   set time of dueDate to 9 * hours
   tell application "Reminders"
     make new reminder with properties {name:"order ECL substrate [P003]", due date:dueDate}
   end tell
   EOF
   ```
4. Tell the user the task was pushed (the vault task line is the record of truth).

## Push a planned experiment to Calendar
Use the same locale-safe date construction with `make new event` in the target
calendar. Include the project/serial in the event title.

## Reconciliation
Completing a reminder on the phone does NOT check the vault box. During daily
review, ask which reminders were completed and call
`cricknote tool task_complete '{"task_description":"<text>"}'` for each.
