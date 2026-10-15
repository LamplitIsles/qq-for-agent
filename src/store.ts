import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { privateDirectory, SafeError } from "./config.ts";

export type Kind = "group" | "c2c";
export interface Message {
  app_id: string;
  conversation_id: string;
  conversation_type: Kind;
  native_conversation_id: string;
  message_id: string;
  direction: "inbound" | "outbound";
  sender_id: string;
  sender_name?: string;
  timestamp: string;
  body: string;
  raw_event_type?: string;
  mentions?: Array<Record<string, string | boolean>>;
  ref_msg_idx?: string;
}
export interface Conversation {
  conversation_id: string;
  conversation_type: Kind;
  native_conversation_id: string;
}
interface Row {
  seq: number;
  payload: string;
}
const MAX_PAGE_BYTES = 512_000;
export class Store {
  private db: DatabaseSync;
  readonly appId: string;
  constructor(path: string, appId: string) {
    this.appId = appId;
    privateDirectory(dirname(path));
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS identity (app_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL, native_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL,
          message_id TEXT NOT NULL, payload TEXT NOT NULL,
          UNIQUE(conversation, message_id));
        CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation, seq);`);
      const identity = this.db.prepare("SELECT app_id FROM identity").get();
      if (identity && identity.app_id !== appId)
        throw new SafeError("Database belongs to a different App");
      if (!identity)
        this.db.prepare("INSERT INTO identity VALUES (?)").run(appId);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  insert(m: Message): boolean {
    if (m.app_id !== this.appId) throw new SafeError("App mismatch");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO conversations(id,kind,native_id) VALUES (?,?,?)",
        )
        .run(m.conversation_id, m.conversation_type, m.native_conversation_id);
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO messages(conversation,message_id,payload) VALUES (?,?,?)",
        )
        .run(m.conversation_id, m.message_id, JSON.stringify(m));
      this.db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  conversation(id: string): Conversation {
    const row = this.db
      .prepare("SELECT id,kind,native_id FROM conversations WHERE id=?")
      .get(id);
    if (!row) throw new SafeError("Conversation not observed");
    return {
      conversation_id: String(row.id),
      conversation_type: row.kind as Kind,
      native_conversation_id: String(row.native_id),
    };
  }
  message(conversation: string, id: string): Message | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM messages WHERE conversation=? AND message_id=?",
      )
      .get(conversation, id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  private cursor(scope: string, seq: number) {
    return Buffer.from(JSON.stringify([this.appId, scope, seq])).toString(
      "base64url",
    );
  }
  private boundary(scope: string, before?: string): number {
    if (!before) return Number.MAX_SAFE_INTEGER;
    try {
      if (before.length > 4096 || !/^[\w-]+$/.test(before)) throw 0;
      const [app, boundScope, seq, ...extra] = JSON.parse(
        Buffer.from(before, "base64url").toString(),
      );
      if (
        app !== this.appId ||
        boundScope !== scope ||
        !Number.isSafeInteger(seq) ||
        seq < 1 ||
        extra.length
      )
        throw 0;
      return seq;
    } catch {
      throw new SafeError("Invalid cursor for this App/conversation");
    }
  }
  private limit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new SafeError("Limit must be 1–100");
    return limit;
  }
  conversations(limit = 20, before?: string) {
    const rows = this.db
      .prepare(
        "SELECT seq,id,kind,native_id FROM conversations WHERE seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(this.boundary("conversations", before), this.limit(limit) + 1);
    const page = rows.slice(0, limit);
    return {
      conversations: page.map((r) => ({
        conversation_id: r.id,
        conversation_type: r.kind,
        native_conversation_id: r.native_id,
      })),
      next:
        rows.length > limit
          ? this.cursor("conversations", Number(page.at(-1)!.seq))
          : null,
      observed_only: true,
      incomplete: true,
    };
  }
  read(conversation: string, limit = 20, before?: string) {
    this.conversation(conversation);
    const rows = this.db
      .prepare(
        "SELECT seq,payload FROM messages WHERE conversation=? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(
        conversation,
        this.boundary(conversation, before),
        this.limit(limit) + 1,
      ) as unknown as Row[];
    const page: Row[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const size = Buffer.byteLength(row.payload);
      if (bytes + size > MAX_PAGE_BYTES) {
        if (!page.length)
          throw new SafeError("Message exceeds query response budget");
        break;
      }
      bytes += size;
      page.push(row);
    }
    return {
      messages: page.map((r) => JSON.parse(r.payload) as Message).reverse(),
      next:
        rows.length > page.length
          ? this.cursor(conversation, page.at(-1)!.seq)
          : null,
      observed_only: true,
      incomplete: true,
      page_byte_limit: MAX_PAGE_BYTES,
    };
  }
}
