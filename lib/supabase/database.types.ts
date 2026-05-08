import type { Json } from "@/lib/types";

type DbTable<Row, Insert = Record<string, unknown>, Update = Record<string, unknown>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      messages: DbTable<{
        id: string;
        telegram_message_id: string | number | null;
        telegram_chat_id: string | number | null;
        telegram_user_id: string | number | null;
        telegram_username: string | null;
        message_text: string | null;
        message_type: string | null;
        raw_payload: Json | null;
        created_at: string | null;
      }>;
      tickets: DbTable<{
        id: string;
        ticket_code: string | null;
        client_chat_id: string | number | null;
        client_message_id: string | number | null;
        client_user_id: string | number | null;
        client_username: string | null;
        intent: string | null;
        status: string | null;
        priority: string | null;
        needs_mark: boolean | null;
        client_original_message: string | null;
        extracted_data: Json | null;
        internal_summary: string | null;
        holding_message_id: string | number | null;
        internal_message_id: string | number | null;
        completion_message: string | null;
        created_at: string | null;
        updated_at: string | null;
        closed_at: string | null;
      }>;
      bot_responses: DbTable<{
        id: string;
        ticket_id: string | null;
        telegram_chat_id: string | number | null;
        telegram_message_id: string | number | null;
        response_type: string | null;
        response_text: string | null;
        created_at: string | null;
      }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
