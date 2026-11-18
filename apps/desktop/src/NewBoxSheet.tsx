import { Dialog } from "radix-ui";
import { type FormEvent, useEffect, useState } from "react";
import type { Api, CreateOpts, Harness } from "./api.ts";
import { HELPERS, type Helper, ROOMY, SIZES } from "./box.ts";
import { Button } from "./components/ui/button.tsx";
import { Icon } from "./keys.tsx";
import { showError } from "./lib/utils.ts";
import { KEY_HELP } from "./Shelf.tsx";
import { sound } from "./sound.ts";

const EXAMPLES = [
  "Fix the failing tests",
  "Build a landing page for my bakery",
  "Rename my holiday photos by date",
  "Summarise the PDFs in this folder",
];
const NETWORKS = [
  ["public", "Internet", "Can reach the internet, not the other devices on your network."],
  ["none", "Offline", "No network at all. Safest for private files."],
  ["all", "Internet + my network", "Can also reach printers, NAS and other devices at home or work."],
] as const;
const HELPER_IDS = Object.keys(HELPERS) as Helper[];
const defaultSize = (helper: Helper, screen: boolean) => (screen ? ROOMY : helper === "none" ? 0 : 1);

type Props = { api: Api; open: boolean; onOpenChange(open: boolean): void; onCreate(opts: CreateOpts): void };

