import { postJson } from "./provider-client";

export async function sendEmail(to: string, subject: string, body: string): Promise<{ messageId: string }> {
  return postJson("/emails", { to, subject, body });
}
