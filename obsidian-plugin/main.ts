import { Plugin, WorkspaceLeaf } from 'obsidian';
import { ChatView, CHAT_VIEW_TYPE } from './chat-view';
import { CrickNoteWebSocket } from './websocket-client';

interface CrickNotePluginData {
  chatSessionId?: string;
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function createChatSessionId(): string {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `obsidian-${randomId}`;
}

export default class CrickNotePlugin extends Plugin {
  ws: CrickNoteWebSocket | null = null;

  async onload() {
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon('message-square', 'CrickNote Chat', () => {
      this.activateChatView();
    });

    this.addCommand({
      id: 'open-chat',
      name: 'Open CrickNote Chat',
      callback: () => this.activateChatView(),
    });

    const data = (await this.loadData()) as CrickNotePluginData | null;
    let chatSessionId = data?.chatSessionId;
    if (!isValidSessionId(chatSessionId)) {
      chatSessionId = createChatSessionId();
      await this.saveData({ ...(data ?? {}), chatSessionId });
    }

    // Connect to agent service using built-in defaults (127.0.0.1:18790).
    // Configurable host/port/token will require a proper settings model and UI.
    this.ws = new CrickNoteWebSocket(this, { sessionId: chatSessionId });
    await this.ws.connect();

    // Status bar
    const statusBar = this.addStatusBarItem();
    statusBar.setText('CrickNote: connecting...');

    // Safety net: Node's EventEmitter throws if 'error' is emitted with no listener
    this.ws.on('error', (err) => { console.error('CrickNote websocket error:', err); });

    this.ws.on('connected', () => {
      statusBar.setText('CrickNote: connected');
    });

    this.ws.on('disconnected', () => {
      statusBar.setText('CrickNote: disconnected');
    });

    this.ws.on('indexing', (data: { state: string; total: number; indexed: number }) => {
      if (data.state === 'indexing') {
        const pct = data.total > 0 ? Math.round((data.indexed / data.total) * 100) : 0;
        statusBar.setText(`CrickNote: indexing ${data.indexed}/${data.total} (${pct}%)`);
      } else {
        statusBar.setText('CrickNote: connected');
      }
    });
  }

  async onunload() {
    this.ws?.disconnect();
  }

  async activateChatView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CHAT_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}
