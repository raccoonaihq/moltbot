import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  isJidGroup,
  type WASocket,
  type WAMessage,
  type ConnectionState,
  type AnyMessageContent,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface UserConnection {
  userId: string;
  socket: WASocket | null;
  authDir: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  phone?: string;
  error?: string;
  lastConnectedAt?: number;
  reconnectAttempts: number;
}

export interface InboundMessage {
  userId: string;
  integrationId: "whatsapp";
  chatId: string;
  from: string;
  text: string;
  timestamp: number;
  metadata?: {
    accountId?: string;
    conversationId?: string;
    chatType?: "direct" | "group";
    senderName?: string;
    senderJid?: string;
    groupSubject?: string;
    messageId?: string;
  };
}

export type OnMessageCallback = (message: InboundMessage) => Promise<void>;

// Connection manager for multiple RaccoonAI users
class WhatsAppConnectionManager {
  private connections = new Map<string, UserConnection>();
  private onMessageCallback: OnMessageCallback | null = null;
  private apiUrl: string | null = null;
  private isInitialized = false;

  setApiUrl(url: string) {
    this.apiUrl = url;
  }

  setOnMessage(callback: OnMessageCallback) {
    this.onMessageCallback = callback;
  }

  // Get base auth directory
  private getBaseAuthDir(): string {
    return path.join(os.homedir(), ".clawdbot", "credentials", "whatsapp");
  }

  // Get auth directory for a specific user
  private getAuthDir(userId: string): string {
    return path.join(this.getBaseAuthDir(), `raccoon-${userId}`);
  }

  // Write credentials from RaccoonAI to local files
  private async writeCredentials(
    userId: string,
    credentials: Record<string, unknown>
  ): Promise<string> {
    const authDir = this.getAuthDir(userId);
    fs.mkdirSync(authDir, { recursive: true });

    // The credentials object contains multiple files (creds.json, app-state-sync-key-*.json, etc.)
    // Each key in the object is a filename (without .json), value is the content
    for (const [key, value] of Object.entries(credentials)) {
      if (value !== null && value !== undefined) {
        const filePath = path.join(authDir, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
      }
    }

    // Ensure registered: true in creds.json for Baileys to recognize as linked
    const credsPath = path.join(authDir, "creds.json");
    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
        if (!creds.registered) {
          creds.registered = true;
          fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
        }
      } catch {
        // Ignore parse errors
      }
    }

