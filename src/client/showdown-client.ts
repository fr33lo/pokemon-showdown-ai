import WebSocket from 'ws';
import https from 'https';
import http from 'http';
import { CONFIG } from '../config';
import { log, logError, logDebug } from '../logging/logger';
import { EventEmitter } from 'events';

export interface ShowdownEvents {
  'challstr': (challstr: string) => void;
  'login': () => void;
  'battle-start': (battleId: string) => void;
  'battle-message': (battleId: string, messages: string[]) => void;
  'battle-end': (battleId: string) => void;
  'pm': (from: string, message: string) => void;
  'error': (error: Error) => void;
  'disconnect': () => void;
}

export class ShowdownClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private challstr: string = '';
  private loggedIn: boolean = false;
  private activeBattleId: string | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor() {
    super();
  }

  // ────────────────────────────────────────
  // Connection
  // ────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      log(`Connecting to ${CONFIG.ps.server}...`);
      // Clean up any existing connection
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      }
      this.ws = new WebSocket(CONFIG.ps.server);

      this.ws.on('open', () => {
        log('WebSocket connected');
        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        const raw = data.toString();
        this.handleRawMessage(raw);
      });

      this.ws.on('close', () => {
        log('WebSocket disconnected');
        this.loggedIn = false;
        this.emit('disconnect');
        this.attemptReconnect();
      });

      this.ws.on('error', (err: Error) => {
        logError('WebSocket error', err);
        this.emit('error', err);
        reject(err);
      });
    });
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logError('Max reconnect attempts reached');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    setTimeout(async () => {
      try {
        await this.connectAndLogin();
        log('Reconnected and logged in successfully');
      } catch {
        logError('Reconnection failed');
      }
    }, delay);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ────────────────────────────────────────
  // Message Handling
  // ────────────────────────────────────────

  private handleRawMessage(raw: string): void {
    const lines = raw.split('\n');

    // Check if this is a room-specific message
    let roomId = '';
    let startIdx = 0;
    if (lines[0]?.startsWith('>')) {
      roomId = lines[0].substring(1).trim();
      startIdx = 1;
    }

    // Battle messages are routed to the battle handler
    if (roomId.startsWith('battle-')) {
      const battleMessages = lines.slice(startIdx);
      this.emit('battle-message', roomId, battleMessages);
      return;
    }

    // Global / lobby messages
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.startsWith('|')) continue;

      const parts = line.substring(1).split('|');
      const command = parts[0];

      switch (command) {
        case 'challstr':
          this.challstr = parts.slice(1).join('|');
          logDebug('Received challstr');
          this.emit('challstr', this.challstr);
          break;

        case 'updateuser': {
          const rawName = parts[1]?.trim() || '';
          // PS may prepend a space or special chars; normalize for comparison
          const cleanName = rawName.replace(/^[\s\u00a0]+/, '');
          const isGuest = parts[2]?.trim() === '0';
          if (!isGuest && cleanName.toLowerCase() === CONFIG.ps.username.toLowerCase()) {
            this.loggedIn = true;
            log(`Logged in as ${cleanName}`);
            this.emit('login');
          }
          break;
        }

        case 'updatesearch':
          // Battle search status update
          try {
            const searchData = JSON.parse(parts.slice(1).join('|'));
            if (searchData?.games) {
              const battleIds = Object.keys(searchData.games);
              for (const bid of battleIds) {
                if (!this.activeBattleId || this.activeBattleId !== bid) {
                  this.activeBattleId = bid;
                  log(`Battle started: ${bid}`);
                  this.emit('battle-start', bid);
                }
              }
            }
          } catch {
            // Not valid JSON, ignore
          }
          break;

        case 'pm': {
          const from = parts[1]?.trim() || '';
          const msg = parts.slice(3).join('|');
          if (msg.startsWith('/challenge')) {
            logDebug(`Challenge from ${from}: ${msg}`);
          }
          this.emit('pm', from, msg);
          break;
        }

        case 'popup':
          logDebug(`Popup: ${parts.slice(1).join('|')}`);
          break;
      }
    }
  }

  // ────────────────────────────────────────
  // Login
  // ────────────────────────────────────────

  async login(): Promise<void> {
    if (!this.challstr) {
      throw new Error('No challstr received yet');
    }

    log('Logging in...');
    const assertion = await this.getAssertion();

    this.send(`|/trn ${CONFIG.ps.username},0,${assertion}`);

    // Wait for updateuser confirmation
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Login timeout')), 15000);
      this.once('login', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private getAssertion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const postData = `act=login&name=${encodeURIComponent(CONFIG.ps.username)}&pass=${encodeURIComponent(CONFIG.ps.password)}&challstr=${encodeURIComponent(this.challstr)}`;

      const url = new URL(CONFIG.ps.loginUrl);
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // Response starts with ']' followed by JSON
          const jsonStr = data.startsWith(']') ? data.substring(1) : data;
          try {
            const json = JSON.parse(jsonStr);
            if (json.actionsuccess) {
              resolve(json.assertion);
            } else {
              reject(new Error(`Login failed: ${json.actionerror || 'Unknown error'}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse login response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  // ────────────────────────────────────────
  // Commands
  // ────────────────────────────────────────

  send(message: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logError('Cannot send: WebSocket not connected');
      return;
    }
    logDebug(`>>> ${message}`);
    this.ws.send(message);
  }

  searchBattle(): void {
    log(`Searching for ${CONFIG.ps.format}...`);
    this.send(`|/search ${CONFIG.ps.format}`);
  }

  joinBattle(battleId: string): void {
    this.send(`|/join ${battleId}`);
    this.activeBattleId = battleId;
  }

  sendBattleCommand(battleId: string, command: string): void {
    this.send(`${battleId}|${command}`);
  }

  chooseMove(battleId: string, moveIndex: number, extra?: string): void {
    let cmd = `/choose move ${moveIndex}`;
    if (extra) cmd += ` ${extra}`;
    this.sendBattleCommand(battleId, cmd);
  }

  chooseSwitch(battleId: string, switchIndex: number): void {
    this.sendBattleCommand(battleId, `/choose switch ${switchIndex}`);
  }

  chooseDefault(battleId: string): void {
    this.sendBattleCommand(battleId, `/choose default`);
  }

  sendTimer(battleId: string, on: boolean): void {
    this.sendBattleCommand(battleId, `/timer ${on ? 'on' : 'off'}`);
  }

  leaveBattle(battleId: string): void {
    this.send(`|/leave ${battleId}`);
    if (this.activeBattleId === battleId) {
      this.activeBattleId = null;
    }
  }

  getActiveBattleId(): string | null {
    return this.activeBattleId;
  }

  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Wait for the challstr event then login */
  async connectAndLogin(): Promise<void> {
    await this.connect();

    // Wait for challstr
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Challstr timeout')), 15000);
      this.once('challstr', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await this.login();
  }
}
