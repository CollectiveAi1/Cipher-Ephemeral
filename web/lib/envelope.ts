/**
 * The decrypted message body. Only the client ever sees this shape: attachment keys
 * live inside the encrypted payload, so the server cannot open an attachment it stores.
 */

type AttachmentMeta = {
  mediaId: string;
  /** Raw AES key for the blob, base64. */
  key: string;
  iv: string;
  name: string;
  mime: string;
  size: number;
};

export type MessageBody = {
  text: string;
  attachment: AttachmentMeta | null;
};

export function encodeBody(body: MessageBody): string {
  return JSON.stringify(body);
}

/**
 * Parses a decrypted body defensively: authentication already proved the sender held
 * the conversation key, but not that they sent a well-formed envelope.
 */
export function decodeBody(raw: string): MessageBody {
  try {
    const parsed = JSON.parse(raw) as Partial<MessageBody>;
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      attachment: isAttachment(parsed.attachment) ? parsed.attachment : null,
    };
  } catch {
    return { text: raw, attachment: null };
  }
}

function isAttachment(value: unknown): value is AttachmentMeta {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AttachmentMeta>;
  return (
    typeof candidate.mediaId === "string" &&
    typeof candidate.key === "string" &&
    typeof candidate.iv === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.mime === "string" &&
    typeof candidate.size === "number"
  );
}
