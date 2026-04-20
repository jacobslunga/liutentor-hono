import { HTTPException } from "hono/http-exception";
import { supabase } from "~/db/supabase";

export async function getAuthenticatedUserId(
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;

  return data.user.id;
}

export async function assertConversationOwnership(
  conversationId: string,
  userId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("conversations")
    .select("user_id")
    .eq("id", conversationId)
    .single();

  if (error || !data) {
    throw new HTTPException(404, { message: "Conversation not found" });
  }
  if (data.user_id !== userId) {
    throw new HTTPException(403, { message: "Not your conversation" });
  }
}
