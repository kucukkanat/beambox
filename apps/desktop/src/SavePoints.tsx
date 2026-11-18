import { useCallback, useEffect, useState } from "react";
import type { Api, SavePoint } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { HoldKey } from "./keys.tsx";
import { showError } from "./lib/utils.ts";

type Props = {
  api: Api;
  /** The box whose save points these are. */
  name: string;
  /** Changes after each Save point: the strip reloads then, and polls nothing. */
  version: number;
  /** Start a copy from save point number `n`. */
  onCopy(snapshot: string, n: number): void;
  /** Rewind the box to save point number `n`. */
  onRewind(snapshot: string, n: number): void;
};

/** A box's save points as a strip of photo cards, oldest to newest, ending at NOW. */
export function SavePoints({ api, name, version, onCopy, onRewind }: Props) {
  const [points, setPoints] = useState<SavePoint[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the reload signal
  const load = useCallback(
    () => void api.savePoints(name).then((all) => setPoints([...all].reverse()), showError),
    [api, name, version],
  );
  useEffect(load, [load]);

  const index = points.findIndex((p) => p.snapshot === selected);
  const point = points[index];
  const remove = (snapshot: string) =>
    void api.removeSavePoint(snapshot).then(() => {
      setSelected(null);
      load();
    }, showError);

  return (
    <section aria-label="Save points" className="panel flex flex-col gap-2.5">
      <div className="sect">
        <h2>Save points</h2>
        <span className="rule" />
        <span className="mono dim">They keep the files, not the agent's memory: it starts over on them.</span>
      </div>
      {points.length === 0 ? (
        <p className="dim">
          No save points yet. Take one before a risky step, then rewind to it or start a copy from it.
        </p>
      ) : (
        <ol className="save-points">
          {points.map((p, i) => {
            const time = new Date(p.takenAt * 1000).toLocaleString();
            return (
              <li key={p.snapshot}>
                <button
                  type="button"
                  className="save-point"
                  aria-label={`Save point ${i + 1}, ${time}`}
                  aria-pressed={p.snapshot === selected}
                  onClick={() => setSelected(p.snapshot === selected ? null : p.snapshot)}
                >
                  <b className="save-n">{i + 1}</b>
                  <span className="mono dim">{time}</span>
                </button>
              </li>
            );
          })}
          <li className="save-now">NOW</li>
        </ol>
      )}
      {point && (
        <div className="flex flex-wrap items-end gap-3.5">
          <Button variant="accent" onClick={() => onCopy(point.snapshot, index + 1)}>
            Try another way from here
          </Button>
          <HoldKey
            label="Rewind to here"
            icon="restart"
            onConfirm={() => {
              setSelected(null);
              onRewind(point.snapshot, index + 1);
            }}
          />
          <HoldKey label="Remove" onConfirm={() => remove(point.snapshot)} />
        </div>
      )}
    </section>
  );
}
