import { ReaderClient } from "@/components/ReaderClient";

export const metadata = { title: "Reader" };

export default async function ReaderPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  return <ReaderClient documentId={documentId} />;
}
