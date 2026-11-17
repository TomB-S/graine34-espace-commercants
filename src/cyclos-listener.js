// The listening loop of ONE merchant: logs in to Cyclos with its own session, opens the push
// stream, reads it, reopens it, logs in again when needed, and stops cleanly.
//
// What happens to the stream:
// - Cyclos closes it after about 41 seconds, every time. That is NORMAL: it is reopened at once,
//   with the same clientId and the Last-Event-ID, with no pause and nothing in the log.
// - Silence for `streamWatchdogSeconds` (not even a comment line) means a dead connection: the
//   request is cancelled and the stream reopened.
// - Network error, timeout, 429, 5xx: state "reconnecting", pauses of 1, 2, 4, 8... seconds up to
//   `reconnectMaxSeconds`, with jitter. The pause restarts from zero as soon as a stream opens.
//   After `streamWatchdogSeconds` seconds of failure the state is "degraded".
// - 401: the session is over, log in again and reopen. If Cyclos refuses the credentials
//   `reauthMax` times in a row, state "error" and the loop STOPS (no hammering of the login: Cyclos may
//   lock an account after too many tries). Credentials refused at the very first login: "error" at once.
// - 403 (login or stream): state "error", the loop stops, no automatic retry.
// - After any period of trouble the payments may have been missed: the processor is told
//   (`recovered`) so that it can read the history (the "safety net", see payment-processor.js).
//
// What is NOT here: the meaning of the events (that is the processor's job). Nothing from Cyclos
// (payer, amount, description, identifiers, token) is ever written to the log.
import { randomUUID } from "node:crypto";
import { createSseParser, interpretEvent } from "./sse-parser.js";
import { PushAuthError, PushForbiddenError, PushUnavailableError } from "./cyclos-push.js";

const KNOWN_ERRORS = [PushAuthError, PushForbiddenError, PushUnavailableError];

// The configuration has no credentials for this merchant (nothing to try, nothing to retry).
class NoCredentialsError extends Error {}

// Default logger: one line per call, prefixed. Callers give their own in tests.
export function consoleLog() {
  return {
    info: (message) => console.log(`Caisse : ${message}`),
    error: (message) => console.error(`Caisse : ${message}`),
  };
}

// What may be written about an error: for our own error kinds, the kind and the message (written by us,
// no data inside); for anything else, the name and the stack frames only, never the message (a
// parsing error can quote the text it could not read).
export function describeError(error) {
  if (KNOWN_ERRORS.some((kind) => error instanceof kind)) return `${error.constructor.name} (${error.message})`;
  const frames = String(error?.stack ?? "")
    .split("\n")
    .filter((line) => line.trim().startsWith("at "))
    .slice(0, 6)
    .map((line) => line.trim())
    .join(" | ");
  return `${error?.name ?? "Error"}${frames ? ` ${frames}` : ""}`;
}

// A pause that ends early when `signal` is aborted. Timers never keep the process alive.
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

