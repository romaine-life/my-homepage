chrome.commands.onCommand.addListener((command) => {
  if (command === "open-homepage") {
    chrome.tabs.create({ url: "https://homepage.romaine.life" });
  }
});
