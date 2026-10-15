import { readFileSync } from "node:fs";
import * as acorn from "acorn";

const file = process.argv[2];
// A CRLF checkout (Git for Windows' default core.autocrlf=true) would match
// no block at all and report "0 snippet(s) valid" as success.
const markdown = readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
const pattern = /```js\n([\s\S]*?)```/g;

let match;
let checked = 0;
while ((match = pattern.exec(markdown)) !== null) {
  checked += 1;
  try {
    acorn.parse(match[1], { ecmaVersion: 3 });
  } catch (error) {
    console.error(`${file}: JSX snippet #${checked} is not valid ES3 — ${error.message}`);
    process.exit(1);
  }
}
console.log(`${file}: ${checked} JSX snippet(s) valid as ES3`);
