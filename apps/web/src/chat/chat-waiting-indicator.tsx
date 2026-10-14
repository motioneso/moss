import { BrandMark } from "@moss/ui";

export function ChatWaitingIndicator({ assistantName }: { readonly assistantName: string }) {
  return (
    <div
      className="chatd-loading"
      aria-live="polite"
      aria-label={assistantName ? `${assistantName} is thinking` : "Assistant is thinking"}
    >
      <span className="chatd-msg__av">
        <BrandMark size={14} />
      </span>
      <svg
        className="chatd-loading__bar"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 14 32 4"
        fill="currentColor"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path opacity="0.8" transform="translate(0 0)" d="M2 14 V18 H6 V14z">
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 24 0; 0 0"
            dur="2s"
            begin="0"
            repeatCount="indefinite"
            keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8"
            calcMode="spline"
          />
        </path>
        <path opacity="0.5" transform="translate(0 0)" d="M0 14 V18 H8 V14z">
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 24 0; 0 0"
            dur="2s"
            begin="0.1s"
            repeatCount="indefinite"
            keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8"
            calcMode="spline"
          />
        </path>
        <path opacity="0.25" transform="translate(0 0)" d="M0 14 V18 H8 V14z">
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0; 24 0; 0 0"
            dur="2s"
            begin="0.2s"
            repeatCount="indefinite"
            keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8"
            calcMode="spline"
          />
        </path>
      </svg>
    </div>
  );
}