/** The New box sheet: who works in it, what the job is, and what the box gets. */
export function NewBoxSheet({ api, open, onOpenChange, onCreate }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <div className="sheet-wrap">
          {/* Remounted on every open, so each box starts from the defaults. */}
          {open && <Sheet api={api} onCreate={onCreate} onClose={() => onOpenChange(false)} />}
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Sheet({ api, onCreate, onClose }: { api: Api; onCreate(opts: CreateOpts): void; onClose(): void }) {
  const [helper, setHelper] = useState<Helper>("claude-code");
  const [task, setTask] = useState("");
  const [mount, setMount] = useState<string | null>(null);
  const [screen, setScreen] = useState(false);
  const [size, setSize] = useState(defaultSize("claude-code", false));
  const [network, setNetwork] = useState<string>("public");
  const [name, setName] = useState("");
  const [ports, setPorts] = useState("");
  // Keys each harness could use when none is stored yet: empty means signed in.
  const [missing, setMissing] = useState<Partial<Record<Harness, string[]>>>({});
  const [provider, setProvider] = useState("");
  const [key, setKey] = useState("");
  useEffect(() => {
    let current = true;
    for (const h of HELPER_IDS)
      if (h !== "none")
        void api
          .missingCredentials(h)
          .then((keys) => current && setMissing((all) => ({ ...all, [h]: keys })), showError);
    return () => {
      current = false;
    };
  }, [api]);
  useEffect(() => api.onFolderDrop(setMount), [api]);
  const plain = helper === "none";
  const needKeys = plain ? [] : (missing[helper] ?? []);
  useEffect(() => setProvider(needKeys[0] ?? ""), [needKeys[0]]);
  const ok = plain || task.trim().length > 0;
  const chosen = SIZES[size] ?? SIZES[1];

  const pick = (h: Helper) => {
    setHelper(h);
    setSize(defaultSize(h, screen));
  };
  const toggleScreen = () => {
    sound.clunk();
    setScreen(!screen);
    if (!screen) setSize((s) => Math.max(s, ROOMY));
  };
  const build = async () => {
    if (!ok) return;
    if (needKeys.length && key.trim()) {
      try {
        await api.setCredential(provider, key.trim());
      } catch (error) {
        return showError(error);
      }
    }
    const opts: CreateOpts = {};
    if (!plain) {
      opts.harness = helper;
      opts.task = task.trim();
    }
    if (mount) opts.mount = mount;
    opts.desktop = screen;
    opts.cpus = chosen.cpus;
    opts.memoryMib = chosen.gb * 1024;
    opts.network = network;
    if (name.trim()) opts.name = name.trim();
    const list = ports
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (list.length) opts.ports = list;
    onCreate(opts);
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void build();
  };
  const browse = () => {
    if (mount) return setMount(null);
    void api.pickFolder().then((folder) => folder && setMount(folder), showError);
  };
  const net = NETWORKS.find(([id]) => id === network) ?? NETWORKS[0];
  const summary = [
    HELPERS[helper].name,
    `${chosen.cpus} CPU · ${chosen.gb} GB`,
    mount ? `borrows ${mount}` : "no folder",
    screen && "with a screen",
    net[1].toLowerCase(),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Dialog.Content asChild aria-describedby={undefined}>
      <form
        className="sheet"
        onSubmit={submit}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(e);
        }}
      >
        <div className="flex items-center gap-3">
          <Dialog.Title asChild>
            <h2>New box</h2>
          </Dialog.Title>
          <Button size="sq" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </div>

        <div className="step">
          <div className="step-h">
            <b>1</b>
            <h3>Who works in it?</h3>
          </div>
          <div className="helpers" role="radiogroup" aria-label="Who works in it">
            {HELPER_IDS.map((h) => {
              const keys = h === "none" ? [] : missing[h];
              return (
                // biome-ignore lint/a11y/useSemanticElements: keycaps, like the prototype; a radio input can't be styled as one
                <button
                  type="button"
                  key={h}
                  role="radio"
                  aria-checked={helper === h}
                  className="hcap"
                  onClick={() => {
                    sound.press();
                    pick(h);
                  }}
                >
                  <span className="mark">{HELPERS[h].mark}</span>
                  <strong>{HELPERS[h].name}</strong>
                  <small>{HELPERS[h].by}</small>
                  <span className="hled">
                    <span className={keys?.length ? "led led-amber" : "led led-green"} />
                    {h === "none"
                      ? "Nothing to sign in"
                      : keys === undefined
                        ? "…"
                        : keys.length
                          ? "Sign in once"
                          : "Signed in"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="step">
          <div className="step-h">
            <b>2</b>
            <h3>{plain ? "What's it for?" : "What's the job?"}</h3>
          </div>
          {plain ? (
            <p className="dim m-0">
              A clean Linux computer with a terminal. Use it to try things out without touching your own
              computer.
            </p>
          ) : (
            <>
              <textarea
                aria-label="The job"
                // biome-ignore lint/a11y/noAutofocus: the sheet opens to write the job
                autoFocus
                className="field"
                rows={3}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Describe it like you would to a colleague. For example: fix the failing tests and tell me what was wrong."
              />
              <div className="chips">
                {EXAMPLES.map((example) => (
                  <button type="button" key={example} className="chip" onClick={() => setTask(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="step">
          <div className="step-h">
            <b>3</b>
            <h3>What does it get?</h3>
          </div>
          <div className="gets">
            <div className="well">
              <h4>
                A folder to work on <span className="mono dim">Optional</span>
              </h4>
              <button type="button" className={mount ? "drop has" : "drop"} onClick={browse}>
                <Icon name="folder" size={26} />
                {mount ? (
                  <span>
                    <code>{mount}</code>
                    <br />
                    <span className="dim">Shows up as /workspace. Click to remove.</span>
                  </span>
                ) : (
                  <span>
                    Click to choose a folder.
                    <br />
                    <span className="dim">It's the only part of your computer the box can see.</span>
                  </span>
                )}
              </button>
            </div>
            <div className="well">
              <h4>
                A screen
                <button
                  type="button"
                  role="switch"
                  aria-checked={screen}
                  aria-label="A screen"
                  className="toggle"
                  onClick={toggleScreen}
                />
              </h4>
              <p>So it can use a browser and desktop apps, and you can watch. Needs at least Roomy.</p>
            </div>
            <div className="well">
              <h4>
                How big{" "}
                <span className="mono">
                  {chosen.cpus} CPU · {chosen.gb} GB
                </span>
              </h4>
              <div className="fader">
                <input
                  type="range"
                  min={0}
                  max={SIZES.length - 1}
                  step={1}
                  value={size}
                  aria-label="How big"
                  aria-valuetext={`${chosen.label}: ${chosen.cpus} CPU, ${chosen.gb} GB memory`}
                  onChange={(e) => setSize(Math.max(screen ? ROOMY : 0, Number(e.target.value)))}
                />
                <div className="ticks">
                  {SIZES.map((s, i) => (
                    <span key={s.label} className={i === size ? "on" : ""}>
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="well">
              <h4>Network</h4>
              <fieldset className="seg" aria-label="Network">
                {NETWORKS.map(([id, label]) => (
                  <Button key={id} aria-pressed={network === id} onClick={() => setNetwork(id)}>
                    {label}
                  </Button>
                ))}
              </fieldset>
              <p>{net[2]}</p>
            </div>
          </div>
          <details className="adv">
            <summary>More options</summary>
            <div className="adv-grid">
              <label>
                Name
                <input
                  className="field small"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Automatic: sandbox-1, sandbox-2…"
                />
              </label>
              <label>
                Web ports to share with your computer
                <input
                  className="field small"
                  value={ports}
                  onChange={(e) => setPorts(e.target.value)}
                  placeholder="3000, 8080"
                />
              </label>
              {needKeys.length > 0 && (
                <div className="flex flex-col gap-1.5 text-[12.5px] text-[var(--ink-2)]">
                  {needKeys.length > 1 && (
                    <select
                      aria-label="Key provider"
                      className="field small"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {needKeys.map((p) => (
                        <option key={p} value={p}>
                          {KEY_HELP[p]?.[0] ?? p}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="flex flex-col gap-1.5">
                    {KEY_HELP[provider]?.[0] ?? `${provider} key`}
                    <input
                      type="password"
                      autoComplete="off"
                      className="field small"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder="Optional: paste once, kept in your keychain"
                    />
                  </label>
                  <span>
                    {KEY_HELP[provider]?.[1]} Or leave it empty and sign in with your subscription in the
                    box's terminal.
                  </span>
                </div>
              )}
            </div>
          </details>
        </div>

        <div className="sheet-foot">
          <p>{summary}</p>
          <Button type="submit" variant="accent" size="big" disabled={!ok}>
            Build the box <kbd>⌘↵</kbd>
          </Button>
        </div>
      </form>
    </Dialog.Content>
  );
}
