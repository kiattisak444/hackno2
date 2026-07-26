export interface FaqItem {
  category: string;
  question: string;
  answer: string;
}

export interface GeminiResult {
  text: string;
  finishReason: string;
  thoughtsTokenCount: number;
  candidatesTokenCount: number;
}

export interface LineTextMessage {
  type: "text";
  id?: string;
  text: string;
  [key: string]: unknown;
}

export interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  message?: LineTextMessage & Record<string, unknown>;
  [key: string]: unknown;
}

export function isTextMessageEvent(
  event: LineWebhookEvent
): event is LineWebhookEvent & { replyToken: string; message: LineTextMessage } {
  return (
    event.type === "message" &&
    typeof event.replyToken === "string" &&
    !!event.message &&
    event.message.type === "text" &&
    typeof event.message.text === "string"
  );
}
