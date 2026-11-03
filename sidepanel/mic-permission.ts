const requestButton = document.querySelector<HTMLButtonElement>("#request-microphone");
const permissionStatus = document.querySelector<HTMLParagraphElement>("#permission-status");
const settingsLink = document.querySelector<HTMLAnchorElement>("#microphone-settings");

if (requestButton && permissionStatus && settingsLink) {
  requestButton.addEventListener("click", async () => {
    requestButton.disabled = true;
    permissionStatus.textContent = "Waiting for Chrome microphone permission...";
    settingsLink.hidden = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      permissionStatus.textContent = "Microphone access is enabled. Close this tab and tap the microphone in Browse Voice.";
    } catch (error) {
      requestButton.disabled = false;
      permissionStatus.textContent = error instanceof Error ? error.message : "Chrome did not grant microphone access.";
      settingsLink.href = `chrome://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
      settingsLink.hidden = false;
    }
  });
}
