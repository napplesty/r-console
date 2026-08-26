import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface HostKeyPayload {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

interface QueueItem {
  kind: "confirm" | "mismatch";
  payload: HostKeyPayload;
}

/**
 * Global host-key dialogs: unknown keys block the SSH handshake until a
 * decision is made; changed keys are a warning only. Events arriving while
 * a dialog is open are queued and shown one at a time.
 */
export default function HostKeyDialog() {
  const [items, setItems] = useState<QueueItem[]>([]);

  useEffect(() => {
    const unConfirm = listen<HostKeyPayload>("host-key-confirm", (e) =>
      setItems((xs) => [...xs, { kind: "confirm", payload: e.payload }]),
    );
    const unMismatch = listen<HostKeyPayload>("host-key-mismatch", (e) =>
      setItems((xs) => [...xs, { kind: "mismatch", payload: e.payload }]),
    );
    return () => {
      unConfirm.then((f) => f());
      unMismatch.then((f) => f());
    };
  }, []);

  const current = items[0] ?? null;
  if (!current) return null;

  const { host, port, keyType, fingerprint } = current.payload;
  const dismiss = () => setItems((xs) => xs.slice(1));
  const decide = (accept: boolean) => {
    invoke("host_key_decision", { host, port, accept }).catch(() => {});
    dismiss();
  };

  const mismatch = current.kind === "mismatch";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={mismatch ? dismiss : undefined}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex w-[28rem] flex-col gap-3 rounded-lg border bg-(--panel-alt) p-5 shadow-xl ${
          mismatch ? "border-red-500/60" : "border-(--border)"
        }`}
      >
        {mismatch ? (
          <>
            <h2 className="text-base font-semibold text-red-400">
              HOST KEY CHANGED
            </h2>
            <p className="text-sm text-red-400/90">
              The host key for {host}:{port} does not match the previously
              trusted key — possible man-in-the-middle attack. The connection
              was rejected.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-(--text)">
              Unknown host key
            </h2>
            <p className="text-sm text-(--text-dim)">
              The authenticity of {host}:{port} can't be established. Verify
              the fingerprint before trusting it.
            </p>
          </>
        )}

        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-(--text-dim)">Host</dt>
            <dd className="text-(--text)">
              {host}:{port}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-(--text-dim)">Key type</dt>
            <dd className="text-(--text)">{keyType}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-(--text-dim)">Fingerprint</dt>
            <dd className="font-mono text-xs break-all text-(--text)">
              {fingerprint}
            </dd>
          </div>
        </dl>

        <div className="mt-1 flex justify-end gap-2">
          {mismatch ? (
            <button
              onClick={dismiss}
              className="rounded bg-red-500/80 px-4 py-1.5 text-sm text-white hover:bg-red-500"
            >
              Close
            </button>
          ) : (
            <>
              <button
                onClick={() => decide(false)}
                className="rounded px-3 py-1.5 text-sm text-(--text-dim) hover:bg-(--hover)"
              >
                Reject
              </button>
              <button
                onClick={() => decide(true)}
                className="rounded bg-(--accent) px-4 py-1.5 text-sm text-white hover:bg-[color-mix(in_srgb,var(--accent)_85%,white)]"
              >
                Trust &amp; Connect
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
