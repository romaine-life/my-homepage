chrome.commands.onCommand.addListener((command) => {
  if (command === "open-homepage") {
    chrome.tabs.create({ url: "https://homepage.romaine.life" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "homepage.openTab") return false;
  if (!sender.tab || !sender.tab.url || !sender.tab.url.startsWith("https://homepage.romaine.life/")) {
    sendResponse({ ok: false, error: "invalid sender" });
    return false;
  }

  let url;
  try {
    url = new URL(message.url);
  } catch {
    sendResponse({ ok: false, error: "invalid url" });
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    sendResponse({ ok: false, error: "unsupported url protocol" });
    return false;
  }

  chrome.tabs.create({
    url: url.href,
    windowId: sender.tab.windowId,
    index: sender.tab.index + 1,
    active: message.active !== false,
  }).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: error.message }),
  );

  return true;
});
