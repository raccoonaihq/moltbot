export type RaccoonAIBridgeConfig = {
  webhookUrl?: string;
  raccoonApiUrl?: string;
  enabled?: boolean;
};

export type InboundPayload = {
  userId: string;
  integrationId: string;
  chatId: string;
  from: string;
  text: string;
  media?: string[];
  timestamp: number;
  metadata?: {
    accountId?: string;
    conversationId?: string;
    chatType?: string;
    senderName?: string;
  };
};

export type OutboundPayload = {
  integrationId: string;
  chatId: string;
  text: string;
  userId?: string;
  media?: Array<{
    url: string;
    mimeType?: string;
    filename?: string;
  }>;
};

let bridgeConfig: RaccoonAIBridgeConfig = {};

export function setBridgeConfig(config: RaccoonAIBridgeConfig) {
  bridgeConfig = config;
}

export function getBridgeConfig(): RaccoonAIBridgeConfig {
  return bridgeConfig;
}

export async function forwardToRaccoonAI(payload: InboundPayload): Promise<{
  success: boolean;
  sessionId?: string;
  sessionUrl?: string;
  error?: string;
}> {
  const config = getBridgeConfig();

  if (!config.enabled) {
    return { success: false, error: "Bridge is disabled" };
  }

  if (!config.webhookUrl) {
    return { success: false, error: "No webhook URL configured" };
  }

  try {
    console.log(
      `[RaccoonAI Bridge] Forwarding message to ${config.webhookUrl}:`,
      JSON.stringify(payload, null, 2)
    );

    const response = await fetch(config.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(
        `[RaccoonAI Bridge] Forward failed: HTTP ${response.status}: ${errorText}`
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const result = (await response.json()) as {
      success?: boolean;
      sessionId?: string;
      sessionUrl?: string;
      error?: string;
    };
    return {
      success: result.success ?? true,
      sessionId: result.sessionId,
      sessionUrl: result.sessionUrl,
      error: result.error,
    };
  } catch (error) {
    console.error(`[RaccoonAI Bridge] Forward error:`, error);
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to forward message",
    };
  }
}
