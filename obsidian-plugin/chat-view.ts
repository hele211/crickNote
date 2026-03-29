import { ItemView, WorkspaceLeaf } from 'obsidian';
import type CrickNotePlugin from './main';

export const CHAT_VIEW_TYPE = 'cricknote-chat';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  pendingEdits?: Array<{ editId: string; path: string; diff: string; hasConflict: boolean }>;
}

export class ChatView extends ItemView {
  private plugin: CrickNotePlugin;
  private messages: ChatMessage[] = [];
  private inputEl: HTMLTextAreaElement | null = null;
  private messagesEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CrickNotePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'CrickNote Chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('cricknote-chat-container');

    // Messages area
    this.messagesEl = container.createDiv({ cls: 'cricknote-messages' });

    // Welcome message
    this.addMessage({
      role: 'system',
      content: 'Welcome to CrickNote! Ask me about your experiments, or tell me what to record.',
      timestamp: Date.now(),
    });

    // Input area
    const inputContainer = container.createDiv({ cls: 'cricknote-input-container' });
    this.inputEl = inputContainer.createEl('textarea', {
      cls: 'cricknote-input',
      attr: { placeholder: 'Ask about your research...' },
    });

    const sendBtn = inputContainer.createEl('button', { cls: 'cricknote-send-btn', text: 'Send' });

    // Event handlers
    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    sendBtn.addEventListener('click', () => this.sendMessage());

    // Listen for responses
    this.plugin.ws?.on('chat_response', (msg: Record<string, unknown>) => {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: msg.content as string,
        timestamp: Date.now(),
      };

      if (msg.pendingEdits && Array.isArray(msg.pendingEdits) && (msg.pendingEdits as unknown[]).length > 0) {
        assistantMsg.pendingEdits = msg.pendingEdits as ChatMessage['pendingEdits'];
      }

      this.addMessage(assistantMsg);
    });

    this.plugin.ws?.on('error', (msg: Record<string, unknown>) => {
      this.addMessage({
        role: 'system',
        content: `Error: ${msg.message}`,
        timestamp: Date.now(),
      });
    });
  }

  async onClose(): Promise<void> {
    // Cleanup
  }

  private sendMessage(): void {
    if (!this.inputEl) return;
    const content = this.inputEl.value.trim();
    if (!content) return;

    this.addMessage({ role: 'user', content, timestamp: Date.now() });
    this.plugin.ws?.sendChat(content);
    this.inputEl.value = '';
  }

  private addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    if (!this.messagesEl) return;

    const msgEl = this.messagesEl.createDiv({ cls: `cricknote-message cricknote-${msg.role}` });

    const roleEl = msgEl.createDiv({ cls: 'cricknote-role' });
    roleEl.setText(msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'CrickNote' : 'System');

    const contentEl = msgEl.createDiv({ cls: 'cricknote-content' });
    contentEl.setText(msg.content);

    // Render pending edits with confirmation buttons
    if (msg.pendingEdits) {
      for (const edit of msg.pendingEdits) {
        const editEl = msgEl.createDiv({ cls: 'cricknote-pending-edit' });
        editEl.createDiv({ cls: 'cricknote-edit-path', text: edit.path });

        if (edit.hasConflict) {
          editEl.createDiv({ cls: 'cricknote-conflict-warning', text: 'Conflict detected — file was modified since last read' });
        }

        const diffEl = editEl.createEl('pre', { cls: 'cricknote-diff' });
        diffEl.setText(edit.diff);

        const actionsEl = editEl.createDiv({ cls: 'cricknote-edit-actions' });

        const applyBtn = actionsEl.createEl('button', { text: 'Apply', cls: 'mod-cta' });
        applyBtn.addEventListener('click', () => {
          this.plugin.ws?.confirmEdit(edit.editId, 'apply');
          applyBtn.disabled = true;
          applyBtn.setText('Applied');
        });

        if (edit.hasConflict) {
          const forceBtn = actionsEl.createEl('button', { text: 'Force Apply' });
          forceBtn.addEventListener('click', () => {
            this.plugin.ws?.confirmEdit(edit.editId, 'force');
            forceBtn.disabled = true;
          });
        }

        const cancelBtn = actionsEl.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
          this.plugin.ws?.confirmEdit(edit.editId, 'cancel');
          cancelBtn.disabled = true;
          cancelBtn.setText('Cancelled');
        });
      }
    }

    // Auto-scroll
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
