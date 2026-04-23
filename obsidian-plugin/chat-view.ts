import { ItemView, MarkdownRenderer, WorkspaceLeaf } from 'obsidian';
import type CrickNotePlugin from './main';

export const CHAT_VIEW_TYPE = 'cricknote-chat';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  pendingEdits?: Array<{ editId: string; path: string; diff: string; hasConflict: boolean; warnings: string[] }>;
}

export class ChatView extends ItemView {
  private plugin: CrickNotePlugin;
  private messages: ChatMessage[] = [];
  private inputEl: HTMLTextAreaElement | null = null;
  private messagesEl: HTMLElement | null = null;

  // WebSocket event handlers — kept so they can be detached cleanly.
  private chatChunkHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private chatResponseHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private errorHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private editResultHandler: ((msg: Record<string, unknown>) => void) | null = null;

  // In-progress streaming bubble. Created on first chunk, finalized on chat_response.
  private streamingMessageEl: HTMLElement | null = null;
  private streamingContentEl: HTMLElement | null = null;
  private streamingText = '';

  /** Map from editId to the action buttons container, for updating on server response. */
  private pendingEditButtons: Map<string, { applyBtn: HTMLButtonElement; cancelBtn: HTMLButtonElement; forceBtn?: HTMLButtonElement; actionsEl: HTMLElement }> = new Map();

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

    // Remove any leftover listeners from a previous open before registering new ones.
    this.detachListeners();

    // --- chat_chunk: append text to the in-progress streaming bubble ---
    this.chatChunkHandler = (msg: Record<string, unknown>) => {
      const text = msg.text as string;
      if (!text || !this.messagesEl) return;

      if (!this.streamingMessageEl) {
        // Create the bubble on the first chunk.
        this.streamingMessageEl = this.messagesEl.createDiv({
          cls: 'cricknote-message cricknote-assistant',
        });
        const roleEl = this.streamingMessageEl.createDiv({ cls: 'cricknote-role' });
        roleEl.setText('CrickNote');
        this.streamingContentEl = this.streamingMessageEl.createDiv({ cls: 'cricknote-content' });
        this.streamingText = '';
      }

      this.streamingText += text;
      // Show plain text during streaming; markdown is rendered on finalization.
      this.streamingContentEl!.setText(this.streamingText);
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    };

    // --- chat_response: finalize the streaming bubble or create one if no chunks arrived ---
    this.chatResponseHandler = (msg: Record<string, unknown>) => {
      const content = msg.content as string;
      const pendingEdits = (msg.pendingEdits && Array.isArray(msg.pendingEdits) && (msg.pendingEdits as unknown[]).length > 0)
        ? msg.pendingEdits as ChatMessage['pendingEdits']
        : undefined;

      this.messages.push({ role: 'assistant', content, timestamp: Date.now(), pendingEdits });

      if (this.streamingMessageEl && this.streamingContentEl) {
        // Finalize the streaming bubble: replace plain text with rendered markdown.
        this.streamingContentEl.empty();
        MarkdownRenderer.render(this.plugin.app, content, this.streamingContentEl, '', this);
        if (pendingEdits) {
          this.appendPendingEdits(this.streamingMessageEl, pendingEdits);
        }
        this.streamingMessageEl = null;
        this.streamingContentEl = null;
        this.streamingText = '';
      } else {
        // No chunks arrived (e.g. streaming disabled or very fast empty reply).
        this.addMessage({ role: 'assistant', content, timestamp: Date.now(), pendingEdits });
      }

      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    };

    this.errorHandler = (msg: Record<string, unknown>) => {
      // Discard any half-rendered streaming bubble before showing the error.
      this.streamingMessageEl?.remove();
      this.streamingMessageEl = null;
      this.streamingContentEl = null;
      this.streamingText = '';

      this.addMessage({
        role: 'system',
        content: `Error: ${msg.message}`,
        timestamp: Date.now(),
      });
    };

    this.editResultHandler = (msg: Record<string, unknown>) => {
      const editId = msg.editId as string;
      const btns = this.pendingEditButtons.get(editId);
      if (!btns) return;

      if (msg.success) {
        // Determine which action was taken based on which button shows pending text
        if (btns.cancelBtn.textContent === 'Cancelling\u2026') {
          btns.cancelBtn.setText('Cancelled');
        } else {
          btns.applyBtn.setText('Applied');
        }
        // Add Continue button
        const continueBtn = btns.actionsEl.createEl('button', {
          cls: 'cricknote-continue-btn',
          text: 'Continue',
        });
        continueBtn.addEventListener('click', () => {
          continueBtn.remove();
          this.sendMessageText('continue');
        });
      } else {
        // Server rejected — re-enable buttons and show error
        btns.applyBtn.disabled = false;
        btns.applyBtn.setText('Apply');
        btns.cancelBtn.disabled = false;
        btns.cancelBtn.setText('Cancel');
        if (btns.forceBtn) {
          btns.forceBtn.disabled = false;
          btns.forceBtn.setText('Force Apply');
        }
        this.addMessage({
          role: 'system',
          content: `Edit failed: ${msg.message ?? 'Unknown error'}`,
          timestamp: Date.now(),
        });
      }
      this.pendingEditButtons.delete(editId);
    };

