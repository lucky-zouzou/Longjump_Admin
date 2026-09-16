import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getChatGPTUser } from "./chatgpt-auth";
import ControlTower from "./control-tower";

export const dynamic = "force-dynamic";

export default async function Home() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "";
  const isLocal = process.env.NODE_ENV === "development" && (host.startsWith("localhost") || host.startsWith("127.0.0.1"));
  const user = await getChatGPTUser();

  if (!user && !isLocal) redirect("/signin-with-chatgpt?return_to=%2F");

  const identity = user ?? {
    userId: "local-admin",
    displayName: "本地管理员",
    email: "admin@loongjump.local",
    fullName: "本地管理员",
  };

  return <ControlTower identity={identity} />;
}
