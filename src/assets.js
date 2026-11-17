// Reading of the static files (stylesheet, images, fonts, browser scripts).
// `name` is relative to the web/ folder ("style.css", "images/logo-lagraine34.png", "js/caisse.js"). Run from the sources,
// the files are read from web/. Run from the single executable (see tools/build-sea.js), they are read from the files
// embedded in it, under the same name.
import { readFileSync } from "node:fs";
import sea from "node:sea";

export const inExecutable = sea.isSea();

export function readAsset(name) {
  if (inExecutable) {
    return Buffer.from(sea.getAsset(name));
  }
  return readFileSync(new URL(`../web/${name}`, import.meta.url));
}
