/**
 * A link the sandbox asked the app to open (`beambox-open`, the sandbox's $BROWSER, sends OSC 1337
 * `BeamboxOpen=<url>` through tmux). Only https links are opened, so a program in the sandbox can't make the
 * computer open files or other schemes.
 */
export function linkToOpen(osc: string): string | null {
  const url = osc.startsWith("BeamboxOpen=") ? osc.slice("BeamboxOpen=".length) : null;
  return url && /^https:\/\/[^\s]+$/.test(url) ? url : null;
}
