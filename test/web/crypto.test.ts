import { describe, expect, it } from "vitest";
import {
  exportPublicKey,
  fromBase64,
  generateConversationKey,
  generateIdentity,
  importPublicKey,
  newKeySalt,
  openAttachment,
  openMessage,
  sealAttachment,
  sealMessage,
  toBase64,
  openSignal,
  sealSignal,
  unwrapConversationKey,
  unwrapPrivateKey,
  wrapConversationKey,
  wrapPrivateKey,
} from "../../web/lib/crypto.ts";
import { decodeBody, encodeBody } from "../../web/lib/envelope.ts";

const route = { conversationId: "conv-1", senderId: "user-1", ttlSeconds: 300 };

describe("base64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });
});

describe("identity keys", () => {
  it("restores a private key with the right password", async () => {
    const keys = await generateIdentity();
    const salt = newKeySalt();
    const wrapped = await wrapPrivateKey(keys.privateKey, "a-sufficiently-long-password", salt);

    const restored = await unwrapPrivateKey(wrapped, "a-sufficiently-long-password", salt);
    expect(restored.type).toBe("private");
  });

  it("refuses the wrong password", async () => {
    const keys = await generateIdentity();
    const salt = newKeySalt();
    const wrapped = await wrapPrivateKey(keys.privateKey, "a-sufficiently-long-password", salt);

    await expect(unwrapPrivateKey(wrapped, "not-the-password", salt)).rejects.toThrow();
  });

  it("refuses a different salt, so a wrapped key is bound to its record", async () => {
    const keys = await generateIdentity();
    const wrapped = await wrapPrivateKey(keys.privateKey, "a-sufficiently-long-password", newKeySalt());
    await expect(unwrapPrivateKey(wrapped, "a-sufficiently-long-password", newKeySalt())).rejects.toThrow();
  });

  it("exports and reimports a public key", async () => {
    const keys = await generateIdentity();
    const exported = await exportPublicKey(keys.publicKey);
    const reimported = await importPublicKey(exported);
    expect(await exportPublicKey(reimported)).toBe(exported);
  });
});

describe("conversation keys", () => {
  it("lets the intended member unwrap, via the matching ECDH secret", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const conversationKey = await generateConversationKey();

    const wrapped = await wrapConversationKey(conversationKey, alice.privateKey, bob.publicKey);
    const unwrapped = await unwrapConversationKey(wrapped, bob.privateKey, alice.publicKey);

    const sealed = await sealMessage(conversationKey, "shared secret", route);
    expect(await openMessage(unwrapped, sealed, route)).toBe("shared secret");
  });

  it("lets the wrapper unwrap their own copy", async () => {
    const alice = await generateIdentity();
    const conversationKey = await generateConversationKey();

    const wrapped = await wrapConversationKey(conversationKey, alice.privateKey, alice.publicKey);
    const unwrapped = await unwrapConversationKey(wrapped, alice.privateKey, alice.publicKey);

    const sealed = await sealMessage(conversationKey, "note to self", route);
    expect(await openMessage(unwrapped, sealed, route)).toBe("note to self");
  });

  it("keeps a non-member out, even holding the wrapped blob", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const mallory = await generateIdentity();
    const conversationKey = await generateConversationKey();

    const wrapped = await wrapConversationKey(conversationKey, alice.privateKey, bob.publicKey);
    await expect(unwrapConversationKey(wrapped, mallory.privateKey, alice.publicKey)).rejects.toThrow();
  });

  it("uses a fresh salt per wrap, so two wraps never match", async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const conversationKey = await generateConversationKey();

    const first = await wrapConversationKey(conversationKey, alice.privateKey, bob.publicKey);
    const second = await wrapConversationKey(conversationKey, alice.privateKey, bob.publicKey);
    expect(first).not.toBe(second);
  });
});

