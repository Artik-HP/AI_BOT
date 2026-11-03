// node:test reporter that turns every failed test into a GitHub Actions annotation (`::error ...`).
// The reason of a failure then shows up on the check run itself, not only deep inside a long log.
// Used by CI next to the normal reporter:
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./tests/helpers/githubReporter.js --test-reporter-destination=stdout
const path = require("path");

const MAX_ANNOTATIONS = 10;
const MAX_MESSAGE_CHARS = 900;

// Workflow-command escaping: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

function describeFailure(data) {
  const error = data.details?.error;
  const original = error?.cause && typeof error.cause === "object" ? error.cause : error;
  const message = String(original?.message || error?.message || "test failed")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" | ");

  return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}...` : message;
}

function formatAnnotation(data, root = process.cwd()) {
  const properties = [];

  if (data.file) {
    properties.push(`file=${escapeProperty((path.relative(root, data.file) || data.file).split(path.sep).join("/"))}`);
  }

  if (data.line) {
    properties.push(`line=${data.line}`);
  }

  properties.push(`title=${escapeProperty(`Тест упал: ${data.name}`)}`);
  return `::error ${properties.join(",")}::${escapeData(describeFailure(data))}\n`;
}

module.exports = async function* githubReporter(source) {
  let printed = 0;

  for await (const event of source) {
    if (event.type === "test:fail" && printed < MAX_ANNOTATIONS) {
      printed += 1;
      yield formatAnnotation(event.data);
    }
  }
};

module.exports.formatAnnotation = formatAnnotation;
module.exports.escapeData = escapeData;
