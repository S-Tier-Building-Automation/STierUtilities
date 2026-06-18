import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMediaPaths } from "./media-paths.js";

test("filterMediaPaths keeps HEIC/HEIF/MOV and drops other extensions", () => {
  const paths = [
    "C:\\Photos\\a.heic",
    "C:\\Photos\\b.mov",
    "/tmp/c.jpg",
    "D:\\d.HEIF",
    "E:\\e.txt",
  ];
  assert.deepEqual(filterMediaPaths(paths), [
    "C:\\Photos\\a.heic",
    "C:\\Photos\\b.mov",
    "D:\\d.HEIF",
  ]);
  assert.deepEqual(filterMediaPaths(["/tmp/noext", "readme.heic"]), ["readme.heic"]);
});
