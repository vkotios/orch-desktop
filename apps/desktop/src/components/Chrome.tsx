import { useEffect, useRef, type ReactNode } from "react";

const paths = {
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M18 6 6 18",
  chevron: "m9 5 7 7-7 7",
  down: "m7 10 5 5 5-5",
  folder: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z",
  branch:
    "M6 3v12a4 4 0 0 0 4 4h5M18 7v4a4 4 0 0 1-4 4H6M6 3h.01M18 4h.01M18 19h.01",
  panel: "M4 4h16v16H4ZM9 4v16",
  activity: "M4 16V9m5 7V5m5 11v-5m5 5V7",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6Z",
  chat: "M5 5h14v11H9l-4 4Z",
  search: "m16 16 4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-12-2 14",
  plan: "M8 6h12M8 12h12M8 18h8M3 6h.01M3 12h.01M3 18h.01",
  check: "m5 12 4 4L19 6",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  moon: "M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z",
  sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 1.4 1.4m10 10 1.4 1.4M5.6 18.4 1.4-1.4m10-10 1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  refresh: "M20 8a8 8 0 1 0 .3 7M20 3v5h-5",
  terminal: "m5 6 5 6-5 6m8 0h6",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
};

export function Icon({
  name,
  size = 18,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Dialog({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
