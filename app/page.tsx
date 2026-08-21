import { LibraryClient } from "@/components/LibraryClient";

export const metadata = {
  title: "Library",
  description: "Upload math textbooks and annotate them with beautifully rendered mathematics.",
};

export default function Home() {
  return <LibraryClient />;
}
