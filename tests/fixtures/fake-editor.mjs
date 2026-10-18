// A stand-in for $EDITOR in the `odw approve --edit` tests. It records what it
// was opened on — the file's path, text and permissions — in $FAKE_EDITOR_SEEN,
// then leaves the file alone ($FAKE_EDITOR_TEXT unset), or rewrites it with
// $FAKE_EDITOR_TEXT, and exits with $FAKE_EDITOR_EXIT (default 0).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const file = process.argv[process.argv.length - 1];
const seen = process.env.FAKE_EDITOR_SEEN;
if (seen) {
  writeFileSync(
    seen,
    JSON.stringify({
      file,
      text: readFileSync(file, "utf8"),
      mode: statSync(file).mode & 0o777,
      dirMode: statSync(dirname(file)).mode & 0o777,
    }),
  );
}
if (process.env.FAKE_EDITOR_TEXT !== undefined) writeFileSync(file, process.env.FAKE_EDITOR_TEXT);
process.exit(Number(process.env.FAKE_EDITOR_EXIT ?? 0));
