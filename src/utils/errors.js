function getErrorDetails(error) {
  const data = error.response?.data;

  if (Buffer.isBuffer(data)) {
    const text = data.toString("utf8");

    try {
      return JSON.parse(text);
    } catch {
      return text.slice(0, 1000);
    }
  }

  return data || error.message;
}

module.exports = {
  getErrorDetails
};
