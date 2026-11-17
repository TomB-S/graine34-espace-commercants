// Entry point of the single executable: starts the server on the local address and opens the page, where the merchant
// types the login (see launcher.js).
import { startServer } from "./server.js";
import { launchWithPageLogin, openBrowser, waitForEnter } from "./launcher.js";

async function main() {
  const input = process.stdin;
  const output = process.stdout;
  const result = await launchWithPageLogin({
    env: process.env,
    output,
    start: startServer,
    open: openBrowser,
  });

  if (result.code !== 0) {
    if (!result.cancelled) await waitForEnter({ input, output });
    process.exit(result.code);
  }

  // Stop cleanly: listening streams cut and Cyclos sessions closed, then exit.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await result.handle.close();
      process.exit(0);
    });
  }
}

main();