    console.log(
      `[RaccoonAI Bridge] Wrote credentials for user ${userId} to ${authDir}`
    );
    return authDir;
  }

  // Fetch connected integrations from RaccoonAI
  private async fetchIntegrations(): Promise<
    Array<{
      userId: string;
      integrationId: string;
      credentials: Record<string, unknown>;
      metadata?: { phone?: string; displayName?: string };
    }>
  > {
    if (!this.apiUrl) {
      console.error("[RaccoonAI Bridge] No API URL configured");
      return [];
    }

    try {
      const response = await fetch(`${this.apiUrl}/i/moltbot/integrations`);
      if (!response.ok) {
        console.error(
          `[RaccoonAI Bridge] Failed to fetch integrations: ${response.status}`
        );
        return [];
      }
      const data = (await response.json()) as {
        integrations?: Array<{
          userId: string;
          integrationId: string;
          credentials: Record<string, unknown>;
          metadata?: { phone?: string; displayName?: string };
        }>;
      };
      return data.integrations ?? [];
    } catch (error) {
      console.error("[RaccoonAI Bridge] Error fetching integrations:", error);
      return [];
    }
  }

  // Extract phone from JID or credentials
  private extractPhone(
    credentials: Record<string, unknown>,
    metadata?: { phone?: string }
  ): string | undefined {
    if (metadata?.phone) {
      return metadata.phone;
    }
    // Try to extract from credentials.me.id
    const creds = credentials.creds as { me?: { id?: string } } | undefined;
    if (creds?.me?.id) {
      // JID format: "919027553376:22@s.whatsapp.net"
      return creds.me.id.split("@")[0].split(":")[0];
    }
    return undefined;
  }

  // Create a Baileys socket for a user
  private async createSocket(userConn: UserConnection): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(userConn.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
      },
      version,
      printQRInTerminal: false,
      browser: ["RaccoonAI-Moltbot", "Bridge", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    userConn.socket = sock;
    userConn.status = "connecting";

    // Handle connection updates
    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        console.log(
          `[RaccoonAI Bridge] WhatsApp connected for user ${userConn.userId}`
        );
        userConn.status = "connected";
        userConn.lastConnectedAt = Date.now();
        userConn.reconnectAttempts = 0;
        userConn.error = undefined;

        // Extract phone number
        if (sock.user?.id) {
          userConn.phone = sock.user.id.split("@")[0].split(":")[0];
        }

        // Send presence
        try {
          await sock.sendPresenceUpdate("available");
        } catch {
          // Ignore presence errors
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        console.log(
          `[RaccoonAI Bridge] WhatsApp disconnected for user ${userConn.userId}, code: ${statusCode}`
        );

        // Handle reconnection
        const shouldReconnect =
          statusCode === DisconnectReason.restartRequired ||
          statusCode === 515 ||
          statusCode === DisconnectReason.connectionReplaced;

        if (
          shouldReconnect &&
          userConn.reconnectAttempts < 3 &&
          userConn.status !== "error"
        ) {
          userConn.reconnectAttempts++;
          userConn.status = "connecting";
          console.log(
            `[RaccoonAI Bridge] Reconnecting user ${userConn.userId} (attempt ${userConn.reconnectAttempts})`
          );
          setTimeout(() => this.createSocket(userConn), 2000);
          return;
        }

        // Mark as disconnected/error
        if (statusCode === DisconnectReason.loggedOut) {
          userConn.status = "error";
          userConn.error = "logged_out";
          console.error(
            `[RaccoonAI Bridge] User ${userConn.userId} logged out from WhatsApp`
          );
        } else {
          userConn.status = "disconnected";
          userConn.error = `disconnect_${statusCode}`;
        }
      }
    });

    // Save credentials when updated
    sock.ev.on("creds.update", saveCreds);

    // Handle incoming messages
    sock.ev.on(
      "messages.upsert",
      async (upsert: { type?: string; messages?: WAMessage[] }) => {
        if (upsert.type !== "notify") return;

        for (const msg of upsert.messages ?? []) {
          await this.handleIncomingMessage(userConn, msg, sock);
        }
      }
    );
  }

  // Handle incoming WhatsApp message
  private async handleIncomingMessage(
    userConn: UserConnection,
    msg: WAMessage,
    sock: WASocket
  ): Promise<void> {
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid) return;

    // Skip status/broadcast messages
    if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast"))
      return;

    // Skip messages from self
    if (msg.key?.fromMe) return;

    // Extract text content
    const message = msg.message;
    if (!message) return;

    let text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      "";

    // Skip empty messages
    if (!text.trim()) return;

    const isGroup = isJidGroup(remoteJid) === true;
    const participantJid = msg.key?.participant;

    // For groups, extract sender info
    let senderE164: string | undefined;
    if (isGroup && participantJid) {
      senderE164 = participantJid.split("@")[0].split(":")[0];
    } else if (!isGroup) {
      senderE164 = remoteJid.split("@")[0].split(":")[0];
    }

    // Get group metadata if applicable
    let groupSubject: string | undefined;
    if (isGroup) {
      try {
        const groupMeta = await sock.groupMetadata(remoteJid);
        groupSubject = groupMeta.subject;
      } catch {
        // Ignore group metadata errors
      }
    }

    const inboundMessage: InboundMessage = {
      userId: userConn.userId,
      integrationId: "whatsapp",
      chatId: remoteJid,
      from: senderE164 || remoteJid,
      text,
      timestamp: msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : Date.now(),
      metadata: {
        conversationId: remoteJid,
        chatType: isGroup ? "group" : "direct",
        senderName: msg.pushName || undefined,
        senderJid: participantJid || undefined,
        groupSubject,
        messageId: msg.key?.id,
      },
    };

    console.log(
      `[RaccoonAI Bridge] Received message for user ${userConn.userId} from ${inboundMessage.from}`
    );

    // Mark message as read
    if (msg.key?.id) {
      try {
        await sock.readMessages([
          {
            remoteJid,
            id: msg.key.id,
            participant: participantJid,
            fromMe: false,
          },
        ]);
      } catch {
        // Ignore read receipt errors
      }
    }

    // Forward to callback
    if (this.onMessageCallback) {
      try {
        await this.onMessageCallback(inboundMessage);
      } catch (error) {
        console.error(
          "[RaccoonAI Bridge] Error in message callback:",
          error
        );
      }
    }
  }

  // Initialize connections for all RaccoonAI users
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("[RaccoonAI Bridge] Already initialized");
      return;
    }

    console.log("[RaccoonAI Bridge] Initializing WhatsApp connections...");

    const integrations = await this.fetchIntegrations();
    const whatsappIntegrations = integrations.filter(
      (i) => i.integrationId === "whatsapp" && i.credentials
    );

    console.log(
      `[RaccoonAI Bridge] Found ${whatsappIntegrations.length} WhatsApp integrations`
    );

    for (const integration of whatsappIntegrations) {
      try {
        await this.connectUser(
          integration.userId,
          integration.credentials,
          integration.metadata
        );
      } catch (error) {
        console.error(
          `[RaccoonAI Bridge] Failed to connect user ${integration.userId}:`,
          error
        );
      }
    }

    this.isInitialized = true;
    console.log("[RaccoonAI Bridge] Initialization complete");
  }

  // Connect a specific user
  async connectUser(
    userId: string,
    credentials: Record<string, unknown>,
    metadata?: { phone?: string; displayName?: string }
  ): Promise<void> {
    // Check if already connected
    const existing = this.connections.get(userId);
    if (existing && existing.status === "connected") {
      console.log(
        `[RaccoonAI Bridge] User ${userId} already connected`
      );
      return;
    }

    // Write credentials to local files
    const authDir = await this.writeCredentials(userId, credentials);
    const phone = this.extractPhone(credentials, metadata);

    const userConn: UserConnection = {
      userId,
      socket: null,
      authDir,
      status: "connecting",
      phone,
      reconnectAttempts: 0,
    };

    this.connections.set(userId, userConn);

    console.log(
      `[RaccoonAI Bridge] Connecting WhatsApp for user ${userId} (phone: ${phone || "unknown"})`
    );

    await this.createSocket(userConn);
  }

  // Send message to a chat
  async sendMessage(
    userId: string,
    chatId: string,
    text: string,
    mediaUrl?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const userConn = this.connections.get(userId);
    if (!userConn || !userConn.socket) {
      return { success: false, error: "User not connected" };
    }

    if (userConn.status !== "connected") {
      return { success: false, error: `Connection status: ${userConn.status}` };
    }

    try {
      let content: AnyMessageContent;

      if (mediaUrl) {
        // Determine media type from URL
        const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(mediaUrl);
        const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(mediaUrl);
        const isAudio = /\.(mp3|wav|ogg|m4a|opus)$/i.test(mediaUrl);

        if (isImage) {
          content = {
            image: { url: mediaUrl },
            caption: text || undefined,
          };
        } else if (isVideo) {
          content = {
            video: { url: mediaUrl },
            caption: text || undefined,
          };
        } else if (isAudio) {
          content = { audio: { url: mediaUrl } };
        } else {
          content = {
            document: { url: mediaUrl },
            caption: text || undefined,
          };
        }
      } else {
        content = { text };
      }

      const result = await userConn.socket.sendMessage(chatId, content);
      return { success: true, messageId: result?.key?.id };
    } catch (error) {
      console.error(
        `[RaccoonAI Bridge] Failed to send message for user ${userId}:`,
        error
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Send failed",
      };
    }
  }

  // Get connection status for a user
  getConnectionStatus(userId: string): UserConnection | undefined {
    return this.connections.get(userId);
  }

  // Get the user ID for a connected phone number
  getUserIdByPhone(phone: string): string | undefined {
    // Normalize phone (remove non-digits)
    const normalized = phone.replace(/\D/g, "");

    for (const [userId, conn] of this.connections) {
      if (conn.phone && conn.phone.endsWith(normalized)) {
        return userId;
      }
      if (conn.phone && normalized.endsWith(conn.phone)) {
        return userId;
      }
    }
    return undefined;
  }

  // Get all connected user IDs
  getConnectedUserIds(): string[] {
    return Array.from(this.connections.entries())
      .filter(([_, conn]) => conn.status === "connected")
      .map(([userId, _]) => userId);
  }

  // Disconnect a user
  async disconnectUser(userId: string): Promise<void> {
    const userConn = this.connections.get(userId);
    if (userConn?.socket) {
      try {
        userConn.socket.end(undefined);
      } catch {
        // Ignore
      }
    }
    this.connections.delete(userId);
  }

  // Disconnect all users
  async shutdown(): Promise<void> {
    for (const [userId] of this.connections) {
      await this.disconnectUser(userId);
    }
    this.isInitialized = false;
  }
}

// Singleton instance
export const connectionManager = new WhatsAppConnectionManager();
