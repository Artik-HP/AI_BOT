function getErrorDetails(error) {
  // Provider bodies can contain user text, internal IDs and URLs with credentials.
  return { status: error.response?.status || error.response?.statusCode || null, code: error.code || error.name || 'Error' };
}

module.exports = {
  getErrorDetails
};
