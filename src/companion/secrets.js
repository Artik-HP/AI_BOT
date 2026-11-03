// What must not be stored for a person: passwords, card and document numbers, access keys.
// Two filters of different strictness, because the texts differ. A fact about a person ("my password is ...")
// is refused broadly; an idea is creative text that may well talk about passwords or "secret menus", so only
// strings that look like real credentials are refused there.

const SECRET_WORDS = /парол|password|passwd|\bcvv\b|\bcvc\b|пин-?код|pin code|паспорт|снилс|сид[- ]?фраз|seed phrase|api[ _-]?key|секретн|private key|приватн\p{L}* ключ|(?<![\p{L}])инн(?![\p{L}])/iu;
const LONG_NUMBER = /(?:\d[ -]?){9,}/;
const CARD_LIKE_NUMBER = /(?:\d[ -]?){13,}/;
const CREDENTIAL_ASSIGNMENT = /(?:парол\p{L}*|password|passwd|пин-?код|\bpin\b|\bcvv\b|\bcvc\b|api[ _-]?key|token|токен|секрет\p{L}*|secret)\s*[:=]\s*\S+/iu;
const KEY_LIKE_TOKEN = /\b(?:sk|pk|ghp|xox[bap])-[A-Za-z0-9_-]{16,}|\b\d{6,}:[A-Za-z0-9_-]{30,}|[A-Za-z0-9+/_-]{40,}/;

function looksSecret(text) {
  return SECRET_WORDS.test(text) || LONG_NUMBER.test(text);
}

function looksCredential(text) {
  return CREDENTIAL_ASSIGNMENT.test(text) || KEY_LIKE_TOKEN.test(text) || CARD_LIKE_NUMBER.test(text);
}

module.exports = {
  looksSecret,
  looksCredential
};
