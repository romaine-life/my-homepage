window.addEventListener("homepage:open-tab", (event) => {
  const url = event && event.detail && event.detail.url;
  if (typeof url !== "string" || url.length === 0) return;

  chrome.runtime.sendMessage({
    type: "homepage.openTab",
    url,
    active: event.detail.active !== false,
  }).catch(() => {});
});
