// Address of the visitor, read in a controlled way when the server sits behind relays (reverse proxy).
//
// Each trusted relay adds to X-Forwarded-For the address it received the call from. So, counting from the RIGHT, the chain
// is: [...X-Forwarded-For, address of the socket]. With `hops` trusted relays between the visitor and this server, the
// visitor is `hops` places before the end of that chain. What stands further left in the header was written by the visitor
// himself and is never used. With 0 relays, the header is not even looked at.
//
// Safe side: a header that is missing, shorter than expected or holding something that is not an address gives the address of
// the socket (never a value chosen by the visitor).
import { isIP } from "node:net";

const unmap = (address) => (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address);

// `socketAddress`: req.socket.remoteAddress. `forwardedFor`: the value of the X-Forwarded-For header (or undefined).
// Returns { address, fromHeader, headerEntries }: where the address comes from, and how many entries the header held.
export function readClientAddress({ socketAddress, forwardedFor }, hops = 0) {
  const socket = typeof socketAddress === "string" && socketAddress !== "" ? unmap(socketAddress) : "unknown";
  const entries =
    typeof forwardedFor === "string"
      ? forwardedFor
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part !== "")
      : [];
  if (!Number.isInteger(hops) || hops <= 0) return { address: socket, fromHeader: false, headerEntries: entries.length };
  const candidate = entries[entries.length - hops];
  const valid = candidate !== undefined && entries.length >= hops && isIP(unmap(candidate)) !== 0;
  return valid
    ? { address: unmap(candidate), fromHeader: true, headerEntries: entries.length }
    : { address: socket, fromHeader: false, headerEntries: entries.length };
}

// Same, from a request.
export const clientAddressOf = (req, hops = 0) =>
  readClientAddress({ socketAddress: req.socket?.remoteAddress, forwardedFor: req.headers?.["x-forwarded-for"] }, hops);
