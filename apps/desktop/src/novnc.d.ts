declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    disconnect(): void;
    addEventListener(type: "connect" | "disconnect", listener: () => void): void;
    addEventListener(type: "clipboard", listener: (event: CustomEvent<{ text: string }>) => void): void;
  }
}
