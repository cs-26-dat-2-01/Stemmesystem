import {
  configure,
  defaultConsoleFormatter,
  getConsoleSink,
} from "@logtape/logtape";
import {
  JWT_PATTERN,
  redactByPattern,
  RedactionPattern,
} from "@logtape/redaction"; // https://logtape.org/manual/redaction

const ARGON2_PATTERN: RedactionPattern = {
  // argon2id regex from here: https://regex101.com/r/8d0bGE/1
  // Modified to remove the ^ and $ anchors from the regex so it can match the hash anywhere within the larger log string.
  pattern:
    /\$argon2id\$v=(?:16|19)\$m=\d{1,10},t=\d{1,10},p=\d{1,3}(?:,keyid=[A-Za-z0-9+/]{0,11}(?:,data=[A-Za-z0-9+/]{0,43})?)?\$[A-Za-z0-9+/]{11,64}\$[A-Za-z0-9+/]{16,86}/g,
  replacement: "[REDACTED PASSWORD HASH]",
};

const formatter = redactByPattern(defaultConsoleFormatter, [
  JWT_PATTERN,
  ARGON2_PATTERN,
]);

await configure({
  sinks: { console: getConsoleSink({ formatter }) },
  loggers: [
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    }, // https://logtape.org/manual/categories#meta-logger
    { category: "server-backend", lowestLevel: "debug", sinks: ["console"] },
  ],
});
