/**
 * All encryption happens here, in the browser. The server receives ciphertext, public
 * keys, and a private key it cannot open.
 *
 * - Identity: ECDH P-256 keypair per account.
 * - Private key at rest: AES-256-GCM under PBKDF2(password).
 * - Conversation key: AES-256-GCM, wrapped per member via ECDH + HKDF.
 * - Messages: AES-256-GCM with the routing fields bound in as additional data.
 */

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const PBKDF2_ITERATIONS = 310_000;
const IV_BYTES = 12;
const HKDF_SALT_BYTES = 16;

/**
 * WebCrypto needs buffers backed by a plain ArrayBuffer, not the SharedArrayBuffer that
 * the default `Uint8Array` type also allows, so byte helpers pin that down.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes: ArrayBuffer | Uint8Array<ArrayBufferLike>): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** Additional authenticated data: binds a message to its route and its lifespan. */
function messageAad(conversationId: string, senderId: string, ttlSeconds: number): Bytes {
  return utf8.encode(`${conversationId}|${senderId}|${ttlSeconds}`);
}

/** Binds a signal to its call and sender, so one cannot be replayed into another call. */
function signalAad(callId: string, senderId: string): Bytes {
  return utf8.encode(`cipher/signal|${callId}|${senderId}`);
}

export async function generateIdentity(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(await crypto.subtle.exportKey("spki", key));
}

export async function importPublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", fromBase64(value), ECDH_PARAMS, true, []);
}

/** Derives the AES key that protects the identity private key at rest. */
async function passwordKey(password: string, salt: Bytes): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", utf8.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function newKeySalt(): string {
  return toBase64(randomBytes(HKDF_SALT_BYTES));
}

/** Encrypts the identity private key so only the password holder can restore it. */
export async function wrapPrivateKey(privateKey: CryptoKey, password: string, keySalt: string): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const iv = randomBytes(IV_BYTES);
  const key = await passwordKey(password, fromBase64(keySalt));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pkcs8);
  return toBase64(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

export async function unwrapPrivateKey(wrapped: string, password: string, keySalt: string): Promise<CryptoKey> {
  const blob = fromBase64(wrapped);
  const key = await passwordKey(password, fromBase64(keySalt));
  const pkcs8 = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(0, IV_BYTES) },
    key,
    blob.subarray(IV_BYTES),
  );
  return crypto.subtle.importKey("pkcs8", pkcs8, ECDH_PARAMS, true, ["deriveBits"]);
}

/**
 * ECDH + HKDF to the AES key that wraps a conversation key. The HKDF salt travels with
 * the wrapped blob, so wrapping never depends on an id the server has not assigned yet.
 */
async function sharedWrapKey(privateKey: CryptoKey, peerPublicKey: CryptoKey, salt: Bytes): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPublicKey },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8.encode("cipher/ckey/v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateConversationKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function wrapConversationKey(
  conversationKey: CryptoKey,
  privateKey: CryptoKey,
  memberPublicKey: CryptoKey,
): Promise<string> {
  const salt = randomBytes(HKDF_SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const raw = await crypto.subtle.exportKey("raw", conversationKey);
  const wrapKey = await sharedWrapKey(privateKey, memberPublicKey, salt);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, raw);
  return toBase64(new Uint8Array([...salt, ...iv, ...new Uint8Array(sealed)]));
}

export async function unwrapConversationKey(
  wrapped: string,
  privateKey: CryptoKey,
  wrapperPublicKey: CryptoKey,
): Promise<CryptoKey> {
  const blob = fromBase64(wrapped);
  const salt = blob.subarray(0, HKDF_SALT_BYTES);
  const iv = blob.subarray(HKDF_SALT_BYTES, HKDF_SALT_BYTES + IV_BYTES);
  const wrapKey = await sharedWrapKey(privateKey, wrapperPublicKey, salt);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrapKey, blob.subarray(HKDF_SALT_BYTES + IV_BYTES));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

type SealedMessage = {
  ciphertext: string;
  iv: string;
};

export async function sealMessage(
  conversationKey: CryptoKey,
  plaintext: string,
  route: { conversationId: string; senderId: string; ttlSeconds: number },
): Promise<SealedMessage> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: messageAad(route.conversationId, route.senderId, route.ttlSeconds),
    },
    conversationKey,
    utf8.encode(plaintext),
  );
  return { ciphertext: toBase64(sealed), iv: toBase64(iv) };
}

export async function openMessage(
  conversationKey: CryptoKey,
  sealed: SealedMessage,
  route: { conversationId: string; senderId: string; ttlSeconds: number },
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(sealed.iv),
      additionalData: messageAad(route.conversationId, route.senderId, route.ttlSeconds),
    },
    conversationKey,
    fromBase64(sealed.ciphertext),
  );
  return decoder.decode(plaintext);
}

/**
 * Seals a WebRTC signal. SDP and ICE candidates carry network addresses, so they are
 * encrypted under the conversation key and the server relays bytes it cannot read.
 */
export async function sealSignal(
  conversationKey: CryptoKey,
  signal: unknown,
  route: { callId: string; senderId: string },
): Promise<SealedMessage> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: signalAad(route.callId, route.senderId) },
    conversationKey,
    utf8.encode(JSON.stringify(signal)),
  );
  return { ciphertext: toBase64(sealed), iv: toBase64(iv) };
}

export async function openSignal(
  conversationKey: CryptoKey,
  sealed: SealedMessage,
  route: { callId: string; senderId: string },
): Promise<unknown> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: signalAad(route.callId, route.senderId) },
    conversationKey,
    fromBase64(sealed.ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext)) as unknown;
}

type SealedAttachment = {
  bytes: Bytes;
  key: string;
  iv: string;
};

/** Attachments get their own key, which is carried inside the encrypted message body. */
export async function sealAttachment(bytes: Bytes): Promise<SealedAttachment> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = randomBytes(IV_BYTES);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return {
    bytes: new Uint8Array(sealed),
    key: toBase64(await crypto.subtle.exportKey("raw", key)),
    iv: toBase64(iv),
  };
}

export async function openAttachment(bytes: Bytes, rawKey: string, iv: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", fromBase64(rawKey), { name: "AES-GCM", length: 256 }, false, [
    "decrypt",
  ]);
  const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, key, bytes);
  return new Uint8Array(opened);
}