describe("message envelope", () => {
  it("round-trips a body through encryption", async () => {
    const key = await generateConversationKey();
    const body = { text: "rotate the key", attachment: null };
    const sealed = await sealMessage(key, encodeBody(body), route);

    expect(sealed.ciphertext).not.toContain("rotate");
    expect(decodeBody(await openMessage(key, sealed, route))).toEqual(body);
  });

  it("uses a fresh IV, so the same text never produces the same ciphertext", async () => {
    const key = await generateConversationKey();
    const first = await sealMessage(key, "same text", route);
    const second = await sealMessage(key, "same text", route);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
  });

  it("fails authentication if the lifespan is tampered with", async () => {
    const key = await generateConversationKey();
    const sealed = await sealMessage(key, "burn in 5 minutes", route);

    // The TTL is bound in as additional data: a server that extends it breaks the tag.
    await expect(openMessage(key, sealed, { ...route, ttlSeconds: 604_800 })).rejects.toThrow();
  });

  it("fails authentication if the message is replayed into another conversation", async () => {
    const key = await generateConversationKey();
    const sealed = await sealMessage(key, "for this room only", route);

    await expect(openMessage(key, sealed, { ...route, conversationId: "conv-2" })).rejects.toThrow();
    await expect(openMessage(key, sealed, { ...route, senderId: "someone-else" })).rejects.toThrow();
  });

  it("fails authentication if the ciphertext is altered", async () => {
    const key = await generateConversationKey();
    const sealed = await sealMessage(key, "do not modify", route);

    const bytes = fromBase64(sealed.ciphertext);
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    await expect(openMessage(key, { ...sealed, ciphertext: toBase64(bytes) }, route)).rejects.toThrow();
  });
});

describe("call signalling", () => {
  const route = { callId: "call-1", senderId: "user-1" };

  it("round-trips an SDP offer under the conversation key", async () => {
    const key = await generateConversationKey();
    const offer = { kind: "description", description: { type: "offer", sdp: "v=0 candidate 203.0.113.7" } };

    const sealed = await sealSignal(key, offer, route);
    expect(sealed.ciphertext).not.toContain("203.0.113");
    expect(await openSignal(key, sealed, route)).toEqual(offer);
  });

  it("refuses a signal replayed into another call", async () => {
    const key = await generateConversationKey();
    const sealed = await sealSignal(key, { kind: "candidate" }, route);

    await expect(openSignal(key, sealed, { ...route, callId: "call-2" })).rejects.toThrow();
    await expect(openSignal(key, sealed, { ...route, senderId: "someone-else" })).rejects.toThrow();
  });

  it("refuses a signal from a different conversation's key", async () => {
    const sealed = await sealSignal(await generateConversationKey(), { kind: "candidate" }, route);
    await expect(openSignal(await generateConversationKey(), sealed, route)).rejects.toThrow();
  });
});

describe("attachments", () => {
  it("round-trips bytes under their own key", async () => {
    const data = new Uint8Array([1, 2, 3, 250, 0, 99]);
    const sealed = await sealAttachment(data);

    expect([...sealed.bytes]).not.toEqual([...data]);
    expect([...(await openAttachment(sealed.bytes, sealed.key, sealed.iv))]).toEqual([...data]);
  });

  it("refuses the wrong key", async () => {
    const sealed = await sealAttachment(new Uint8Array([1, 2, 3]));
    const other = await sealAttachment(new Uint8Array([4, 5, 6]));
    await expect(openAttachment(sealed.bytes, other.key, sealed.iv)).rejects.toThrow();
  });
});

describe("body decoding", () => {
  it("survives a malformed payload instead of throwing", () => {
    expect(decodeBody("not json")).toEqual({ text: "not json", attachment: null });
    expect(decodeBody('{"text":"hi","attachment":{"bad":true}}')).toEqual({ text: "hi", attachment: null });
    expect(decodeBody('{"attachment":null}')).toEqual({ text: "", attachment: null });
  });
});