    this.plugin.ws?.on('chat_chunk', this.chatChunkHandler);
    this.plugin.ws?.on('chat_response', this.chatResponseHandler);
    this.plugin.ws?.on('server_error', this.errorHandler);
    this.plugin.ws?.on('edit_result', this.editResultHandler);
  }

  async onClose(): Promise<void> {
    this.detachListeners();
  }

  private detachListeners(): void {
    if (this.chatChunkHandler) {
      this.plugin.ws?.off('chat_chunk', this.chatChunkHandler);
      this.chatChunkHandler = null;
    }
    if (this.chatResponseHandler) {
      this.plugin.ws?.off('chat_response', this.chatResponseHandler);
      this.chatResponseHandler = null;
    }
    if (this.errorHandler) {
      this.plugin.ws?.off('server_error', this.errorHandler);
      this.errorHandler = null;
    }
    if (this.editResultHandler) {
      this.plugin.ws?.off('edit_result', this.editResultHandler);
      this.editResultHandler = null;
    }
    this.streamingMessageEl = null;
    this.streamingContentEl = null;
    this.streamingText = '';
    this.pendingEditButtons.clear();
  }

  private sendMessage(): void {
    if (!this.inputEl) return;
    const content = this.inputEl.value.trim();
    if (!content) return;

    this.addMessage({ role: 'user', content, timestamp: Date.now() });
    this.plugin.ws?.sendChat(content);
    this.inputEl.value = '';
  }

  private sendMessageText(text: string): void {
    this.addMessage({ role: 'user', content: text, timestamp: Date.now() });
    this.plugin.ws?.sendChat(text);
  }

  private addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    if (!this.messagesEl) return;

    const msgEl = this.messagesEl.createDiv({ cls: `cricknote-message cricknote-${msg.role}` });

    const roleEl = msgEl.createDiv({ cls: 'cricknote-role' });
    roleEl.setText(msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'CrickNote' : 'System');

    const contentEl = msgEl.createDiv({ cls: 'cricknote-content' });
    if (msg.role === 'assistant') {
      MarkdownRenderer.render(this.plugin.app, msg.content, contentEl, '', this);
    } else {
      contentEl.setText(msg.content);
    }

    if (msg.pendingEdits) {
      this.appendPendingEdits(msgEl, msg.pendingEdits);
    }

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Render pending-edit blocks with confirmation buttons into an existing message element. */
  private appendPendingEdits(
    msgEl: HTMLElement,
    pendingEdits: NonNullable<ChatMessage['pendingEdits']>,
  ): void {
    for (const edit of pendingEdits) {
      const editEl = msgEl.createDiv({ cls: 'cricknote-pending-edit' });
      editEl.createDiv({ cls: 'cricknote-edit-path', text: edit.path });

      if (edit.warnings && edit.warnings.length > 0) {
        const warningsEl = editEl.createDiv({ cls: 'cricknote-template-warnings' });
        for (const warning of edit.warnings) {
          warningsEl.createDiv({ cls: 'cricknote-template-warning', text: `Warning: ${warning}` });
        }
      }

      if (edit.hasConflict) {
        editEl.createDiv({ cls: 'cricknote-conflict-warning', text: 'Conflict detected — file was modified since last read' });
      }

      const diffEl = editEl.createEl('pre', { cls: 'cricknote-diff' });
      diffEl.setText(edit.diff);

      const actionsEl = editEl.createDiv({ cls: 'cricknote-edit-actions' });

      const applyBtn = actionsEl.createEl('button', { text: 'Apply', cls: 'mod-cta' });
      const cancelBtn = actionsEl.createEl('button', { text: 'Cancel' });
      let forceBtn: HTMLButtonElement | undefined;

      const btnEntry: { applyBtn: HTMLButtonElement; cancelBtn: HTMLButtonElement; forceBtn?: HTMLButtonElement; actionsEl: HTMLElement } = { applyBtn, cancelBtn, actionsEl };

      const disableAll = () => {
        applyBtn.disabled = true;
        cancelBtn.disabled = true;
        if (forceBtn) forceBtn.disabled = true;
      };

      applyBtn.addEventListener('click', () => {
        this.plugin.ws?.confirmEdit(edit.editId, 'apply');
        disableAll();
        applyBtn.setText('Applying\u2026');
      });

      if (edit.hasConflict) {
        forceBtn = actionsEl.createEl('button', { text: 'Force Apply' });
        btnEntry.forceBtn = forceBtn;
        forceBtn.addEventListener('click', () => {
          this.plugin.ws?.confirmEdit(edit.editId, 'force');
          disableAll();
          forceBtn!.setText('Applying\u2026');
        });
      }

      cancelBtn.addEventListener('click', () => {
        this.plugin.ws?.confirmEdit(edit.editId, 'cancel');
        disableAll();
        cancelBtn.setText('Cancelling\u2026');
      });

      this.pendingEditButtons.set(edit.editId, btnEntry);
    }
  }
}
