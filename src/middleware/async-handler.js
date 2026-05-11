/**
 * asyncHandler — wraps async Express route handlers so they forward
 * rejected promises to Express error handler via next(err).
 *
 * Usage: app.get('/path', asyncHandler(async (req, res) => { ... }));
 */
module.exports = function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
