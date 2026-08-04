import { ok, SlackError } from "../envelope";
import { str, num } from "../args";
import { newFileId } from "../ids";
import { mintTs } from "../ts";
import { runMutation, type MethodHandler } from "../route-helpers";
import { requireChannel } from "./helpers";
import { insertFile, linkFileToMessage, getFile, shapeFile } from "../../store/files";
import { insertMessage } from "../../store/messages";
import type { Database } from "better-sqlite3";
import type { SelfIdentity } from "../../store/meta";

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf",
};

async function readContent(args: Record<string, unknown>): Promise<Buffer> {
  const file = args.file;
  // multipart upload (a File/Blob from formData)
  if (file && typeof file === "object" && "arrayBuffer" in file) {
    return Buffer.from(await (file as Blob).arrayBuffer());
  }
  const content = str(args as never, "content");
  if (content !== undefined) return Buffer.from(content, "utf8");
  throw new SlackError("no_file_data");
}

function storeAndShare(
  db: Database,
  self: SelfIdentity,
  opts: {
    data: Buffer;
    filename: string;
    title: string;
    channels: string[];
    comment: string | undefined;
    threadTs: string | undefined;
  },
) {
  const id = newFileId();
  const created = Math.floor(Date.now() / 1000);
  const filetype = extOf(opts.filename) || "text";
  const mimetype = MIME_BY_EXT[filetype] ?? "application/octet-stream";
  insertFile(db, {
    id,
    user: self.userId,
    name: opts.filename,
    title: opts.title,
    mimetype,
    filetype,
    size: opts.data.length,
    created,
    urlPrivate: `https://sandbox.local/files/${id}/${opts.filename}`,
    permalink: `https://sandbox.local/files/${id}`,
    data: opts.data,
    rawJson: JSON.stringify({
      id,
      created,
      name: opts.filename,
      title: opts.title,
      mimetype,
      filetype,
      user: self.userId,
      size: opts.data.length,
      mode: "hosted",
      is_public: false,
      url_private: `https://sandbox.local/files/${id}/${opts.filename}`,
      permalink: `https://sandbox.local/files/${id}`,
    }),
    isSandboxCreated: true,
  });

  // Sharing a file posts a message carrying it into each channel.
  for (const channelId of opts.channels) {
    const ts = mintTs(db, channelId);
    insertMessage(db, {
      channelId,
      ts,
      threadTs: opts.threadTs ?? null,
      user: self.userId,
      text: opts.comment ?? "",
      hasFiles: true,
      rawJson: JSON.stringify({
        type: "message",
        user: self.userId,
        text: opts.comment ?? "",
        ts,
        team: self.teamId,
      }),
      isSandboxCreated: true,
    });
    linkFileToMessage(db, channelId, ts, id);
  }
  return id;
}

/**
 * files.upload (v1, deprecated by Slack but still what many agents call) and
 * files.uploadV2's single-shot form. Content comes from `content` (text) or a
 * multipart `file` part.
 */
export const filesUpload: MethodHandler = async ({ db, args, self, method, httpMethod }) => {
  const data = await readContent(args);
  const filename = str(args, "filename") ?? "upload.txt";
  const title = str(args, "title") ?? filename;
  const channels = (str(args, "channels") ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => requireChannel(db, c, self.userId).id);
  const comment = str(args, "initial_comment");
  const threadTs = str(args, "thread_ts");

  const id = runMutation(
    db,
    () => storeAndShare(db, self, { data, filename, title, channels, comment, threadTs }),
    (fileId) => ({
      method: httpMethod,
      endpoint: method,
      actionType: "upload",
      targetType: "file",
      targetId: fileId,
      request: { filename, title, channels, size: data.length },
      responseCode: 200,
      summary: `uploaded ${filename} (${data.length} bytes)${channels.length ? ` to ${channels.length} channel(s)` : ""}`,
    }),
  );

  return ok({ file: shapeFile(db, getFile(db, id)!) });
};

// --- uploadV2's external flow ------------------------------------------------
// The SDK's filesUploadV2 does getUploadURLExternal → POST bytes to that URL →
// completeUploadExternal. We serve all three locally so the SDK helper works.

interface PendingUpload {
  id: string;
  filename: string;
  length: number;
  data?: Buffer;
}
const g = globalThis as unknown as { __slackSandboxUploads?: Map<string, PendingUpload> };
if (!g.__slackSandboxUploads) g.__slackSandboxUploads = new Map();
const pending = g.__slackSandboxUploads;

export const filesGetUploadURLExternal: MethodHandler = ({ args, self }) => {
  const filename = str(args, "filename") ?? "upload.txt";
  const length = num(args, "length") ?? 0;
  const id = newFileId();
  pending.set(id, { id, filename, length });
  const base = process.env.SANDBOX_PUBLIC_URL || `http://localhost:${process.env.PORT || 3200}`;
  void self;
  return ok({ upload_url: `${base}/api/sandbox/upload/${id}`, file_id: id });
};

export function acceptUploadBytes(fileId: string, data: Buffer): boolean {
  const p = pending.get(fileId);
  if (!p) return false;
  p.data = data;
  return true;
}

export const filesCompleteUploadExternal: MethodHandler = ({ db, args, self, method, httpMethod }) => {
  const filesArg = args.files;
  const parsed: Array<{ id: string; title?: string }> =
    typeof filesArg === "string" ? JSON.parse(filesArg) : (filesArg as never) ?? [];
  if (!parsed.length) throw new SlackError("invalid_arguments");
  const channelArg = str(args, "channel_id") ?? str(args, "channels");
  const channels = (channelArg ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => requireChannel(db, c, self.userId).id);
  const comment = str(args, "initial_comment");
  const threadTs = str(args, "thread_ts");

  const out: string[] = [];
  runMutation(
    db,
    () => {
      for (const f of parsed) {
        const p = pending.get(f.id);
        if (!p?.data) throw new SlackError("upload_not_found");
        const id = storeAndShare(db, self, {
          data: p.data,
          filename: p.filename,
          title: f.title ?? p.filename,
          channels,
          comment,
          threadTs,
        });
        pending.delete(f.id);
        out.push(id);
      }
    },
    () => ({
      method: httpMethod,
      endpoint: method,
      actionType: "upload",
      targetType: "file",
      targetId: out.join(","),
      request: { files: parsed, channels },
      responseCode: 200,
      summary: `completed upload of ${out.length} file(s)${channels.length ? ` to ${channels.length} channel(s)` : ""}`,
    }),
  );

  return ok({ files: out.map((id) => shapeFile(db, getFile(db, id)!)) });
};
