export const padMarkup = `
<section class="sc-pad" aria-label="Scratchpad">
  <header class="sc-pad__head">
    <h2 class="sc-pad__title">Scratchpad</h2>
    <span class="jds-hint sc-pad__status" role="status">Saved</span
    ><button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Scratchpad settings"
      title="Scratchpad settings"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path
          d="m9.7 4.3.5-2.3h3.6l.5 2.3 1.8 1 2.2-.7 1.8 3.1-1.7 1.6v2.1l1.7 1.6-1.8 3.1-2.2-.7-1.8 1-.5 2.3h-3.6l-.5-2.3-1.8-1-2.2.7-1.8-3.1 1.7-1.6V9.3L4.4 7.7l1.8-3.1 2.2.7Z"
        />
        <circle cx="12" cy="10.4" r="3" />
      </svg></button
    ><button
      class="jds-iconbtn jds-iconbtn--sm sc-pad__close"
      aria-label="Close scratchpad"
      title="Close scratchpad"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path class="sc-pad__close-desktop" d="M18 6 6 18M6 6l12 12" />
        <path class="sc-pad__close-phone" d="m15 18-6-6 6-6" />
      </svg>
    </button>
  </header>
  <div id="notice" class="sc-pad__notice" role="status" hidden></div>
  <div id="conflict" class="sc-pad__conflict" role="alert" hidden>
    <span>Changed elsewhere</span
    ><button class="jds-btn jds-btn--secondary" id="reload">Reload</button>
  </div>
  <div id="failure" role="alert" hidden>
    <span id="error-text"></span>
    <button class="jds-btn jds-btn--secondary" id="retry">Try again</button>
  </div>
  <textarea
    class="jds-textarea sc-pad__text"
    aria-label="Scratchpad text"
    placeholder="Jot something down…"
    disabled
  ></textarea>
  <p id="count" class="jds-hint sc-pad__count" hidden></p>
  <div class="sc-pad__tools" role="toolbar" aria-label="Formatting">
    <button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Bullet list"
      title="Bullet list"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </svg></button
    ><button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Numbered list"
      title="Numbered list"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path
          d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"
        />
      </svg></button
    ><button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Checkbox"
      title="Checkbox"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <rect x="3" y="5" width="6" height="6" rx="1" />
        <path d="m3 17 2 2 4-4M13 6h8M13 12h8M13 18h8" />
      </svg></button
    ><button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Indent"
      title="Indent"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path d="M3 8l4 4-4 4M21 12H11M21 6H11M21 18H11" />
      </svg></button
    ><button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Outdent"
      title="Outdent"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path d="M7 8l-4 4 4 4M21 12H11M21 6H11M21 18H11" />
      </svg></button
    ><button class="jds-iconbtn jds-iconbtn--sm" aria-label="Bold" title="Bold">
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path d="M6 12h9a4 4 0 0 1 0 8H6V4h8a4 4 0 0 1 0 8" />
      </svg></button
    ><button
      class="jds-iconbtn jds-iconbtn--sm"
      aria-label="Italic"
      title="Italic"
    >
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.6"
        viewBox="0 0 24 24"
      >
        <path d="M19 4h-9M14 20H5M15 4 9 20" />
      </svg>
    </button>
  </div>
</section>
`;
