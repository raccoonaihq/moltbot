import type { MoltbotPluginApi } from "../../src/plugins/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  setBridgeConfig,
  getBridgeConfig,
  forwardToRaccoonAI,
  type RaccoonAIBridgeConfig,
  type OutboundPayload,
} from "./src/bridge.js";
import {
  connectionManager,
  type InboundMessage,
} from "./src/whatsapp-connection.js";

export default function register(api: MoltbotPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as RaccoonAIBridgeConfig;

  // Initialize bridge config
  setBridgeConfig({
    webhookUrl: pluginConfig.webhookUrl,
    raccoonApiUrl: pluginConfig.raccoonApiUrl,
    enabled: pluginConfig.enabled !== false,
  });

  api.logger.info(
    `RaccoonAI Bridge initialized (enabled: ${pluginConfig.enabled !== false}, webhook: ${pluginConfig.webhookUrl ?? "not set"}, api: ${pluginConfig.raccoonApiUrl ?? "not set"})`
  );

  // Set up the connection manager
  if (pluginConfig.enabled !== false && pluginConfig.raccoonApiUrl) {
    connectionManager.setApiUrl(pluginConfig.raccoonApiUrl);

    // Set up message handler - forward to RaccoonAI
    connectionManager.setOnMessage(async (message: InboundMessage) => {
      api.logger.info(
        `[RaccoonAI Bridge] Received WhatsApp message from ${message.from} for user ${message.userId}`
      );

      const result = await forwardToRaccoonAI({
        userId: message.userId,
        integrationId: message.integrationId,
        chatId: message.chatId,
        from: message.from,
        text: message.text,
        timestamp: message.timestamp,
        metadata: {
          conversationId: message.metadata?.conversationId,
          chatType: message.metadata?.chatType,
          senderName: message.metadata?.senderName,
        },
      });

      if (result.success) {
        api.logger.info(
          `[RaccoonAI Bridge] Message forwarded successfully (session: ${result.sessionId})`
        );

        // Send "Working on it" acknowledgment with session link
        if (result.sessionUrl) {
          const ackMessage = `Working on it! See live progress: ${result.sessionUrl}`;
          await connectionManager.sendMessage(
            message.userId,
            message.chatId,
            ackMessage
          );
        }
      } else {
        api.logger.error(
          `[RaccoonAI Bridge] Failed to forward message: ${result.error}`
        );
      }
    });

    // Initialize connections on startup (with small delay to let gateway settle)
    setTimeout(async () => {
      try {
        await connectionManager.initialize();
        api.logger.info("RaccoonAI Bridge: WhatsApp connections initialized");
      } catch (err) {
        api.logger.error(
          `RaccoonAI Bridge: Failed to initialize WhatsApp connections: ${err}`
        );
      }
    }, 2000);
  }

  // Register HTTP endpoint for RaccoonAI to send outbound messages
  api.registerHttpRoute({
    path: "/raccoonai/send",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Method not allowed" }));
        return;
      }

      try {
        // Parse request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString("utf-8");
        const payload: OutboundPayload = JSON.parse(body);

        // Validate payload
        if (!payload.integrationId || !payload.chatId || !payload.text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              error: "Missing required fields: integrationId, chatId, text",
            })
          );
          return;
        }

        // Find the user ID for this request
        // The payload should include userId, or we need to look it up
        let userId = payload.userId;
        if (!userId) {
          // Try to find user by connected integrations
          const connectedUsers = connectionManager.getConnectedUserIds();
          if (connectedUsers.length === 1) {
            userId = connectedUsers[0];
          } else if (connectedUsers.length === 0) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                success: false,
                error: "No WhatsApp connections available",
              })
            );
            return;
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                success: false,
                error: "Multiple users connected, userId required",
              })
            );
            return;
          }
        }

        // Send the message via our connection manager
        if (payload.integrationId === "whatsapp") {
          // Handle media if present
          let mediaUrl: string | undefined;
          if (payload.media && payload.media.length > 0) {
            mediaUrl = payload.media[0].url;
          }

          const result = await connectionManager.sendMessage(
            userId,
            payload.chatId,
            payload.text,
            mediaUrl
          );

          res.writeHead(result.success ? 200 : 500, {
            "Content-Type": "application/json",
          });
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: false,
              error: `Integration ${payload.integrationId} not supported`,
            })
          );
        }
      } catch (error) {
        api.logger.error(`Error handling outbound request: ${error}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Internal error",
          })
        );
      }
    },
  });

  api.logger.info("RaccoonAI Bridge HTTP endpoint registered at /raccoonai/send");
}