// processor (all optional, see payment-processor.js):
//   prepare(ctx)                    after the first login: setting, account, first load of the history
//   onEvent(event, ctx)             one interpreted event ({ kind, data, ... }); a PushAuthError makes the loop log in again
//   onStreamOpen(ctx, { recovered }) the stream just opened; `recovered`: it follows a period of trouble
//   stop()                          clear its timers
// ctx: { token(), isStopped(), isReopening(), authLost() }
// Test hooks: `sleep(ms, signal)`, `random()`, `now()`, `shortStreamMs`.
export function createListener({
  merchantKey,
  config,
  push,
  store,
  log = consoleLog(),
  processor = {},
  sleep = defaultSleep,
  random = Math.random,
  now = Date.now,
  shortStreamMs = 1000,
}) {
  // One identifier for the whole life of the listener, kept across reconnections and new logins.
  const clientId = randomUUID();
  const watchdogMs = config.streamWatchdogSeconds * 1000;
  const maxPauseMs = config.reconnectMaxSeconds * 1000;
  const stopSignal = new AbortController();

  let token = null;
  let stopped = false;
  let running = false;
  let loop = null;
  let connection = null; // AbortController of the connection being opened or read
  let lastEventId = null;
  let prepared = false;
  let everLoggedIn = false;
  let loginFailures = 0; // credentials refused in a row
  let rejections = 0; // token refused (401) in a row, without any stream opened in between
  let pauseStep = 0; // failures in a row, for the growing pause
  let failingSince = null;
  let needsRecovery = false;
  let reopening = true; // no stream is open right now
  let sessionLost = false; // the processor says the token no longer works
  let shortStreams = 0;

  const ctx = {
    token: () => token,
    isStopped: () => stopped,
    isReopening: () => reopening,
    // The processor met a 401 outside the stream: forget the token, drop the connection, log in again.
    authLost() {
      if (stopped) return;
      sessionLost = true;
      needsRecovery = true;
      connection?.abort();
    },
  };

  // Growing pause with jitter: 1, 2, 4, 8... seconds, never above the maximum, between half and the whole of the step.
  function nextPause() {
    const step = Math.min(maxPauseMs, 1000 * 2 ** Math.min(pauseStep, 12));
    pauseStep += 1;
    return Math.round(step * (0.5 + 0.5 * random()));
  }

  // Logs in with the credentials of the configuration. They are looked up each time and not kept here.
  async function authenticate() {
    const credentials = config.credentialsFor(merchantKey);
    if (!credentials) throw new NoCredentialsError("no credentials for this merchant");
    const fresh = await push.createSession(credentials.login, credentials.password, stopSignal.signal);
    if (stopped) {
      await push.closeSession(fresh);
      return;
    }
    token = fresh;
    everLoggedIn = true;
    loginFailures = 0;
  }

  // Dispatches one decoded event. Errors of the processor never break the loop, except a 401.
  async function dispatch(event) {
    const interpreted = interpretEvent(event);
    if (interpreted.invalid) {
      log.info(`événement illisible ignoré (${interpreted.name})`);
      return;
    }
    if (!interpreted.kind || !processor.onEvent) return;
    try {
      await processor.onEvent(interpreted, ctx);
    } catch (error) {
      if (error instanceof PushAuthError || stopped || sessionLost) throw error;
      log.error(`erreur de traitement d'un événement : ${describeError(error)}`);
    }
  }

  // One connection: opens the stream and reads it until it ends. Returns when it ended by itself
  // (normal end, or silence cut by the watchdog); throws for any other reason.
  async function runConnection() {
    const mine = new AbortController();
    connection = mine;
    let watchdogFired = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        watchdogFired = true;
        mine.abort();
      }, watchdogMs);
      timer.unref?.();
    };
    const startedAt = now();
    arm(); // also covers a connection that never answers
    try {
      const stream = await push.openStream(token, { clientId, lastEventId, signal: mine.signal });
      reopening = false;
      pauseStep = 0;
      rejections = 0;
      failingSince = null;
      store.setConnection("live");
      const recovered = needsRecovery;
      needsRecovery = false;
      Promise.resolve()
        .then(() => processor.onStreamOpen?.(ctx, { recovered }))
        .catch((error) => {
          if (!stopped) log.error(`erreur à l'ouverture du flux : ${describeError(error)}`);
        });

      const parser = createSseParser();
      for await (const chunk of stream.chunks) {
        arm();
        const events = parser.feed(chunk);
        if (parser.lastEventId !== null) lastEventId = parser.lastEventId;
        for (const event of events) {
          await dispatch(event);
          if (stopped) return;
        }
        arm();
      }
      // Normal end. A stream that lasted almost nothing, several times in a row, is not normal: slow down.
      shortStreams = now() - startedAt < shortStreamMs ? shortStreams + 1 : 0;
    } catch (error) {
      if (stopped) throw error;
      if (watchdogFired) {
        needsRecovery = true; // events may have been lost
        log.info("silence prolongé sur le flux, réouverture");
        return;
      }
      if (sessionLost) throw new PushAuthError("session lost");
      throw error;
    } finally {
      clearTimeout(timer);
      connection = null;
      reopening = true;
    }
  }

  // Shared handling of a failure that is not an end of the loop: state, pause.
  async function pauseAfterFailure() {
    needsRecovery = true;
    failingSince ??= now();
    store.setConnection(now() - failingSince > watchdogMs ? "degraded" : "reconnecting");
    await sleep(nextPause(), stopSignal.signal);
  }

  function giveUp(reason) {
    store.setConnection("error");
    log.error(`écoute arrêtée : ${reason}`);
  }

  async function run() {
    while (!stopped) {
      try {
        if (sessionLost) {
          // authLost() came while no connection was open: same outcome as a 401.
          sessionLost = false;
          token = null;
        }
        if (!token) await authenticate();
        if (stopped) break;
        if (!prepared) {
          await processor.prepare?.(ctx);
          prepared = true;
        }
        await runConnection();
        if (shortStreams >= 3) await pauseAfterFailure(); // streams that end at once: no hammering
      } catch (error) {
        if (stopped) break;
        if (error instanceof NoCredentialsError) {
          giveUp("aucun identifiant d'écoute configuré");
          break;
        }
        if (error instanceof PushForbiddenError) {
          giveUp("accès refusé par Cyclos (403)");
          break;
        }
        if (error instanceof PushAuthError) {
          const duringLogin = !token;
          if (duringLogin) {
            loginFailures += 1;
            // Optional (executable): the credentials come from the page and are forgotten at the first refusal, so the
            // next try finds none and the loop stops: a refused login is never repeated.
            config.credentialsRefused?.(merchantKey);
            if (!everLoggedIn) {
              giveUp("identifiants refusés par Cyclos (401)");
              break;
            }
            if (loginFailures >= config.reauthMax) {
              giveUp(`identifiants refusés ${loginFailures} fois de suite (401)`);
              break;
            }
          } else {
            rejections += 1;
            if (rejections >= config.reauthMax) {
              giveUp(`jeton refusé ${rejections} fois de suite (401)`);
              break;
            }
          }
          token = null;
          sessionLost = false;
          needsRecovery = true;
          log.info("session Cyclos à renouveler");
          if (duringLogin) await pauseAfterFailure();
          continue;
        }
        log.error(`écoute interrompue : ${describeError(error)}`);
        await pauseAfterFailure();
      }
    }
    // The loop is over (stop, or error state): close the Cyclos session if there is one.
    const last = token;
    token = null;
    if (last) await push.closeSession(last);
    reopening = true;
  }

  return {
    clientId,
    get running() {
      return running;
    },
    // Starts the loop and returns at once: the first events arrive later.
    start() {
      if (running || stopped) return;
      running = true;
      store.setConnection("starting");
      log.info("écoute démarrée");
      loop = run()
        .catch((error) => {
          giveUp(`erreur inattendue : ${describeError(error)}`);
        })
        .finally(() => {
          running = false;
        });
    },
    // Stops everything: stream cut, timers cleared, Cyclos session closed, tickets forgotten.
    async stop() {
      if (stopped) return loop;
      stopped = true;
      stopSignal.abort();
      connection?.abort();
      processor.stop?.();
      await loop;
      store.clear();
      log.info("écoute arrêtée");
      return undefined;
    },
  };
}
