import { messagingApi, validateSignature } from "@line/bot-sdk";

const { MessagingApiClient } = messagingApi;

export function verifySignature(rawBody: string, signature: string | null): boolean {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  if (!signature || !channelSecret) return false;
  try {
    return validateSignature(rawBody, channelSecret, signature);
  } catch {
    return false;
  }
}

let client: InstanceType<typeof MessagingApiClient> | null = null;
function getClient(): InstanceType<typeof MessagingApiClient> {
  if (!client) {
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelAccessToken) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
    client = new MessagingApiClient({ channelAccessToken });
  }
  return client;
}

export async function replyMessage(replyToken: string, text: string): Promise<void> {
  try {
    await getClient().replyMessage({
      replyToken,
      messages: [{ type: "text", text }],
    });
  } catch (err) {
    // Never throw — the webhook route must still return 200 to LINE.
    console.error("[line] replyMessage failed:", err);
  }
}
