// Tiny stroke-icon set used inside the wizard. Phosphor isn't available
// for the FAB itself (it lives outside the admin layout where the font
// is loaded, so the safer move is to ship our own SVG paths).

type IconProps = { className?: string };

const ic = (paths: React.ReactNode) =>
  function Icon({ className }: IconProps) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {paths}
      </svg>
    );
  };

export const WI = {
  Sparkle: ic(
    <>
      <path d="M12 3l1.9 5.5L19.5 10l-5.6 1.5L12 17l-1.9-5.5L4.5 10l5.6-1.5z" />
      <path d="M19 17l.8 2.2 2.2.8-2.2.8L19 23l-.8-2.2-2.2-.8 2.2-.8z" />
    </>,
  ),
  Question: ic(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1 1-2 1-2 2.5" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" />
    </>,
  ),
  X: ic(<path d="M18 6L6 18M6 6l12 12" />),
  ArrowRight: ic(<path d="M5 12h14M13 5l7 7-7 7" />),
  Check: ic(<path d="M20 6L9 17l-5-5" />),
  ChevRight: ic(<path d="M9 18l6-6-6-6" />),
  Lock: ic(
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>,
  ),
};
