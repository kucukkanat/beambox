import { type ReactNode, useEffect, useState } from "react";
import type { Api, Hypervisor } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Card } from "./components/ui/card.tsx";

/** The only first-launch prompt: shown when the host can't run microVMs. */
export function HypervisorCard({ api }: { api: Api }) {
  const [hypervisor, setHypervisor] = useState<Hypervisor | null>(null);
  const [restart, setRestart] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void api.hypervisor().then(setHypervisor, () => {}), [api]);

  if (!hypervisor || hypervisor.state === "ok") return null;
  const enable = () =>
    api.enableHypervisor().then(
      () => setRestart(true),
      (e) => setError(String(e)),
    );

  let title: string;
  let body: ReactNode;
  if (hypervisor.state === "unsupported") {
    title = "This computer isn't supported";
    body =
      "Beambox runs sandboxes as microVMs, which needs a Mac with Apple Silicon, Linux with KVM or Windows 11.";
  } else if (hypervisor.os === "windows") {
    title = "Windows Hypervisor Platform is off";
    body = restart ? (
      "Restart Windows to finish, then open Beambox again."
    ) : (
      <Button onClick={enable}>Enable Windows Hypervisor Platform</Button>
    );
  } else if (hypervisor.os === "linux") {
    title = "KVM isn't available";
    body = (
      <>
        Beambox needs access to <code>/dev/kvm</code>. Turn on virtualization in your firmware settings, then
        run <code>sudo usermod -aG kvm $USER</code> and log in again.
      </>
    );
  } else {
    title = "Hypervisor.framework isn't available";
    body = "macOS reports no hypervisor support. If this Mac is itself a VM, turn on nested virtualization.";
  }

  return (
    <Card role="alert" className="flex flex-col gap-2 border-[var(--led-amber)] p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="text-muted-foreground text-sm">{body}</div>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </Card>
  );
}
