import { ClientActivity } from "@/components/client-activity";

export const dynamic = "force-dynamic";

export default async function ClientActivityPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  return <ClientActivity chatId={decodeURIComponent(chatId)} />;
}
