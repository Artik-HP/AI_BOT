// Test-only preload; never used by the application entry point in production.
process.on("message", async (message) => {
  if (message?.type === "test-sigterm") process.emit("SIGTERM");
  if (message?.type === "test-auth") {
    try {
      const result = await require("../../src/services/auth").auth.authenticate(message.userId, message.password);
      process.send({ type: "test-auth-result", requestId: message.requestId, ok: result.ok });
    } catch { process.send({ type: "test-auth-result", requestId: message.requestId, ok: false }); }
  }
});
