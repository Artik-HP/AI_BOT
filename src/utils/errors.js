function getErrorDetails(error) {
  return error.response?.data || error.message;
}

module.exports = {
  getErrorDetails
};
