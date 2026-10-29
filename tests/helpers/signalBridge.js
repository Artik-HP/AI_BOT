// Test-only preload; never used by the application entry point in production.
process.on("message", (message) => {
  if (message?.type === "test-sigterm") process.emit("SIGTERM");
});
