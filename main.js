// Entry point of the single executable: asks what the environment does not give, checks it once, starts the server
// on the local address and opens the page (see launcher.js).
import { startServer } from "./server.js";
import { createCyclosPush } from "./cyclos-push.js";
import { launch, openBrowser, waitForEnter } from "./launcher.js";

async function main() {
  const input = process.stdin;
  const output = process.stdout;
  const result = await launch({
    env: process.env,
    input,
    output,
    start: startServer,
    createPush: ({ baseUrl, channel }) => createCyclosPush({ baseUrl, channel }),
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
