import { postJson, type CallOptions } from "./provider-client";

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  opts: CallOptions,
): Promise<{ messageId: string }> {
  return postJson("/emails", { to, subject, body }, opts);
}
