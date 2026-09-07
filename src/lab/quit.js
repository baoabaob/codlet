(async () => {
  const href = window.location.href;
  const document = "app://-/index.html";
  if (window !== window.top || typeof href !== "string" ||
      !(href === document || href.startsWith(document + "?") || href.startsWith(document + "#"))) {
    return { status: "wrong_document" };
  }
  const bridge = window.electronBridge;
  if (bridge?.windowType !== "electron" || typeof bridge.sendMessageFromView !== "function") {
    return { status: "bridge_unavailable" };
  }
  // Audited preload -> this Desktop's trusted IPC handler -> app.quit().
  // No relaunch, credentials, arbitrary message or external endpoint is accepted.
  await bridge.sendMessageFromView({ type: "quit-app" });
  return { status: "quit_requested" };
})()
