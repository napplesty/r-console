/** Pill switch used across settings rows. */
export default function Toggle({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-(--accent)" : "bg-(--hover)"
      }`}
    >
      <span
        className={`block h-3.5 w-3.5 rounded-full bg-(--text) transition-transform ${
          checked ? "translate-x-[1.25rem]" : "translate-x-[0.1875rem]"
        }`}
      />
    </button>
  );
}
