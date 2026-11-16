// Reading of the static files (stylesheet, images, fonts, browser scripts).
// Run from the sources, they are read from the disk next to this file. Run from
// the single executable (see build-sea.js), they are read from the files embedded
// in it, under the same relative name.
import { readFileSync } from "node:fs";
import sea from "node:sea";

export const inExecutable = sea.isSea();

export function readAsset(file) {
  if (inExecutable) {
    return Buffer.from(sea.getAsset(file.replace(/^\.\//, "")));
  }
  return readFileSync(new URL(file, import.meta.url));
}
