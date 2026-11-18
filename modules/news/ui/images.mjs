// Fills in story pictures and site icons. Each one is fetched through the host once, kept in
// memory by address, and loaded a few at a time so a long page does not flood the bridge.

const MAX_AT_ONCE = 4;

export function createImages(api, { onSettled = () => {}, onFail = () => {} } = {}) {
  const cache = new Map();
  const failed = new Set();
  const waiting = [];
  const loading = new Set();
  let active = 0;

  function apply(root, url, dataUrl) {
    for (const img of root.querySelectorAll("img[data-img]")) {
      if (img.getAttribute("data-img") === url && img.getAttribute("src") !== dataUrl) {
        img.setAttribute("src", dataUrl);
      }
    }
  }

  function pump(root) {
    while (active < MAX_AT_ONCE && waiting.length > 0) {
      const url = waiting.shift();
      active += 1;
      api
        .picture(url)
        .then((dataUrl) => {
          cache.set(url, dataUrl);
          apply(root, url, dataUrl);
        })
        .catch(() => {
          failed.add(url);
          for (const img of root.querySelectorAll("img[data-img]")) {
            if (img.getAttribute("data-img") === url) onFail(img);
          }
        })
        .finally(() => {
          active -= 1;
          loading.delete(url);
          onSettled();
          pump(root);
        });
    }
  }

  return {
    // Call after every redraw. Known pictures appear at once and new ones join the queue.
    hydrate(root) {
      for (const img of root.querySelectorAll("img[data-img]")) {
        const url = img.getAttribute("data-img");
        if (cache.has(url)) img.setAttribute("src", cache.get(url));
        else if (failed.has(url)) onFail(img);
        else if (!loading.has(url)) {
          loading.add(url);
          waiting.push(url);
        }
      }
      pump(root);
    }
  };
}
